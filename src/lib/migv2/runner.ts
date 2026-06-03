import { createHash, randomUUID } from 'crypto';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import type { MigConn, MigRun, MigRunTableState, TableMap, ColumnMap } from './types';

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
  });
  try { return await fn(c); } finally { await c.end(); }
}

// ── Row reading ───────────────────────────────────────────────────────────────

interface IncrementalFilter { col: string; gt: string; }

async function countRows(
  conn: MigConn, schema: string, table: string,
  filter?: IncrementalFilter
): Promise<number> {
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const where = filter ? `WHERE "${filter.col}" > $1` : '';
      const params = filter ? [filter.gt] : [];
      const { rows } = await c.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM "${schema}"."${table}" ${where}`, params
      );
      return Number(rows[0].n);
    });
  }
  return withMysql(conn, async c => {
    const where = filter ? `WHERE \`${filter.col}\` > ?` : '';
    const params = filter ? [filter.gt] : [];
    const [rows] = await c.query<any[]>(
      `SELECT COUNT(*) AS n FROM \`${schema}\`.\`${table}\` ${where}`, params
    );
    return Number((rows as any[])[0].n);
  });
}

async function readChunk(
  conn: MigConn, schema: string, table: string,
  cols: string[], offset: number, limit: number,
  filter?: IncrementalFilter
): Promise<Record<string, unknown>[]> {
  const colList = cols.map(c => conn.type === 'postgresql' ? `"${c}"` : `\`${c}\``).join(', ');

  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      if (filter) {
        const { rows } = await c.query(
          `SELECT ${colList} FROM "${schema}"."${table}" WHERE "${filter.col}" > $1 ORDER BY "${filter.col}" ASC LIMIT $2 OFFSET $3`,
          [filter.gt, limit, offset]
        );
        return rows;
      }
      const { rows } = await c.query(
        `SELECT ${colList} FROM "${schema}"."${table}" LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      return rows;
    });
  }
  return withMysql(conn, async c => {
    if (filter) {
      const [rows] = await c.query(
        `SELECT ${colList} FROM \`${schema}\`.\`${table}\` WHERE \`${filter.col}\` > ? ORDER BY \`${filter.col}\` ASC LIMIT ? OFFSET ?`,
        [filter.gt, limit, offset]
      );
      return rows as Record<string, unknown>[];
    }
    const [rows] = await c.query(
      `SELECT ${colList} FROM \`${schema}\`.\`${table}\` LIMIT ? OFFSET ?`,
      [limit, offset]
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

export function buildCreateTableSQL(tableMap: TableMap, targetType: 'postgresql' | 'mysql'): string {
  const { schema, table } = tableMap.target;
  const cols = tableMap.columns.filter(c => c.include);

  const pkCol = cols.find(c => c.conversion === 'serial_to_uuid') ??
    cols.find(c => c.sourceCol && c.targetCol.toLowerCase() === 'id');

  const colDefs = cols.map(c => {
    let type = c.targetType;
    const notNull = !c.nullable ? ' NOT NULL' : '';
    // UUID columns cannot accept numeric/expression defaults from MySQL source
    const rawDef = c.targetType.toLowerCase() === 'uuid' ? null : safeDdlDefault(c.defaultValue, targetType);
    const def = rawDef ? ` DEFAULT ${rawDef}` : '';
    if (targetType === 'postgresql') {
      return `  "${c.targetCol}" ${type}${notNull}${def}`;
    } else {
      return `  \`${c.targetCol}\` ${type}${notNull}${def}`;
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
      colDefs.push(`  PRIMARY KEY ("${pkCol.targetCol}")`);
    } else {
      colDefs.push(`  PRIMARY KEY (\`${pkCol.targetCol}\`)`);
    }
  }

  if (targetType === 'postgresql') {
    return `CREATE SCHEMA IF NOT EXISTS "${schema}";\n` +
      `CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (\n${colDefs.join(',\n')}\n);`;
  }
  return `CREATE TABLE IF NOT EXISTS \`${schema}\`.\`${table}\` (\n${colDefs.join(',\n')}\n);`;
}

// ── Value transformation ──────────────────────────────────────────────────────

function coerceValue(
  val: unknown, col: ColumnMap, tableMap: TableMap
): unknown {
  if (val === null || val === undefined) return null;

  if (col.conversion === 'serial_to_uuid') {
    const ns = `${tableMap.source.schema}.${tableMap.source.table}`;
    return seqToUUID(ns, String(val));
  }

  if (col.fkRef) {
    return seqToUUID(col.fkRef, String(val));
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

  // Date objects → ISO string for mysql
  if (val instanceof Date) return val.toISOString().replace('T', ' ').slice(0, 19);

  return val;
}

function transformRow(
  row: Record<string, unknown>,
  tableMap: TableMap
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const col of tableMap.columns.filter(c => c.include)) {
    if (col.sourceCol === null) {
      // target-only column: use default (null or literal)
      out[col.targetCol] = col.defaultValue ?? null;
    } else {
      const originalVal = row[col.sourceCol];
      out[col.targetCol] = coerceValue(originalVal, col, tableMap);
      // Preserve original serial integer in the legacy column alongside the UUID
      if (col.keepLegacyAs && col.conversion === 'serial_to_uuid') {
        out[col.keepLegacyAs] = originalVal != null ? Number(originalVal) : null;
      }
    }
  }
  return out;
}

// ── Row insertion ─────────────────────────────────────────────────────────────

async function insertRows(
  conn: MigConn, schema: string, table: string,
  rows: Record<string, unknown>[], targetPkCol: string | null,
  upsert = false
): Promise<string[]> {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const insertedPks: string[] = [];
  // Columns to update on conflict (exclude PK)
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
          await c.query(sql, values);
          if (targetPkCol && row[targetPkCol] != null) {
            insertedPks.push(String(row[targetPkCol]));
          }
        } catch { /* skip conflicting rows */ }
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
          await c.query(sql, values);
          if (targetPkCol && row[targetPkCol] != null) {
            insertedPks.push(String(row[targetPkCol]));
          }
        } catch { /* skip conflicting rows */ }
      }
    });
  }

  return insertedPks;
}

