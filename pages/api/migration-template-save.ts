import type { NextApiRequest, NextApiResponse } from 'next';
import { saveTemplate } from '../../lib/migration-template-store';
import { MigrationConfig } from '../../lib/types';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_migration_template_save_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, name, description, config } = req.body as {
    id?: string;
    name?: string;
    description?: string;
    config?: MigrationConfig;
  };

  if (!name || !config) {
    await logApiActivity(req, 'api_migration_template_save_bad_request', 'warn');
    return res.status(400).json({ error: 'name and config are required' });
  }

  try {
    const template = await saveTemplate({ id, name, description, config });
    await logApiActivity(req, 'api_migration_template_save_success', 'info', {
      templateId: template.id,
      version: template.version,
    });
    return res.status(200).json({ success: true, template });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_migration_template_save_error', 'error', { message });
    return res.status(500).json({ success: false, error: message });
  }
}
