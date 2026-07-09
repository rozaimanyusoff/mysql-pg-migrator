import type { NextApiRequest, NextApiResponse } from 'next';
import { Client, Pool } from 'pg';
import mysql from 'mysql2/promise';
import { formidable, type File } from 'formidable';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConnCfg } from '../../../lib/sql-exporter';
import { execSqlImport } from './import';
import { markDbUpdated, markSchemaUpdated } from '../../../lib/export-import-metadata';

const execFileAsync = promisify(execFile);

export const config = { api: { bodyParser: false } };

type Scope = 'db' | 'schema' | 'table';
type Format = 'sql' | 'dump';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quotePgIdent(v: string) { return `"${v.replace(/"/g, '""')}"`; }
function quoteMysqlIdent(v: string) { return `\`${v.replace(/`/g, '``')}\``; }
function field(v: string | string[] | undefined): string { return Array.isArray(v) ? v[0] ?? '' : v ?? ''; }

// Best-effort rename of a CREATE TABLE / references-to-it identifier inside a plain
// SQL dump. Covers the common case: a .sql exported by this tool's own Export
// feature (single table, quoted identifiers). Not guaranteed for arbitrary dumps.
function renameSqlIdentifier(sql: string, from: string, to: string): string {
  const pattern = new RegExp(`(["\`]?)\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b\\1`, 'g');
  return sql.replace(pattern, (_m, quote: string) => `${quote}${to}${quote}`);
}

