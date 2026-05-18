import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';
import { logApiActivity } from '../../../lib/audit-api';

export interface ConnectionRow {
  id: number;
  db_type: 'mysql' | 'postgres';
  label: string;
  host: string;
  port: number;
  username: string;
  password_enc: string | null;
  database_name: string;
  ssl_enabled: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const pool = getPool();

  // ── GET: list all connections ────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query<ConnectionRow>(
        `SELECT id, db_type, label, host, port, username, password_enc,
                database_name, ssl_enabled, is_active, created_at, updated_at
         FROM dbt_connections
         ORDER BY db_type, label`
      );
      return res.status(200).json({ success: true, connections: rows });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ success: false, error: message });
    }
  }

  // ── POST: create new connection ──────────────────────────────────────────────
  if (req.method === 'POST') {
    const { db_type, label, host, port, username, password, database, ssl } = req.body as {
      db_type?: string; label?: string; host?: string; port?: number;
      username?: string; password?: string; database?: string; ssl?: boolean;
    };

    if (!db_type || !label || !host || !username || !database) {
      return res.status(400).json({ error: 'db_type, label, host, username, database are required' });
    }

    try {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO dbt_connections
           (db_type, label, host, port, username, password_enc, database_name, ssl_enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (db_type, label) DO UPDATE SET
           host          = EXCLUDED.host,
           port          = EXCLUDED.port,
           username      = EXCLUDED.username,
           password_enc  = EXCLUDED.password_enc,
           database_name = EXCLUDED.database_name,
           ssl_enabled   = EXCLUDED.ssl_enabled,
           updated_at    = NOW()
         RETURNING id`,
        [db_type, label.trim(), host, Number(port) || (db_type === 'mysql' ? 3306 : 5432),
         username, password ?? null, database, ssl ?? false]
      );
      await logApiActivity(req, 'api_connections_create', 'info', { db_type, label });
      return res.status(200).json({ success: true, id: rows[0].id });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ success: false, error: message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
