import type { NextApiRequest, NextApiResponse } from 'next';
import { acquireRunLock, activeRunCount, loadRun, MAX_CONCURRENT_MIGRATIONS, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { listSchedules, saveSchedule } from '../../../../lib/migv2/schedule-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import type { MigRunTableState } from '../../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';

type BulkAction = 'run' | 'pause' | 'stop';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;
  const { runId, tableIds, action } = req.body as { runId?: string; tableIds?: string[]; action?: BulkAction };
  if (!runId || !Array.isArray(tableIds) || !tableIds.length || !action) {
    return res.status(400).json({ error: 'runId, tableIds and action are required' });
  }

  const release = await acquireRunLock(runId);
  try {

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (!run.jobId) return res.status(400).json({ error: 'Run has no job' });
  const job = loadJob(run.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const wasActive = run.status === 'running' || run.status === 'pending';
  if (action === 'run' && !wasActive && activeRunCount(run.id) >= MAX_CONCURRENT_MIGRATIONS) {
    return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  }

  const requested = new Set(tableIds);
  let changed = 0;
  for (const tableMap of job.tables.filter(t => t.include && requested.has(t.id))) {
    let table = run.tableStates.find(t => t.id === tableMap.id);
    if (!table) {
      if (!run.tables.some(t => t.id === tableMap.id)) run.tables.push(tableMap);
      table = {
        id: tableMap.id,
        sourceKey: `${tableMap.source.schema}.${tableMap.source.table}`,
        targetKey: `${tableMap.target.schema}.${tableMap.targetAlias?.trim() || tableMap.target.table}`,
        status: 'pending', rowsSource: 0, rowsMigrated: 0, rowsSkipped: 0, rowsErrored: 0,
        offset: 0, hasMore: true, error: null, insertedPks: [], pkOverflow: false, targetPkCol: null,
      } satisfies MigRunTableState;
      run.tableStates.push(table);
    }

    if (action === 'run' && (table.status === 'pending' || table.status === 'paused')) {
      table.status = 'pending';
      table.error = null;
      changed++;
    } else if (action === 'pause' && (table.status === 'running' || table.status === 'pending')) {
      table.status = 'paused';
      table.error = null;
      changed++;
    } else if (action === 'stop' && (table.status === 'running' || table.status === 'pending' || table.status === 'paused')) {
      table.status = 'aborted';
      table.error = 'Stopped by user.';
      changed++;
    }
  }

  if (!changed) return res.status(200).json({ run, changed: 0 });
  const now = new Date().toISOString();
  let shouldDrive = false;
  if (action === 'run') {
    run.status = 'running';
    run.completedAt = null;
    run.interrupted = false;
    run.heartbeatAt = now;
    shouldDrive = !wasActive;
  } else if (action === 'pause' && !run.tableStates.some(t => t.status === 'running' || t.status === 'pending')) {
    run.status = 'paused';
  } else if (action === 'stop' && !run.tableStates.some(t => t.status === 'running' || t.status === 'pending' || t.status === 'paused')) {
    run.status = 'aborted';
    run.completedAt = now;
  }
  run.logs.push(`[${now}] Bulk ${action} requested for ${changed} table(s).`);
  saveRun(run);
  const owningSchedule = listSchedules().find(s => s.jobId === run.jobId) ?? null;
  if (owningSchedule && (run.status === 'paused' || run.status === 'aborted')) {
    saveSchedule({ ...owningSchedule, lastRunStatus: run.status === 'paused' ? 'paused' : 'failed', updatedAt: now });
  }

  if (shouldDrive) {
    try {
      const conns = await resolveJobConns(job);
      void driveRun(run, conns.source, conns.target, owningSchedule?.id ?? null);
    } catch (err) {
      run.status = 'failed';
      saveRun(run);
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

    return res.status(200).json({ run, changed });
  } finally {
    release();
  }
}
