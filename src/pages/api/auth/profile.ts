import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { getPool } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  const username = token ? verifyAccessToken(token) : null;
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { rows } = await getPool().query<{ email: string | null }>(
    `SELECT email FROM dbt_users WHERE username = $1`,
    [username]
  );
  return res.status(200).json({ username, email: rows[0]?.email ?? null });
}
