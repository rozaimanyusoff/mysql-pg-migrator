import type { NextApiRequest, NextApiResponse } from 'next';
import { advanceMigrationRun } from '../../lib/migration-orchestrator';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_migration_run_advance_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.body as { id?: string };
  if (!id) {
    await logApiActivity(req, 'api_migration_run_advance_bad_request', 'warn');
    return res.status(400).json({ error: 'id is required' });
  }

  try {
    const run = await advanceMigrationRun(id);
    await logApiActivity(req, 'api_migration_run_advance_success', 'info', {
      id,
      status: run.status,
      totalRowsCopied: run.totalRowsCopied,
    });
    return res.status(200).json({ success: true, run });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_migration_run_advance_error', 'error', { id, message });
    return res.status(500).json({ success: false, error: message });
  }
}
