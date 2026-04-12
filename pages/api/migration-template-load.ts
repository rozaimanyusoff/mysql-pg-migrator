import type { NextApiRequest, NextApiResponse } from 'next';
import { loadTemplate } from '../../lib/migration-template-store';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    await logApiActivity(req, 'api_migration_template_load_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(req.query.id || '').trim();
  if (!id) {
    await logApiActivity(req, 'api_migration_template_load_bad_request', 'warn');
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const template = await loadTemplate(id);
    if (!template) {
      await logApiActivity(req, 'api_migration_template_load_not_found', 'warn', { id });
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    await logApiActivity(req, 'api_migration_template_load_success', 'info', { id: template.id });
    return res.status(200).json({ success: true, template });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_migration_template_load_error', 'error', { message, id });
    return res.status(500).json({ success: false, error: message });
  }
}
