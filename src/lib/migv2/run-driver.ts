import { advanceRun } from './runner';
import { loadRun, saveRun } from './run-store';
import { loadJob, saveJobRuntimeState } from './job-store';
import { loadSchedule, saveSchedule } from './schedule-store';
import { sendEmail } from '../mailer';
import type { MigConn, MigRun } from './types';

const TERMINAL = new Set(['completed', 'failed', 'aborted', 'rolled_back']);

function persistWatermarks(run: MigRun) {
  if (!run.jobId) return;
  const job = loadJob(run.jobId);
  if (!job) return;
  let updated = false;
  for (const ts of run.tableStates) {
    if (ts.newWatermark == null) continue;
    const jt = job.tables.find(t => t.id === ts.id);
    if (jt) { jt.lastSyncedValue = ts.newWatermark; jt.lastSyncedPk = ts.newWatermarkPk ?? null; updated = true; }
  }
  if (updated) saveJobRuntimeState(job);
}

function buildNotifyBody(run: MigRun): { subject: string; text: string } {
  const ok = run.status === 'completed';
  const icon = ok ? '✓' : '✗';
  const lines = [
    `${icon} Migration "${run.jobName}" ${run.status}`,
    ``,
    `Run ID:   ${run.id}`,
    `Started:  ${run.startedAt ?? '—'}`,
    `Finished: ${run.completedAt ?? '—'}`,
    `Rows migrated: ${run.migratedRows} / ${run.totalRows}`,
    ``,
    `Tables:`,
    ...run.tableStates.map(ts => {
      const mark = ts.status === 'completed' ? '✓' : ts.status === 'failed' ? '✗' : '·';
      return `  ${mark} ${ts.sourceKey} → ${ts.targetKey} (${ts.rowsMigrated} written${ts.rowsErrored ? `, ${ts.rowsErrored} errors` : ''})`;
    }),
  ];
  if (run.errors.length) {
    lines.push('', 'Errors:', ...run.errors.slice(0, 20).map(e => `  - ${e}`));
  }
  return {
    subject: `[Migration] ${icon} ${run.jobName} ${run.status}`,
    text: lines.join('\n'),
  };
}

async function notify(run: MigRun, notifyEmail: string | null | undefined) {
  if (!notifyEmail) return;
  try {
    const { subject, text } = buildNotifyBody(run);
    await sendEmail({ to: notifyEmail, subject, text });
  } catch {
    // notification is best-effort — never fail a run because email is down
  }
}

/**
 * Drive a run to a terminal state in the background. Stamps `heartbeatAt` each
 * loop so an orphaned run (process restart) can be detected and resumed. On
 * terminal, persists incremental watermarks, updates the owning schedule, and
 * sends an optional completion/failure email.
 */
export async function driveRun(
  initial: MigRun,
  source: MigConn,
  target: MigConn,
  scheduleId: string | null,
): Promise<void> {
  let run = initial;
  try {
    while (!TERMINAL.has(run.status)) {
      // Re-read persisted control state so table pause/stop requests made by
      // another API request are observed by this background driver.
      const persisted = loadRun(run.id);
      if (persisted) run = persisted;
      if (TERMINAL.has(run.status)) break;
      if (run.status === 'paused') return;
      // A run with only paused/terminal tables remains resumable, but should
      // not spin a hot background loop while waiting for user input.
      if (!run.tableStates.some(t => t.status === 'pending' || t.status === 'running')) {
        const hasPaused = run.tableStates.some(t => t.status === 'paused');
        if (!hasPaused) {
          run.status = run.tableStates.some(t => t.status === 'failed') ? 'failed'
            : run.tableStates.some(t => t.status === 'aborted') ? 'aborted' : 'completed';
          run.completedAt = new Date().toISOString();
          saveRun(run);
          break;
        }
        run.heartbeatAt = new Date().toISOString();
        saveRun(run);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      run = await advanceRun(run, source, target);
      // A control request can arrive while a DB chunk is in flight. Preserve
      // that request instead of overwriting it with this chunk's stale state.
      const controlled = loadRun(run.id);
      if (controlled) {
        if (controlled.status === 'aborted') run.status = 'aborted';
        if (controlled.status === 'paused') run.status = 'paused';
        for (const current of controlled.tableStates) {
          if (current.status !== 'paused' && current.status !== 'aborted') continue;
          const table = run.tableStates.find(t => t.id === current.id);
          if (table) {
            table.status = current.status;
            table.error = current.error;
          }
        }
      }
      run.heartbeatAt = new Date().toISOString();
      saveRun(run);
      persistWatermarks(run);
    }
  } catch (err) {
    run.status = 'failed';
    run.errors.push(err instanceof Error ? err.message : String(err));
    run.completedAt = new Date().toISOString();
    run.heartbeatAt = new Date().toISOString();
    saveRun(run);
  }

  let notifyEmail: string | null | undefined;
  if (scheduleId) {
    const schedule = loadSchedule(scheduleId);
    if (schedule) {
      notifyEmail = schedule.notifyEmail;
      saveSchedule({
        ...schedule,
        lastRunAt: new Date().toISOString(),
        lastRunStatus: run.status === 'completed' ? 'completed' : 'failed',
        lastRunId: run.id,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  await notify(run, notifyEmail);
}
