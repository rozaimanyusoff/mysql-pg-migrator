import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const pool = getPool();

  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, description, domain, schema_name, status, created_at, updated_at
         FROM dbt_ftd_projects ORDER BY updated_at DESC`
      );
      return res.status(200).json({ success: true, projects: rows });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  if (req.method === 'POST') {
    const { name, description, domain, schemaName } = req.body as {
      name?: string; description?: string; domain?: string; schemaName?: string;
    };
    if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO dbt_ftd_projects (name, description, domain, schema_name)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [name.trim(), description ?? '', domain ?? '', schemaName ?? 'app']
      );
      return res.status(200).json({ success: true, project: rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  if (req.method === 'PUT') {
    const { id, name, description, domain, schemaName } = req.body as {
      id?: number; name?: string; description?: string; domain?: string; schemaName?: string;
    };
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      await pool.query(
        `UPDATE dbt_ftd_projects SET name=$1, description=$2, domain=$3, schema_name=$4, updated_at=NOW()
         WHERE id=$5`,
        [name, description, domain, schemaName, id]
      );
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  if (req.method === 'DELETE') {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      await pool.query('DELETE FROM dbt_ftd_projects WHERE id=$1', [id]);
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
