import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';

export interface HistoryEntry {
  id: number;
  username: string;
  operation: 'export' | 'import' | 'sync';
  source_label: string | null;
  source_db: string | null;
  target_label: string | null;
  target_db: string | null;
  tables_list: string[] | null;
  tables_count: number;
  include: string | null;
  conflict: string | null;
  format: string;
  where_clause: string | null;
  status: 'success' | 'failed' | 'pending';
  created_at: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const username = 'system';

  const pool = getPool();

  if (req.method === 'GET') {
    const { rows } = await pool.query<HistoryEntry>(
      `SELECT id, username, operation, source_label, source_db, target_label, target_db,
              tables_list, tables_count, include, conflict, format, where_clause, status, created_at
       FROM dbt_export_history
       WHERE username = $1
       ORDER BY created_at DESC
       LIMIT 60`,
      [username],
    );
    return res.status(200).json({ history: rows });
  }

  if (req.method === 'POST') {
    const {
      operation, source_label, source_db, target_label, target_db,
      tables_list, tables_count, include, conflict, format, where_clause, status,
    } = req.body as Partial<HistoryEntry>;

    if (!operation) return res.status(400).json({ error: 'operation is required' });

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO dbt_export_history
         (username, operation, source_label, source_db, target_label, target_db,
          tables_list, tables_count, include, conflict, format, where_clause, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        username, operation,
        source_label ?? null, source_db ?? null,
        target_label ?? null, target_db ?? null,
        tables_list ? JSON.stringify(tables_list) : null,
        tables_count ?? 0,
        include ?? null, conflict ?? null,
        format ?? 'sql', where_clause ?? null,
        status ?? 'success',
      ],
    );
    return res.status(201).json({ id: rows[0].id });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id required' });
    await pool.query(
      'DELETE FROM dbt_export_history WHERE id = $1 AND username = $2',
      [id, username],
    );
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
