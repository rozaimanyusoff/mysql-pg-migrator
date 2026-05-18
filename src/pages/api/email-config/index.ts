import type { NextApiRequest, NextApiResponse } from 'next';
import { getEmailConfig, saveEmailConfig } from '../../../lib/mailer';
import { logApiActivity } from '../../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const cfg = await getEmailConfig();
    // Never return password in GET
    if (cfg) {
      const { password_enc: _, ...safe } = cfg;
      return res.status(200).json({ success: true, config: { ...safe, has_password: Boolean(cfg.password_enc) } });
    }
    return res.status(200).json({ success: true, config: null });
  }

  if (req.method === 'POST') {
    const { host, port, username, password, from_email, from_name, secure, enable_2fa } = req.body as {
      host?: string; port?: number; username?: string; password?: string;
      from_email?: string; from_name?: string; secure?: boolean; enable_2fa?: boolean;
    };

    if (!host || !from_email) return res.status(400).json({ error: 'host and from_email are required' });

    // Keep existing password if not provided
    let password_enc: string | null = null;
    if (password) {
      password_enc = password;
    } else {
      const existing = await getEmailConfig();
      password_enc = existing?.password_enc ?? null;
    }

    await saveEmailConfig({
      host: host.trim(), port: Number(port) || 587, username: username?.trim() ?? '',
      password_enc, from_email: from_email.trim(), from_name: from_name?.trim() || 'DB Maintenance Tools',
      secure: Boolean(secure), enable_2fa: Boolean(enable_2fa),
    });
    await logApiActivity(req, 'api_email_config_save', 'info');
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
