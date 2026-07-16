import { createHash, randomUUID } from 'crypto';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { Client as PgClient } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import mysql from 'mysql2/promise';
import type { MigConn, MigRun, TableMap, ColumnMap, DbType, MigRunReject } from './types';
import { suggestTargetType } from './type-map';
import { runWithTableWorkerLimit } from './table-worker-pool';
import { usesUpsertStrategy } from './sync-strategy';
import { buildWhere, cursorValue, type IncrementalFilter, type RangeFilter } from './cursor-query';
import { runChunkRows } from './execution-policy';

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
  inc?: IncrementalFilter, range?: RangeFilter,
  useKeyset = false,
): Promise<Record<string, unknown>[]> {
  const colList = cols.map(c => conn.type === 'postgresql' ? `"${c}"` : `\`${c}\``).join(', ');
  const { where, params, orderCols } = buildWhere(conn.type, inc, range);
  const orderBy = orderCols.length
    ? `ORDER BY ${orderCols.map(col => conn.type === 'postgresql' ? `"${col}" ASC` : `\`${col}\` ASC`).join(', ')}`
    : '';

  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const nextIdx = params.length + 1;
      const { rows } = await c.query(
        `SELECT ${colList} FROM "${schema}"."${table}" ${where} ${orderBy} LIMIT $${nextIdx} OFFSET $${nextIdx + 1}`,
        [...params, limit, useKeyset ? 0 : offset]
      );
      return rows;
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query(
      `SELECT ${colList} FROM \`${schema}\`.\`${table}\` ${where} ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, useKeyset ? 0 : offset]
    );
    return rows as Record<string, unknown>[];
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

// Legacy recovery for runs created before constraint bypass became transaction-scoped.
// New runs never leave triggers disabled because SET LOCAL is rolled back with the
// transaction if the process or connection stops unexpectedly.
async function setTriggers(conn: MigConn, schema: string, table: string, enable: boolean): Promise<void> {
  if (conn.type !== 'postgresql') return;
  const action = enable ? 'ENABLE' : 'DISABLE';
  await withPg(conn, async c => {
    await c.query(`ALTER TABLE "${schema}"."${table}" ${action} TRIGGER ALL`);
  });
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

  if (col.fkRef) {
    // Use only the last 2 parts (schema.table) as the namespace so that 3-part
    // cross-DB refs (database.schema.table) generate the same UUID as 2-part refs.
    const ns = col.fkRef.split('.').slice(-2).join('.');
    return seqToUUID(ns, String(val));
  }

  if (col.conversion === 'serial_to_uuid') {
    const ns = `${tableMap.source.schema}.${tableMap.source.table}`;
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

interface TransformResult {
  row: Record<string, unknown> | null;
  reject: Omit<MigRunReject, 'tableId' | 'sourceKey' | 'targetKey' | 'sourcePk' | 'createdAt'> | null;
}

function valuePreview(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function transformRow(
  row: Record<string, unknown>,
  tableMap: TableMap
): TransformResult {
  const out: Record<string, unknown> = {};
  for (const col of tableMap.columns.filter(c => c.include)) {
    const outCol = tgtCol(col);
    if (col.sourceCol === null) {
      out[outCol] = col.defaultValue ?? null;
    } else {
      const originalVal = row[col.sourceCol];
      const normalizedVal = col.emptyPolicy === 'as_null' && typeof originalVal === 'string' && originalVal.trim() === ''
        ? null
        : originalVal;
      let converted = coerceValue(normalizedVal, col, tableMap);
      const targetNullable = col.targetNullable ?? col.nullable;
      if (converted == null && !targetNullable) {
        const policy = col.nullPolicy ?? 'fail';
        if (policy === 'target_default' && (col.targetDefaultValue ?? col.defaultValue) != null) {
          // Omitting the column is what activates a database DEFAULT.
          continue;
        }
        if (policy === 'fallback') {
          converted = coerceValue(col.nullFallback, col, tableMap);
          if (converted == null) {
            return { row: null, reject: { column: outCol, reason: 'fallback_invalid', message: `Fallback for "${outCol}" resolves to NULL.`, valuePreview: valuePreview(col.nullFallback) } };
          }
        } else if (policy === 'skip_row') {
          return { row: null, reject: { column: outCol, reason: 'row_skipped', message: `Row skipped because "${outCol}" is required.`, valuePreview: valuePreview(originalVal) } };
        } else if (policy === 'fail') {
          return { row: null, reject: { column: outCol, reason: 'null_not_allowed', message: `Required target column "${outCol}" received NULL.`, valuePreview: valuePreview(originalVal) } };
        }
      }
      out[outCol] = converted;
      if (col.keepLegacyAs && col.conversion === 'serial_to_uuid') {
        out[col.keepLegacyAs] = originalVal != null ? Number(originalVal) : null;
      }
    }
  }
  return { row: out, reject: null };
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
  failedRows: Array<{ rowIndex: number; message: string }>;
  writerMethod: 'copy-staging' | 'multi-row' | 'row-by-row';
  fallbackReason?: string | null;
}

function copyCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '\\N';
  let text: string;
  if (Buffer.isBuffer(value)) text = `\\x${value.toString('hex')}`;
  else if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function insertRowsPgCopy(
  conn: MigConn, schema: string, table: string,
  rows: Record<string, unknown>[], targetPkCol: string | null,
  upsert: boolean, bypassConstraints: boolean,
): Promise<InsertResult> {
  return withPg(conn, async client => {
    const insertedPks: string[] = [];
    let inserted = 0;
    let conflictSkipped = 0;
    const groups = new Map<string, { cols: string[]; rows: Record<string, unknown>[] }>();
    for (const row of rows) {
      const cols = Object.keys(row);
      if (!cols.length) throw new Error('COPY staging cannot insert a row containing only target defaults.');
      const key = cols.join('\u0000');
      const group = groups.get(key) ?? { cols, rows: [] };
      group.rows.push(row);
      groups.set(key, group);
    }
    await client.query('BEGIN');
    try {
      if (bypassConstraints) await client.query("SET LOCAL session_replication_role = 'replica'");
      for (const group of groups.values()) {
        const stage = `mig_stage_${randomUUID().replace(/-/g, '')}`;
        const colList = group.cols.map(col => `"${col}"`).join(', ');
        await client.query(`CREATE TEMP TABLE "${stage}" (LIKE "${schema}"."${table}" INCLUDING DEFAULTS) ON COMMIT DROP`);
        const copyStream = client.query(copyFrom(`COPY "${stage}" (${colList}) FROM STDIN WITH (FORMAT csv, NULL '\\N')`));
        const input = Readable.from(group.rows.map(row => `${group.cols.map(col => copyCsvValue(row[col])).join(',')}\n`));
        await pipeline(input, copyStream);
        const updateCols = group.cols.filter(col => col !== targetPkCol);
        const conflictSql = upsert && targetPkCol && updateCols.length
          ? `ON CONFLICT ("${targetPkCol}") DO UPDATE SET ${updateCols.map(col => `"${col}" = EXCLUDED."${col}"`).join(', ')}`
          : 'ON CONFLICT DO NOTHING';
        const returning = !upsert && targetPkCol ? ` RETURNING "${targetPkCol}"` : '';
        const merged = await client.query(
          `INSERT INTO "${schema}"."${table}" (${colList}) SELECT ${colList} FROM "${stage}" WHERE true ${conflictSql}${returning}`
        );
        inserted += merged.rowCount ?? 0;
        if (!upsert && targetPkCol) insertedPks.push(...merged.rows.map(row => String(row[targetPkCol])));
        if (!upsert) conflictSkipped += group.rows.length - (merged.rowCount ?? 0);
      }
      await client.query('COMMIT');
      return { pks: insertedPks, inserted, conflictSkipped, errored: 0, firstError: null, failedRows: [], writerMethod: 'copy-staging' };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection may be gone */ }
      throw err;
    }
  });
}

async function insertRows(
  conn: MigConn, schema: string, table: string,
  rows: Record<string, unknown>[], targetPkCol: string | null,
  upsert = false,
  bypassConstraints = false,
): Promise<InsertResult> {
  if (!rows.length) return { pks: [], inserted: 0, conflictSkipped: 0, errored: 0, firstError: null, failedRows: [], writerMethod: conn.type === 'postgresql' ? 'copy-staging' : 'row-by-row' };
  let copyFallbackReason: string | null = null;
  if (conn.type === 'postgresql' && rows.length > 1 && rows.every(row => Object.keys(row).length > 0)) {
    try {
      return await insertRowsPgCopy(conn, schema, table, rows, targetPkCol, upsert, bypassConstraints);
    } catch (err) {
      // A malformed value can abort COPY for the whole batch. Rollback is
      // complete, so retry row-by-row to preserve per-row reject evidence.
      copyFallbackReason = err instanceof Error ? err.message : String(err);
    }
  }
  const insertedPks: string[] = [];
  let actualInserted = 0;
  let conflictSkipped = 0;
  let errored = 0;
  let firstError: string | null = null;
  const failedRows: Array<{ rowIndex: number; message: string }> = [];

  if (conn.type === 'postgresql') {
    await withPg(conn, async c => {
      if (bypassConstraints) {
        await c.query('BEGIN');
        // Transaction-local and connection-local: a crash/disconnect rolls this
        // back automatically instead of leaving table triggers disabled.
        await c.query("SET LOCAL session_replication_role = 'replica'");
      }
      try {
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const row = rows[rowIndex];
          const cols = Object.keys(row);
          const colList = cols.map(c => `"${c}"`).join(', ');
          const updateCols = cols.filter(c => c !== targetPkCol);
          const values = cols.map(k => row[k]);
          const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
          let sql: string;
          if (cols.length === 0) {
            sql = `INSERT INTO "${schema}"."${table}" DEFAULT VALUES`;
          } else if (upsert && targetPkCol && updateCols.length > 0) {
            const setClauses = updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
            sql = `INSERT INTO "${schema}"."${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT ("${targetPkCol}") DO UPDATE SET ${setClauses}`;
          } else {
            sql = `INSERT INTO "${schema}"."${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
          }
          const savepoint = `migration_row_${rowIndex}`;
          if (bypassConstraints) await c.query(`SAVEPOINT ${savepoint}`);
          try {
            const result = await c.query(sql, values);
            const written = result.rowCount ?? 0;
            if (written > 0) {
              actualInserted += written;
              // An upsert may have updated an existing row. Without a before
              // image it cannot be rolled back safely by deleting the PK.
              if (!upsert && targetPkCol && row[targetPkCol] != null) {
                insertedPks.push(String(row[targetPkCol]));
              }
            } else {
              conflictSkipped++;
            }
            if (bypassConstraints) await c.query(`RELEASE SAVEPOINT ${savepoint}`);
          } catch (err) {
            if (bypassConstraints) {
              await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
              await c.query(`RELEASE SAVEPOINT ${savepoint}`);
            }
            errored++;
            const message = err instanceof Error ? err.message : String(err);
            failedRows.push({ rowIndex, message });
            if (!firstError) firstError = message;
          }
        }
        if (bypassConstraints) await c.query('COMMIT');
      } catch (err) {
        if (bypassConstraints) {
          try { await c.query('ROLLBACK'); } catch { /* connection may already be gone */ }
        }
        throw err;
      }
    });
  } else {
    await withMysql(conn, async c => {
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        const cols = Object.keys(row);
        const colList = cols.map(c => `\`${c}\``).join(', ');
        const updateCols = cols.filter(c => c !== targetPkCol);
        const values = cols.map(k => row[k]);
        const placeholders = values.map(() => '?').join(', ');
        let sql: string;
        if (cols.length === 0) {
          sql = `INSERT INTO \`${schema}\`.\`${table}\` () VALUES ()`;
        } else if (upsert && updateCols.length > 0) {
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
            if (!upsert && targetPkCol && row[targetPkCol] != null) {
              insertedPks.push(String(row[targetPkCol]));
            }
          } else {
            conflictSkipped++;
          }
        } catch (err) {
          errored++;
          const message = err instanceof Error ? err.message : String(err);
          failedRows.push({ rowIndex, message });
          if (!firstError) firstError = message;
        }
      }
    });
  }

  return { pks: insertedPks, inserted: actualInserted, conflictSkipped, errored, firstError, failedRows, writerMethod: 'row-by-row', fallbackReason: copyFallbackReason };
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

