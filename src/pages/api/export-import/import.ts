import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool, Client } from 'pg';
import mysql from 'mysql2/promise';
import { ConnCfg } from '../../../lib/sql-exporter';

type ImportStrategy = 'import_rows' | 'replace_schema' | 'replace_db' | 'replace_table';

interface ImportScopeOpts {
  schema?: string;   // PostgreSQL target schema (default 'public')
  table?: string;    // required for replace_table
}

// ── pg_dump preprocessor ─────────────────────────────────────────────────────
// Strips psql meta-commands (\restrict, \unrestrict, \connect, …) and converts
// COPY … FROM stdin blocks into batched INSERT statements so the pg driver can
// execute the SQL directly without the psql client.

function preprocessSql(rawSql: string): { sql: string; converted: number; copyTables: string[] } {
  const lines = rawSql.split('\n');
  const output: string[] = [];

  let copyMode = false;
  let copyTarget = '';
  let copyCols: string[] = [];
  let copyData: (string | null)[][] = [];
  let converted = 0;
  const copyTables: string[] = [];

  const flushCopy = () => {
    if (copyData.length === 0) return;
    converted++;
    copyTables.push(copyTarget);
    const colList = copyCols.map(c => `"${c}"`).join(', ');
    for (let i = 0; i < copyData.length; i += 500) {
      const chunk = copyData.slice(i, i + 500);
      const valsList = chunk
        .map(row =>
          `(${row.map(f => f === null ? 'NULL' : `'${f.replace(/'/g, "''")}'`).join(', ')})`
        )
        .join(',\n');
      output.push(`INSERT INTO ${copyTarget} (${colList}) VALUES\n${valsList};`);
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // ── Inside a COPY block ──────────────────────────────────────────────────
    if (copyMode) {
      if (trimmed === '\\.') {
        flushCopy();
        copyMode = false; copyTarget = ''; copyCols = []; copyData = [];
        continue;
      }
      if (trimmed) copyData.push(parseCopyRow(line));
      continue;
    }

    // ── Skip psql backslash meta-commands ────────────────────────────────────
    // Matches \restrict, \unrestrict, \connect, \set, \c, etc.
    if (/^\\[a-zA-Z]/.test(trimmed)) continue;

    // ── Detect COPY … FROM stdin ─────────────────────────────────────────────
    const m = trimmed.match(/^COPY\s+(\S+)\s*\(([^)]+)\)\s+FROM\s+stdin\s*;?\s*$/i);
    if (m) {
      copyMode = true;
      copyTarget = m[1];
      copyCols = m[2].split(',').map(c => c.trim());
      copyData = [];
      continue;
    }

    output.push(line);
  }

  return { sql: output.join('\n'), converted, copyTables };
}

// Parse one line of COPY text format (tab-separated, \N = NULL, \\ = backslash …)
function parseCopyRow(line: string): (string | null)[] {
  return line.split('\t').map(field => {
    if (field === '\\N') return null;
    let result = '';
    for (let i = 0; i < field.length; i++) {
      if (field[i] === '\\' && i + 1 < field.length) {
        i++;
        switch (field[i]) {
          case '\\': result += '\\'; break;
          case 'n': result += '\n'; break;
          case 't': result += '\t'; break;
          case 'r': result += '\r'; break;
          default: result += field[i]; break;
        }
      } else {
        result += field[i];
      }
    }
    return result;
  });
}
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cfg, sql, strategy = 'import_rows', schema, table } = req.body as {
    cfg?: ConnCfg; sql?: string; strategy?: ImportStrategy; schema?: string; table?: string;
  };
  if (!cfg?.host || !cfg?.user || !cfg?.database || !cfg?.db_type)
    return res.status(400).json({ error: 'cfg (db_type, host, user, database) required' });
  if (!sql?.trim()) return res.status(400).json({ error: 'sql is required' });
  if (strategy === 'replace_table' && !table?.trim())
    return res.status(400).json({ error: 'table is required for replace_table' });

  const scope: ImportScopeOpts = { schema: schema?.trim() || undefined, table: table?.trim() || undefined };

  try {
    if (cfg.db_type === 'postgres') return await pgImport(cfg, sql, strategy, res, scope);
    return await mysqlImport(cfg, sql, strategy, res, scope);
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function pgImport(cfg: ConnCfg, rawSql: string, strategy: ImportStrategy, res: NextApiResponse, scope: ImportScopeOpts = {}) {
  const log: string[] = [];
  const targetSchema = scope.schema || 'public';

  // Preprocess: convert COPY blocks → INSERT, strip psql meta-commands
  const { sql, converted, copyTables } = preprocessSql(rawSql);
  if (converted > 0)
    log.push(`[INFO] Preprocessed dump: converted ${converted} COPY block${converted > 1 ? 's' : ''} to INSERT statements`);

  if (strategy === 'replace_db') {
    const adminClient = new Client({
      host: cfg.host, port: cfg.port ?? 5432, user: cfg.user,
      password: cfg.password, database: 'postgres',
      ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 15000,
    });
    await adminClient.connect();
    try {
      await adminClient.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [cfg.database],
      );
      await adminClient.query(`DROP DATABASE IF EXISTS "${cfg.database}"`);
      await adminClient.query(`CREATE DATABASE "${cfg.database}"`);
      log.push(`[INFO] Dropped and recreated database "${cfg.database}"`);
    } finally { await adminClient.end(); }
  }

  const pool = new Pool({
    host: cfg.host, port: cfg.port ?? 5432, user: cfg.user,
    password: cfg.password, database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
    statement_timeout: 0,       // disable per-statement timeout for large imports
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (strategy === 'replace_schema') {
      if (copyTables.length > 0) {
        // Data-only dump: truncate only the tables referenced in the dump so the
        // schema structure is preserved and duplicates are avoided.
        await client.query(
          `TRUNCATE TABLE ${copyTables.join(', ')} RESTART IDENTITY CASCADE`
        );
        log.push(`[INFO] Truncated ${copyTables.length} table(s) before import: ${copyTables.join(', ')}`);
      } else {
        // Full SQL dump (has CREATE TABLE): drop and recreate the target schema.
        await client.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`);
        await client.query(`CREATE SCHEMA "${targetSchema}"`);
        await client.query(`GRANT ALL ON SCHEMA "${targetSchema}" TO "${cfg.user}"`);
        if (targetSchema === 'public') await client.query('GRANT ALL ON SCHEMA public TO public');
        log.push(`[INFO] Replaced schema "${targetSchema}"`);
      }
    } else if (strategy === 'replace_table') {
      await client.query(`DROP TABLE IF EXISTS "${targetSchema}"."${scope.table}" CASCADE`);
      log.push(`[INFO] Dropped table "${targetSchema}"."${scope.table}" before import`);
    } else if (targetSchema !== 'public') {
      // Create-new / insert into a non-public schema: ensure it exists.
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${targetSchema}"`);
    }

    // Route unqualified objects in the dump into the target schema.
    await client.query(`SET search_path TO "${targetSchema}", public`);

    await client.query(sql);
    await client.query('COMMIT');
    log.push(`[OK] SQL imported and committed to "${cfg.database}"${targetSchema !== 'public' ? ` (schema "${targetSchema}")` : ''}`);
    return res.status(200).json({ success: true, log });
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      success: false, rolledBack: true,
      log: [
        ...log,
        `[FAIL] Import failed on "${cfg.database}"`,
        '[ROLLBACK] Transaction rolled back — database state is unchanged.',
        `[ERROR] ${message}`,
      ],
    });
  } finally { client.release(); await pool.end(); }
}

