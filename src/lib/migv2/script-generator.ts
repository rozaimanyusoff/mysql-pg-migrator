// ─────────────────────────────────────────────────────────────────────────────
// Standalone migration script generator.
//
// Produces a self-contained Node.js ESM (.mjs) script that migrates a job's tables
// from source → target WITHOUT requiring the Next.js app to be running. It depends
// only on `pg` and `mysql2` (already in node_modules) and replicates the exact
// transformation logic of src/lib/migv2/runner.ts so the output is identical to the
// in-app runner and scheduler.
//
// This module is PURE — it imports no runtime DB libraries. It only produces a
// string of JavaScript source code.
// ─────────────────────────────────────────────────────────────────────────────

import type { MigJob, TableMap, ColumnMap } from './types';

// ── Pure helpers (ported from runner.ts, no DB imports) ───────────────────────

function tgtCol(c: ColumnMap): string { return c.targetName ?? c.targetCol; }
function resolveTargetTable(t: TableMap): string { return t.targetAlias?.trim() || t.target.table; }

// Mirror of runner.ts safeDdlDefault
function safeDdlDefault(raw: string | null | undefined, targetType: 'postgresql' | 'mysql'): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v.toUpperCase() === 'NULL') return 'NULL';
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^'[^']*'$/.test(v)) return v;
  if (/^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|NOW\(\)|LOCALTIMESTAMP)$/i.test(v)) {
    return targetType === 'postgresql' ? 'CURRENT_TIMESTAMP' : v;
  }
  if (v.startsWith("b'")) return null;
  if (v.startsWith('(')) return null;
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(v)) return null;
  return null;
}

// Mirror of runner.ts buildCreateTableSQL
function buildCreateTableSQL(tableMap: TableMap, targetType: 'postgresql' | 'mysql'): string {
  const schema = tableMap.target.schema;
  const table = resolveTargetTable(tableMap);
  const cols = tableMap.columns.filter(c => c.include);

  const pkCol = cols.find(c => c.conversion === 'serial_to_uuid') ??
    cols.find(c => c.sourceCol && tgtCol(c).toLowerCase() === 'id');

  const colDefs = cols.map(c => {
    const type = c.targetType;
    const notNull = !c.nullable ? ' NOT NULL' : '';
    const rawDef = c.targetType.toLowerCase() === 'uuid' ? null : safeDdlDefault(c.defaultValue, targetType);
    const def = rawDef ? ` DEFAULT ${rawDef}` : '';
    if (targetType === 'postgresql') {
      return `  "${tgtCol(c)}" ${type}${notNull}${def}`;
    }
    return `  \`${tgtCol(c)}\` ${type}${notNull}${def}`;
  });

  for (const c of cols) {
    if (c.keepLegacyAs && c.conversion === 'serial_to_uuid') {
      if (targetType === 'postgresql') colDefs.push(`  "${c.keepLegacyAs}" BIGINT NULL`);
      else colDefs.push(`  \`${c.keepLegacyAs}\` BIGINT NULL`);
    }
  }

  if (pkCol) {
    if (targetType === 'postgresql') colDefs.push(`  PRIMARY KEY ("${tgtCol(pkCol)}")`);
    else colDefs.push(`  PRIMARY KEY (\`${tgtCol(pkCol)}\`)`);
  }

  if (targetType === 'postgresql') {
    return `CREATE SCHEMA IF NOT EXISTS "${schema}";\n` +
      `CREATE TABLE IF NOT EXISTS "${schema}"."${table}" (\n${colDefs.join(',\n')}\n);`;
  }
  return `CREATE TABLE IF NOT EXISTS \`${schema}\`.\`${table}\` (\n${colDefs.join(',\n')}\n);`;
}

// ── Serialized shapes baked into the generated script ─────────────────────────

interface GenColumn {
  sourceCol: string | null;
  targetCol: string;          // effective target name (after targetName override)
  targetType: string;
  conversion: string;
  fkRef: string | null;
  keepLegacyAs: string | null;
  defaultValue: string | null;
}

