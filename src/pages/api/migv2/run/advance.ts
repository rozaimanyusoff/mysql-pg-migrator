import type { NextApiRequest, NextApiResponse } from 'next';
import { advanceRun } from '../../../../lib/migv2/runner';
import { loadRun, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob, saveJobRuntimeState } from '../../../../lib/migv2/job-store';
import type { MigConn } from '../../../../lib/migv2/types';
import { canPersistWatermark } from '../../../../lib/migv2/run-outcome';
import { claimRunExecution, releaseRunExecution, refreshRunLease, RUN_LEASE_MS } from '../../../../lib/migv2/run-store';
import { randomUUID } from 'crypto';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { runId, source, target, pausedTableIds = [] } = req.body as { runId: string; source: MigConn; target: MigConn; pausedTableIds?: string[] };
  if (!runId || !source || !target) return res.status(400).json({ error: 'runId, source, target required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status === 'completed' || run.status === 'completed_with_issues' || run.status === 'rolled_back' || run.status === 'aborted' || run.status === 'interrupted') {
    return res.status(200).json({ run });
  }

  const executionId = randomUUID();
  const claimed = await claimRunExecution(runId, executionId);
  if (!claimed) return res.status(409).json({ error: 'This run is already being driven by another execution. Wait for its checkpoint or resume it after interruption.' });
  const heartbeatTimer = setInterval(() => {
    void refreshRunLease(runId, executionId).then(refreshed => {
      if (!refreshed) console.error(`[migration] lease heartbeat rejected for run ${runId}; execution ownership changed`);
    }).catch(err => {
      console.error('[migration] lease heartbeat failed', err);
    });
  }, 10_000);
  try {
    const advanced = await advanceRun(claimed, source, target, pausedTableIds);
    const heartbeatAt = new Date();
    advanced.heartbeatAt = heartbeatAt.toISOString();
    advanced.leaseExpiresAt = new Date(heartbeatAt.getTime() + RUN_LEASE_MS).toISOString();
    saveRun(advanced);

    // Persist incremental watermarks to the separate runtime store.
    if (advanced.jobId) {
      const job = loadJob(advanced.jobId);
      if (job) {
        let jobUpdated = false;
        for (const ts of advanced.tableStates) {
          if (!canPersistWatermark(ts)) continue;
          const jt = job.tables.find(t => t.id === ts.id);
          if (jt) { jt.lastSyncedValue = ts.newWatermark; jt.lastSyncedPk = ts.newWatermarkPk ?? null; jobUpdated = true; }
        }
        if (jobUpdated) saveJobRuntimeState(job);
      }
    }

    return res.status(200).json({ run: advanced });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    run.status = 'failed';
    run.errors.push(msg);
    run.logs.push(`[${new Date().toISOString()}] ERROR: ${msg}`);
    run.completedAt = new Date().toISOString();
    saveRun(run);
    return res.status(200).json({ run });
  } finally {
    clearInterval(heartbeatTimer);
    await releaseRunExecution(runId, executionId);
  }
}
