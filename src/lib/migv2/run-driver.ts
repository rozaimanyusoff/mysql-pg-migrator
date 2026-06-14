import { advanceRun } from './runner';
import { saveRun } from './run-store';
import { loadJob, saveJob } from './job-store';
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
    if (jt) { jt.lastSyncedValue = ts.newWatermark; updated = true; }
  }
  if (updated) saveJob(job);
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
      run = await advanceRun(run, source, target);
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