interface GenTable {
  id: string;
  sourceSchema: string;
  sourceTable: string;
  sourceDatabase: string | null;
  targetSchema: string;
  targetTable: string;
  truncate: boolean;
  syncMode: string;
  incrementalCol: string | null;
  incrementalStrategy: string;
  lastSyncedValue: string | null;
  targetPkCol: string | null;
  columns: GenColumn[];
  ddl: string;
  extraCols: { name: string; type: string; nullable: boolean }[];
}

function serializeTables(job: MigJob): GenTable[] {
  const targetType = job.targetMeta.type;
  return job.tables
    .filter(t => t.include && t.columns.length > 0)
    .map(t => {
      const includedCols = t.columns.filter(c => c.include);
      const pkColMap = includedCols.find(c => c.conversion === 'serial_to_uuid' || tgtCol(c).toLowerCase() === 'id');

      const extraCols: { name: string; type: string; nullable: boolean }[] = [];
      for (const c of includedCols) {
        if (c.keepLegacyAs && c.conversion === 'serial_to_uuid') {
          extraCols.push({ name: c.keepLegacyAs, type: 'BIGINT', nullable: true });
        }
        if (c.sourceCol === null) {
          extraCols.push({ name: tgtCol(c), type: c.targetType || 'TEXT', nullable: c.nullable });
        }
      }

      return {
        id: t.id,
        sourceSchema: t.source.schema,
        sourceTable: t.source.table,
        sourceDatabase: t.sourceDatabase ?? null,
        targetSchema: t.target.schema,
        targetTable: resolveTargetTable(t),
        truncate: t.truncateBeforeMigrate,
        syncMode: t.syncMode ?? 'full',
        incrementalCol: t.incrementalCol ?? null,
        incrementalStrategy: t.incrementalStrategy ?? 'id',
        lastSyncedValue: t.lastSyncedValue ?? null,
        targetPkCol: pkColMap ? tgtCol(pkColMap) : null,
        columns: includedCols.map(c => ({
          sourceCol: c.sourceCol,
          targetCol: tgtCol(c),
          targetType: c.targetType,
          conversion: c.conversion,
          fkRef: c.fkRef,
          keepLegacyAs: c.keepLegacyAs ?? null,
          defaultValue: c.defaultValue ?? null,
        })),
        ddl: buildCreateTableSQL(t, targetType),
        extraCols,
      };
    });
}

// ── The static runtime block of the generated script ──────────────────────────
// This is plain JS (as a string). It is identical for every job; only the CONFIG
// and DATA blocks above it change. Transformation logic mirrors runner.ts exactly.

