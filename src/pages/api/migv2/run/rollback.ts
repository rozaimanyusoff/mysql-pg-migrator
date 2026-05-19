import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../../lib/auth-store';
import { rollbackRun } from '../../../../lib/migv2/runner';
import { loadRun, saveRun } from '../../../../lib/migv2/run-store';
import type { MigConn } from '../../../../lib/migv2/types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { runId, target } = req.body as { runId: string; target: MigConn };
  if (!runId || !target) return res.status(400).json({ error: 'runId, target required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  try {
    const rolled = await rollbackRun(run, target);
    saveRun(rolled);
    return res.status(200).json({ run: rolled });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