async function checkExists(cfg: ConnCfg, scope: Scope, name: string, parentSchema: string): Promise<boolean> {
  if (cfg.db_type === 'postgres') {
    if (scope === 'db') {
      const admin = new Client({ host: cfg.host, port: cfg.port ?? 5432, user: cfg.user, password: cfg.password, database: 'postgres', ssl: cfg.ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10000 });
      await admin.connect();
      try {
        const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
        return rows.length > 0;
      } finally { await admin.end().catch(() => {}); }
    }
    const pool = new Pool({ host: cfg.host, port: cfg.port ?? 5432, user: cfg.user, password: cfg.password, database: cfg.database, ssl: cfg.ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10000 });
    try {
      if (scope === 'schema') {
        const { rows } = await pool.query('SELECT 1 FROM information_schema.schemata WHERE schema_name = $1', [name]);
        return rows.length > 0;
      }
      const { rows } = await pool.query('SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [parentSchema, name]);
      return rows.length > 0;
    } finally { await pool.end(); }
  }
  // MySQL: only db/table scope reach here
  const admin = await mysql.createConnection({ host: cfg.host, port: cfg.port ?? 3306, user: cfg.user, password: cfg.password });
  try {
    if (scope === 'db') {
      const [rows] = await admin.execute('SELECT 1 FROM information_schema.schemata WHERE schema_name = ?', [name]) as [unknown[], unknown];
      return rows.length > 0;
    }
    const [rows] = await admin.execute('SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?', [cfg.database, name]) as [unknown[], unknown];
    return rows.length > 0;
  } finally { await admin.end(); }
}

async function createPgDatabase(cfg: ConnCfg, name: string) {
  const admin = new Client({ host: cfg.host, port: cfg.port ?? 5432, user: cfg.user, password: cfg.password, database: 'postgres', ssl: cfg.ssl ? { rejectUnauthorized: false } : false, connectionTimeoutMillis: 10000 });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${quotePgIdent(name)}`); } finally { await admin.end().catch(() => {}); }
}

async function createMysqlDatabase(cfg: ConnCfg, name: string) {
  const admin = await mysql.createConnection({ host: cfg.host, port: cfg.port ?? 3306, user: cfg.user, password: cfg.password });
  try { await admin.execute(`CREATE DATABASE ${quoteMysqlIdent(name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } finally { await admin.end(); }
}

async function runPgBinary(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { env, maxBuffer: 1024 * 1024 * 64 });
    return { ok: true, output: [stdout, stderr].filter(Boolean).join('\n') };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n') };
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const form = formidable({ maxFileSize: 500 * 1024 * 1024 });
  let fields: Record<string, string | string[] | undefined>;
  let files: Record<string, File | File[] | undefined>;
  try {
    [fields, files] = await form.parse(req);
  } catch (err: unknown) {
    return res.status(400).json({ success: false, log: [`[ERROR] Failed to parse upload: ${err instanceof Error ? err.message : String(err)}`] });
  }

  let cfg: ConnCfg;
  try { cfg = JSON.parse(field(fields.cfg)) as ConnCfg; } catch { return res.status(400).json({ error: 'cfg must be valid JSON' }); }
  const scope = field(fields.scope) as Scope;
  const format = field(fields.format) as Format;
  const parentSchema = field(fields.parentSchema) || 'public';
  const targetName = field(fields.targetName);
  const originalName = field(fields.originalName) || targetName;
  const skipConstraints = field(fields.skipConstraints) === 'true';
  const fileEntry = Array.isArray(files.file) ? files.file[0] : files.file;

  if (!cfg?.host || !cfg?.user || !cfg?.db_type) return res.status(400).json({ error: 'cfg (db_type, host, user) required' });
  if (!scope || !format) return res.status(400).json({ error: 'scope and format are required' });
  if (!targetName || !IDENT_RE.test(targetName)) return res.status(400).json({ error: 'targetName must contain only letters, digits, and underscores, and not start with a digit' });
  if (!fileEntry) return res.status(400).json({ error: 'file is required' });
  if (format === 'dump' && cfg.db_type !== 'postgres') return res.status(400).json({ error: '.dump import is only supported for PostgreSQL' });

  const log: string[] = [];
  try {
    if (await checkExists(cfg, scope, targetName, parentSchema)) {
      return res.status(409).json({ success: false, log: [`[FAIL] ${scope} "${targetName}" already exists — choose a different name`] });
    }

    if (format === 'sql') {
      let sqlText = fs.readFileSync(fileEntry.filepath, 'utf8');
      if (scope === 'table' && originalName !== targetName) {
        sqlText = renameSqlIdentifier(sqlText, originalName, targetName);
        log.push(`[INFO] Renamed table identifier "${originalName}" → "${targetName}" in SQL text`);
      }

      if (scope === 'db') {
        if (cfg.db_type === 'postgres') await createPgDatabase(cfg, targetName);
        else await createMysqlDatabase(cfg, targetName);
        log.push(`[OK] Created database "${targetName}"`);
        const result = await execSqlImport({ ...cfg, database: targetName }, sqlText, { skipConstraints });
        if (result.success) markDbUpdated(cfg, targetName, 'imported');
        return res.status(result.success ? 200 : 500).json({ success: result.success, log: [...log, ...result.log] });
      }
      if (scope === 'schema') {
        const result = await execSqlImport(cfg, sqlText, { schema: targetName, skipConstraints });
        if (result.success) markSchemaUpdated(cfg, cfg.database, targetName, 'imported');
        return res.status(result.success ? 200 : 500).json({ success: result.success, log: [...log, ...result.log] });
      }
      const result = await execSqlImport(cfg, sqlText, { schema: parentSchema, skipConstraints });
      return res.status(result.success ? 200 : 500).json({ success: result.success, log: [...log, ...result.log] });
    }

    // ── .dump (pg_restore) — PostgreSQL only ──────────────────────────────────
    const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: cfg.password };
    const host = cfg.host, port = String(cfg.port ?? 5432), user = cfg.user;

    if (scope === 'db') {
      await createPgDatabase(cfg, targetName);
      log.push(`[OK] Created database "${targetName}"`);
      const r = await runPgBinary('pg_restore', ['--no-owner', '--clean', '--if-exists', '-h', host, '-p', port, '-U', user, '-d', targetName, fileEntry.filepath], env);
      log.push(...r.output.split('\n').filter(Boolean));
      log.push(r.ok ? `[OK] Restored dump into database "${targetName}"` : '[FAIL] pg_restore reported errors');
      if (r.ok) markDbUpdated(cfg, targetName, 'imported');
      return res.status(r.ok ? 200 : 500).json({ success: r.ok, log });
    }
    if (scope === 'schema') {
      const pool = new Pool({ host: cfg.host, port: cfg.port ?? 5432, user: cfg.user, password: cfg.password, database: cfg.database, ssl: cfg.ssl ? { rejectUnauthorized: false } : false });
      try { await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdent(targetName)}`); } finally { await pool.end(); }
      log.push(`[OK] Created schema "${targetName}"`);
      const r = await runPgBinary('pg_restore', ['--no-owner', '-h', host, '-p', port, '-U', user, '-d', cfg.database, fileEntry.filepath], { ...env, PGOPTIONS: `-c search_path=${targetName}` });
      log.push(...r.output.split('\n').filter(Boolean));
      log.push(r.ok ? `[OK] Restored dump into schema "${targetName}"` : '[FAIL] pg_restore reported errors');
      if (r.ok) markSchemaUpdated(cfg, cfg.database, targetName, 'imported');
      return res.status(r.ok ? 200 : 500).json({ success: r.ok, log });
    }
    // table scope
    if (originalName !== targetName) {
      return res.status(400).json({ success: false, log: [`[FAIL] Renaming is not supported for .dump table imports — choose a name that doesn't conflict, or use a .sql file`] });
    }
    const r = await runPgBinary('pg_restore', ['--no-owner', '-h', host, '-p', port, '-U', user, '-d', cfg.database, '-t', originalName, fileEntry.filepath], { ...env, PGOPTIONS: `-c search_path=${parentSchema}` });
    log.push(...r.output.split('\n').filter(Boolean));
    log.push(r.ok ? `[OK] Restored table "${targetName}" into schema "${parentSchema}"` : '[FAIL] pg_restore reported errors');
    return res.status(r.ok ? 200 : 500).json({ success: r.ok, log });
  } catch (err: unknown) {
    return res.status(500).json({ success: false, log: [...log, `[ERROR] ${err instanceof Error ? err.message : String(err)}`] });
  } finally {
    if (fileEntry) fs.unlink(fileEntry.filepath, () => {});
  }
}
