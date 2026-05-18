import type { NextApiRequest, NextApiResponse } from 'next';
import { loadSettings, saveSettings } from '../../lib/settings-store';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    try {
      const settings = await loadSettings();
      await logApiActivity(req, 'api_settings_load', 'info');
      return res.status(200).json({ success: true, settings });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ success: false, error: message });
    }
  }

  if (req.method === 'POST') {
    const { mysql, postgres } = req.body as {
      mysql?: Record<string, unknown>;
      postgres?: Record<string, unknown>;
    };
    try {
      const updated = await saveSettings({ mysql: mysql as never, postgres: postgres as never });
      await logApiActivity(req, 'api_settings_save', 'info');
      return res.status(200).json({ success: true, settings: updated });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ success: false, error: message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
