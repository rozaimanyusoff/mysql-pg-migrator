import { createHash } from 'crypto';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import type { MigConn, MigRun, TableMap, ColumnMap, DbType } from './types';
import { suggestTargetType } from './type-map';

const CHUNK_SIZE = 500;
const MAX_ADVANCE_MS = 8_000;
const MAX_ROLLBACK_PKS = 5_000;

// ── Deterministic UUID from source-table namespace + sequential id ────────────
// Guarantees the same UUID for the same source row across runs,
// so FK columns can be converted without a separate pre-pass.
export function seqToUUID(tableNamespace: string, sourceId: string | number): string {
  const hash = createHash('sha256')
    .update(`${tableNamespace}\x00${String(sourceId)}`)
    .digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

// ── DB connection helpers ─────────────────────────────────────────────────────

async function withPg<T>(conn: MigConn, fn: (c: PgClient) => Promise<T>): Promise<T> {
  const c = new PgClient({
    host: conn.host, port: conn.port,
    database: conn.database || 'postgres',
    user: conn.username, password: conn.password,
    connectionTimeoutMillis: 10_000,
  });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function withMysql<T>(conn: MigConn, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({
    host: conn.host, port: conn.port,
    database: conn.database || undefined,
    user: conn.username, password: conn.password,
    connectTimeout: 10_000, multipleStatements: false,
    // Preserve malformed/zero MySQL temporal values as raw text.  Let the
    // migration transform decide how to handle them instead of mysql2 creating
    // an Invalid Date which later throws in Date#toISOString().
    dateStrings: true,
  });
  try { return await fn(c); } finally { await c.end(); }
}

// ── Row reading ───────────────────────────────────────────────────────────────

interface IncrementalFilter { col: string; gt: string; }
interface RangeFilter { col: string; from: string | null; to: string | null; }

// Build a parameterised WHERE clause supporting incremental (gt) + date-range (from/to).
// PostgreSQL uses $N positional params; MySQL uses ? placeholders.
function buildWhere(
  dbType: 'postgresql' | 'mysql',
  inc?: IncrementalFilter,
  range?: RangeFilter,
): { where: string; params: unknown[]; orderCol: string | null } {
  const conds: string[] = [];
  const params: unknown[] = [];
  let orderCol: string | null = null;

  const q = (col: string) => dbType === 'postgresql' ? `"${col}"` : `\`${col}\``;
  const p = () => dbType === 'postgresql' ? `$${params.length}` : '?';

  if (inc) {
    params.push(inc.gt);
    conds.push(`${q(inc.col)} > ${p()}`);
    orderCol = inc.col;
  }
  if (range?.from) {
    params.push(range.from);
    conds.push(`${q(range.col)} >= ${p()}`);
    if (!orderCol) orderCol = range.col;
  }
  if (range?.to) {
    params.push(range.to);
    conds.push(`${q(range.col)} <= ${p()}`);
    if (!orderCol) orderCol = range.col;
  }

  return {
    where: conds.length ? `WHERE ${conds.join(' AND ')}` : '',
    params,
    orderCol,
  };
}

async function countRows(
  conn: MigConn, schema: string, table: string,
  inc?: IncrementalFilter, range?: RangeFilter
): Promise<number> {
  const { where, params } = buildWhere(conn.type, inc, range);
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM "${schema}"."${table}" ${where}`, params
      );
      return Number(rows[0].n);
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query<any[]>(
      `SELECT COUNT(*) AS n FROM \`${schema}\`.\`${table}\` ${where}`, params
    );
    return Number((rows as any[])[0].n);
  });
}

async function readChunk(
  conn: MigConn, schema: string, table: string,
  cols: string[], offset: number, limit: number,
  inc?: IncrementalFilter, range?: RangeFilter
): Promise<Record<string, unknown>[]> {
  const colList = cols.map(c => conn.type === 'postgresql' ? `"${c}"` : `\`${c}\``).join(', ');
  const { where, params, orderCol } = buildWhere(conn.type, inc, range);
  const orderBy = orderCol
    ? `ORDER BY ${conn.type === 'postgresql' ? `"${orderCol}"` : `\`${orderCol}\``} ASC`
    : '';

  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const nextIdx = params.length + 1;
      const { rows } = await c.query(
        `SELECT ${colList} FROM "${schema}"."${table}" ${where} ${orderBy} LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
        [...params, limit, offset]
      );
      return rows;
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query(
      `SELECT ${colList} FROM \`${schema}\`.\`${table}\` ${where} ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return rows as Record<string, unknown>[];
  });
}

async function getMaxValue(
  conn: MigConn, schema: string, table: string, col: string
): Promise<string | null> {
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const { rows } = await c.query(
        `SELECT MAX("${col}") AS v FROM "${schema}"."${table}"`
      );
      return rows[0].v != null ? String(rows[0].v) : null;
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query<any[]>(
      `SELECT MAX(\`${col}\`) AS v FROM \`${schema}\`.\`${table}\``
    );
    return (rows as any[])[0].v != null ? String((rows as any[])[0].v) : null;
  });
}

// ── DDL generation for target table ──────────────────────────────────────────

