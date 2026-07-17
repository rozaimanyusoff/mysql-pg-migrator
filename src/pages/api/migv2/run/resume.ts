import type { NextApiRequest, NextApiResponse } from 'next';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';
import { resumeInterruptedRun, RunRecoveryError } from '../../../../lib/migv2/run-recovery';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;
  const { runId } = req.body as { runId?: string };
  if (!runId) return res.status(400).json({ error: 'runId is required' });

  try {
    return res.status(200).json(await resumeInterruptedRun(runId));
  } catch (err) {
    if (err instanceof RunRecoveryError) return res.status(err.status).json(err.payload);
    console.error('[run-recovery] Failed to resume run', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Run recovery failed' });
  }
}
