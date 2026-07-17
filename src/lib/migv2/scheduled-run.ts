import { randomUUID } from 'crypto';
import { acceptedScheduleRun, loadSchedule, saveSchedule } from './schedule-store';
import { loadJob } from './job-store';
import {
  acquireRunLock,
  activeRunCount,
  activeRunForJob,
  MAX_CONCURRENT_MIGRATIONS,
  RUN_START_LOCK,
  saveRun,
} from './run-store';
import { resolveJobConns } from './resolve-conns';
import { driveRun } from './run-driver';
import { prepareRunTables } from './run-tables';
import type { MigRun, MigRunTableState } from './types';
import { getPreflightResult, getPreflightStatus, preflightRequiredMessage } from './preflight-store';
import { createRunExecutionPolicy } from './execution-policy';

export class ScheduledRunError extends Error {
  constructor(public status: number, public payload: Record<string, unknown>) {
    super(String(payload.error ?? 'Scheduled run failed'));
  }
}

function reject(status: number, payload: Record<string, unknown>): never {
  throw new ScheduledRunError(status, payload);
}

export async function startScheduledRun(scheduleId: string): Promise<{ runId: string }> {
  let schedule = loadSchedule(scheduleId);
  if (!schedule) reject(404, { error: 'Schedule not found' });
  const job = loadJob(schedule.jobId);
  if (!job) reject(404, { error: 'Job not found' });
  const preflightStatus = getPreflightStatus(job);
  if (!preflightStatus.ready) reject(428, { error: preflightRequiredMessage(preflightStatus), preflightRequired: true });
  if (!schedule.enabled) {
    if (schedule.scheduleMode === 'once' && schedule.triggeredAt && schedule.lastRunId) {
      reject(409, { error: 'This run-once trigger was already accepted.', activeRunId: schedule.lastRunId });
    }
    reject(400, { error: 'Schedule is disabled. Enable it before running.' });
  }
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
    reject(409, { error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached. Stop or wait for an active run.` });
  }
  const existingRun = activeRunForJob(job.id);
  if (existingRun) reject(409, { error: `This job already has an active ${existingRun.status} run (${existingRun.id.slice(0, 8)}). Resume or stop it before starting another.`, activeRunId: existingRun.id });

  let source, target;
  try {
    ({ source, target } = await resolveJobConns(job));
  } catch (err) {
    reject(400, { error: err instanceof Error ? err.message : String(err) });
  }

  const releaseJobLock = await acquireRunLock(RUN_START_LOCK);
  try {
    schedule = loadSchedule(scheduleId);
    if (!schedule || !schedule.enabled) {
      reject(409, {
        error: 'Schedule is disabled or its run-once trigger has already been consumed.',
        ...(schedule?.lastRunId ? { activeRunId: schedule.lastRunId } : {}),
      });
    }
    const nowMinute = new Date().toISOString().slice(0, 16);
    if (schedule.scheduleMode === 'recurring' && schedule.lastTriggeredAt?.slice(0, 16) === nowMinute) {
      reject(409, { error: 'This recurring schedule was already accepted in the current minute.', ...(schedule.lastRunId ? { activeRunId: schedule.lastRunId } : {}) });
    }
    if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
      reject(409, { error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
    }
    const lockedExistingRun = activeRunForJob(job.id);
    if (lockedExistingRun) {
      reject(409, { error: `This job already has an active ${lockedExistingRun.status} run (${lockedExistingRun.id.slice(0, 8)}).`, activeRunId: lockedExistingRun.id });
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
      tableStates: includedTables.map((table): MigRunTableState => ({
        id: table.id,
        sourceKey: `${table.source.schema}.${table.source.table}`,
        targetKey: `${table.target.schema}.${table.targetAlias?.trim() || table.target.table}`,
        status: 'pending',
        rowsSource: 0,
        rowsMigrated: 0,
        rowsSkipped: 0,
        rowsErrored: 0,
        offset: 0,
        hasMore: true,
        error: null,
        insertedPks: [],
        pkOverflow: false,
        targetPkCol: null,
      })),
      logs: [],
      totalRows: 0,
      migratedRows: 0,
      errors: [],
      filterCol: job.filterCol ?? null,
      filterFrom: job.filterFrom ?? null,
      filterTo: job.filterTo ?? null,
    };

    saveRun(run);
    saveSchedule(acceptedScheduleRun(schedule, run.id, now));
    void driveRun(run, source, target, scheduleId);
    return { runId: run.id };
  } finally {
    releaseJobLock();
  }
}
