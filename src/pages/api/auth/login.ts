import type { NextApiRequest, NextApiResponse } from 'next';
import { validateCredentials, createTokens } from '../../../lib/auth-store';
import { getPool } from '../../../lib/db';
import { getEmailConfig, generateOtp, sendEmail } from '../../../lib/mailer';
import { logApiActivity } from '../../../lib/audit-api';

const OTP_TTL_MINUTES = 5;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body as { username?: string; password?: string };
  if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

  if (!await validateCredentials(username, password)) {
    await logApiActivity(req, 'api_auth_login_failed', 'warn', { username });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Check if 2FA is enabled
  const emailCfg = await getEmailConfig();
  if (emailCfg?.enable_2fa) {
    // Look up user's email
    const pool = getPool();
    const { rows } = await pool.query<{ email: string | null }>(
      `SELECT email FROM dbt_users WHERE username = $1`, [username]
    );
    const userEmail = rows[0]?.email;

    if (!userEmail) {
      await logApiActivity(req, 'api_auth_login_2fa_no_email', 'warn', { username });
      return res.status(422).json({ error: '2FA is enabled but no email is set on your account. Add an email in Settings → Account, or disable 2FA.' });
    }

    // Generate OTP and store in DB
    const code = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);
    await pool.query(
      `INSERT INTO dbt_otp_codes (username, code, expires_at) VALUES ($1, $2, $3)`,
      [username, code, expiresAt]
    );

    // Send OTP email
    try {
      await sendEmail({
        to: userEmail,
        subject: 'Your DB Maintenance Tools login code',
        text: `Your one-time login code is: ${code}\n\nThis code expires in ${OTP_TTL_MINUTES} minutes.`,
        html: `
          <div style="font-family:sans-serif;max-width:400px;margin:0 auto">
            <h2 style="color:#1d4ed8">DB Maintenance Tools</h2>
            <p>Your one-time login code:</p>
            <div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#111;margin:16px 0">${code}</div>
            <p style="color:#6b7280;font-size:14px">Expires in ${OTP_TTL_MINUTES} minutes. Do not share this code.</p>
          </div>`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await logApiActivity(req, 'api_auth_login_2fa_email_failed', 'error', { username, message });
      return res.status(500).json({ error: `Failed to send OTP email: ${message}` });
    }

    await logApiActivity(req, 'api_auth_login_2fa_otp_sent', 'info', { username });
    return res.status(200).json({ success: true, twoFactorRequired: true, username });
  }

  // No 2FA — issue tokens immediately
  const { accessToken, refreshToken } = await createTokens(username);
  await logApiActivity(req, 'api_auth_login_success', 'info', { username });
  return res.status(200).json({ success: true, twoFactorRequired: false, accessToken, refreshToken, username });
}
