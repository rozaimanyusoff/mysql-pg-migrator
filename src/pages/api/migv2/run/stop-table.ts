import type { NextApiRequest, NextApiResponse } from 'next';
import { loadRun, saveRun } from '../../../../lib/migv2/run-store';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;

  const { runId, tableId } = req.body as { runId: string; tableId: string };
  if (!runId || !tableId) return res.status(400).json({ error: 'runId and tableId required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const ts = run.tableStates.find(t => t.id === tableId);
  if (ts && (ts.status === 'running' || ts.status === 'pending')) {
    ts.status = 'aborted';
    ts.error = 'Stopped by user.';
    run.logs.push(`[${new Date().toISOString()}] [${ts.sourceKey}] stopped by user.`);
    saveRun(run);
  }

  return res.status(200).json({ run });
}