// Returns a safe DEFAULT literal for DDL, or null if the value is too complex / DB-specific.
// Rejects column references, MySQL-specific expressions and parenthesised expressions
// that PostgreSQL cannot use in a DEFAULT clause.
function safeDdlDefault(raw: string | null | undefined, targetType: 'postgresql' | 'mysql'): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.toUpperCase() === 'NULL') return 'NULL';
  // Numeric literal
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  // Quoted string literal
  if (/^'[^']*'$/.test(v)) return v;
  // Safe timestamp keywords
  if (/^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NOW\(\)|LOCALTIMESTAMP)$/i.test(v)) {
    return targetType === 'postgresql' ? 'CURRENT_TIMESTAMP' : v;
  }
  // MySQL b'...' bit literal → skip for PG
  if (v.startsWith("b'")) return null;
  // MySQL parenthesised expression (generated column default, column reference, etc.)
  if (v.startsWith('(')) return null;
  // Anything else that looks like an identifier (column reference) → skip
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) return null;
  return null;
}

// Effective target column name — use targetName override when set
function tgtCol(c: ColumnMap): string { return c.targetName ?? c.targetCol; }

// Effective target table name — use targetAlias override when set
function resolveTargetTable(tableMap: TableMap): string {
  return tableMap.targetAlias?.trim() || tableMap.target.table;
}

// Disable or re-enable all triggers on a PG table (FK checks, etc.)
// Only relevant for PostgreSQL — MySQL handles FK checks differently.
async function setTriggers(conn: MigConn, schema: string, table: string, enable: boolean): Promise<void> {
  if (conn.type !== 'postgresql') return;
  const action = enable ? 'ENABLE' : 'DISABLE';
  await withPg(conn, async c => {
    await c.query(`ALTER TABLE "${schema}"."${table}" ${action} TRIGGER ALL`);
  });
}

