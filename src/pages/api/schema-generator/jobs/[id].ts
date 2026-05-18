import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../../lib/auth-store';
import { getPool } from '../../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  const username = token ? verifyAccessToken(token) : null;
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const id = Number(req.query.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  const { rows } = await getPool().query(
    `SELECT id, job_name, description, connection_label, target_database,
            schema_file_path, seed_file_path, schema_sql, seed_sql, status, log, created_at
     FROM dbt_schema_jobs
     WHERE id = $1 AND username = $2`,
    [id, username]
  );

  if (!rows[0]) return res.status(404).json({ error: 'Job not found' });
  return res.status(200).json({ job: rows[0] });
}
