import type { NextApiRequest, NextApiResponse } from 'next';
import { rollbackRun } from '../../../../lib/migv2/runner';
import { loadRun, saveRun } from '../../../../lib/migv2/run-store';
import type { MigConn } from '../../../../lib/migv2/types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { runId, target, dropTable } = req.body as { runId: string; target: MigConn; dropTable?: boolean };
  if (!runId || !target) return res.status(400).json({ error: 'runId, target required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (dropTable) return res.status(400).json({ error: 'Rollback never drops or truncates target tables. Use an explicit destructive maintenance action instead.' });

  try {
    const rolled = await rollbackRun(run, target);
    saveRun(rolled);
    return res.status(200).json({ run: rolled });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