// Drop or restore NOT NULL constraints on a PG table before/after insert.
// Returns the list of columns altered so the caller can restore the same set.
async function setNullable(
  conn: MigConn, schema: string, table: string, enable: boolean,
  log: (msg: string) => void, cols?: string[]
): Promise<string[]> {
  if (conn.type !== 'postgresql') return [];
  const altered: string[] = [];
  await withPg(conn, async c => {
    const targets = cols ?? await (async () => {
      const res = await c.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
           AND is_nullable = 'NO'
           AND (column_default IS NULL OR column_default NOT LIKE 'nextval%')`,
        [schema, table]
      );
      return res.rows.map(r => r.column_name);
    })();
    for (const col of targets) {
      try {
        const action = enable ? 'SET NOT NULL' : 'DROP NOT NULL';
        await c.query(`ALTER TABLE "${schema}"."${table}" ALTER COLUMN "${col}" ${action}`);
        altered.push(col);
      } catch (e) {
        log(`[${schema}.${table}] warn: cannot ${enable ? 'restore' : 'drop'} NOT NULL on "${col}": ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  });
  return altered;
}

export function buildCreateTableSQL(tableMap: TableMap, targetType: 'postgresql' | 'mysql'): string {
  const schema = tableMap.target.schema;
  const table = resolveTargetTable(tableMap);
  const cols = tableMap.columns.filter(c => c.include);

  const pkCol = cols.find(c => c.conversion === 'serial_to_uuid') ??
    cols.find(c => c.sourceCol && tgtCol(c).toLowerCase() === 'id');

  const colDefs = cols.map(c => {
    let type = c.targetType;
    const notNull = !c.nullable ? ' NOT NULL' : '';
    // UUID columns cannot accept numeric/expression defaults from MySQL source
    const rawDef = c.targetType.toLowerCase() === 'uuid' ? null : safeDdlDefault(c.defaultValue, targetType);
    const def = rawDef ? ` DEFAULT ${rawDef}` : '';
    if (targetType === 'postgresql') {
      return `  "${tgtCol(c)}" ${type}${notNull}${def}`;
    } else {
      return `  \`${tgtCol(c)}\` ${type}${notNull}${def}`;
    }
  });

  // Legacy columns: extra BIGINT to preserve the original serial integer alongside the UUID
  for (const c of cols) {
    if (c.keepLegacyAs && c.conversion === 'serial_to_uuid') {
      if (targetType === 'postgresql') {
        colDefs.push(`  "${c.keepLegacyAs}" BIGINT NULL`);
      } else {
        colDefs.push(`  \`${c.keepLegacyAs}\` BIGINT NULL`);
      }
    }
  }

  if (pkCol) {
    if (targetType === 'postgresql') {
      colDefs.push(`  PRIMARY KEY ("${tgtCol(pkCol)}")`);
    } else {
      colDefs.push(`  PRIMARY KEY (\`${tgtCol(pkCol)}\`)`);
    }
  }

  if (targetType === 'postgresql') {
    return `CREATE SCHEMA IF NOT EXISTS "${schema}";\n` +
      `CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (\n${colDefs.join(',\n')}\n);`;
  }
  return `CREATE TABLE IF NOT EXISTS \`${schema}\`.\`${table}\` (\n${colDefs.join(',\n')}\n);`;
}

// ── Value transformation ──────────────────────────────────────────────────────

function validDateParts(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Convert common MySQL/CSV temporal strings to an unambiguous PG value. */
function normalizeTemporal(val: unknown, kind: 'date' | 'time' | 'timestamp'): string | null {
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    const iso = val.toISOString();
    if (kind === 'date') return iso.slice(0, 10);
    if (kind === 'time') return iso.slice(11, 19);
    return iso.replace('T', ' ').slice(0, 19);
  }

  const raw = String(val).trim();
  if (!raw || /^0{4}-0{2}-0{2}/.test(raw) || /^\/?date(?:time)?\/?$/i.test(raw)) return null;

  if (kind === 'time') {
    const m = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/);
    if (!m) return null;
    const h = Number(m[1]), min = Number(m[2]), sec = Number(m[3] ?? 0);
    if (h > 23 || min > 59 || sec > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }

  // ISO/MySQL (Y-M-D) and legacy CSV (D/M/Y), with an optional time part.
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  let year: number, month: number, day: number, hour = 0, minute = 0, second = 0;
  if (m) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]);
    hour = Number(m[4] ?? 0); minute = Number(m[5] ?? 0); second = Number(m[6] ?? 0);
  } else {
    m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    day = Number(m[1]); month = Number(m[2]); year = Number(m[3]);
    hour = Number(m[4] ?? 0); minute = Number(m[5] ?? 0); second = Number(m[6] ?? 0);
  }
  if (!validDateParts(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (kind === 'date') return date;
  return `${date} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
}

function coerceValue(
  val: unknown, col: ColumnMap, tableMap: TableMap
): unknown {
  if (val === null || val === undefined) return null;

  if (col.conversion === 'serial_to_uuid') {
    const ns = `${tableMap.source.schema}.${tableMap.source.table}`;
    return seqToUUID(ns, String(val));
  }

  if (col.fkRef) {
    // Use only the last 2 parts (schema.table) as the namespace so that 3-part
    // cross-DB refs (database.schema.table) generate the same UUID as 2-part refs.
    const ns = col.fkRef.split('.').slice(-2).join('.');
    return seqToUUID(ns, String(val));
  }

  // Boolean coercions
  const t = col.targetType.toLowerCase();
  if (t === 'boolean' || t === 'bool') {
    if (typeof val === 'number') return val !== 0;
    if (typeof val === 'string') return val === '1' || val.toLowerCase() === 'true';
    return Boolean(val);
  }
  if (t.startsWith('tinyint(1)')) {
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  }

  // Sanitize temporal targets even when conversion is "keep". This handles
  // legacy VARCHAR dates as well as MySQL zero dates without touching source.
  if (col.conversion === 'to_date' || t === 'date') return normalizeTemporal(val, 'date');
  if (t === 'time' || t.startsWith('time(') || t.startsWith('time without') || t.startsWith('time with')) {
    return normalizeTemporal(val, 'time');
  }
  if (col.conversion === 'to_timestamptz' || t.includes('timestamp') || t === 'datetime') {
    return normalizeTemporal(val, 'timestamp');
  }

  // Date objects → ISO string for mysql
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString().replace('T', ' ').slice(0, 19);
  }

  return val;
}

function transformRow(
  row: Record<string, unknown>,
  tableMap: TableMap
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of tableMap.columns.filter(c => c.include)) {
    const outCol = tgtCol(col);
    if (col.sourceCol === null) {
      out[outCol] = col.defaultValue ?? null;
    } else {
      const originalVal = row[col.sourceCol];
      out[outCol] = coerceValue(originalVal, col, tableMap);
      if (col.keepLegacyAs && col.conversion === 'serial_to_uuid') {
        out[col.keepLegacyAs] = originalVal != null ? Number(originalVal) : null;
      }
    }
  }
  return out;
}

// Some legacy tables were populated from CSV with the CSV header stored as the
// first data row. Require at least two matching labels to avoid dropping a
// legitimate row that merely contains the word "date" or a column name.
function isEmbeddedHeaderRow(row: Record<string, unknown>, tableMap: TableMap): boolean {
  let matches = 0;
  for (const col of tableMap.columns.filter(c => c.include && c.sourceCol !== null)) {
    const raw = row[col.sourceCol as string];
    if (typeof raw !== 'string') continue;
    const value = raw.trim().replace(/^\/+|\/+$/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const source = (col.sourceCol as string).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (value === source || (value === 'datetime' && /date|time/.test(source))) matches++;
    if (matches >= 2) return true;
  }
  return false;
}

// ── Row insertion ─────────────────────────────────────────────────────────────

interface InsertResult {
  pks: string[];
  inserted: number;
  conflictSkipped: number; // rowCount=0 from ON CONFLICT DO NOTHING — intentional
  errored: number;         // exceptions — type errors, FK violations, etc.
  firstError: string | null;
}

async function insertRows(
  conn: MigConn, schema: string, table: string,
  rows: Record<string, unknown>[], targetPkCol: string | null,
  upsert = false
): Promise<InsertResult> {
  if (!rows.length) return { pks: [], inserted: 0, conflictSkipped: 0, errored: 0, firstError: null };
  const cols = Object.keys(rows[0]);
  const insertedPks: string[] = [];
  let actualInserted = 0;
  let conflictSkipped = 0;
  let errored = 0;
  let firstError: string | null = null;
  const updateCols = cols.filter(c => c !== targetPkCol);

  if (conn.type === 'postgresql') {
    await withPg(conn, async c => {
      const colList = cols.map(c => `"${c}"`).join(', ');
      for (const row of rows) {
        const values = cols.map(k => row[k]);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        let sql: string;
        if (upsert && targetPkCol && updateCols.length > 0) {
          const setClauses = updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
          sql = `INSERT INTO "${schema}"."${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT ("${targetPkCol}") DO UPDATE SET ${setClauses}`;
        } else {
          sql = `INSERT INTO "${schema}"."${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
        }
        try {
          const result = await c.query(sql, values);
          const written = result.rowCount ?? 0;
          if (written > 0) {
            actualInserted += written;
            if (targetPkCol && row[targetPkCol] != null) {
              insertedPks.push(String(row[targetPkCol]));
            }
          } else {
            conflictSkipped++;
          }
        } catch (err) {
          errored++;
          if (!firstError) firstError = err instanceof Error ? err.message : String(err);
        }
      }
    });
  } else {
    await withMysql(conn, async c => {
      const colList = cols.map(c => `\`${c}\``).join(', ');
      for (const row of rows) {
        const values = cols.map(k => row[k]);
        const placeholders = values.map(() => '?').join(', ');
        let sql: string;
        if (upsert && updateCols.length > 0) {
          const setClauses = updateCols.map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
          sql = `INSERT INTO \`${schema}\`.\`${table}\` (${colList}) VALUES (${placeholders}) ON DUPLICATE KEY UPDATE ${setClauses}`;
        } else {
          sql = `INSERT IGNORE INTO \`${schema}\`.\`${table}\` (${colList}) VALUES (${placeholders})`;
        }
        try {
          const [result] = await c.query(sql, values);
          const written = (result as { affectedRows?: number }).affectedRows ?? 0;
          if (written > 0) {
            actualInserted++;
            if (targetPkCol && row[targetPkCol] != null) {
              insertedPks.push(String(row[targetPkCol]));
            }
          } else {
            conflictSkipped++;
          }
        } catch (err) {
          errored++;
          if (!firstError) firstError = err instanceof Error ? err.message : String(err);
        }
      }
    });
  }

  return { pks: insertedPks, inserted: actualInserted, conflictSkipped, errored, firstError };
}

