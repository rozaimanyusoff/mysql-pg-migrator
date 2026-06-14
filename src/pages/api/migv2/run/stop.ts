import type { NextApiRequest, NextApiResponse } from 'next';
import { loadRun, saveRun } from '../../../../lib/migv2/run-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { runId } = req.body as { runId: string };
  if (!runId) return res.status(400).json({ error: 'runId required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  if (run.status === 'running' || run.status === 'pending') {
    run.status = 'aborted';
    run.completedAt = new Date().toISOString();
    run.errors.push('Migration stopped by user.');
    saveRun(run);
  }

  return res.status(200).json({ run });
}