// ── Ensure target schema + table exist ───────────────────────────────────────

async function ensureTargetTable(conn: MigConn, tableMap: TableMap): Promise<void> {
  const ddl = buildCreateTableSQL(tableMap, conn.type);
  if (conn.type === 'postgresql') {
    await withPg(conn, async c => {
      // Run schema + table creation separately
      const stmts = ddl.split(';\n').map(s => s.trim()).filter(Boolean);
      for (const s of stmts) {
        await c.query(s);
      }
    });
  } else {
    await withMysql(conn, async c => {
      await c.query(ddl);
    });
  }
}

// ── Advance: migrate one chunk for all pending/running tables ─────────────────

export async function advanceRun(
  run: MigRun,
  source: MigConn,
  target: MigConn
): Promise<MigRun> {
  const deadline = Date.now() + MAX_ADVANCE_MS;
  run.startedAt ??= new Date().toISOString();
  run.status = 'running';

  function log(msg: string) {
    run.logs.push(`[${new Date().toISOString()}] ${msg}`);
    if (run.logs.length > 2000) run.logs = run.logs.slice(-2000);
  }

  for (const ts of run.tableStates) {
    if (ts.status !== 'pending' && ts.status !== 'running') continue;
    if (Date.now() > deadline) break;

    const tableMap = run.tables.find(t => t.id === ts.id);
    if (!tableMap || !tableMap.include) { ts.status = 'completed'; continue; }

    try {
      ts.status = 'running';

      // Build incremental filter (only when syncMode=incremental and a prior watermark exists)
      const isIncremental = tableMap.syncMode === 'incremental' && !!tableMap.incrementalCol;
      const filter: IncrementalFilter | undefined =
        isIncremental && tableMap.lastSyncedValue
          ? { col: tableMap.incrementalCol!, gt: tableMap.lastSyncedValue }
          : undefined;
      const useUpsert = isIncremental && tableMap.incrementalStrategy === 'timestamp';

      // Per-table source conn: override database from tableMap.sourceDatabase if set
      const tableSource: MigConn = tableMap.sourceDatabase && tableMap.sourceDatabase !== source.database
        ? { ...source, database: tableMap.sourceDatabase }
        : source;

      // Count source rows (once)
      if (ts.rowsSource === 0 && ts.offset === 0) {
        ts.rowsSource = await countRows(tableSource, tableMap.source.schema, tableMap.source.table, filter);
        run.totalRows = run.tableStates.reduce((s, t) => s + t.rowsSource, 0);
        log(`[${ts.sourceKey}] source rows: ${ts.rowsSource}${isIncremental ? ` (incremental, since ${tableMap.lastSyncedValue ?? 'beginning'})` : ''}`);
      }

      // Truncate target if requested (first chunk only)
      if (ts.offset === 0 && tableMap.truncateBeforeMigrate) {
        const { schema, table } = tableMap.target;
        if (target.type === 'postgresql') {
          await withPg(target, c => c.query(`TRUNCATE "${schema}"."${table}" CASCADE`).then(() => undefined));
        } else {
          await withMysql(target, c => c.query(`TRUNCATE TABLE \`${schema}\`.\`${table}\``).then(() => undefined));
        }
        log(`[${ts.targetKey}] truncated`);
      }

      // Ensure target table exists (first chunk only)
      if (ts.offset === 0) {
        await ensureTargetTable(target, tableMap);
        log(`[${ts.targetKey}] table ready`);
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
        c.include && (c.conversion === 'serial_to_uuid' || c.targetCol.toLowerCase() === 'id')
      );
      ts.targetPkCol = pkColMap?.targetCol ?? null;

      // Read chunk
      const chunk = await readChunk(
        tableSource, tableMap.source.schema, tableMap.source.table,
        srcCols, ts.offset, CHUNK_SIZE, filter
      );

      if (!chunk.length) {
        ts.hasMore = false;
        ts.status = 'completed';
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

      // Transform rows
      const transformed = chunk.map(row => transformRow(row, tableMap));

      // Insert into target (upsert when incremental by timestamp)
      const pks = await insertRows(
        target, tableMap.target.schema, tableMap.target.table,
        transformed, ts.targetPkCol, useUpsert
      );

      // Accumulate rollback PKs (up to cap)
      if (!ts.pkOverflow) {
        const space = MAX_ROLLBACK_PKS - ts.insertedPks.length;
        if (space > 0) {
          ts.insertedPks.push(...pks.slice(0, space));
        }
        if (ts.insertedPks.length >= MAX_ROLLBACK_PKS && pks.length > space) {
          ts.pkOverflow = true;
        }
      }

      ts.offset += chunk.length;
      ts.rowsMigrated += chunk.length;
      run.migratedRows = run.tableStates.reduce((s, t) => s + t.rowsMigrated, 0);

      if (chunk.length < CHUNK_SIZE) {
        ts.hasMore = false;
        ts.status = 'completed';
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

  const { schema, table } = tableMap.target;
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

    const { schema, table } = tableMap.target;

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
    lines.push(`### \`${tm.source.schema}.${tm.source.table}\` → \`${tm.target.schema}.${tm.target.table}\``);
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
      const { schema, table } = tm.target;
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