async function enforcedForeignKeyColumns(conn: MigConn, schema: string, table: string): Promise<Set<string>> {
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const { rows } = await c.query<{ column_name: string }>(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2
      `, [schema, table]);
      return new Set(rows.map(row => row.column_name.toLowerCase()));
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query<any[]>(`
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
    `, [schema, table]);
    return new Set((rows as Array<{ column_name: string }>).map(row => row.column_name.toLowerCase()));
  });
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
  const chunkSize = runChunkRows(run.executionPolicy);
  run.startedAt ??= new Date().toISOString();
  run.status = 'running';
  run.rejects ??= [];
  run.integrityIssues ??= [];

  function log(msg: string) {
    run.logs.push(`[${new Date().toISOString()}] ${msg}`);
    if (run.logs.length > 2000) run.logs = run.logs.slice(-2000);
  }
  if (!run.logs.some(entry => entry.includes('Execution policy:'))) {
    const policy = run.executionPolicy;
    log(`Execution policy: ${policy?.mode ?? 'legacy-default'} chunk ${chunkSize.toLocaleString()} rows, up to ${policy?.maxConcurrentTables ?? 1} table workers, ${target.type === 'postgresql' ? 'COPY staging' : 'row writer'} (${policy?.source ?? 'system_default'}).`);
  }

  // Process table chunks sequentially. Running five large tables in parallel
  // caused source scans, row-by-row target writes, and connection setup to
  // contend with each other, making high-volume scheduler runs dramatically
  // slower. Preserve the advance deadline so later tables enter on the next
  // driver iteration without creating a five-way Promise.all barrier.
  const runnableTables = run.tableStates
    .filter(ts => (ts.status === 'pending' || ts.status === 'running') && !pausedTableIds.includes(ts.id));

  const tableBySourceKey = new Map(run.tables.map(table => [`${table.source.schema}.${table.source.table}`.toLowerCase(), table]));
  const tableByTargetKey = new Map(run.tables.map(table => [`${table.target.schema}.${resolveTargetTable(table)}`.toLowerCase(), table]));
  const eligibleTables = runnableTables.filter(state => {
    const table = run.tables.find(candidate => candidate.id === state.id);
    if (!table) return true;
    const dependencies = [
      ...table.columns.filter(column => column.include && column.fkRef).map(column => ({ key: column.fkRef!.split('.').slice(-2).join('.').toLowerCase(), target: false })),
      ...table.columns.filter(column => column.include && column.targetFkRef).map(column => ({ key: column.targetFkRef!.split('.').slice(0, 2).join('.').toLowerCase(), target: true })),
    ];
    return dependencies.every(dependency => {
      const parent = dependency.target ? tableByTargetKey.get(dependency.key) : tableBySourceKey.get(dependency.key);
      if (!parent || parent.id === table.id) return true;
      const parentState = run.tableStates.find(candidate => candidate.id === parent.id);
      return !parentState || parentState.status === 'completed';
    });
  });
  const workerLimit = Math.max(1, Math.min(5, run.executionPolicy?.maxConcurrentTables ?? 1));
  const currentWave = (eligibleTables.length ? eligibleTables : runnableTables.slice(0, 1)).slice(0, workerLimit);

  await runWithTableWorkerLimit(currentWave, workerLimit, async ts => {

    const tableMap = run.tables.find(t => t.id === ts.id);
    if (!tableMap || !tableMap.include) { ts.status = 'completed'; return; }

    try {
      ts.status = 'running';
      ts.startedAt ??= new Date().toISOString();

      // Build incremental filter (only when syncMode=incremental and a prior watermark exists)
      const isIncremental = tableMap.syncMode === 'incremental' && !!tableMap.incrementalCol;
      const useUpsert = usesUpsertStrategy(tableMap);

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
            return;
          }
          tableMap.columns = discovered;
          log(`[${ts.sourceKey}] auto-discovered ${discovered.length} columns`);
        } catch (err) {
          ts.status = 'failed';
          ts.error = err instanceof Error ? err.message : String(err);
          log(`[${ts.sourceKey}] failed to auto-discover columns: ${ts.error}`);
          run.errors.push(ts.error);
          return;
        }
      }

      const sourcePkCol = tableMap.incrementalTieCol ?? tableMap.columns.find(c =>
        c.include && c.sourceCol && (c.conversion === 'serial_to_uuid' || c.sourceCol.toLowerCase() === 'id' || tgtCol(c).toLowerCase() === 'id')
      )?.sourceCol ?? null;
      const useCompositeCursor = tableMap.incrementalStrategy === 'timestamp' && !!sourcePkCol;
      const countFilter: IncrementalFilter | undefined =
        isIncremental
          ? {
              col: tableMap.incrementalCol!, gt: tableMap.lastSyncedValue ?? undefined,
              pkCol: useCompositeCursor ? sourcePkCol : null,
              pkGt: useCompositeCursor ? tableMap.lastSyncedPk ?? null : null,
            }
          : undefined;
      const readFilter: IncrementalFilter | undefined = isIncremental
        ? {
            col: tableMap.incrementalCol!,
            gt: ts.sourceCursorValue ?? tableMap.lastSyncedValue ?? undefined,
            pkCol: useCompositeCursor ? sourcePkCol : null,
            pkGt: useCompositeCursor ? (ts.sourceCursorPk ?? tableMap.lastSyncedPk ?? null) : null,
          }
        : sourcePkCol
          ? { col: sourcePkCol, gt: ts.sourceCursorValue ?? undefined }
          : undefined;
      const useKeyset = Boolean(readFilter);

      // Count source rows (once)
      if (ts.rowsSource === 0 && ts.offset === 0) {
        ts.rowsSource = await countRows(tableSource, tableMap.source.schema, tableMap.source.table, countFilter, rangeFilter);
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

      // Constraint bypass is transaction-scoped inside insertRows. It cannot
      // remain active after a crash or disconnected database session.
      if (ts.offset === 0 && tableMap.skipConstraints) {
        log(`[${ts.targetKey}] constraint bypass enabled (transaction-scoped)`);
      }

      if (ts.offset === 0 && tableMap.skipNullViolations) {
        log(`[${ts.targetKey}] legacy Skip NULL ignored; use an explicit per-column NULL policy.`);
      }

      // Determine which source columns to SELECT
      const srcCols = tableMap.columns
        .filter(c => c.include && c.sourceCol !== null)
        .map(c => c.sourceCol as string);

      if (!srcCols.length) {
        ts.status = 'completed';
        log(`[${ts.sourceKey}] no columns mapped, skipping`);
        return;
      }

      // Find target PK column
      const pkColMap = tableMap.columns.find(c =>
        c.include && (c.conversion === 'serial_to_uuid' || tgtCol(c).toLowerCase() === 'id')
      );
      ts.targetPkCol = pkColMap ? tgtCol(pkColMap) : null;

      // Read chunk
      const readStarted = Date.now();
      const chunk = await readChunk(
        tableSource, tableMap.source.schema, tableMap.source.table,
        srcCols, ts.offset, chunkSize, readFilter, rangeFilter, useKeyset
      );
      ts.readDurationMs = (ts.readDurationMs ?? 0) + (Date.now() - readStarted);

      if (!chunk.length) {
        ts.hasMore = false;
        ts.status = 'completed';
        ts.completedAt = new Date().toISOString();
        const tableElapsed = ts.startedAt ? Math.max(0.001, (Date.parse(ts.completedAt) - Date.parse(ts.startedAt)) / 1000) : 0;
        ts.rowsPerSecond = tableElapsed ? Number((ts.rowsMigrated / tableElapsed).toFixed(1)) : null;
        log(ts.rowsSource === 0
          ? `[${ts.sourceKey}] empty (0 source rows); target structure ready`
          : `[${ts.sourceKey}] completed (${ts.rowsMigrated} rows)`);
        run.migratedRows = run.tableStates.reduce((s, t) => s + t.rowsMigrated, 0);
        // Record watermark even when no new rows (source max may have advanced)
        if (isIncremental && tableMap.incrementalCol) {
          ts.newWatermark = tableMap.lastSyncedValue ?? null;
          ts.newWatermarkPk = tableMap.lastSyncedPk ?? null;
        }
        return;
      }

      // Remove accidental CSV header rows before transforming typed values.
      const dataRows = chunk.filter(row => !isEmbeddedHeaderRow(row, tableMap));
      const embeddedHeaders = chunk.length - dataRows.length;
      if (embeddedHeaders > 0) log(`[${ts.sourceKey}] skipped ${embeddedHeaders} embedded CSV header row(s)`);
      const transformedResults = dataRows.map(row => transformRow(row, tableMap));
      const acceptedRows: Record<string, unknown>[] = [];
      const acceptedSourceRows: Record<string, unknown>[] = [];
      let blockingPolicyError: string | null = null;
      transformedResults.forEach((result, index) => {
        if (result.row) {
          acceptedRows.push(result.row);
          acceptedSourceRows.push(dataRows[index]);
          return;
        }
        if (!result.reject) return;
        const sourcePk = sourcePkCol && dataRows[index][sourcePkCol] != null ? String(dataRows[index][sourcePkCol]) : null;
        if (run.rejects!.length < 1000) {
          run.rejects!.push({
            ...result.reject,
            tableId: ts.id,
            sourceKey: ts.sourceKey,
            targetKey: ts.targetKey,
            sourcePk,
            createdAt: new Date().toISOString(),
          });
        }
        ts.rowsRejected = (ts.rowsRejected ?? 0) + 1;
        if (result.reject.reason === 'null_not_allowed' || result.reject.reason === 'fallback_invalid') {
          blockingPolicyError ??= result.reject.message;
        }
      });

      if (blockingPolicyError) {
        ts.status = 'failed';
        ts.error = blockingPolicyError;
        ts.rowsErrored += transformedResults.filter(result => result.reject?.reason === 'null_not_allowed' || result.reject?.reason === 'fallback_invalid').length;
        run.errors.push(`${ts.sourceKey}: ${blockingPolicyError}`);
        log(`[${ts.sourceKey}] ERROR: ${blockingPolicyError}`);
        return;
      }

      // Insert into target (upsert when incremental by timestamp)
      const writeStarted = Date.now();
      const insertResult = await insertRows(
        target, tableMap.target.schema, resolveTargetTable(tableMap),
        acceptedRows, ts.targetPkCol, useUpsert, tableMap.skipConstraints === true
      );
      ts.writeDurationMs = (ts.writeDurationMs ?? 0) + (Date.now() - writeStarted);
      ts.writerMethod = insertResult.writerMethod;
      if (insertResult.fallbackReason) log(`[${ts.targetKey}] COPY staging rolled back; row-by-row reject isolation used: ${insertResult.fallbackReason}`);
      for (const failed of insertResult.failedRows) {
        const sourceRow = acceptedSourceRows[failed.rowIndex];
        if (run.rejects!.length >= 1000) break;
        run.rejects!.push({
          tableId: ts.id,
          sourceKey: ts.sourceKey,
          targetKey: ts.targetKey,
          sourcePk: sourcePkCol && sourceRow?.[sourcePkCol] != null ? String(sourceRow[sourcePkCol]) : null,
          column: null,
          reason: 'db_error',
          message: failed.message,
          valuePreview: null,
          createdAt: new Date().toISOString(),
        });
      }

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
      const lastSourceRow = chunk[chunk.length - 1];
      if (readFilter) {
        ts.sourceCursorValue = cursorValue(lastSourceRow[readFilter.col]);
        ts.sourceCursorPk = readFilter.pkCol ? cursorValue(lastSourceRow[readFilter.pkCol]) : null;
      }
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

      if (chunk.length < chunkSize) {
        ts.hasMore = false;
        ts.status = 'completed';
        ts.completedAt = new Date().toISOString();
        const tableElapsed = ts.startedAt ? Math.max(0.001, (Date.parse(ts.completedAt) - Date.parse(ts.startedAt)) / 1000) : 0;
        ts.rowsPerSecond = tableElapsed ? Number((ts.rowsMigrated / tableElapsed).toFixed(1)) : null;
        log(`[${ts.sourceKey}] completed (${ts.rowsMigrated} rows)`);
        // Record new high-water mark for incremental sync
        if (isIncremental && tableMap.incrementalCol) {
          const lastRow = chunk[chunk.length - 1];
          ts.newWatermark = cursorValue(lastRow[tableMap.incrementalCol]);
          ts.newWatermarkPk = useCompositeCursor && sourcePkCol ? cursorValue(lastRow[sourcePkCol]) : null;
          if (ts.newWatermark) log(`[${ts.sourceKey}] last synced position updated → ${ts.newWatermark}${ts.newWatermarkPk ? ` / PK ${ts.newWatermarkPk}` : ''}`);
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
  });

  // Check overall completion
  const allDone = run.tableStates.every(t => t.status === 'completed' || t.status === 'failed' || t.status === 'rolled_back' || t.status === 'aborted');
  const anyFailed = run.tableStates.some(t => t.status === 'failed');
  if (allDone) {
    const anyAborted = run.tableStates.some(t => t.status === 'aborted');
    run.status = anyFailed ? 'failed' : anyAborted ? 'aborted' : 'completed';
    run.completedAt = new Date().toISOString();
    const elapsedSeconds = run.startedAt ? Math.max(0.001, (Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000) : null;
    const targetSeconds = run.executionPolicy?.performanceTargetSeconds ?? 15 * 60;
    const actualRowsPerSecond = elapsedSeconds ? Number((run.migratedRows / elapsedSeconds).toFixed(1)) : null;
    run.performance = {
      targetSeconds,
      requiredRowsPerSecond: run.totalRows ? Number((run.totalRows / targetSeconds).toFixed(1)) : 0,
      actualRowsPerSecond,
      elapsedSeconds,
      meetsTarget: elapsedSeconds == null ? null : elapsedSeconds <= targetSeconds,
    };
    run.integrityIssues = run.tableStates.flatMap(ts => {
      const issues = [];
      if ((ts.rowsRejected ?? 0) > 0) issues.push({
        tableId: ts.id, targetKey: ts.targetKey, kind: 'rejected_rows' as const,
        level: 'warning' as const,
        message: `${ts.rowsRejected} source row${ts.rowsRejected === 1 ? '' : 's'} rejected by mapping data policies.`,
      });
      if (ts.rowsErrored > 0) issues.push({
        tableId: ts.id, targetKey: ts.targetKey, kind: 'database_errors' as const,
        level: 'error' as const,
        message: `${ts.rowsErrored} row${ts.rowsErrored === 1 ? '' : 's'} failed target database validation or insertion.`,
      });
      return issues;
    });
    for (const tableMap of run.tables.filter(table => table.include && table.columns.some(column => column.include && column.fkRef))) {
      try {
        const physicalTable = resolveTargetTable(tableMap);
        const enforced = await enforcedForeignKeyColumns(target, tableMap.target.schema, physicalTable);
        const logicalOnly = tableMap.columns.filter(column => column.include && column.fkRef && !enforced.has(tgtCol(column).toLowerCase()));
        for (const column of logicalOnly) {
          run.integrityIssues.push({
            tableId: tableMap.id,
            targetKey: `${tableMap.target.schema}.${physicalTable}`,
            kind: 'logical_fk_not_enforced',
            level: 'warning',
            message: `"${tgtCol(column)}" is a logical mapping reference to ${column.fkRef}, but the target database has no FK constraint on this column.`,
          });
        }
      } catch (err) {
        log(`[${tableMap.target.schema}.${resolveTargetTable(tableMap)}] integrity inspection incomplete: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    log(`Run ${run.status}. Total: ${run.migratedRows} rows migrated.`);
    if (run.performance.actualRowsPerSecond != null && run.performance.elapsedSeconds != null) {
      log(`Performance: ${run.performance.actualRowsPerSecond.toLocaleString()} rows/s over ${run.performance.elapsedSeconds.toFixed(1)}s — 15-minute target ${run.performance.meetsTarget ? 'met' : 'missed'}.`);
    }
  }

  return run;
}

// Repair trigger state left by the old ALTER TABLE ... DISABLE TRIGGER ALL
// implementation. Versioned transaction-scoped runs never need this cleanup.
export async function recoverLegacyDisabledConstraints(run: MigRun, target: MigConn): Promise<string[]> {
  if (target.type !== 'postgresql' || run.constraintBypassMode === 'transaction') return [];
  const recovered: string[] = [];
  for (const tableMap of run.tables.filter(t => t.include && t.skipConstraints)) {
    const table = resolveTargetTable(tableMap);
    const targetKey = `${tableMap.target.schema}.${table}`;
    // A hard process stop can happen before the in-memory "disabled" log is
    // persisted. For unversioned interrupted runs, enabling every opted-in
    // table is the only reliable way to repair the former persistent state.
    await setTriggers(target, tableMap.target.schema, table, true);
    recovered.push(targetKey);
  }
  return recovered;
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