// ── Ensure target schema + table exist ───────────────────────────────────────

async function ensureTargetTable(conn: MigConn, tableMap: TableMap): Promise<void> {
  const schema = tableMap.target.schema;
  const table  = resolveTargetTable(tableMap);
  const ddl    = buildCreateTableSQL(tableMap, conn.type);

  // Columns that must exist but won't be in CREATE TABLE IF NOT EXISTS when the
  // table already exists: keepLegacyAs BIGINT columns and target-only new columns.
  const extraCols: { name: string; type: string; nullable: boolean }[] = [];
  for (const c of tableMap.columns.filter(col => col.include)) {
    if (c.keepLegacyAs && c.conversion === 'serial_to_uuid') {
      extraCols.push({ name: c.keepLegacyAs, type: 'BIGINT', nullable: true });
    }
    if (c.sourceCol === null) {
      // target-only column — may not exist in an existing table
      extraCols.push({ name: tgtCol(c), type: c.targetType || 'TEXT', nullable: c.nullable });
    }
  }

  if (conn.type === 'postgresql') {
    await withPg(conn, async c => {
      const stmts = ddl.split(';\n').map(s => s.trim()).filter(Boolean);
      for (const s of stmts) {
        await c.query(s);
      }
      // Ensure extra columns exist (ADD COLUMN IF NOT EXISTS — PG 9.6+)
      for (const col of extraCols) {
        const nn = col.nullable ? '' : ' NOT NULL';
        await c.query(
          `ALTER TABLE "${schema}"."${table}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}${nn}`
        );
      }
    });
  } else {
    await withMysql(conn, async c => {
      await c.query(ddl);
      // MySQL: ADD COLUMN IF NOT EXISTS (8.0.3+); fall back to silent ignore on duplicate
      for (const col of extraCols) {
        const nn = col.nullable ? '' : ' NOT NULL';
        try {
          await c.query(
            `ALTER TABLE \`${schema}\`.\`${table}\` ADD COLUMN IF NOT EXISTS \`${col.name}\` ${col.type}${nn}`
          );
        } catch {
          // MySQL < 8.0.3 doesn't support IF NOT EXISTS — ignore duplicate column error (1060)
        }
      }
    });
  }
}

// ── Auto-discover columns from source schema (fresh migration, no mapping) ────

async function fetchSourceColumns(
  conn: MigConn,
  schema: string,
  table: string,
  targetType: DbType,
): Promise<ColumnMap[]> {
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const { rows } = await c.query<any>(`
        SELECT c.column_name, c.udt_name, c.data_type,
          c.character_maximum_length, c.numeric_precision, c.numeric_scale,
          c.is_nullable, c.column_default
        FROM information_schema.columns c
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position
      `, [schema, table]);
      return rows.map((c: any): ColumnMap => {
        let rawType: string = c.udt_name;
        if (c.character_maximum_length) rawType += `(${c.character_maximum_length})`;
        else if (c.numeric_precision && ['numeric', 'decimal'].includes(c.data_type))
          rawType += `(${c.numeric_precision},${c.numeric_scale ?? 0})`;
        return {
          sourceCol: c.column_name, targetCol: c.column_name, targetName: null,
          targetType: suggestTargetType(rawType, 'postgresql', targetType),
          nullable: c.is_nullable === 'YES', defaultValue: c.column_default ?? null,
          include: true, conversion: 'keep', fkRef: null, keepLegacyAs: null,
        };
      });
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query<any[]>(`
      SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION
    `, [schema, table]);
    return (rows as any[]).map((c): ColumnMap => ({
      sourceCol: c.COLUMN_NAME, targetCol: c.COLUMN_NAME, targetName: null,
      targetType: suggestTargetType(c.COLUMN_TYPE, 'mysql', targetType),
      nullable: c.IS_NULLABLE === 'YES', defaultValue: c.COLUMN_DEFAULT ?? null,
      include: true, conversion: 'keep', fkRef: null, keepLegacyAs: null,
    }));
  });
}

