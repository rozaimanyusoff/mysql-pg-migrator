import type { NextApiRequest, NextApiResponse } from 'next';
import { advanceRun } from '../../../../lib/migv2/runner';
import { loadRun, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob, saveJob } from '../../../../lib/migv2/job-store';
import type { MigConn } from '../../../../lib/migv2/types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { runId, source, target, pausedTableIds = [] } = req.body as { runId: string; source: MigConn; target: MigConn; pausedTableIds?: string[] };
  if (!runId || !source || !target) return res.status(400).json({ error: 'runId, source, target required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status === 'completed' || run.status === 'rolled_back' || run.status === 'aborted') {
    return res.status(200).json({ run });
  }

  try {
    const advanced = await advanceRun(run, source, target, pausedTableIds);
    saveRun(advanced);

    // Persist incremental watermarks back to the saved job so next run picks them up
    if (advanced.jobId) {
      const job = loadJob(advanced.jobId);
      if (job) {
        let jobUpdated = false;
        for (const ts of advanced.tableStates) {
          if (ts.newWatermark == null) continue;
          const jt = job.tables.find(t => t.id === ts.id);
          if (jt) { jt.lastSyncedValue = ts.newWatermark; jobUpdated = true; }
        }
        if (jobUpdated) saveJob(job);
      }
    }

    return res.status(200).json({ run: advanced });
  } catch (err) {
    run.errors.push(err instanceof Error ? err.message : String(err));
    saveRun(run);
    return res.status(200).json({ run });
  }
}
