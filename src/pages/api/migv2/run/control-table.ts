import type { NextApiRequest, NextApiResponse } from 'next';
import { activeRunCount, loadRun, MAX_CONCURRENT_MIGRATIONS, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { listSchedules } from '../../../../lib/migv2/schedule-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';

type TableAction = 'run' | 'pause' | 'resume' | 'stop' | 'restart';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const { runId, tableId, action } = req.body as { runId?: string; tableId?: string; action?: TableAction };
  if (!runId || !tableId || !action) return res.status(400).json({ error: 'runId, tableId and action are required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const table = run.tableStates.find(t => t.id === tableId);
  if (!table) return res.status(404).json({ error: 'Table not found in run' });

  const wasActive = run.status === 'running' || run.status === 'pending';
  const now = new Date().toISOString();
  let shouldDrive = false;

  if (action === 'pause') {
    if (table.status !== 'running' && table.status !== 'pending') return res.status(409).json({ error: `Cannot pause a ${table.status} table` });
    table.status = 'paused';
    table.error = null;
  } else if (action === 'stop') {
    if (table.status === 'completed' || table.status === 'rolled_back') return res.status(409).json({ error: `Cannot stop a ${table.status} table` });
    table.status = 'aborted';
    table.error = 'Stopped by user.';
  } else {
    if (!wasActive && activeRunCount(run.id) >= MAX_CONCURRENT_MIGRATIONS) {
      return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
    }
    if (action === 'restart') {
      table.rowsSource = 0;
      table.rowsMigrated = 0;
      table.rowsSkipped = 0;
      table.rowsErrored = 0;
      table.offset = 0;
      table.hasMore = true;
      table.insertedPks = [];
      table.pkOverflow = false;
      table.newWatermark = null;
    } else if (action === 'run' && table.status !== 'pending') {
      return res.status(409).json({ error: `Cannot run a ${table.status} table; use resume or restart` });
    }
    table.status = 'pending';
    table.error = null;
    run.status = 'running';
    run.completedAt = null;
    run.interrupted = false;
    run.heartbeatAt = now;
    shouldDrive = !wasActive;
  }

  run.logs.push(`[${now}] [${table.sourceKey}] ${action} requested by user.`);
  saveRun(run);

  if (shouldDrive) {
    if (!run.jobId) return res.status(400).json({ error: 'Run has no job to resolve connections from' });
    const job = loadJob(run.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    try {
      const conns = await resolveJobConns(job);
      const schedule = listSchedules().find(s => s.jobId === run.jobId) ?? null;
      void driveRun(run, conns.source, conns.target, schedule?.id ?? null);
    } catch (err) {
      table.status = action === 'restart' ? 'aborted' : 'paused';
      run.status = 'failed';
      saveRun(run);
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  return res.status(200).json({ run });
}
