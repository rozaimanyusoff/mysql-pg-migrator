import type { MigJob, TableMap, ColumnMap } from './types';

function tgtCol(c: ColumnMap): string { return c.targetName ?? c.targetCol; }
function resolveTargetTable(t: TableMap): string { return t.targetAlias?.trim() || t.target.table; }

interface SerializedTable {
  id: string;
  source_schema: string;
  source_table: string;
  source_database: string | null;
  target_schema: string;
  target_table: string;
  truncate: boolean;
  sync_mode: string;
  incremental_col: string | null;
  incremental_strategy: string;
  last_synced_value: string | null;
  columns: SerializedColumn[];
}

interface SerializedColumn {
  source_col: string | null;
  target_col: string;
  target_type: string;
  nullable: boolean;
  default_value: string | null;
  conversion: string;
  fk_ref: string | null;
  keep_legacy_as: string | null;
}

function serializeTables(tables: TableMap[]): SerializedTable[] {
  return tables
    .filter(t => t.include && t.columns.length > 0)
    .map(t => ({
      id: t.id,
      source_schema: t.source.schema,
      source_table: t.source.table,
      source_database: t.sourceDatabase ?? null,
      target_schema: t.target.schema,
      target_table: resolveTargetTable(t),
      truncate: t.truncateBeforeMigrate,
      sync_mode: t.syncMode ?? 'full',
      incremental_col: t.incrementalCol ?? null,
      incremental_strategy: t.incrementalStrategy ?? 'id',
      last_synced_value: t.lastSyncedValue ?? null,
      columns: t.columns
        .filter(c => c.include)
        .map(c => ({
          source_col: c.sourceCol,
          target_col: tgtCol(c),
          target_type: c.targetType,
          nullable: c.nullable,
          default_value: c.defaultValue,
          conversion: c.conversion,
          fk_ref: c.fkRef,
          keep_legacy_as: c.keepLegacyAs ?? null,
        })),
    }));
}

