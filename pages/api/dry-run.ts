import type { NextApiRequest, NextApiResponse } from 'next';
import { MigrationConfig } from '../../lib/types';
import { validateMigrationConfig } from '../../lib/postgres-migrator';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_dry_run_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { config } = req.body as { config: MigrationConfig };
  if (!config) {
    await logApiActivity(req, 'api_dry_run_bad_request', 'warn');
    return res.status(400).json({ error: 'config is required' });
  }

  try {
    const result = validateMigrationConfig(config);
    await logApiActivity(req, 'api_dry_run_success', 'info', { valid: result.valid, tables: result.summary.includedTables });
    return res.status(200).json({ success: true, ...result });
  } catch (err: unknown) {
    await logApiActivity(req, 'api_dry_run_error', 'error', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
