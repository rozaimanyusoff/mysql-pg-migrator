import type { NextApiRequest, NextApiResponse } from 'next';
import { Client, Pool } from 'pg';
import mysql from 'mysql2/promise';
import { ConnCfg } from '../../../lib/sql-exporter';

type Scope = 'db' | 'schema' | 'table';
type Action = 'rename' | 'truncate' | 'drop';

interface Body {
  cfg?: ConnCfg;
  scope?: Scope;
  schema?: string;   // parent schema, required for table scope (PG)
  name?: string;     // current db/schema/table name
  action?: Action;
  newName?: string;  // required for rename
}

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quotePgIdent(v: string) { return `"${v.replace(/"/g, '""')}"`; }
function quoteMysqlIdent(v: string) { return `\`${v.replace(/`/g, '``')}\``; }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cfg, scope, schema = 'public', name, action, newName } = req.body as Body;
  if (!cfg?.host || !cfg?.user || !cfg?.database || !cfg?.db_type)
    return res.status(400).json({ error: 'cfg (db_type, host, user, database) required' });
  if (!scope || !action || !name?.trim())
    return res.status(400).json({ error: 'scope, action, and name are required' });
  if (action === 'rename') {
    if (!newName?.trim()) return res.status(400).json({ error: 'newName is required for rename' });
    if (!IDENT_RE.test(newName)) return res.status(400).json({ error: 'Invalid name — letters, digits, and underscores only, must not start with a digit' });
  }
  if (scope !== 'db' && cfg.db_type === 'mysql')
    return res.status(400).json({ error: 'MySQL has no schemas — only database-scope maintenance is supported' });

  const log: string[] = [];
  try {
    if (cfg.db_type === 'postgres') {
      if (scope === 'db') return await pgDb(cfg, name, action, newName, log, res);
      if (scope === 'schema') return await pgSchema(cfg, name, action, newName, log, res);
      return await pgTable(cfg, schema, name, action, newName, log, res);
    }
    return await mysqlDb(cfg, name, action, newName, log, res, scope === 'table' ? name : undefined);
  } catch (err: unknown) {
    return res.status(500).json({ success: false, log: [...log, `[ERROR] ${err instanceof Error ? err.message : String(err)}`] });
  }
}

function pgPool(cfg: ConnCfg) {
  return new Pool({
    host: cfg.host, port: cfg.port ?? 5432, user: cfg.user, password: cfg.password,
    database: cfg.database, ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000, statement_timeout: 0,
  });
}

