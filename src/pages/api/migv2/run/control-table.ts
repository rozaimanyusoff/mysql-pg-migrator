import type { NextApiRequest, NextApiResponse } from 'next';
import { acquireRunLock, activeRunCount, loadRun, MAX_CONCURRENT_MIGRATIONS, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { listSchedules, saveSchedule } from '../../../../lib/migv2/schedule-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import type { MigConn, MigRunTableState } from '../../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';

type TableAction = 'run' | 'pause' | 'resume' | 'stop' | 'restart';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;
  const { runId, tableId, action, source, target } = req.body as {
    runId?: string; tableId?: string; action?: TableAction;
    source?: MigConn; target?: MigConn;
  };
  if (!runId || !tableId || !action) return res.status(400).json({ error: 'runId, tableId and action are required' });

  const release = await acquireRunLock(runId);
  try {

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  let table = run.tableStates.find(t => t.id === tableId);
  if (!table && run.jobId) {
    // Jobs can gain tables after an older run was created. Allow those current
    // job tables to be started from Run History without hiding them or forcing
    // the user to create a whole new run first.
    const currentJob = loadJob(run.jobId);
    const tableMap = currentJob?.tables.find(t => t.id === tableId && t.include);
    if (tableMap) {
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
  }
  if (!table) return res.status(404).json({ error: 'Table not found in current job' });

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
      table.newWatermarkPk = null;
      table.sourceCursorValue = null;
      table.sourceCursorPk = null;
      table.startedAt = null;
      table.completedAt = null;
      table.readDurationMs = 0;
      table.writeDurationMs = 0;
      table.rowsPerSecond = null;
      table.writerMethod = undefined;
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

  if (action === 'pause' && !run.tableStates.some(t => t.status === 'running' || t.status === 'pending')) run.status = 'paused';
  if (action === 'stop' && !run.tableStates.some(t => t.status === 'running' || t.status === 'pending' || t.status === 'paused')) {
    run.status = 'aborted';
    run.completedAt = now;
  }

  run.logs.push(`[${now}] [${table.sourceKey}] ${action} requested by user.`);
  saveRun(run);
  const owningSchedule = run.jobId ? listSchedules().find(s => s.jobId === run.jobId) ?? null : null;
  if (owningSchedule && (run.status === 'paused' || run.status === 'aborted')) {
    saveSchedule({ ...owningSchedule, lastRunStatus: run.status === 'paused' ? 'paused' : 'failed', updatedAt: now });
  } else if (owningSchedule && run.status === 'running') {
    saveSchedule({ ...owningSchedule, lastRunStatus: 'running', updatedAt: now });
  }

  if (shouldDrive) {
    try {
      let conns: { source: MigConn; target: MigConn };
      if (run.jobId) {
        const job = loadJob(run.jobId);
        if (!job) throw new Error('Job not found');
        conns = await resolveJobConns(job);
      } else {
        if (!source || !target) throw new Error('Source and target connections are required to resume an unsaved run');
        conns = { source, target };
      }
      void driveRun(run, conns.source, conns.target, owningSchedule?.id ?? null);
    } catch (err) {
      table.status = action === 'restart' ? 'aborted' : 'paused';
      run.status = 'failed';
      saveRun(run);
      return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }

    return res.status(200).json({ run });
  } finally {
    release();
  }
}