async function mysqlImport(cfg: ConnCfg, rawSql: string, strategy: ImportStrategy, res: NextApiResponse, scope: ImportScopeOpts = {}) {
  const log: string[] = [];

  // Preprocess handles psql dumps gracefully even if targeting MySQL
  const { sql, converted } = preprocessSql(rawSql);
  if (converted > 0)
    log.push(`[INFO] Preprocessed dump: converted ${converted} COPY block${converted > 1 ? 's' : ''} to INSERT statements`);

  if (strategy === 'replace_table') {
    // MySQL has no separate schema; drop the single named table before import.
    const tblConn = await mysql.createConnection({
      host: cfg.host, port: cfg.port ?? 3306, user: cfg.user,
      password: cfg.password, database: cfg.database,
    });
    try {
      await tblConn.execute('SET FOREIGN_KEY_CHECKS = 0');
      await tblConn.execute(`DROP TABLE IF EXISTS \`${scope.table}\``);
      await tblConn.execute('SET FOREIGN_KEY_CHECKS = 1');
      log.push(`[INFO] Dropped table "${scope.table}" before import`);
    } finally { await tblConn.end(); }
  } else if (strategy === 'replace_db') {
    const adminConn = await mysql.createConnection({
      host: cfg.host, port: cfg.port ?? 3306, user: cfg.user, password: cfg.password,
    });
    try {
      await adminConn.execute(`DROP DATABASE IF EXISTS \`${cfg.database}\``);
      await adminConn.execute(`CREATE DATABASE \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      log.push(`[INFO] Dropped and recreated database "${cfg.database}"`);
    } finally { await adminConn.end(); }
  } else if (strategy === 'replace_schema') {
    const schemaConn = await mysql.createConnection({
      host: cfg.host, port: cfg.port ?? 3306, user: cfg.user,
      password: cfg.password, database: cfg.database,
    });
    try {
      await schemaConn.execute('SET FOREIGN_KEY_CHECKS = 0');
      const [rows] = await schemaConn.execute(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
        [cfg.database],
      ) as [{ table_name: string }[], unknown];
      for (const row of rows) {
        await schemaConn.execute(`DROP TABLE IF EXISTS \`${row.table_name}\``);
      }
      await schemaConn.execute('SET FOREIGN_KEY_CHECKS = 1');
      log.push(`[INFO] Dropped all tables in "${cfg.database}"`);
    } finally { await schemaConn.end(); }
  }

  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port ?? 3306, user: cfg.user,
    password: cfg.password, database: cfg.database,
    multipleStatements: true,
  });
  try {
    await conn.beginTransaction();
    await conn.execute(sql);
    await conn.commit();
    log.push(`[OK] SQL imported and committed to "${cfg.database}"`);
    return res.status(200).json({ success: true, log });
  } catch (err: unknown) {
    await conn.rollback().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({
      success: false, rolledBack: true,
      log: [
        ...log,
        `[FAIL] Import failed on "${cfg.database}"`,
        '[ROLLBACK] Transaction rolled back — database state is unchanged.',
        `[ERROR] ${message}`,
      ],
    });
  } finally { await conn.end(); }
}
