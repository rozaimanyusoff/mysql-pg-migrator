import type { NextApiRequest, NextApiResponse } from 'next';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';
import { ScheduledRunError, startScheduledRun } from '../../../../lib/migv2/scheduled-run';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;

  try {
    const result = await startScheduledRun(String(req.query.id));
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof ScheduledRunError) return res.status(err.status).json(err.payload);
    console.error('[scheduler] Failed to start run', err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start scheduled run' });
  }
}
