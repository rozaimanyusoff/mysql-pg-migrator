import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { loadJob } from '../../../../lib/migv2/job-store';
import { acquireRunLock, activeRunCount, activeRunForJob, MAX_CONCURRENT_MIGRATIONS, RUN_START_LOCK, saveRun } from '../../../../lib/migv2/run-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import { prepareRunTables } from '../../../../lib/migv2/run-tables';
import type { MigRun, MigRunTableState } from '../../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';
import { getPreflightResult, getPreflightStatus, preflightRequiredMessage } from '../../../../lib/migv2/preflight-store';
import { createRunExecutionPolicy, MAX_CHUNK_ROWS } from '../../../../lib/migv2/execution-policy';
import { acceptedScheduleRun, listSchedules, saveSchedule } from '../../../../lib/migv2/schedule-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;

  const { jobId, chunkRows } = req.body as { jobId?: string; chunkRows?: number | null };
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });
  if (chunkRows != null && (!Number.isFinite(chunkRows) || chunkRows < 100 || chunkRows > MAX_CHUNK_ROWS)) {
    return res.status(400).json({ error: `chunkRows must be between 100 and ${MAX_CHUNK_ROWS.toLocaleString()}` });
  }

  const job = loadJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const preflightStatus = getPreflightStatus(job);
  if (!preflightStatus.ready) return res.status(428).json({ error: preflightRequiredMessage(preflightStatus), preflightRequired: true });
  const includedTables = prepareRunTables(job.tables).map(table => ({
    ...table,
    truncateBeforeMigrate: false,
    skipConstraints: job.mappingMode === 'copy_source' && job.initialRunOptions?.skipConstraints === true,
  }));
  if (!includedTables.length) return res.status(400).json({ error: 'Job has no included tables' });

  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
    return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached. Stop or wait for an active run.` });
  }
  const existingRun = activeRunForJob(job.id);
  if (existingRun) {
    return res.status(409).json({ error: `This job already has an active ${existingRun.status} run (${existingRun.id.slice(0, 8)}). Resume or stop it before starting another.`, activeRunId: existingRun.id });
  }

  let source, target;
  try {
    ({ source, target } = await resolveJobConns(job));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const releaseJobLock = await acquireRunLock(RUN_START_LOCK);
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
    releaseJobLock();
    return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  }
  const lockedExistingRun = activeRunForJob(job.id);
  if (lockedExistingRun) {
    releaseJobLock();
    return res.status(409).json({ error: `This job already has an active ${lockedExistingRun.status} run (${lockedExistingRun.id.slice(0, 8)}).`, activeRunId: lockedExistingRun.id });
  }

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
    executionPolicy: createRunExecutionPolicy(getPreflightResult(job).report?.capabilities, chunkRows),
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

  let consumedScheduleId: string | null = null;
  try {
    saveRun(run);
    const missedOneShot = listSchedules().find(schedule =>
      schedule.jobId === job.id
      && schedule.scheduleMode === 'once'
      && schedule.enabled
      && !schedule.triggeredAt
      && !!schedule.runAt
      && Number.isFinite(Date.parse(schedule.runAt))
      && Date.parse(schedule.runAt) < Date.now()
    );
    if (missedOneShot) {
      consumedScheduleId = missedOneShot.id;
      saveSchedule(acceptedScheduleRun(missedOneShot, run.id, now));
    }
  } finally { releaseJobLock(); }

  void driveRun(run, source, target, consumedScheduleId);

  return res.status(200).json({ runId: run.id });
}
