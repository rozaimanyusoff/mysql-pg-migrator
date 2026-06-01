import type { NextApiRequest, NextApiResponse } from 'next';
import { rollbackTable } from '../../../../lib/migv2/runner';
import { loadRun, saveRun } from '../../../../lib/migv2/run-store';
import type { MigConn } from '../../../../lib/migv2/types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { runId, tableId, target } = req.body as { runId: string; tableId: string; target: MigConn };
  if (!runId || !tableId || !target) {
    return res.status(400).json({ error: 'runId, tableId, target required' });
  }

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  try {
    const updated = await rollbackTable(run, tableId, target);
    saveRun(updated);
    return res.status(200).json({ run: updated });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