// ── Advance: migrate one chunk for all pending/running tables ─────────────────

export async function advanceRun(
  run: MigRun,
  source: MigConn,
  target: MigConn,
  pausedTableIds: string[] = []
): Promise<MigRun> {
  const deadline = Date.now() + MAX_ADVANCE_MS;
  run.startedAt ??= new Date().toISOString();
  run.status = 'running';

  function log(msg: string) {
    run.logs.push(`[${new Date().toISOString()}] ${msg}`);
    if (run.logs.length > 2000) run.logs = run.logs.slice(-2000);
  }

  // Track which columns had NOT NULL dropped per table (for restore after completion)
  const nullDroppedCols = new Map<string, string[]>(); // tableState.id → column names

  for (const ts of run.tableStates) {
    if (ts.status !== 'pending' && ts.status !== 'running') continue;
    if (pausedTableIds.includes(ts.id)) continue;
    if (Date.now() > deadline) break;

    const tableMap = run.tables.find(t => t.id === ts.id);
    if (!tableMap || !tableMap.include) { ts.status = 'completed'; continue; }

    try {
      ts.status = 'running';

      // Build incremental filter (only when syncMode=incremental and a prior watermark exists)
      const isIncremental = tableMap.syncMode === 'incremental' && !!tableMap.incrementalCol;
      const incFilter: IncrementalFilter | undefined =
        isIncremental && tableMap.lastSyncedValue
          ? { col: tableMap.incrementalCol!, gt: tableMap.lastSyncedValue }
          : undefined;
      const useUpsert = isIncremental && tableMap.incrementalStrategy === 'timestamp';

      // Build job-level date-range filter (applies to every table in the run)
      const rangeFilter: RangeFilter | undefined =
        run.filterCol
          ? { col: run.filterCol, from: run.filterFrom ?? null, to: run.filterTo ?? null }
          : undefined;

      // Per-table source conn: override database from tableMap.sourceDatabase if set
      const tableSource: MigConn = tableMap.sourceDatabase && tableMap.sourceDatabase !== source.database
        ? { ...source, database: tableMap.sourceDatabase }
        : source;

      // Fresh migration: no column mapping configured — auto-discover from source schema
      if (tableMap.columns.length === 0) {
        try {
          const discovered = await fetchSourceColumns(
            tableSource, tableMap.source.schema, tableMap.source.table, target.type
          );
          if (!discovered.length) {
            ts.status = 'completed';
            log(`[${ts.sourceKey}] source table has no columns, skipping`);
            continue;
          }
          tableMap.columns = discovered;
          log(`[${ts.sourceKey}] auto-discovered ${discovered.length} columns`);
        } catch (err) {
          ts.status = 'failed';
          ts.error = err instanceof Error ? err.message : String(err);
          log(`[${ts.sourceKey}] failed to auto-discover columns: ${ts.error}`);
          run.errors.push(ts.error);
          continue;
        }
      }

      // Count source rows (once)
      if (ts.rowsSource === 0 && ts.offset === 0) {
        ts.rowsSource = await countRows(tableSource, tableMap.source.schema, tableMap.source.table, incFilter, rangeFilter);
        run.totalRows = run.tableStates.reduce((s, t) => s + t.rowsSource, 0);
        const filterDesc = [
          isIncremental ? `incremental since ${tableMap.lastSyncedValue ?? 'beginning'}` : '',
          rangeFilter ? `range ${rangeFilter.from ?? '*'} → ${rangeFilter.to ?? '*'}` : '',
        ].filter(Boolean).join(', ');
        log(`[${ts.sourceKey}] source rows: ${ts.rowsSource}${filterDesc ? ` (${filterDesc})` : ''}`);
      }

      // Ensure target table exists (first chunk only) — must run before TRUNCATE
      // so that auto-created tables exist before we try to truncate them.
      if (ts.offset === 0) {
        await ensureTargetTable(target, tableMap);
        log(`[${ts.targetKey}] table ready`);
      }

      // Truncate target if requested (first chunk only)
      if (ts.offset === 0 && tableMap.truncateBeforeMigrate) {
        const schema = tableMap.target.schema;
        const table = resolveTargetTable(tableMap);
        if (target.type === 'postgresql') {
          await withPg(target, c => c.query(`TRUNCATE "${schema}"."${table}" CASCADE`).then(() => undefined));
        } else {
          await withMysql(target, c => c.query(`TRUNCATE TABLE \`${schema}\`.\`${table}\``).then(() => undefined));
        }
        log(`[${ts.targetKey}] truncated`);
      }

      // Disable constraints after table is guaranteed to exist
      if (ts.offset === 0 && tableMap.skipConstraints) {
        await setTriggers(target, tableMap.target.schema, resolveTargetTable(tableMap), false);
        log(`[${ts.targetKey}] constraints disabled`);
      }

      // Drop NOT NULL on target columns (first chunk only)
      if (ts.offset === 0 && tableMap.skipNullViolations) {
        const dropped = await setNullable(target, tableMap.target.schema, resolveTargetTable(tableMap), false, log);
        if (dropped.length) {
          nullDroppedCols.set(ts.id, dropped);
          log(`[${ts.targetKey}] NOT NULL dropped on: ${dropped.join(', ')}`);
        }
      }

      // Determine which source columns to SELECT
      const srcCols = tableMap.columns
        .filter(c => c.include && c.sourceCol !== null)
        .map(c => c.sourceCol as string);

      if (!srcCols.length) {
        ts.status = 'completed';
        log(`[${ts.sourceKey}] no columns mapped, skipping`);
        continue;
      }

      // Find target PK column
      const pkColMap = tableMap.columns.find(c =>
        c.include && (c.conversion === 'serial_to_uuid' || tgtCol(c).toLowerCase() === 'id')
      );
      ts.targetPkCol = pkColMap ? tgtCol(pkColMap) : null;

      // Read chunk
      const chunk = await readChunk(
        tableSource, tableMap.source.schema, tableMap.source.table,
        srcCols, ts.offset, CHUNK_SIZE, incFilter, rangeFilter
      );

      if (!chunk.length) {
        ts.hasMore = false;
        ts.status = 'completed';
        if (tableMap.skipConstraints) {
          await setTriggers(target, tableMap.target.schema, resolveTargetTable(tableMap), true);
          log(`[${ts.targetKey}] constraints re-enabled`);
        }
        if (tableMap.skipNullViolations) {
          await setNullable(target, tableMap.target.schema, resolveTargetTable(tableMap), true, log, nullDroppedCols.get(ts.id));
          log(`[${ts.targetKey}] NOT NULL restored`);
        }
        log(`[${ts.sourceKey}] completed (${ts.rowsMigrated} rows)`);
        run.migratedRows = run.tableStates.reduce((s, t) => s + t.rowsMigrated, 0);
        // Record watermark even when no new rows (source max may have advanced)
        if (isIncremental && tableMap.incrementalCol) {
          const wm = await getMaxValue(tableSource, tableMap.source.schema, tableMap.source.table, tableMap.incrementalCol);
          ts.newWatermark = wm;
          if (wm) log(`[${ts.sourceKey}] watermark updated → ${wm} (no new rows)`);
        }
        continue;
      }

      // Remove accidental CSV header rows before transforming typed values.
      const dataRows = chunk.filter(row => !isEmbeddedHeaderRow(row, tableMap));
      const embeddedHeaders = chunk.length - dataRows.length;
      if (embeddedHeaders > 0) log(`[${ts.sourceKey}] skipped ${embeddedHeaders} embedded CSV header row(s)`);
      const transformed = dataRows.map(row => transformRow(row, tableMap));

      // Insert into target (upsert when incremental by timestamp)
      const insertResult = await insertRows(
        target, tableMap.target.schema, resolveTargetTable(tableMap),
        transformed, ts.targetPkCol, useUpsert
      );

      // Accumulate rollback PKs (up to cap) — only actually-inserted rows
      if (!ts.pkOverflow) {
        const space = MAX_ROLLBACK_PKS - ts.insertedPks.length;
        if (space > 0) {
          ts.insertedPks.push(...insertResult.pks.slice(0, space));
        }
        if (ts.insertedPks.length >= MAX_ROLLBACK_PKS && insertResult.pks.length > space) {
          ts.pkOverflow = true;
        }
      }

      ts.offset += chunk.length;
      ts.rowsMigrated += insertResult.inserted;
      ts.rowsSkipped  += insertResult.conflictSkipped + embeddedHeaders;
      ts.rowsErrored  += insertResult.errored;
      run.migratedRows = run.tableStates.reduce((s, t) => s + t.rowsMigrated, 0);

      const parts: string[] = [];
      if (insertResult.inserted > 0)        parts.push(`${insertResult.inserted} written`);
      if (insertResult.conflictSkipped > 0)  parts.push(`${insertResult.conflictSkipped} skipped (already exist)`);
      if (insertResult.errored > 0)          parts.push(`${insertResult.errored} errors`);
      if (parts.length > 1 || insertResult.errored > 0) log(`[${ts.sourceKey}] ${parts.join(', ')}`);
      if (insertResult.firstError) log(`[${ts.sourceKey}] ERROR: ${insertResult.firstError}`);

      if (chunk.length < CHUNK_SIZE) {
        ts.hasMore = false;
        ts.status = 'completed';
        if (tableMap.skipConstraints) {
          await setTriggers(target, tableMap.target.schema, resolveTargetTable(tableMap), true);
          log(`[${ts.targetKey}] constraints re-enabled`);
        }
        if (tableMap.skipNullViolations) {
          await setNullable(target, tableMap.target.schema, resolveTargetTable(tableMap), true, log, nullDroppedCols.get(ts.id));
          log(`[${ts.targetKey}] NOT NULL restored`);
        }
        log(`[${ts.sourceKey}] completed (${ts.rowsMigrated} rows)`);
        // Record new high-water mark for incremental sync
        if (isIncremental && tableMap.incrementalCol) {
          const wm = await getMaxValue(tableSource, tableMap.source.schema, tableMap.source.table, tableMap.incrementalCol);
          ts.newWatermark = wm;
          if (wm) log(`[${ts.sourceKey}] watermark updated → ${wm}`);
        }
      } else {
        ts.hasMore = true;
        log(`[${ts.sourceKey}] offset ${ts.offset} / ~${ts.rowsSource}`);
      }
    } catch (err) {
      ts.status = 'failed';
      ts.error = err instanceof Error ? err.message : String(err);
      run.errors.push(`${ts.sourceKey}: ${ts.error}`);
      log(`[${ts.sourceKey}] ERROR: ${ts.error}`);
      // Best-effort re-enable constraints so the table is not left in a broken state
      if (tableMap.skipConstraints) {
        try {
          await setTriggers(target, tableMap.target.schema, resolveTargetTable(tableMap), true);
          log(`[${ts.targetKey}] constraints re-enabled (after error)`);
        } catch { /* ignore — table may not exist */ }
      }
      if (tableMap.skipNullViolations) {
        try {
          await setNullable(target, tableMap.target.schema, resolveTargetTable(tableMap), true, log, nullDroppedCols.get(ts.id));
          log(`[${ts.targetKey}] NOT NULL restored (after error)`);
        } catch { /* ignore */ }
      }
    }
  }

  // Check overall completion
  const allDone = run.tableStates.every(t => t.status === 'completed' || t.status === 'failed' || t.status === 'rolled_back');
  const anyFailed = run.tableStates.some(t => t.status === 'failed');
  if (allDone) {
    run.status = anyFailed ? 'failed' : 'completed';
    run.completedAt = new Date().toISOString();
    log(`Run ${run.status}. Total: ${run.migratedRows} rows migrated.`);
  }

  return run;
}

