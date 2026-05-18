import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';
import { logApiActivity } from '../../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = Number(req.query.id);
  if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

  const pool = getPool();

  // ── PUT: update a connection ─────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const { label, host, port, username, password, database, ssl } = req.body as {
      label?: string; host?: string; port?: number;
      username?: string; password?: string; database?: string; ssl?: boolean;
    };
    try {
      // Build dynamic SET clause — only update non-null fields
      const updates: string[] = [];
      const params: unknown[] = [];

      const set = (col: string, val: unknown) => { params.push(val); updates.push(`${col} = $${params.length}`); };

      if (label    !== undefined) set('label',         label.trim());
      if (host     !== undefined) set('host',          host);
      if (port     !== undefined) set('port',          Number(port));
      if (username !== undefined) set('username',      username);
      if (password !== undefined) set('password_enc',  password);
      if (database !== undefined) set('database_name', database);
      if (ssl      !== undefined) set('ssl_enabled',   ssl);

      if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

      params.push(id);
      await pool.query(
        `UPDATE dbt_connections SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
        params
      );
      await logApiActivity(req, 'api_connections_update', 'info', { id });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── PATCH: set as active (one active per db_type) ───────────────────────────
  if (req.method === 'PATCH') {
    try {
      // Get this connection's db_type first
      const { rows } = await pool.query<{ db_type: string }>(
        `SELECT db_type FROM dbt_connections WHERE id = $1`, [id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'Connection not found' });

      const db_type = rows[0].db_type;
      await pool.query('BEGIN');
      await pool.query(
        `UPDATE dbt_connections SET is_active = FALSE WHERE db_type = $1`, [db_type]
      );
      await pool.query(
        `UPDATE dbt_connections SET is_active = TRUE  WHERE id = $1`, [id]
      );
      await pool.query('COMMIT');
      await logApiActivity(req, 'api_connections_activate', 'info', { id, db_type });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      await pool.query('ROLLBACK').catch(() => {});
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── DELETE ───────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      await pool.query(`DELETE FROM dbt_connections WHERE id = $1`, [id]);
      await logApiActivity(req, 'api_connections_delete', 'info', { id });
      return res.status(200).json({ success: true });
    } catch (err: unknown) {
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