export function generatePythonScript(job: MigJob): string {
  const included = serializeTables(job.tables);
  const tablesJson = JSON.stringify(included, null, 2);
  const scriptName = `migrate_${job.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}.py`;
  const generated = new Date().toISOString();
  const nIncluded = included.length;
  const nTotal = job.tables.length;

  return `#!/usr/bin/env python3
"""
Migration Script — ${job.name}
${job.description ? `${job.description}\n` : ''}Generated : ${generated}
Source    : ${job.sourceMeta.type}://${job.sourceMeta.host}:${job.sourceMeta.port}/${job.sourceMeta.database}
Target    : ${job.targetMeta.type}://${job.targetMeta.host}:${job.targetMeta.port}/${job.targetMeta.database}
Tables    : ${nIncluded} included / ${nTotal} total

Usage
-----
  SRC_PASSWORD=... TGT_PASSWORD=... python3 ${scriptName} [options]

  If env vars are not set, the script prompts for passwords interactively.

Options
-------
  --batch START-END   Process only tables at positions START–END (1-based, inclusive)
                      Example: --batch 1-100  then  --batch 101-200
  --dry-run           Count source rows only, do not insert anything
  --chunk-size N      Rows per INSERT batch (default 500; raise to 1000–5000 for CLI)
  --reset             Ignore saved state file and start fresh for all tables

State / Resume
--------------
  Progress is saved to  ${job.id}_state.json  after every chunk.
  Re-running the script automatically skips completed tables.
  Use --reset to force a clean start.

Requirements
------------
  pip install psycopg2-binary mysql-connector-python
"""

import os, sys, re, json, time, hashlib, argparse
from typing import Any, Optional

# ── Connection config (passwords NOT stored here — supply via env or prompt) ─
SRC: dict = {
    "type"    : "${job.sourceMeta.type}",
    "host"    : "${job.sourceMeta.host}",
    "port"    : ${job.sourceMeta.port},
    "database": "${job.sourceMeta.database}",
    "username": "${job.sourceMeta.username}",
}
TGT: dict = {
    "type"    : "${job.targetMeta.type}",
    "host"    : "${job.targetMeta.host}",
    "port"    : ${job.targetMeta.port},
    "database": "${job.targetMeta.database}",
    "username": "${job.targetMeta.username}",
}

# ── Table mapping from job "${job.name}" (v${job.version}) ───────────────────
TABLES: list = ${tablesJson}

# ── State file for resume support ────────────────────────────────────────────
STATE_FILE = "${job.id}_state.json"


# ─────────────────────────────────────────────────────────────────────────────
# UUID conversion — mirrors runner.ts seqToUUID exactly
# ─────────────────────────────────────────────────────────────────────────────
def seq_to_uuid(namespace: str, source_id: Any) -> str:
    h = hashlib.sha256(f"{namespace}\\x00{source_id}".encode()).hexdigest()
    b = (int(h[16], 16) & 0x3) | 0x8
    return f"{h[0:8]}-{h[8:12]}-4{h[13:16]}-{b:x}{h[17:20]}-{h[20:32]}"


# ─────────────────────────────────────────────────────────────────────────────
# DB connection helpers
# ─────────────────────────────────────────────────────────────────────────────
def connect(cfg: dict, password: str):
    if cfg["type"] == "postgresql":
        import psycopg2  # type: ignore
        return psycopg2.connect(
            host=cfg["host"], port=cfg["port"], dbname=cfg["database"],
            user=cfg["username"], password=password, connect_timeout=30,
        )
    import mysql.connector  # type: ignore
    return mysql.connector.connect(
        host=cfg["host"], port=cfg["port"], database=cfg["database"],
        user=cfg["username"], password=password, connection_timeout=30,
        autocommit=False,
    )


def q(db_type: str, name: str) -> str:
    """Quote an identifier."""
    return f'"{name}"' if db_type == "postgresql" else f"\`{name}\`"


# ─────────────────────────────────────────────────────────────────────────────
# Row transform — mirrors runner.ts coerceValue + transformRow
# ─────────────────────────────────────────────────────────────────────────────
def _coerce(val: Any, col: dict, src_schema: str, src_table: str) -> Any:
    if val is None:
        return None
    conv = col["conversion"]
    if conv == "serial_to_uuid":
        return seq_to_uuid(f"{src_schema}.{src_table}", val)
    if col["fk_ref"]:
        ns = ".".join(col["fk_ref"].split(".")[-2:])
        return seq_to_uuid(ns, val)
    t = (col["target_type"] or "").lower()
    if t in ("boolean", "bool"):
        if isinstance(val, int):   return val != 0
        if isinstance(val, str):   return val == "1" or val.lower() == "true"
        return bool(val)
    if conv == "to_text":       return str(val)
    if conv == "to_integer":    return int(val)
    if conv == "to_bigint":     return int(val)
    if conv == "to_numeric":    return float(val)
    if conv == "to_boolean":
        if isinstance(val, int): return val != 0
        if isinstance(val, str): return val == "1" or val.lower() == "true"
        return bool(val)
    if conv == "to_timestamptz":
        return str(val)
    if conv == "to_date":
        return str(val)[:10] if val else None
    if conv == "to_jsonb":
        return json.dumps(val) if not isinstance(val, str) else val
    return val


def transform_row(row: dict, tmap: dict) -> dict:
    out: dict = {}
    for col in tmap["columns"]:
        tgt = col["target_col"]
        if col["source_col"] is None:
            out[tgt] = col["default_value"]
        else:
            raw = row.get(col["source_col"])
            out[tgt] = _coerce(raw, col, tmap["source_schema"], tmap["source_table"])
            if col.get("keep_legacy_as") and col["conversion"] == "serial_to_uuid":
                out[col["keep_legacy_as"]] = int(raw) if raw is not None else None
    return out


# ─────────────────────────────────────────────────────────────────────────────
# DDL — ensure target table exists (CREATE TABLE IF NOT EXISTS)
# ─────────────────────────────────────────────────────────────────────────────
def ensure_target_table(conn, tgt_type: str, tmap: dict, dry_run: bool) -> None:
    if dry_run:
        return
    schema = tmap["target_schema"]
    table  = tmap["target_table"]
    cols   = tmap["columns"]

    pk_col = next((c for c in cols if c["conversion"] == "serial_to_uuid"), None)
    if pk_col is None:
        pk_col = next((c for c in cols if c["target_col"].lower() == "id"), None)

    col_defs = []
    for c in cols:
        nn = " NOT NULL" if not c["nullable"] else ""
        if tgt_type == "postgresql":
            col_defs.append(f'  "{c["target_col"]}" {c["target_type"]}{nn}')
        else:
            col_defs.append(f"  \`{c['target_col']}\` {c['target_type']}{nn}")
        if c.get("keep_legacy_as") and c["conversion"] == "serial_to_uuid":
            if tgt_type == "postgresql":
                col_defs.append(f'  "{c["keep_legacy_as"]}" BIGINT NULL')
            else:
                col_defs.append(f"  \`{c['keep_legacy_as']}\` BIGINT NULL")

    if pk_col:
        if tgt_type == "postgresql":
            col_defs.append(f'  PRIMARY KEY ("{pk_col["target_col"]}")')
        else:
            col_defs.append(f"  PRIMARY KEY (\`{pk_col['target_col']}\`)")

    body = ",\\n".join(col_defs)
    cur = conn.cursor()
    try:
        if tgt_type == "postgresql":
            cur.execute(f'CREATE SCHEMA IF NOT EXISTS "{schema}"')
            cur.execute(f'CREATE TABLE IF NOT EXISTS "{schema}"."{table}" (\\n{body}\\n)')
        else:
            cur.execute(f"CREATE TABLE IF NOT EXISTS \`{schema}\`.\`{table}\` (\\n{body}\\n)")
        conn.commit()
    finally:
        cur.close()


# ─────────────────────────────────────────────────────────────────────────────
# Read a chunk from source
# ─────────────────────────────────────────────────────────────────────────────
def read_chunk(
    conn, src_type: str, schema: str, table: str,
    cols: list, offset: int, limit: int,
    filter_col: Optional[str] = None, filter_gt: Optional[str] = None,
) -> list:
    col_list = ", ".join(q(src_type, c) for c in cols)
    cur = conn.cursor()
    try:
        if src_type == "postgresql":
            if filter_col and filter_gt is not None:
                cur.execute(
                    f'SELECT {col_list} FROM "{schema}"."{table}" WHERE "{filter_col}" > %s LIMIT %s OFFSET %s',
                    (filter_gt, limit, offset),
                )
            else:
                cur.execute(
                    f'SELECT {col_list} FROM "{schema}"."{table}" LIMIT %s OFFSET %s',
                    (limit, offset),
                )
        else:
            if filter_col and filter_gt is not None:
                cur.execute(
                    f"SELECT {col_list} FROM \`{schema}\`.\`{table}\` WHERE \`{filter_col}\` > %s LIMIT %s OFFSET %s",
                    (filter_gt, limit, offset),
                )
            else:
                cur.execute(
                    f"SELECT {col_list} FROM \`{schema}\`.\`{table}\` LIMIT %s OFFSET %s",
                    (limit, offset),
                )
        colnames = [d[0] for d in cur.description]
        return [dict(zip(colnames, row)) for row in cur.fetchall()]
    finally:
        cur.close()


# ─────────────────────────────────────────────────────────────────────────────
# Insert a chunk into target (ON CONFLICT DO NOTHING or UPSERT)
# ─────────────────────────────────────────────────────────────────────────────
def insert_rows(
    conn, tgt_type: str, schema: str, table: str,
    rows: list, pk_col: Optional[str], upsert: bool, dry_run: bool,
) -> int:
    if dry_run or not rows:
        return len(rows)
    cols = list(rows[0].keys())
    update_cols = [c for c in cols if c != pk_col]
    cur = conn.cursor()
    count = 0
    try:
        for row in rows:
            values = [row[c] for c in cols]
            if tgt_type == "postgresql":
                col_list = ", ".join(f'"{c}"' for c in cols)
                placeholders = ", ".join(["%s"] * len(cols))
                if upsert and pk_col and update_cols:
                    set_clause = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in update_cols)
                    sql = (
                        f'INSERT INTO "{schema}"."{table}" ({col_list}) VALUES ({placeholders}) '
                        f'ON CONFLICT ("{pk_col}") DO UPDATE SET {set_clause}'
                    )
                else:
                    sql = (
                        f'INSERT INTO "{schema}"."{table}" ({col_list}) VALUES ({placeholders}) '
                        f'ON CONFLICT DO NOTHING'
                    )
            else:
                col_list = ", ".join(f"\`{c}\`" for c in cols)
                placeholders = ", ".join(["%s"] * len(cols))
                if upsert and update_cols:
                    set_clause = ", ".join(f"\`{c}\` = VALUES(\`{c}\`)" for c in update_cols)
                    sql = (
                        f"INSERT INTO \`{schema}\`.\`{table}\` ({col_list}) VALUES ({placeholders}) "
                        f"ON DUPLICATE KEY UPDATE {set_clause}"
                    )
                else:
                    sql = f"INSERT IGNORE INTO \`{schema}\`.\`{table}\` ({col_list}) VALUES ({placeholders})"
            try:
                cur.execute(sql, values)
                count += 1
            except Exception as exc:
                print(f"    !! row error: {exc}")
        conn.commit()
    finally:
        cur.close()
    return count


# ─────────────────────────────────────────────────────────────────────────────
# State helpers
# ─────────────────────────────────────────────────────────────────────────────
def load_state() -> dict:
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_state(state: dict) -> None:
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


# ─────────────────────────────────────────────────────────────────────────────
# Migrate one table
# ─────────────────────────────────────────────────────────────────────────────
def migrate_table(
    src_conn, tgt_conn,
    src_cfg: dict, tgt_cfg: dict,
    tmap: dict, state: dict,
    chunk_size: int, dry_run: bool,
) -> None:
    src_schema = tmap["source_schema"]
    src_table  = tmap["source_table"]
    tgt_schema = tmap["target_schema"]
    tgt_table  = tmap["target_table"]
    key        = f"{src_schema}.{src_table}"

    ts = state.get(key, {"status": "pending", "offset": 0, "rows_migrated": 0})
    if ts["status"] == "completed":
        print(f"  [skip] {key} — already completed")
        return

    src_cols = [c["source_col"] for c in tmap["columns"] if c["source_col"] is not None]
    pk_map   = next((c for c in tmap["columns"] if c["conversion"] == "serial_to_uuid"), None)
    if pk_map is None:
        pk_map = next((c for c in tmap["columns"] if c["target_col"].lower() == "id"), None)
    tgt_pk_col = pk_map["target_col"] if pk_map else None

    is_incremental = tmap["sync_mode"] == "incremental" and tmap["incremental_col"]
    use_upsert     = is_incremental and tmap["incremental_strategy"] == "timestamp"
    filter_col     = tmap["incremental_col"] if is_incremental and tmap["last_synced_value"] else None
    filter_gt      = tmap["last_synced_value"] if filter_col else None

    ensure_target_table(tgt_conn, tgt_cfg["type"], tmap, dry_run)

    if ts["offset"] == 0 and tmap["truncate"] and not dry_run:
        cur = tgt_conn.cursor()
        try:
            if tgt_cfg["type"] == "postgresql":
                cur.execute(f'TRUNCATE "{tgt_schema}"."{tgt_table}" CASCADE')
            else:
                cur.execute(f"TRUNCATE TABLE \`{tgt_schema}\`.\`{tgt_table}\`")
            tgt_conn.commit()
        finally:
            cur.close()
        print(f"    truncated {tgt_schema}.{tgt_table}")

    offset       = ts["offset"]
    rows_migrated = ts["rows_migrated"]

    while True:
        chunk = read_chunk(
            src_conn, src_cfg["type"], src_schema, src_table,
            src_cols, offset, chunk_size, filter_col, filter_gt,
        )
        if not chunk:
            break

        transformed = [transform_row(row, tmap) for row in chunk]
        n = insert_rows(
            tgt_conn, tgt_cfg["type"], tgt_schema, tgt_table,
            transformed, tgt_pk_col, use_upsert, dry_run,
        )
        offset        += len(chunk)
        rows_migrated += n

        state[key] = {"status": "running", "offset": offset, "rows_migrated": rows_migrated}
        save_state(state)

        sys.stdout.write(f"\\r    {rows_migrated:,} rows {'counted' if dry_run else 'migrated'}...")
        sys.stdout.flush()

        if len(chunk) < chunk_size:
            break

    label = "counted" if dry_run else "migrated"
    sys.stdout.write(f"\\r    done — {rows_migrated:,} rows {label}                \\n")
    state[key] = {"status": "completed", "offset": offset, "rows_migrated": rows_migrated}
    save_state(state)


# ─────────────────────────────────────────────────────────────────────────────
# Source connection cache (avoid reconnecting for every table with same DB)
# ─────────────────────────────────────────────────────────────────────────────
_src_conns: dict = {}


def get_src_conn(tmap: dict, base_cfg: dict, password: str):
    db = tmap.get("source_database") or base_cfg["database"]
    if db not in _src_conns:
        cfg = {**base_cfg, "database": db}
        _src_conns[db] = (connect(cfg, password), cfg)
    return _src_conns[db]


def close_all_src_conns() -> None:
    for conn, _ in _src_conns.values():
        try:
            conn.close()
        except Exception:
            pass
    _src_conns.clear()


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run migration job: ${job.name}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--batch", metavar="START-END",
        help="Tables to process (1-based, e.g. 1-100 or 101-200)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Count source rows only, do not write to target",
    )
    parser.add_argument(
        "--chunk-size", type=int, default=500,
        help="Rows per INSERT batch (default: 500)",
    )
    parser.add_argument(
        "--reset", action="store_true",
        help="Ignore saved state and start fresh",
    )
    args = parser.parse_args()

    # Resolve table range
    tables = TABLES
    if args.batch:
        m = re.fullmatch(r"(\\d+)-(\\d+)", args.batch)
        if not m:
            print("ERROR: --batch must be START-END (e.g. 1-100)")
            sys.exit(1)
        start, end = int(m.group(1)), int(m.group(2))
        if start < 1 or end < start:
            print("ERROR: invalid batch range")
            sys.exit(1)
        tables = TABLES[start - 1 : end]
        print(f"Batch {start}–{end}: {len(tables)} of {len(TABLES)} tables")
    else:
        print(f"Processing all {len(tables)} tables")

    if args.dry_run:
        print("** DRY RUN — no data will be written **")

    state = {} if args.reset else load_state()

    # Passwords
    src_password = os.environ.get("SRC_PASSWORD", "")
    tgt_password = os.environ.get("TGT_PASSWORD", "")
    if not src_password:
        import getpass
        src_password = getpass.getpass(
            f"Source password ({SRC['username']}@{SRC['host']}:{SRC['port']}/{SRC['database']}): "
        )
    if not tgt_password:
        import getpass
        tgt_password = getpass.getpass(
            f"Target password ({TGT['username']}@{TGT['host']}:{TGT['port']}/{TGT['database']}): "
        )

    print(f"\\nConnecting to source: {SRC['type']}://{SRC['host']}:{SRC['port']}/{SRC['database']}")
    print(f"Connecting to target: {TGT['type']}://{TGT['host']}:{TGT['port']}/{TGT['database']}")
    tgt_conn = connect(TGT, tgt_password)
    print()

    t0     = time.time()
    failed: list = []

    for i, tmap in enumerate(tables, 1):
        src_conn, src_cfg = get_src_conn(tmap, SRC, src_password)
        src_label = f"{tmap['source_schema']}.{tmap['source_table']}"
        tgt_label = f"{tmap['target_schema']}.{tmap['target_table']}"
        print(f"[{i}/{len(tables)}]  {src_label}  →  {tgt_label}")
        try:
            migrate_table(
                src_conn, tgt_conn, src_cfg, TGT,
                tmap, state, args.chunk_size, args.dry_run,
            )
        except Exception as exc:
            msg = str(exc)
            print(f"  !! FAILED: {msg}")
            failed.append(f"{src_label}: {msg}")
            state[src_label] = {"status": "failed", "error": msg}
            save_state(state)

    close_all_src_conns()
    tgt_conn.close()

    elapsed = time.time() - t0
    ok_count = len(tables) - len(failed)
    print(f"\\n{'=' * 60}")
    print(f"Finished in {elapsed:.1f}s  —  {ok_count} ok, {len(failed)} failed")
    if failed:
        print("\\nFailed tables:")
        for entry in failed:
            print(f"  ✗ {entry}")
        sys.exit(1)


if __name__ == "__main__":
    main()
`;
}
