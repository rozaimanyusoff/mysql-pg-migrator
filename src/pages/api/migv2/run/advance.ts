import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../../lib/auth-store';
import { advanceRun } from '../../../../lib/migv2/runner';
import { loadRun, saveRun } from '../../../../lib/migv2/run-store';
import type { MigConn } from '../../../../lib/migv2/types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { runId, source, target } = req.body as { runId: string; source: MigConn; target: MigConn };
  if (!runId || !source || !target) return res.status(400).json({ error: 'runId, source, target required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status === 'completed' || run.status === 'rolled_back') {
    return res.status(200).json({ run });
  }

  try {
    const advanced = await advanceRun(run, source, target);
    saveRun(advanced);
    return res.status(200).json({ run: advanced });
  } catch (err) {
    run.errors.push(err instanceof Error ? err.message : String(err));
    saveRun(run);
    return res.status(200).json({ run });
  }
}
