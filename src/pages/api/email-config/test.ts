import type { NextApiRequest, NextApiResponse } from 'next';
import { testEmailConnection, sendEmail, getEmailConfig } from '../../../lib/mailer';
import { logApiActivity } from '../../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { host, port, username, password, from_email, from_name, secure, send_to } = req.body as {
    host?: string; port?: number; username?: string; password?: string;
    from_email?: string; from_name?: string; secure?: boolean; send_to?: string;
  };

  if (!host || !from_email) return res.status(400).json({ error: 'host and from_email are required' });

  // Resolve password: use provided or fall back to stored
  let resolvedPassword = password ?? null;
  if (!resolvedPassword) {
    const existing = await getEmailConfig();
    resolvedPassword = existing?.password_enc ?? null;
  }

  const cfg = {
    id: 0, host, port: Number(port) || 587, username: username ?? '',
    password_enc: resolvedPassword, from_email, from_name: from_name ?? 'DB Maintenance Tools',
    secure: Boolean(secure), enable_2fa: false,
  };

  try {
    await testEmailConnection(cfg);

    // Optionally send a test email
    if (send_to) {
      await sendEmail({ to: send_to, subject: 'DB Maintenance Tools — Test Email', text: 'Your email configuration is working correctly.' });
    }

    await logApiActivity(req, 'api_email_config_test_ok', 'info');
    return res.status(200).json({ success: true, message: send_to ? `Test email sent to ${send_to}` : 'SMTP connection verified' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_email_config_test_failed', 'warn', { message });
    return res.status(400).json({ success: false, error: message });
  }
}