// ── Rollback ──────────────────────────────────────────────────────────────────

// Rollback a single table by tableMap id. Run status is NOT changed — other tables are unaffected.
export async function rollbackTable(
  run: MigRun,
  tableId: string,
  target: MigConn,
  dropTable = false
): Promise<MigRun> {
  function log(msg: string) {
    run.logs.push(`[${new Date().toISOString()}] ROLLBACK: ${msg}`);
  }

  const ts = run.tableStates.find(t => t.id === tableId);
  if (!ts) { log(`table ${tableId} not found in run`); return run; }
  if (ts.status !== 'completed' && ts.status !== 'failed') {
    log(`${ts.sourceKey}: cannot rollback — status is ${ts.status}`);
    return run;
  }

  const tableMap = run.tables.find(t => t.id === tableId);
  if (!tableMap) { log(`tableMap ${tableId} missing`); return run; }

  const schema = tableMap.target.schema;
  const table = resolveTargetTable(tableMap);
  try {
    if (ts.pkOverflow || !ts.targetPkCol || !ts.insertedPks.length) {
      if (target.type === 'postgresql') {
        await withPg(target, c => c.query(`TRUNCATE "${schema}"."${table}" CASCADE`).then(() => undefined));
      } else {
        await withMysql(target, c => c.query(`TRUNCATE TABLE \`${schema}\`.\`${table}\``).then(() => undefined));
      }
      log(`${ts.targetKey}: truncated (${ts.pkOverflow ? 'pk list overflowed' : 'no pk tracked'})`);
    } else {
      const pkCol = ts.targetPkCol;
      if (target.type === 'postgresql') {
        const phs = ts.insertedPks.map((_, i) => `$${i + 1}`).join(', ');
        await withPg(target, c =>
          c.query(`DELETE FROM "${schema}"."${table}" WHERE "${pkCol}" IN (${phs})`, ts.insertedPks).then(() => undefined)
        );
      } else {
        const phs = ts.insertedPks.map(() => '?').join(', ');
        await withMysql(target, c =>
          c.query(`DELETE FROM \`${schema}\`.\`${table}\` WHERE \`${pkCol}\` IN (${phs})`, ts.insertedPks).then(() => undefined)
        );
      }
      log(`${ts.targetKey}: deleted ${ts.insertedPks.length} rows`);
    }
    ts.status = 'rolled_back';
    if (dropTable) {
      if (target.type === 'postgresql') {
        await withPg(target, c => c.query(`DROP TABLE IF EXISTS "${schema}"."${table}" CASCADE`).then(() => undefined));
      } else {
        await withMysql(target, c => c.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${table}\``).then(() => undefined));
      }
      log(`${ts.targetKey}: table dropped`);
    }
  } catch (err) {
    log(`${ts.targetKey} rollback ERROR: ${err instanceof Error ? err.message : String(err)}`);
  }

  return run;
}

