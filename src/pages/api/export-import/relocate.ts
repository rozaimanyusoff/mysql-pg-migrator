import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { exportDatabase, ConnCfg, ExportInclude, ConflictStrategy } from '../../../lib/sql-exporter';

// Relocate = copy or move objects to another live location (schema/db), generalising
// the old Sync (db→db) and adding PostgreSQL schema/table relocation.

interface Log { step: string; ok: boolean; text: string }
type Scope = 'db' | 'schema' | 'table';
type Operation = 'copy' | 'move';

interface Body {
  source?: ConnCfg;
  target?: ConnCfg;
  scope?: Scope;
  sourceSchema?: string;
  targetSchema?: string;
  table?: string;
  operation?: Operation;
  include?: ExportInclude;
  conflict?: ConflictStrategy;
}

function pgPool(cfg: ConnCfg) {
  return new Pool({
    host: cfg.host, port: cfg.port ?? 5432, user: cfg.user,
    password: cfg.password, database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000, statement_timeout: 0,
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    source, target, scope = 'table', sourceSchema = 'public', targetSchema = 'public',
    table, operation = 'copy', include = 'both', conflict = 'insert_only',
  } = req.body as Body;

  if (!source?.host || !source?.user || !source?.database)
    return res.status(400).json({ error: 'source cfg required' });
  if (!target?.host || !target?.user || !target?.database)
    return res.status(400).json({ error: 'target cfg required' });
  if (source.db_type !== target.db_type)
    return res.status(400).json({ error: 'Cross-DB relocate (MySQL↔PostgreSQL) is not supported. Use the Migration module instead.' });
  if (scope === 'table' && !table?.trim())
    return res.status(400).json({ error: 'table is required for table scope' });
  if (source.db_type === 'mysql' && scope !== 'db')
    return res.status(400).json({ error: 'Schema / table relocation requires PostgreSQL. MySQL has no schemas.' });

  const log: Log[] = [];

  try {
    if (source.db_type === 'postgres') {
      return await relocatePg(
        { source, target, scope, sourceSchema, targetSchema, table: table ?? '', operation, include, conflict },
        log, res,
      );
    }
    return await relocateMysqlDb({ source, target, operation, include, conflict }, log, res);
  } catch (err: unknown) {
    log.push({ step: 'relocate', ok: false, text: `[ERROR] ${err instanceof Error ? err.message : String(err)}` });
    return res.status(500).json({ success: false, log });
  }
}

// ── PostgreSQL ───────────────────────────────────────────────────────────────

async function relocatePg(
  p: { source: ConnCfg; target: ConnCfg; scope: Scope; sourceSchema: string; targetSchema: string; table: string; operation: Operation; include: ExportInclude; conflict: ConflictStrategy },
  log: Log[], res: NextApiResponse,
) {
  const { source, target, scope, sourceSchema, targetSchema, table, operation, include, conflict } = p;
  const sameDb = source.host === target.host && (source.port ?? 5432) === (target.port ?? 5432) && source.database === target.database;

  // ── Fast path: same database, table or schema scope → ALTER … SET SCHEMA / CREATE LIKE
  if (sameDb && scope !== 'db') {
    const pool = pgPool(target);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${targetSchema}"`);
      const tables = scope === 'table'
        ? [table]
        : (await client.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
            [sourceSchema],
          )).rows.map(r => r.table_name);

      if (tables.length === 0) { await client.query('ROLLBACK'); log.push({ step: 'relocate', ok: false, text: `[FAIL] No tables found in schema "${sourceSchema}"` }); return res.status(400).json({ success: false, log }); }

      for (const t of tables) {
        if (operation === 'move') {
          await client.query(`ALTER TABLE "${sourceSchema}"."${t}" SET SCHEMA "${targetSchema}"`);
          log.push({ step: 'move', ok: true, text: `[MOVE] "${sourceSchema}"."${t}" → "${targetSchema}"."${t}"` });
        } else {
          await client.query(`CREATE TABLE "${targetSchema}"."${t}" (LIKE "${sourceSchema}"."${t}" INCLUDING ALL)`);
          if (include !== 'schema')
            await client.query(`INSERT INTO "${targetSchema}"."${t}" SELECT * FROM "${sourceSchema}"."${t}"`);
          log.push({ step: 'copy', ok: true, text: `[COPY] "${sourceSchema}"."${t}" → "${targetSchema}"."${t}"` });
        }
      }
      if (operation === 'move' && scope === 'schema') {
        await client.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`);
        log.push({ step: 'drop', ok: true, text: `[DROP] source schema "${sourceSchema}"` });
      }
      await client.query('COMMIT');
      log.push({ step: 'relocate', ok: true, text: `[DONE] ${operation === 'move' ? 'Moved' : 'Copied'} ${tables.length} table(s) into schema "${targetSchema}".` });
      return res.status(200).json({ success: true, log, tables });
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      log.push({ step: 'relocate', ok: false, text: `[FAIL] ${err instanceof Error ? err.message : String(err)}` });
      log.push({ step: 'relocate', ok: false, text: '[ROLLBACK] No changes applied.' });
      return res.status(500).json({ success: false, log });
    } finally { client.release(); await pool.end(); }
  }

  // ── General path: export from source schema → import into target db/schema ──
  const scopeTables = scope === 'table' ? [table] : 'all';
  log.push({ step: 'export', ok: true, text: `[START] Exporting ${scope} from "${source.database}"."${sourceSchema}"…` });
  const exported = await exportDatabase(source, scopeTables, include, { schema: sourceSchema, conflictStrategy: conflict });
  log.push({ step: 'export', ok: true, text: `[OK] Exported ${exported.tables.length} table(s), ${exported.sql.length} bytes` });

  const pool = pgPool(target);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try { await client.query('SET session_replication_role = replica'); } catch { /* no privilege — rely on FK order */ }
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${targetSchema}"`);
    await client.query(`SET search_path TO "${targetSchema}", public`);
    await client.query(exported.sql);
    await client.query('COMMIT');
    log.push({ step: 'import', ok: true, text: `[OK] Imported into "${target.database}"."${targetSchema}"` });
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    log.push({ step: 'import', ok: false, text: `[FAIL] ${err instanceof Error ? err.message : String(err)}` });
    log.push({ step: 'import', ok: false, text: '[ROLLBACK] Target rolled back — no changes applied.' });
    return res.status(500).json({ success: false, log });
  } finally { client.release(); await pool.end(); }

  // Move: drop source only after a successful copy
  if (operation === 'move') {
    const sp = pgPool(source);
    const sc = await sp.connect();
    try {
      if (scope === 'schema') { await sc.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`); log.push({ step: 'drop', ok: true, text: `[DROP] source schema "${sourceSchema}"` }); }
      else for (const t of exported.tables) { await sc.query(`DROP TABLE IF EXISTS "${sourceSchema}"."${t}" CASCADE`); log.push({ step: 'drop', ok: true, text: `[DROP] "${sourceSchema}"."${t}"` }); }
    } catch (err: unknown) {
      log.push({ step: 'drop', ok: false, text: `[WARN] Copy succeeded but dropping source failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally { sc.release(); await sp.end(); }
  }

  log.push({ step: 'relocate', ok: true, text: `[DONE] ${operation === 'move' ? 'Moved' : 'Copied'} ${exported.tables.length} table(s).` });
  return res.status(200).json({ success: true, log, tables: exported.tables });
}

// ── MySQL (db scope only) ──────────────────────────────────────────────────────

async function relocateMysqlDb(
  p: { source: ConnCfg; target: ConnCfg; operation: Operation; include: ExportInclude; conflict: ConflictStrategy },
  log: Log[], res: NextApiResponse,
) {
  const { source, target, operation, include, conflict } = p;
  log.push({ step: 'export', ok: true, text: `[START] Exporting database "${source.database}"…` });
  const exported = await exportDatabase(source, 'all', include, { conflictStrategy: conflict });
  log.push({ step: 'export', ok: true, text: `[OK] Exported ${exported.tables.length} table(s)` });

  const conn = await mysql.createConnection({
    host: target.host, port: target.port ?? 3306, user: target.user,
    password: target.password, database: target.database, multipleStatements: true,
  });
  try {
    await conn.beginTransaction();
    await conn.execute('SET FOREIGN_KEY_CHECKS=0');
    await conn.execute(exported.sql);
    await conn.execute('SET FOREIGN_KEY_CHECKS=1');
    await conn.commit();
    log.push({ step: 'import', ok: true, text: `[OK] Imported into "${target.database}"` });
  } catch (err: unknown) {
    await conn.rollback().catch(() => {});
    log.push({ step: 'import', ok: false, text: `[FAIL] ${err instanceof Error ? err.message : String(err)}` });
    return res.status(500).json({ success: false, log });
  } finally { await conn.end(); }

  if (operation === 'move') {
    const admin = await mysql.createConnection({ host: source.host, port: source.port ?? 3306, user: source.user, password: source.password });
    try { await admin.execute(`DROP DATABASE IF EXISTS \`${source.database}\``); log.push({ step: 'drop', ok: true, text: `[DROP] source database "${source.database}"` }); }
    finally { await admin.end(); }
  }

  log.push({ step: 'relocate', ok: true, text: `[DONE] ${operation === 'move' ? 'Moved' : 'Copied'} database — ${exported.tables.length} table(s).` });
  return res.status(200).json({ success: true, log, tables: exported.tables });
}
