import type { NextApiRequest, NextApiResponse } from 'next';
import { listRuns, loadRun } from '../../lib/migration-run-store';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    await logApiActivity(req, 'api_migration_run_status_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const id = String(req.query.id || '').trim();

  try {
    if (!id) {
      const runs = await listRuns(30);
      await logApiActivity(req, 'api_migration_run_status_list_success', 'info', { count: runs.length });
      return res.status(200).json({ success: true, runs });
    }

    const run = await loadRun(id);
    if (!run) {
      await logApiActivity(req, 'api_migration_run_status_not_found', 'warn', { id });
      return res.status(404).json({ success: false, error: 'Run not found' });
    }

    await logApiActivity(req, 'api_migration_run_status_success', 'info', { id, status: run.status });
    return res.status(200).json({ success: true, run });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_migration_run_status_error', 'error', { id, message });
    return res.status(500).json({ success: false, error: message });
  }
}
