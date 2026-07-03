import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool, Client } from 'pg';
import mysql from 'mysql2/promise';
import { ConnCfg } from '../../../lib/sql-exporter';

type ImportStrategy = 'import_rows' | 'replace_schema' | 'replace_db' | 'replace_table';

interface ImportScopeOpts {
  schema?: string;   // PostgreSQL target schema (default 'public')
  table?: string;    // required for replace_table
  skipConstraints?: boolean; // disable FK/trigger checks during load, restore after
}

// ── pg_dump preprocessor ─────────────────────────────────────────────────────
// Strips psql meta-commands (\restrict, \unrestrict, \connect, …) and converts
// COPY … FROM stdin blocks into batched INSERT statements so the pg driver can
// execute the SQL directly without the psql client.

function preprocessSql(rawSql: string): { sql: string; converted: number; copyTables: string[]; strippedOwnership: number } {
  // PG doesn't support ADD CONSTRAINT IF NOT EXISTS — strip it from any old dumps.
  rawSql = rawSql.replace(/ADD CONSTRAINT IF NOT EXISTS\b/gi, 'ADD CONSTRAINT');
  // CREATE SCHEMA has no IF NOT EXISTS guard in pg_dump output; add it so re-imports don't error.
  rawSql = rawSql.replace(/\bCREATE SCHEMA\s+(?!IF\s+NOT\s+EXISTS)/gi, 'CREATE SCHEMA IF NOT EXISTS ');
  // Old exports used WHEN duplicate_object which doesn't catch cross-schema FK errors.
  // Upgrade to WHEN OTHERS so FK blocks are fully best-effort on import.
  rawSql = rawSql.replace(/EXCEPTION WHEN duplicate_object THEN NULL;/gi, 'EXCEPTION WHEN OTHERS THEN NULL;');

  // Plain-format pg_dump embeds the source server's role names in ALTER ... OWNER TO
  // and GRANT/REVOKE statements. The .dump import path already drops these via
  // `pg_restore --no-owner`; do the same for plain .sql dumps, since the target
  // environment's roles (e.g. its connecting user) rarely match the source's and
  // there's no way to remap them — left in, they abort the whole import with
  // "role ... does not exist".
  let strippedOwnership = 0;
  rawSql = rawSql.replace(/^\s*ALTER\s+.*?\bOWNER\s+TO\s+[^;]+;\s*$/gim, () => { strippedOwnership++; return ''; });
  rawSql = rawSql.replace(/^\s*(?:GRANT|REVOKE)\s+.*;\s*$/gim, () => { strippedOwnership++; return ''; });
  rawSql = rawSql.replace(/^\s*(?:SET|RESET)\s+SESSION\s+AUTHORIZATION\b.*;\s*$/gim, () => { strippedOwnership++; return ''; });

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
      // Strip any existing double-quotes (pg_dump quotes reserved words like "position", "order").
      copyCols = m[2].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      copyData = [];
      continue;
    }

    output.push(line);
  }

  return { sql: output.join('\n'), converted, copyTables, strippedOwnership };
}

