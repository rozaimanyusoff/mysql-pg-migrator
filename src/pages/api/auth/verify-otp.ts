import type { NextApiRequest, NextApiResponse } from 'next';
import { createTokens } from '../../../lib/auth-store';
import { getPool } from '../../../lib/db';
import { logApiActivity } from '../../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, code } = req.body as { username?: string; code?: string };
  if (!username || !code) return res.status(400).json({ error: 'username and code are required' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Invalid OTP format' });

  const pool = getPool();

  // Find a valid, unused OTP for this user
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM dbt_otp_codes
     WHERE username = $1 AND code = $2 AND used = FALSE AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [username, code]
  );

  if (rows.length === 0) {
    await logApiActivity(req, 'api_auth_verify_otp_invalid', 'warn', { username });
    return res.status(401).json({ error: 'Invalid or expired OTP' });
  }

  // Mark OTP as used
  await pool.query(`UPDATE dbt_otp_codes SET used = TRUE WHERE id = $1`, [rows[0].id]);

  const { accessToken, refreshToken } = await createTokens(username);
  await logApiActivity(req, 'api_auth_verify_otp_success', 'info', { username });
  return res.status(200).json({ success: true, accessToken, refreshToken, username });
}
