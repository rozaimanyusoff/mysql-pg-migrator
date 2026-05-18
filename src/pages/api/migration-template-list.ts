import type { NextApiRequest, NextApiResponse } from 'next';
import { listTemplates } from '../../lib/migration-template-store';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    await logApiActivity(req, 'api_migration_template_list_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const templates = await listTemplates();
    await logApiActivity(req, 'api_migration_template_list_success', 'info', { count: templates.length });
    return res.status(200).json({ success: true, templates });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_migration_template_list_error', 'error', { message });
    return res.status(500).json({ success: false, error: message });
  }
}