// ── FK deferral (skip-constraints backstop) ──────────────────────────────────
// session_replication_role = replica should suppress FK trigger firing, but some
// dumps define FOREIGN KEY constraints inline (not deferred to a post-data section
// the way pg_dump/our own exporter do), and in practice that ordering — not just
// the GUC — is what avoids the violation. Structurally relocate every FK-adding
// statement (bare ALTER TABLE, or this app's own DO $$ ... $$ best-effort wrapper)
// to the very end of the script so the constraint physically can't exist yet when
// earlier data statements run, regardless of trigger/GUC behavior on the target server.
//
// Relocating alone isn't enough: ADD CONSTRAINT re-validates against the now-loaded
// data, so a genuinely orphaned row (no matching parent) still fails — and since this
// is a single transaction, that failure rolls back everything, defeating the point of
// "skip constraints". So bare statements get wrapped in the same best-effort
// DO $$ ... EXCEPTION WHEN OTHERS THEN NULL; END $$; pattern already used elsewhere in
// this codebase for FK creation: a constraint that can't validate is skipped, not fatal.
function deferForeignKeys(sql: string): { sql: string; deferred: number } {
  const blockRe = /DO \$\$\s*BEGIN[\s\S]*?FOREIGN KEY[\s\S]*?END \$\$;/gi;
  const bareRe = /ALTER TABLE(?:\s+ONLY)?\s+\S+\s+ADD CONSTRAINT\s+\S+\s+FOREIGN KEY[\s\S]*?;/gi;
  const deferred: string[] = [];
  let out = sql.replace(blockRe, m => { deferred.push(m.trim()); return ''; });
  out = out.replace(bareRe, m => {
    deferred.push(`DO $$ BEGIN\n  ${m.trim()}\nEXCEPTION WHEN OTHERS THEN NULL;\nEND $$;`);
    return '';
  });
  if (deferred.length === 0) return { sql, deferred: 0 };
  return { sql: `${out}\n\n-- [skip-constraints] Deferred FOREIGN KEY constraints, added after data load (best-effort)\n${deferred.join('\n')}\n`, deferred: deferred.length };
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

export const config = {
  api: { bodyParser: { sizeLimit: '100mb' } },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cfg, sql, strategy = 'import_rows', schema, table, skipConstraints } = req.body as {
    cfg?: ConnCfg; sql?: string; strategy?: ImportStrategy; schema?: string; table?: string; skipConstraints?: boolean;
  };
  if (!cfg?.host || !cfg?.user || !cfg?.database || !cfg?.db_type)
    return res.status(400).json({ error: 'cfg (db_type, host, user, database) required' });
  if (!sql?.trim()) return res.status(400).json({ error: 'sql is required' });
  if (strategy === 'replace_table' && !table?.trim())
    return res.status(400).json({ error: 'table is required for replace_table' });

  const scope: ImportScopeOpts = { schema: schema?.trim() || undefined, table: table?.trim() || undefined };

  try {
    if (cfg.db_type === 'postgres') return await pgImport(cfg, sql, strategy, res, scope, !!skipConstraints);
    return await mysqlImport(cfg, sql, strategy, res, scope, !!skipConstraints);
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Shared exec core, reused by import-object.ts for "create new db/schema/table" ──
// Runs preprocessed SQL against cfg under the given schema's search_path, inside a
// transaction. Returns the same { success, log } / rollback shape as the HTTP handlers.
export async function execSqlImport(cfg: ConnCfg, rawSql: string, opts: ImportScopeOpts = {}): Promise<{ success: boolean; log: string[] }> {
  if (cfg.db_type === 'postgres') return execPgImport(cfg, rawSql, opts);
  return execMysqlImport(cfg, rawSql, opts);
}

async function execPgImport(cfg: ConnCfg, rawSql: string, scope: ImportScopeOpts): Promise<{ success: boolean; log: string[] }> {
  const log: string[] = [];
  const targetSchema = scope.schema || 'public';
  let { sql, converted, strippedOwnership } = preprocessSql(rawSql);
  if (converted > 0)
    log.push(`[INFO] Preprocessed dump: converted ${converted} COPY block${converted > 1 ? 's' : ''} to INSERT statements`);
  if (strippedOwnership > 0)
    log.push(`[INFO] Stripped ${strippedOwnership} ownership/privilege statement${strippedOwnership > 1 ? 's' : ''} (ALTER...OWNER TO, GRANT/REVOKE) referencing source-only roles`);
  if (scope.skipConstraints) {
    const { sql: deferredSql, deferred } = deferForeignKeys(sql);
    sql = deferredSql;
    if (deferred > 0) log.push(`[INFO] Deferred ${deferred} FOREIGN KEY constraint${deferred > 1 ? 's' : ''} to run after data load (best-effort — any that fail to validate are silently skipped, not restored)`);
  }

  const pool = new Pool({
    host: cfg.host, port: cfg.port ?? 5432, user: cfg.user,
    password: cfg.password, database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000, statement_timeout: 0,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (scope.skipConstraints) {
      try {
        await client.query('SET session_replication_role = replica');
        log.push('[INFO] Constraints skipped: SET session_replication_role = replica (FK/trigger checks disabled for this transaction)');
      } catch (e: unknown) {
        log.push(`[WARN] Could not disable constraints (requires superuser/REPLICATION privilege): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (targetSchema !== 'public') await client.query(`CREATE SCHEMA IF NOT EXISTS "${targetSchema}"`);
    await client.query(`SET search_path TO "${targetSchema}", public`);
    await client.query(sql);
    if (scope.skipConstraints) {
      await client.query('SET session_replication_role = origin').catch(() => {});
      log.push('[INFO] Constraints restored: SET session_replication_role = origin');
    }
    await client.query('COMMIT');
    log.push(`[OK] SQL imported and committed to "${cfg.database}"${targetSchema !== 'public' ? ` (schema "${targetSchema}")` : ''}`);
    return { success: true, log };
  } catch (err: unknown) {
    await client.query('ROLLBACK').catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, log: [...log, `[FAIL] Import failed on "${cfg.database}"`, '[ROLLBACK] Transaction rolled back — database state is unchanged.', `[ERROR] ${message}`] };
  } finally { client.release(); await pool.end(); }
}

async function execMysqlImport(cfg: ConnCfg, rawSql: string, scope: ImportScopeOpts): Promise<{ success: boolean; log: string[] }> {
  const log: string[] = [];
  const { sql, converted, strippedOwnership } = preprocessSql(rawSql);
  if (converted > 0)
    log.push(`[INFO] Preprocessed dump: converted ${converted} COPY block${converted > 1 ? 's' : ''} to INSERT statements`);
  if (strippedOwnership > 0)
    log.push(`[INFO] Stripped ${strippedOwnership} ownership/privilege statement${strippedOwnership > 1 ? 's' : ''} (ALTER...OWNER TO, GRANT/REVOKE) referencing source-only roles`);

  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port ?? 3306, user: cfg.user,
    password: cfg.password, database: cfg.database, multipleStatements: true,
  });
  try {
    await conn.beginTransaction();
    if (scope.skipConstraints) {
      await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
      log.push('[INFO] Constraints skipped: SET FOREIGN_KEY_CHECKS = 0');
    }
    await conn.execute(sql);
    if (scope.skipConstraints) {
      await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
      log.push('[INFO] Constraints restored: SET FOREIGN_KEY_CHECKS = 1');
    }
    await conn.commit();
    log.push(`[OK] SQL imported and committed to "${cfg.database}"`);
    return { success: true, log };
  } catch (err: unknown) {
    await conn.rollback().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, log: [...log, `[FAIL] Import failed on "${cfg.database}"`, '[ROLLBACK] Transaction rolled back — database state is unchanged.', `[ERROR] ${message}`] };
  } finally { await conn.end(); }
}

async function pgImport(cfg: ConnCfg, rawSql: string, strategy: ImportStrategy, res: NextApiResponse, scope: ImportScopeOpts = {}, skipConstraints = false) {
  const log: string[] = [];
  const targetSchema = scope.schema || 'public';

  // Preprocess: convert COPY blocks → INSERT, strip psql meta-commands
  let { sql, converted, copyTables, strippedOwnership } = preprocessSql(rawSql);
  if (converted > 0)
    log.push(`[INFO] Preprocessed dump: converted ${converted} COPY block${converted > 1 ? 's' : ''} to INSERT statements`);
  if (strippedOwnership > 0)
    log.push(`[INFO] Stripped ${strippedOwnership} ownership/privilege statement${strippedOwnership > 1 ? 's' : ''} (ALTER...OWNER TO, GRANT/REVOKE) referencing source-only roles`);
  if (skipConstraints) {
    const { sql: deferredSql, deferred } = deferForeignKeys(sql);
    sql = deferredSql;
    if (deferred > 0) log.push(`[INFO] Deferred ${deferred} FOREIGN KEY constraint${deferred > 1 ? 's' : ''} to run after data load (best-effort — any that fail to validate are silently skipped, not restored)`);
  }

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

    if (skipConstraints) {
      try {
        await client.query('SET session_replication_role = replica');
        log.push('[INFO] Constraints skipped: SET session_replication_role = replica (FK/trigger checks disabled for this transaction)');
      } catch (e: unknown) {
        log.push(`[WARN] Could not disable constraints (requires superuser/REPLICATION privilege): ${e instanceof Error ? e.message : String(e)}`);
      }
    }

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

    if (skipConstraints) {
      await client.query('SET session_replication_role = origin').catch(() => {});
      log.push('[INFO] Constraints restored: SET session_replication_role = origin');
    }

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

async function mysqlImport(cfg: ConnCfg, rawSql: string, strategy: ImportStrategy, res: NextApiResponse, scope: ImportScopeOpts = {}, skipConstraints = false) {
  const log: string[] = [];

  // Preprocess handles psql dumps gracefully even if targeting MySQL
  const { sql, converted, strippedOwnership } = preprocessSql(rawSql);
  if (converted > 0)
    log.push(`[INFO] Preprocessed dump: converted ${converted} COPY block${converted > 1 ? 's' : ''} to INSERT statements`);
  if (strippedOwnership > 0)
    log.push(`[INFO] Stripped ${strippedOwnership} ownership/privilege statement${strippedOwnership > 1 ? 's' : ''} (ALTER...OWNER TO, GRANT/REVOKE) referencing source-only roles`);

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
    if (skipConstraints) {
      await conn.execute('SET FOREIGN_KEY_CHECKS = 0');
      log.push('[INFO] Constraints skipped: SET FOREIGN_KEY_CHECKS = 0');
    }
    await conn.execute(sql);
    if (skipConstraints) {
      await conn.execute('SET FOREIGN_KEY_CHECKS = 1');
      log.push('[INFO] Constraints restored: SET FOREIGN_KEY_CHECKS = 1');
    }
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
