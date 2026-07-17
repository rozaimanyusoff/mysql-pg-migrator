import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { acceptedScheduleRun, loadSchedule, saveSchedule } from '../../../../lib/migv2/schedule-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { acquireRunLock, activeRunCount, activeRunForJob, MAX_CONCURRENT_MIGRATIONS, RUN_START_LOCK, saveRun } from '../../../../lib/migv2/run-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import { prepareRunTables } from '../../../../lib/migv2/run-tables';
import type { MigRun, MigRunTableState } from '../../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';
import { getPreflightResult, getPreflightStatus, preflightRequiredMessage } from '../../../../lib/migv2/preflight-store';
import { createRunExecutionPolicy } from '../../../../lib/migv2/execution-policy';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;

  const { id } = req.query as { id: string };
  let schedule = loadSchedule(id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  const job = loadJob(schedule.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const preflightStatus = getPreflightStatus(job);
  if (!preflightStatus.ready) return res.status(428).json({ error: preflightRequiredMessage(preflightStatus), preflightRequired: true });
  if (!schedule.enabled) {
    if (schedule.scheduleMode === 'once' && schedule.triggeredAt && schedule.lastRunId) {
      return res.status(409).json({ error: 'This run-once trigger was already accepted.', activeRunId: schedule.lastRunId });
    }
    return res.status(400).json({ error: 'Schedule is disabled. Enable it before running.' });
  }
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
    return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached. Stop or wait for an active run.` });
  }
  const existingRun = activeRunForJob(job.id);
  if (existingRun) return res.status(409).json({ error: `This job already has an active ${existingRun.status} run (${existingRun.id.slice(0, 8)}). Resume or stop it before starting another.`, activeRunId: existingRun.id });

  // Look up full connection credentials from dbt_connections (jobs never store passwords)
  let source, target;
  try {
    ({ source, target } = await resolveJobConns(job));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  // Serialize the check-and-create section across concurrent cron/server calls.
  const releaseJobLock = await acquireRunLock(RUN_START_LOCK);
  // Reload under the same start lock. A one-shot schedule is consumed here so
  // two cron invocations in the same minute cannot both create a run.
  schedule = loadSchedule(id);
  if (!schedule || !schedule.enabled) {
    releaseJobLock();
    return res.status(409).json({
      error: 'Schedule is disabled or its run-once trigger has already been consumed.',
      ...(schedule?.lastRunId ? { activeRunId: schedule.lastRunId } : {}),
    });
  }
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
    releaseJobLock();
    return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  }
  const lockedExistingRun = activeRunForJob(job.id);
  if (lockedExistingRun) {
    releaseJobLock();
    return res.status(409).json({ error: `This job already has an active ${lockedExistingRun.status} run (${lockedExistingRun.id.slice(0, 8)}).`, activeRunId: lockedExistingRun.id });
  }

  const includedTables = prepareRunTables(job.tables);
  const now = new Date().toISOString();
  const run: MigRun = {
    id: randomUUID(),
    jobId: job.id,
    jobName: job.name,
    status: 'pending',
    createdAt: now,
    startedAt: null,
    completedAt: null,
    constraintBypassMode: 'transaction',
    heartbeatAt: now,
    executionPolicy: createRunExecutionPolicy(
      getPreflightResult(job).report?.capabilities,
      schedule.chunkMode === 'fixed' ? schedule.chunkRows : null,
    ),
    sourceMeta: job.sourceMeta,
    targetMeta: job.targetMeta,
    tables: includedTables,
    tableStates: includedTables.map((t): MigRunTableState => ({
      id: t.id,
      sourceKey: `${t.source.schema}.${t.source.table}`,
      targetKey: `${t.target.schema}.${t.targetAlias?.trim() || t.target.table}`,
      status: 'pending',
      rowsSource: 0, rowsMigrated: 0, rowsSkipped: 0, rowsErrored: 0,
      offset: 0, hasMore: true, error: null,
      insertedPks: [], pkOverflow: false, targetPkCol: null,
    })),
    logs: [],
    totalRows: 0, migratedRows: 0, errors: [],
    filterCol: job.filterCol ?? null,
    filterFrom: job.filterFrom ?? null,
    filterTo: job.filterTo ?? null,
  };

  // Persist the run and consume a one-shot schedule before releasing the same
  // start lock. This is the atomic boundary that prevents a duplicate cron
  // invocation from observing the one-shot trigger as still enabled.
  try {
    saveRun(run);
    saveSchedule(acceptedScheduleRun(schedule, run.id, now));
  } finally {
    releaseJobLock();
  }

  // Run in background — response returns immediately with the run ID
  void driveRun(run, source, target, id);

  return res.status(200).json({ runId: run.id });
}