async function pgAdminClient(cfg: ConnCfg) {
  const client = new Client({
    host: cfg.host, port: cfg.port ?? 5432, user: cfg.user, password: cfg.password,
    database: 'postgres', ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  return client;
}

// ── PostgreSQL: database scope ─────────────────────────────────────────────────

async function pgDb(cfg: ConnCfg, name: string, action: Action, newName: string | undefined, log: string[], res: NextApiResponse) {
  const admin = await pgAdminClient(cfg);
  try {
    if (action === 'drop') {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
      await admin.query(`DROP DATABASE IF EXISTS ${quotePgIdent(name)}`);
      log.push(`[OK] Dropped database "${name}"`);
      return res.status(200).json({ success: true, log });
    }
    if (action === 'rename') {
      await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [name]);
      await admin.query(`ALTER DATABASE ${quotePgIdent(name)} RENAME TO ${quotePgIdent(newName!)}`);
      log.push(`[OK] Renamed database "${name}" to "${newName}"`);
      return res.status(200).json({ success: true, log });
    }
    // truncate: walk every schema's base tables and truncate them all
    const pool = pgPool({ ...cfg, database: name });
    try {
      const { rows } = await pool.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`
      );
      if (rows.length === 0) { log.push('[INFO] No tables to truncate'); return res.status(200).json({ success: true, log }); }
      const idents = rows.map(r => `${quotePgIdent(r.table_schema)}.${quotePgIdent(r.table_name)}`).join(', ');
      await pool.query(`TRUNCATE TABLE ${idents} RESTART IDENTITY CASCADE`);
      log.push(`[OK] Truncated ${rows.length} table(s) in database "${name}"`);
      return res.status(200).json({ success: true, log });
    } finally { await pool.end(); }
  } finally { await admin.end().catch(() => {}); }
}

// ── PostgreSQL: schema scope ────────────────────────────────────────────────────

async function pgSchema(cfg: ConnCfg, name: string, action: Action, newName: string | undefined, log: string[], res: NextApiResponse) {
  const pool = pgPool(cfg);
  try {
    if (action === 'drop') {
      await pool.query(`DROP SCHEMA IF EXISTS ${quotePgIdent(name)} CASCADE`);
      log.push(`[OK] Dropped schema "${name}"`);
      return res.status(200).json({ success: true, log });
    }
    if (action === 'rename') {
      await pool.query(`ALTER SCHEMA ${quotePgIdent(name)} RENAME TO ${quotePgIdent(newName!)}`);
      log.push(`[OK] Renamed schema "${name}" to "${newName}"`);
      return res.status(200).json({ success: true, log });
    }
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [name],
    );
    if (rows.length === 0) { log.push('[INFO] No tables to truncate'); return res.status(200).json({ success: true, log }); }
    const idents = rows.map(r => `${quotePgIdent(name)}.${quotePgIdent(r.table_name)}`).join(', ');
    await pool.query(`TRUNCATE TABLE ${idents} RESTART IDENTITY CASCADE`);
    log.push(`[OK] Truncated ${rows.length} table(s) in schema "${name}"`);
    return res.status(200).json({ success: true, log });
  } finally { await pool.end(); }
}

// ── PostgreSQL: table scope ─────────────────────────────────────────────────────

async function pgTable(cfg: ConnCfg, schema: string, name: string, action: Action, newName: string | undefined, log: string[], res: NextApiResponse) {
  const pool = pgPool(cfg);
  try {
    const qualified = `${quotePgIdent(schema)}.${quotePgIdent(name)}`;
    if (action === 'drop') {
      await pool.query(`DROP TABLE IF EXISTS ${qualified} CASCADE`);
      log.push(`[OK] Dropped table "${schema}"."${name}"`);
      return res.status(200).json({ success: true, log });
    }
    if (action === 'rename') {
      await pool.query(`ALTER TABLE ${qualified} RENAME TO ${quotePgIdent(newName!)}`);
      log.push(`[OK] Renamed table "${schema}"."${name}" to "${newName}"`);
      return res.status(200).json({ success: true, log });
    }
    await pool.query(`TRUNCATE TABLE ${qualified} RESTART IDENTITY CASCADE`);
    log.push(`[OK] Truncated table "${schema}"."${name}"`);
    return res.status(200).json({ success: true, log });
  } finally { await pool.end(); }
}

// ── MySQL: database / table scope (no schema concept) ───────────────────────────

async function mysqlDb(cfg: ConnCfg, name: string, action: Action, newName: string | undefined, log: string[], res: NextApiResponse, tableName?: string) {
  if (action === 'rename' && !tableName)
    return res.status(400).json({ error: 'Not supported for MySQL — use Copy then Drop instead.' });

  if (tableName) {
    // Table scope: operate against the database itself
    const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port ?? 3306, user: cfg.user, password: cfg.password, database: cfg.database });
    try {
      if (action === 'drop') { await conn.execute(`DROP TABLE IF EXISTS ${quoteMysqlIdent(tableName)}`); log.push(`[OK] Dropped table "${tableName}"`); }
      else if (action === 'rename') { await conn.execute(`RENAME TABLE ${quoteMysqlIdent(tableName)} TO ${quoteMysqlIdent(newName!)}`); log.push(`[OK] Renamed table "${tableName}" to "${newName}"`); }
      else { await conn.execute(`TRUNCATE TABLE ${quoteMysqlIdent(tableName)}`); log.push(`[OK] Truncated table "${tableName}"`); }
      return res.status(200).json({ success: true, log });
    } finally { await conn.end(); }
  }

  // Database scope
  const admin = await mysql.createConnection({ host: cfg.host, port: cfg.port ?? 3306, user: cfg.user, password: cfg.password });
  try {
    if (action === 'drop') {
      await admin.execute(`DROP DATABASE IF EXISTS ${quoteMysqlIdent(name)}`);
      log.push(`[OK] Dropped database "${name}"`);
      return res.status(200).json({ success: true, log });
    }
    // truncate: walk every table in the database
    const [rows] = await admin.execute(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`, [name],
    ) as [{ table_name: string }[], unknown];
    if (rows.length === 0) { log.push('[INFO] No tables to truncate'); return res.status(200).json({ success: true, log }); }
    await admin.execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const r of rows) await admin.execute(`TRUNCATE TABLE ${quoteMysqlIdent(name)}.${quoteMysqlIdent(r.table_name)}`);
    await admin.execute('SET FOREIGN_KEY_CHECKS = 1');
    log.push(`[OK] Truncated ${rows.length} table(s) in database "${name}"`);
    return res.status(200).json({ success: true, log });
  } finally { await admin.end(); }
}
