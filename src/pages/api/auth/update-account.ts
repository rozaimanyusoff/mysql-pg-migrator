import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken, sha256 } from '../../../lib/auth-store';
import { getPool } from '../../../lib/db';
import { logApiActivity } from '../../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token, currentPassword, newUsername, newPassword, email } = req.body as {
    token?: string; currentPassword?: string; newUsername?: string; newPassword?: string; email?: string;
  };

  const username = token ? verifyAccessToken(token) : null;
  if (!username) return res.status(401).json({ error: 'Unauthorized' });
  if (!currentPassword) return res.status(400).json({ error: 'currentPassword is required' });

  const pool = getPool();
  const check = await pool.query(
    `SELECT id FROM dbt_users WHERE username = $1 AND password_hash = $2 AND is_active = TRUE`,
    [username, sha256(currentPassword)]
  );
  if (check.rows.length === 0) {
    await logApiActivity(req, 'api_auth_update_account_wrong_password', 'warn', { username });
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (newUsername && newUsername !== username) { params.push(newUsername);      updates.push(`username      = $${params.length}`); }
  if (newPassword)                            { params.push(sha256(newPassword)); updates.push(`password_hash = $${params.length}`); }
  if (email !== undefined)                    { params.push(email || null);      updates.push(`email         = $${params.length}`); }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(username);
  await pool.query(
    `UPDATE dbt_users SET ${updates.join(', ')}, updated_at = NOW() WHERE username = $${params.length}`,
    params
  );

  await logApiActivity(req, 'api_auth_update_account_success', 'info', { username });
  return res.status(200).json({ success: true, username: newUsername ?? username });
}
