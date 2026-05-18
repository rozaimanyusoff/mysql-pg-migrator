import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { logApiActivity } from '../../lib/audit-api';

interface PgConfigInput {
  host: string;
  port?: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_sql_execute_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { pgConfig, sql, label } = req.body as {
    pgConfig?: PgConfigInput;
    sql?: string;
    label?: string;
  };

  if (!pgConfig?.host || !pgConfig?.user || !pgConfig?.database) {
    await logApiActivity(req, 'api_sql_execute_bad_request', 'warn');
    return res.status(400).json({ error: 'pgConfig (host, user, database) is required' });
  }
  if (!sql || !sql.trim()) {
    return res.status(400).json({ error: 'sql is required' });
  }

  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block
  const hasConcurrently = /\bCONCURRENTLY\b/i.test(sql);

  const pool = new Pool({
    host: pgConfig.host,
    port: pgConfig.port ?? 5432,
    user: pgConfig.user,
    password: pgConfig.password,
    database: pgConfig.database,
    ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
  });

  const client = await pool.connect();
  try {
    if (hasConcurrently) {
      // Run outside transaction — CONCURRENTLY is incompatible with transaction blocks
      await client.query(sql);
      await logApiActivity(req, 'api_sql_execute_success', 'info', {
        db: pgConfig.database, label: label ?? 'sql', bytes: sql.length, transactional: false,
      });
      return res.status(200).json({
        success: true,
        rolledBack: false,
        log: [
          `[OK] ${label ?? 'SQL'} executed on "${pgConfig.database}"`,
          '[NOTE] Ran without transaction wrapper — SQL contains CONCURRENTLY keyword.',
        ],
      });
    }

    // Wrap in a transaction — any error triggers automatic ROLLBACK
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('COMMIT');
      await logApiActivity(req, 'api_sql_execute_success', 'info', {
        db: pgConfig.database, label: label ?? 'sql', bytes: sql.length, transactional: true,
      });
      return res.status(200).json({
        success: true,
        rolledBack: false,
        log: [`[OK] ${label ?? 'SQL'} executed and committed on "${pgConfig.database}"`],
      });
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const message = err instanceof Error ? err.message : String(err);
      await logApiActivity(req, 'api_sql_execute_error', 'error', {
        db: pgConfig.database, label: label ?? 'sql', message, rolledBack: true,
      });
      return res.status(500).json({
        success: false,
        rolledBack: true,
        error: message,
        log: [
          `[FAIL] ${label ?? 'SQL'} failed on "${pgConfig.database}"`,
          `[ROLLBACK] Transaction rolled back — database state is unchanged.`,
          `[ERROR] ${message}`,
        ],
      });
    }
  } finally {
    client.release();
    await pool.end();
  }
}
