import { scheduleIsDue } from './cron-schedule';
import { listSchedules, loadSchedule, saveSchedule } from './schedule-store';
import { ScheduledRunError, startScheduledRun } from './scheduled-run';
import { loadRun, reconcileStaleRuns } from './run-store';
import { resumeInterruptedRun, RunRecoveryError } from './run-recovery';

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 5_000;

export interface SchedulerWorkerStatus {
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  intervalMs: number;
}

interface WorkerState extends SchedulerWorkerStatus {
  timer: ReturnType<typeof setInterval> | null;
  ticking: boolean;
}

declare global {
  // eslint-disable-next-line no-var
  var __mysqlPgSchedulerWorker: WorkerState | undefined;
}

function pollInterval(): number {
  const configured = Number(process.env.SCHEDULER_POLL_INTERVAL_MS);
  return Number.isFinite(configured) ? Math.max(MIN_POLL_INTERVAL_MS, configured) : DEFAULT_POLL_INTERVAL_MS;
}

function workerState(): WorkerState {
  if (!globalThis.__mysqlPgSchedulerWorker) {
    globalThis.__mysqlPgSchedulerWorker = {
      running: false,
      startedAt: null,
      lastTickAt: null,
      lastError: null,
      intervalMs: pollInterval(),
      timer: null,
      ticking: false,
    };
  }
  return globalThis.__mysqlPgSchedulerWorker;
}

async function tick(): Promise<void> {
  const state = workerState();
  if (state.ticking) return;
  state.ticking = true;
  state.lastTickAt = new Date().toISOString();
  try {
    const now = new Date();
    reconcileStaleRuns();
    const blockedRecoveryJobIds = new Set<string>();
    const configuredRecoveryAttempts = Number(process.env.SCHEDULE_AUTO_RESUME_ATTEMPTS || 3);
    const maxRecoveryAttempts = Number.isFinite(configuredRecoveryAttempts) ? Math.max(0, configuredRecoveryAttempts) : 3;
    for (const candidate of listSchedules()) {
      const interruptedRun = candidate.lastRunId ? loadRun(candidate.lastRunId) : null;
      if (!interruptedRun?.interrupted || interruptedRun.status !== 'failed') continue;
      blockedRecoveryJobIds.add(candidate.jobId);
      const attempts = candidate.recoveryAttempts ?? 0;
      if (attempts >= maxRecoveryAttempts) {
        state.lastError = `${candidate.jobName}: automatic recovery stopped after ${attempts} attempts`;
        continue;
      }
      try {
        await resumeInterruptedRun(interruptedRun.id);
        const current = loadSchedule(candidate.id);
        if (current) saveSchedule({ ...current, recoveryAttempts: attempts + 1, updatedAt: new Date().toISOString() });
        state.lastError = null;
      } catch (err) {
        if (err instanceof RunRecoveryError) {
          state.lastError = `${candidate.jobName}: ${err.message}`;
          if (err.status !== 409) {
            const current = loadSchedule(candidate.id);
            if (current) saveSchedule({ ...current, recoveryAttempts: attempts + 1, updatedAt: new Date().toISOString() });
          }
        }
        else {
          state.lastError = `${candidate.jobName}: ${err instanceof Error ? err.message : String(err)}`;
          const current = loadSchedule(candidate.id);
          if (current) saveSchedule({ ...current, recoveryAttempts: attempts + 1, updatedAt: new Date().toISOString() });
          console.error('[scheduler-worker] Automatic recovery failed', err);
        }
      }
    }

    for (const candidate of listSchedules()) {
      if (blockedRecoveryJobIds.has(candidate.jobId)) continue;
      if (!scheduleIsDue(candidate, now)) continue;
      let schedule = candidate;
      if (schedule.scheduleMode === 'recurring' && !schedule.pendingRunAt) {
        const current = loadSchedule(schedule.id);
        if (!current || !scheduleIsDue(current, now)) continue;
        schedule = { ...current, pendingRunAt: now.toISOString(), updatedAt: now.toISOString() };
        saveSchedule(schedule);
      }
      try {
        await startScheduledRun(schedule.id);
        state.lastError = null;
      } catch (err) {
        if (err instanceof ScheduledRunError) {
          // 409 means the occurrence is safely queued behind an active run or
          // the concurrent-run ceiling. The next tick will retry it.
          if (err.status !== 409) state.lastError = `${schedule.jobName}: ${err.message}`;
        } else {
          state.lastError = `${schedule.jobName}: ${err instanceof Error ? err.message : String(err)}`;
          console.error('[scheduler-worker] Scheduled run failed', err);
        }
      }
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error('[scheduler-worker] Tick failed', err);
  } finally {
    state.lastTickAt = new Date().toISOString();
    state.ticking = false;
  }
}

export function startSchedulerWorker(): SchedulerWorkerStatus {
  const state = workerState();
  if (state.running) return getSchedulerWorkerStatus();
  const developmentDisabled = process.env.NODE_ENV !== 'production' && process.env.ENABLE_INTERNAL_SCHEDULER_IN_DEV !== 'true';
  if (process.env.NEXT_PHASE === 'phase-production-build' || process.env.DISABLE_INTERNAL_SCHEDULER === 'true' || developmentDisabled) {
    return getSchedulerWorkerStatus();
  }

  state.running = true;
  state.startedAt = new Date().toISOString();
  state.intervalMs = pollInterval();
  state.timer = setInterval(() => { void tick(); }, state.intervalMs);
  state.timer.unref?.();
  const initialTimer = setTimeout(() => { void tick(); }, 1_000);
  initialTimer.unref?.();
  console.info(`[scheduler-worker] Started (polling every ${state.intervalMs}ms)`);
  return getSchedulerWorkerStatus();
}

export function getSchedulerWorkerStatus(): SchedulerWorkerStatus {
  const { running, startedAt, lastTickAt, lastError, intervalMs } = workerState();
  return { running, startedAt, lastTickAt, lastError, intervalMs };
}