const RUNTIME = String.raw`
const BT = String.fromCharCode(96); // backtick, for MySQL identifier quoting

// ── Coercion (exact port of runner.ts coerceValue) ────────────────────────────
function seqToUUID(ns, sourceId) {
  const hash = createHash('sha256').update(ns + '\x00' + String(sourceId)).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

function coerceValue(val, col, table) {
  if (val === null || val === undefined) return null;
  if (col.fkRef) {
    const ns = col.fkRef.split('.').slice(-2).join('.');
    return seqToUUID(ns, String(val));
  }
  if (col.conversion === 'serial_to_uuid') {
    return seqToUUID(table.sourceSchema + '.' + table.sourceTable, String(val));
  }
  const t = (col.targetType || '').toLowerCase();
  if (t === 'boolean' || t === 'bool') {
    if (typeof val === 'number') return val !== 0;
    if (typeof val === 'string') return val === '1' || val.toLowerCase() === 'true';
    return Boolean(val);
  }
  if (t.startsWith('tinyint(1)')) {
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  }
  if (col.conversion === 'to_date' || t === 'date') return normalizeTemporal(val, 'date');
  if (t === 'time' || t.startsWith('time(') || t.startsWith('time without') || t.startsWith('time with')) return normalizeTemporal(val, 'time');
  if (col.conversion === 'to_timestamptz' || t.includes('timestamp') || t === 'datetime') return normalizeTemporal(val, 'timestamp');
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val.toISOString().replace('T', ' ').slice(0, 19);
  return val;
}

function validDateParts(year, month, day) {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeTemporal(val, kind) {
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    const iso = val.toISOString();
    return kind === 'date' ? iso.slice(0, 10) : kind === 'time' ? iso.slice(11, 19) : iso.replace('T', ' ').slice(0, 19);
  }
  const raw = String(val).trim();
  if (!raw || /^0{4}-0{2}-0{2}/.test(raw) || /^\/?date(?:time)?\/?$/i.test(raw)) return null;
  if (kind === 'time') {
    const tm = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?$/);
    if (!tm) return null;
    const h = Number(tm[1]), min = Number(tm[2]), sec = Number(tm[3] || 0);
    if (h > 23 || min > 59 || sec > 59) return null;
    return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/);
  let year, month, day, hour = 0, minute = 0, second = 0;
  if (m) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); hour = Number(m[4] || 0); minute = Number(m[5] || 0); second = Number(m[6] || 0);
  } else {
    m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!m) return null;
    day = Number(m[1]); month = Number(m[2]); year = Number(m[3]); hour = Number(m[4] || 0); minute = Number(m[5] || 0); second = Number(m[6] || 0);
  }
  if (!validDateParts(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  const date = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  return kind === 'date' ? date : date + ' ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':' + String(second).padStart(2, '0');
}

function transformRow(row, table) {
  const out = {};
  for (const col of table.columns) {
    if (col.sourceCol === null) {
      out[col.targetCol] = col.defaultValue !== undefined ? (col.defaultValue ?? null) : null;
    } else {
      const original = row[col.sourceCol];
      out[col.targetCol] = coerceValue(original, col, table);
      if (col.keepLegacyAs && col.conversion === 'serial_to_uuid') {
        out[col.keepLegacyAs] = original != null ? Number(original) : null;
      }
    }
  }
  return out;
}

function isEmbeddedHeaderRow(row, table) {
  let matches = 0;
  for (const col of table.columns) {
    if (col.sourceCol === null || typeof row[col.sourceCol] !== 'string') continue;
    const value = row[col.sourceCol].trim().replace(/^\/+|\/+$/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const source = col.sourceCol.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (value === source || (value === 'datetime' && /date|time/.test(source))) matches++;
    if (matches >= 2) return true;
  }
  return false;
}

// ── WHERE builder (mirrors runner.ts buildWhere) ──────────────────────────────
function buildWhere(dbType, inc, range) {
  const conds = [];
  const params = [];
  let orderCol = null;
  const q = (c) => dbType === 'postgresql' ? '"' + c + '"' : BT + c + BT;
  const p = () => dbType === 'postgresql' ? '$' + params.length : '?';
  if (inc) { params.push(inc.gt); conds.push(q(inc.col) + ' > ' + p()); orderCol = inc.col; }
  if (range && range.from) { params.push(range.from); conds.push(q(range.col) + ' >= ' + p()); if (!orderCol) orderCol = range.col; }
  if (range && range.to) { params.push(range.to); conds.push(q(range.col) + ' <= ' + p()); if (!orderCol) orderCol = range.col; }
  return { where: conds.length ? 'WHERE ' + conds.join(' AND ') : '', params, orderCol };
}

// ── Source / target connection helpers ────────────────────────────────────────
async function srcQuery(dbName, sql, params) {
  if (SOURCE.type === 'postgresql') {
    const c = new pg.Client({ host: SOURCE.host, port: SOURCE.port, database: dbName || SOURCE.database, user: SOURCE.user, password: SOURCE.password });
    await c.connect();
    try { const r = await c.query(sql, params); return r.rows; } finally { await c.end(); }
  } else {
    const c = await mysql.createConnection({ host: SOURCE.host, port: SOURCE.port, database: dbName || SOURCE.database, user: SOURCE.user, password: SOURCE.password, multipleStatements: false, dateStrings: true });
    try { const [rows] = await c.query(sql, params); return rows; } finally { await c.end(); }
  }
}

function qid(dbType, name) { return dbType === 'postgresql' ? '"' + name + '"' : BT + name + BT; }

async function countRows(table, inc, range) {
  const dbName = table.sourceDatabase || SOURCE.database;
  const { where, params } = buildWhere(SOURCE.type, inc, range);
  const sql = 'SELECT COUNT(*) AS n FROM ' + qid(SOURCE.type, table.sourceSchema) + '.' + qid(SOURCE.type, table.sourceTable) + ' ' + where;
  const rows = await srcQuery(dbName, sql, params);
  return Number(rows[0].n);
}

async function readChunk(table, offset, limit, inc, range) {
  const dbName = table.sourceDatabase || SOURCE.database;
  const srcCols = table.columns.filter(c => c.sourceCol !== null).map(c => c.sourceCol);
  const colList = srcCols.map(c => qid(SOURCE.type, c)).join(', ');
  const { where, params, orderCol } = buildWhere(SOURCE.type, inc, range);
  const orderBy = orderCol ? 'ORDER BY ' + qid(SOURCE.type, orderCol) + ' ASC' : '';
  let sql;
  if (SOURCE.type === 'postgresql') {
    const nextIdx = params.length + 1;
    sql = 'SELECT ' + colList + ' FROM ' + qid('postgresql', table.sourceSchema) + '.' + qid('postgresql', table.sourceTable) + ' ' + where + ' ' + orderBy + ' LIMIT $' + nextIdx + ' OFFSET $' + (nextIdx + 1);
    return srcQuery(dbName, sql, [...params, limit, offset]);
  } else {
    sql = 'SELECT ' + colList + ' FROM ' + qid('mysql', table.sourceSchema) + '.' + qid('mysql', table.sourceTable) + ' ' + where + ' ' + orderBy + ' LIMIT ? OFFSET ?';
    return srcQuery(dbName, sql, [...params, limit, offset]);
  }
}

async function getMaxValue(table, col) {
  const dbName = table.sourceDatabase || SOURCE.database;
  const sql = 'SELECT MAX(' + qid(SOURCE.type, col) + ') AS v FROM ' + qid(SOURCE.type, table.sourceSchema) + '.' + qid(SOURCE.type, table.sourceTable);
  const rows = await srcQuery(dbName, sql, []);
  return rows[0].v != null ? String(rows[0].v) : null;
}

// ── Target writers ─────────────────────────────────────────────────────────────
let _tgtClient = null;
async function tgtConnect() {
  if (TARGET.type === 'postgresql') {
    _tgtClient = new pg.Client({ host: TARGET.host, port: TARGET.port, database: TARGET.database, user: TARGET.user, password: TARGET.password });
    await _tgtClient.connect();
  } else {
    _tgtClient = await mysql.createConnection({ host: TARGET.host, port: TARGET.port, database: TARGET.database, user: TARGET.user, password: TARGET.password, multipleStatements: true });
  }
}
async function tgtEnd() { if (_tgtClient) { await _tgtClient.end(); _tgtClient = null; } }
async function tgtExec(sql, params) {
  if (TARGET.type === 'postgresql') { return _tgtClient.query(sql, params); }
  const [res] = await _tgtClient.query(sql, params); return res;
}

async function ensureTargetTable(table) {
  if (TARGET.type === 'postgresql') {
    const stmts = table.ddl.split(';\n').map(s => s.trim()).filter(Boolean);
    for (const s of stmts) await tgtExec(s);
    for (const col of table.extraCols) {
      const nn = col.nullable ? '' : ' NOT NULL';
      await tgtExec('ALTER TABLE "' + table.targetSchema + '"."' + table.targetTable + '" ADD COLUMN IF NOT EXISTS "' + col.name + '" ' + col.type + nn);
    }
  } else {
    await tgtExec(table.ddl);
    for (const col of table.extraCols) {
      const nn = col.nullable ? '' : ' NOT NULL';
      try { await tgtExec('ALTER TABLE ' + BT + table.targetSchema + BT + '.' + BT + table.targetTable + BT + ' ADD COLUMN IF NOT EXISTS ' + BT + col.name + BT + ' ' + col.type + nn); } catch (e) { /* dup column */ }
    }
  }
}

async function truncateTarget(table) {
  if (TARGET.type === 'postgresql') {
    await tgtExec('TRUNCATE "' + table.targetSchema + '"."' + table.targetTable + '" CASCADE');
  } else {
    await tgtExec('TRUNCATE TABLE ' + BT + table.targetSchema + BT + '.' + BT + table.targetTable + BT);
  }
}

async function insertRows(table, rows, upsert) {
  if (!rows.length) return { inserted: 0, skipped: 0, errored: 0, firstError: null };
  const cols = Object.keys(rows[0]);
  const pkCol = table.targetPkCol;
  const updateCols = cols.filter(c => c !== pkCol);
  let inserted = 0, skipped = 0, errored = 0, firstError = null;

  if (TARGET.type === 'postgresql') {
    const colList = cols.map(c => '"' + c + '"').join(', ');
    for (const row of rows) {
      const values = cols.map(k => row[k]);
      const ph = values.map((_, i) => '$' + (i + 1)).join(', ');
      let sql;
      if (upsert && pkCol && updateCols.length > 0) {
        const setC = updateCols.map(c => '"' + c + '" = EXCLUDED."' + c + '"').join(', ');
        sql = 'INSERT INTO "' + table.targetSchema + '"."' + table.targetTable + '" (' + colList + ') VALUES (' + ph + ') ON CONFLICT ("' + pkCol + '") DO UPDATE SET ' + setC;
      } else {
        sql = 'INSERT INTO "' + table.targetSchema + '"."' + table.targetTable + '" (' + colList + ') VALUES (' + ph + ') ON CONFLICT DO NOTHING';
      }
      try { const r = await tgtExec(sql, values); if ((r.rowCount ?? 0) > 0) inserted += r.rowCount; else skipped++; }
      catch (e) { errored++; if (!firstError) firstError = e.message || String(e); }
    }
  } else {
    const colList = cols.map(c => BT + c + BT).join(', ');
    for (const row of rows) {
      const values = cols.map(k => row[k]);
      const ph = values.map(() => '?').join(', ');
      let sql;
      if (upsert && updateCols.length > 0) {
        const setC = updateCols.map(c => BT + c + BT + ' = VALUES(' + BT + c + BT + ')').join(', ');
        sql = 'INSERT INTO ' + BT + table.targetSchema + BT + '.' + BT + table.targetTable + BT + ' (' + colList + ') VALUES (' + ph + ') ON DUPLICATE KEY UPDATE ' + setC;
      } else {
        sql = 'INSERT IGNORE INTO ' + BT + table.targetSchema + BT + '.' + BT + table.targetTable + BT + ' (' + colList + ') VALUES (' + ph + ')';
      }
      try { const r = await tgtExec(sql, values); if ((r.affectedRows ?? 0) > 0) inserted++; else skipped++; }
      catch (e) { errored++; if (!firstError) firstError = e.message || String(e); }
    }
  }
  return { inserted, skipped, errored, firstError };
}

// ── State file ─────────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── CLI args ───────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { table: null, from: null, to: null, chunk: CHUNK_SIZE, resume: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--table') a.table = argv[++i];
    else if (v === '--from') a.from = argv[++i];
    else if (v === '--to') a.to = argv[++i];
    else if (v === '--chunk') a.chunk = parseInt(argv[++i], 10) || CHUNK_SIZE;
    else if (v === '--resume') a.resume = true;
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--help' || v === '-h') { printHelp(); process.exit(0); }
  }
  return a;
}

function printHelp() {
  console.log([
    'Migration script for job: ' + JOB.name,
    '',
    'Usage:',
    '  node ' + SCRIPT_NAME,
    '  node ' + SCRIPT_NAME + ' --table <schema.table>',
    '  node ' + SCRIPT_NAME + ' --from <date> --to <date>',
    '  node ' + SCRIPT_NAME + ' --chunk <n>     (default ' + CHUNK_SIZE + ')',
    '  node ' + SCRIPT_NAME + ' --resume        (skip already-migrated chunks)',
    '  node ' + SCRIPT_NAME + ' --dry-run       (count rows, print plan, no writes)',
  ].join('\n'));
}

function fmtPct(done, total) {
  if (!total) return '0.0%';
  return (Math.min(100, (done / total) * 100)).toFixed(1) + '%';
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const filterFrom = args.from !== null ? args.from : JOB.filterFrom;
  const filterTo = args.to !== null ? args.to : JOB.filterTo;
  const rangeFilter = JOB.filterCol ? { col: JOB.filterCol, from: filterFrom, to: filterTo } : undefined;

  let tables = TABLES;
  if (args.table) {
    tables = TABLES.filter(t => (t.sourceSchema + '.' + t.sourceTable) === args.table || (t.targetSchema + '.' + t.targetTable) === args.table);
    if (!tables.length) { console.error('No table matched: ' + args.table); process.exit(1); }
  }

  console.log('═'.repeat(60));
  console.log('Migration: ' + JOB.name);
  console.log('Source: ' + SOURCE.type + ' ' + SOURCE.host + '/' + SOURCE.database);
  console.log('Target: ' + TARGET.type + ' ' + TARGET.host + '/' + TARGET.database);
  console.log('Tables: ' + tables.length + (args.table ? ' (filtered)' : ''));
  if (rangeFilter) console.log('Row filter: ' + rangeFilter.col + ' BETWEEN ' + (rangeFilter.from || '*') + ' AND ' + (rangeFilter.to || '*'));
  console.log('Chunk size: ' + args.chunk + (args.resume ? '  |  RESUME' : '') + (args.dryRun ? '  |  DRY-RUN' : ''));
  console.log('═'.repeat(60));

  const state = args.resume ? loadState() : {};

  // Dry-run: just count and print plan
  if (args.dryRun) {
    let grand = 0;
    for (const table of tables) {
      const key = table.sourceSchema + '.' + table.sourceTable;
      const isInc = table.syncMode === 'incremental' && table.incrementalCol;
      const inc = isInc && table.lastSyncedValue ? { col: table.incrementalCol, gt: table.lastSyncedValue } : undefined;
      const n = await countRows(table, inc, rangeFilter);
      grand += n;
      console.log('[' + key + '] ' + n.toLocaleString() + ' rows → ' + table.targetSchema + '.' + table.targetTable +
        (isInc ? '  (incremental since ' + (table.lastSyncedValue || 'beginning') + ')' : '') +
        (table.truncate ? '  (truncate first)' : ''));
    }
    console.log('─'.repeat(60));
    console.log('TOTAL: ' + grand.toLocaleString() + ' rows across ' + tables.length + ' tables');
    return;
  }

  await tgtConnect();
  let failures = 0;

  for (const table of tables) {
    const key = table.sourceSchema + '.' + table.sourceTable;
    const st = state[key] || { done: false, offset: 0, migratedRows: 0 };
    if (st.done) { console.log('[' + key + '] already done — skipping'); continue; }

    const isInc = table.syncMode === 'incremental' && table.incrementalCol;
    const inc = isInc && table.lastSyncedValue ? { col: table.incrementalCol, gt: table.lastSyncedValue } : undefined;
    const useUpsert = isInc && table.incrementalStrategy === 'timestamp';

    try {
      const total = await countRows(table, inc, rangeFilter);

      if (table.truncate && st.offset === 0) { await truncateTarget(table); console.log('[' + key + '] truncated target'); }
      await ensureTargetTable(table);

      let offset = st.offset;
      let migrated = st.migratedRows;
      let chunkNo = Math.floor(offset / args.chunk);

      while (true) {
        const rows = await readChunk(table, offset, args.chunk, inc, rangeFilter);
        if (!rows.length) break;
        const dataRows = rows.filter(r => !isEmbeddedHeaderRow(r, table));
        const embeddedHeaders = rows.length - dataRows.length;
        if (embeddedHeaders > 0) console.log('  skipped ' + embeddedHeaders + ' embedded CSV header row(s)');
        const transformed = dataRows.map(r => transformRow(r, table));
        const r = await insertRows(table, transformed, useUpsert);
        offset += rows.length;
        migrated += r.inserted;
        chunkNo++;
        state[key] = { done: false, offset, migratedRows: migrated };
        saveState(state);

        const errPart = r.errored > 0 ? '  ' + r.errored + ' errors' + (r.firstError ? ' (' + r.firstError + ')' : '') : '';
        console.log('[' + key + '] ' + migrated.toLocaleString() + '/' + total.toLocaleString() + ' (' + fmtPct(offset, total) + ') — chunk ' + chunkNo + errPart);

        if (rows.length < args.chunk) break;
      }

      let newWatermark = null;
      if (isInc && table.incrementalCol) { newWatermark = await getMaxValue(table, table.incrementalCol); }
      state[key] = { done: true, offset, migratedRows: migrated, watermark: newWatermark };
      saveState(state);
      console.log('[' + key + '] ✓ completed (' + migrated.toLocaleString() + ' rows)' + (newWatermark ? '  watermark → ' + newWatermark : ''));
    } catch (e) {
      failures++;
      console.error('[' + key + '] ✗ FAILED: ' + (e.message || String(e)));
      state[key] = { ...st, done: false, error: e.message || String(e) };
      saveState(state);
    }
  }

  await tgtEnd();
  console.log('═'.repeat(60));
  if (failures > 0) {
    console.log('Done with ' + failures + ' failed table(s). Re-run with --resume to retry from last chunk.');
    process.exit(1);
  } else {
    console.log('All tables migrated successfully.');
    if (state && Object.keys(state).length) console.log('State saved to ' + STATE_FILE + ' (delete to start fresh).');
  }
}

main().catch(e => { console.error('FATAL: ' + (e.stack || e.message || e)); process.exit(1); });
`;