export async function rollbackRun(
  run: MigRun,
  target: MigConn,
  dropTable = false
): Promise<MigRun> {
  function log(msg: string) {
    run.logs.push(`[${new Date().toISOString()}] ROLLBACK: ${msg}`);
  }

  for (const ts of run.tableStates) {
    if (ts.status !== 'completed' && ts.status !== 'failed') continue;
    const tableMap = run.tables.find(t => t.id === ts.id);
    if (!tableMap) continue;

    const schema = tableMap.target.schema;
    const table = resolveTargetTable(tableMap);

    try {
      if (ts.pkOverflow || !ts.targetPkCol || !ts.insertedPks.length) {
        // Fallback: truncate (user accepted this risk)
        if (target.type === 'postgresql') {
          await withPg(target, c => c.query(`TRUNCATE "${schema}"."${table}" CASCADE`).then(() => undefined));
        } else {
          await withMysql(target, c => c.query(`TRUNCATE TABLE \`${schema}\`.\`${table}\``).then(() => undefined));
        }
        log(`${ts.targetKey}: truncated (${ts.pkOverflow ? 'pk list overflowed' : 'no pk tracked'})`);
      } else {
        const pkCol = ts.targetPkCol;
        if (target.type === 'postgresql') {
          const phs = ts.insertedPks.map((_, i) => `$${i + 1}`).join(', ');
          await withPg(target, c =>
            c.query(`DELETE FROM "${schema}"."${table}" WHERE "${pkCol}" IN (${phs})`, ts.insertedPks).then(() => undefined)
          );
        } else {
          const phs = ts.insertedPks.map(() => '?').join(', ');
          await withMysql(target, c =>
            c.query(`DELETE FROM \`${schema}\`.\`${table}\` WHERE \`${pkCol}\` IN (${phs})`, ts.insertedPks).then(() => undefined)
          );
        }
        log(`${ts.targetKey}: deleted ${ts.insertedPks.length} rows`);
      }
      ts.status = 'rolled_back';
      if (dropTable) {
        try {
          if (target.type === 'postgresql') {
            await withPg(target, c => c.query(`DROP TABLE IF EXISTS "${schema}"."${table}" CASCADE`).then(() => undefined));
          } else {
            await withMysql(target, c => c.query(`DROP TABLE IF EXISTS \`${schema}\`.\`${table}\``).then(() => undefined));
          }
          log(`${ts.targetKey}: table dropped`);
        } catch (dropErr) {
          log(`${ts.targetKey} DROP ERROR: ${dropErr instanceof Error ? dropErr.message : String(dropErr)}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${ts.targetKey} rollback ERROR: ${msg}`);
    }
  }

  run.status = 'rolled_back';
  return run;
}

// ── Export migration.md ───────────────────────────────────────────────────────

export function buildMigrationMd(run: MigRun): string {
  const lines: string[] = [
    `# Migration Report`,
    ``,
    `**Run ID:** \`${run.id}\`  `,
    `**Job:** ${run.jobName}  `,
    `**Status:** ${run.status}  `,
    `**Created:** ${run.createdAt}  `,
    run.startedAt ? `**Started:** ${run.startedAt}  ` : '',
    run.completedAt ? `**Completed:** ${run.completedAt}  ` : '',
    ``,
    `## Connections`,
    ``,
    `| | Type | Host | Database |`,
    `|---|---|---|---|`,
    `| **Source** | ${run.sourceMeta.type} | ${run.sourceMeta.host}:${run.sourceMeta.port} | ${run.sourceMeta.database} |`,
    `| **Target** | ${run.targetMeta.type} | ${run.targetMeta.host}:${run.targetMeta.port} | ${run.targetMeta.database} |`,
    ``,
    `## Tables (${run.tables.filter(t => t.include).length} included)`,
    ``,
  ];

  for (const tm of run.tables.filter(t => t.include)) {
    const ts = run.tableStates.find(s => s.id === tm.id);
    lines.push(`### \`${tm.source.schema}.${tm.source.table}\` → \`${tm.target.schema}.${resolveTargetTable(tm)}\``);
    lines.push(``);
    if (ts) {
      lines.push(`**Status:** ${ts.status} | **Rows:** ${ts.rowsMigrated} / ${ts.rowsSource}`);
      if (ts.error) lines.push(`**Error:** ${ts.error}`);
    }
    lines.push(``);
    lines.push(`| Source Column | Source Type | Target Column | Target Type | Conversion | FK Ref |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const c of tm.columns.filter(c => c.include)) {
      lines.push(`| ${c.sourceCol ?? '*(new)*'} | — | ${c.targetCol} | ${c.targetType} | ${c.conversion} | ${c.fkRef ?? '—'} |`);
    }
    lines.push(``);

    // Rollback info
    if (ts && ts.insertedPks.length > 0) {
      const schema = tm.target.schema;
      const table = resolveTargetTable(tm);
      const pkCol = ts.targetPkCol ?? 'id';
      lines.push(`**Rollback SQL:**`);
      lines.push(`\`\`\`sql`);
      if (ts.pkOverflow) {
        lines.push(`-- WARNING: more than ${MAX_ROLLBACK_PKS} rows were inserted. Manual rollback needed.`);
        lines.push(`TRUNCATE "${schema}"."${table}" CASCADE; -- or adjust as needed`);
      } else {
        const ids = ts.insertedPks.map(p => `'${p}'`).join(', ');
        lines.push(`DELETE FROM "${schema}"."${table}" WHERE "${pkCol}" IN (${ids});`);
      }
      lines.push(`\`\`\``);
      lines.push(``);
    }
  }

  if (run.errors.length) {
    lines.push(`## Errors`);
    lines.push(``);
    run.errors.forEach(e => lines.push(`- ${e}`));
    lines.push(``);
  }

  return lines.filter(l => l !== undefined).join('\n');
}