// ── Public entry point ─────────────────────────────────────────────────────────

export function generateMigrationScript(job: MigJob): string {
  const tables = serializeTables(job);
  const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';
  const scriptName = `migration-${slug}.mjs`;

  const jobMeta = {
    id: job.id,
    name: job.name,
    filterCol: job.filterCol ?? null,
    filterFrom: job.filterFrom ?? null,
    filterTo: job.filterTo ?? null,
  };

  const filterDesc = job.filterCol
    ? `${job.filterCol} BETWEEN ${job.filterFrom ?? '*'} AND ${job.filterTo ?? '*'}`
    : 'none';

  const header = `#!/usr/bin/env node
// ============================================================================
// MIGRATION SCRIPT — generated ${new Date().toISOString()}
// Job:     ${job.name} (${job.id})
// Source:  ${job.sourceMeta.type} ${job.sourceMeta.host}:${job.sourceMeta.port}/${job.sourceMeta.database}
// Target:  ${job.targetMeta.type} ${job.targetMeta.host}:${job.targetMeta.port}/${job.targetMeta.database}
// Tables:  ${tables.length}
// Filter:  ${filterDesc}
//
// REQUIREMENTS: Node 18+, with 'pg' and 'mysql2' available.
//   Easiest: drop this file in the project root that already has them installed,
//   or run:  npm i pg mysql2   in the folder where you place this script.
//
// USAGE:
//   1. Fill in YOUR_SOURCE_PASSWORD and YOUR_TARGET_PASSWORD below.
//   2. Run one of:
//        node ${scriptName}
//        node ${scriptName} --dry-run
//        node ${scriptName} --table ${tables[0]?.sourceSchema ?? 'schema'}.${tables[0]?.sourceTable ?? 'table'}
//        node ${scriptName} --from 2024-01-01 --to 2024-03-31
//        node ${scriptName} --resume
//        node ${scriptName} --chunk 1000
// ============================================================================

import pg from 'pg';
import mysql from 'mysql2/promise';
import { createHash } from 'crypto';
import fs from 'fs';

// ── CONFIG — fill in the two passwords ────────────────────────────────────────
const SOURCE = {
  type: ${JSON.stringify(job.sourceMeta.type)},
  host: ${JSON.stringify(job.sourceMeta.host)},
  port: ${JSON.stringify(job.sourceMeta.port)},
  user: ${JSON.stringify(job.sourceMeta.username)},
  password: process.env.SOURCE_PASSWORD || 'YOUR_SOURCE_PASSWORD',
  database: ${JSON.stringify(job.sourceMeta.database)},
};
const TARGET = {
  type: ${JSON.stringify(job.targetMeta.type)},
  host: ${JSON.stringify(job.targetMeta.host)},
  port: ${JSON.stringify(job.targetMeta.port)},
  user: ${JSON.stringify(job.targetMeta.username)},
  password: process.env.TARGET_PASSWORD || 'YOUR_TARGET_PASSWORD',
  database: ${JSON.stringify(job.targetMeta.database)},
};
const CHUNK_SIZE = 500;
const STATE_FILE = ${JSON.stringify(`migration-state-${job.id}.json`)};
const SCRIPT_NAME = ${JSON.stringify(scriptName)};

// ── JOB + TABLE DEFINITIONS (baked from saved config) ─────────────────────────
const JOB = ${JSON.stringify(jobMeta, null, 2)};
const TABLES = ${JSON.stringify(tables, null, 2)};
`;

  return header + RUNTIME;
}
