import { acquireRunLock, activeRunCount, activeRunForJob, loadRun, MAX_CONCURRENT_MIGRATIONS, RUN_START_LOCK, saveRun } from './run-store';
import { loadJob } from './job-store';
import { listSchedules } from './schedule-store';
import { resolveJobConns } from './resolve-conns';
import { driveRun } from './run-driver';
import { recoverLegacyDisabledConstraints } from './runner';

export class RunRecoveryError extends Error {
  constructor(public status: number, public payload: Record<string, unknown>) {
    super(String(payload.error ?? 'Run recovery failed'));
  }
}

function reject(status: number, payload: Record<string, unknown>): never {
  throw new RunRecoveryError(status, payload);
}

export async function resumeInterruptedRun(runId: string): Promise<{ runId: string }> {
  let run = loadRun(runId);
  if (!run) reject(404, { error: 'Run not found' });
  if (run.status === 'running') reject(400, { error: 'Run is already in progress' });
  if (run.status === 'completed' || run.status === 'completed_with_issues') reject(400, { error: 'Run already completed; restart the affected table to retry unresolved rows.' });
  if (activeRunCount(run.id) >= MAX_CONCURRENT_MIGRATIONS) reject(409, { error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  if (!run.jobId) reject(400, { error: 'Run has no job to resolve connections from' });

  const job = loadJob(run.jobId);
  if (!job) reject(404, { error: 'Job not found — cannot resolve connections' });
  let conns;
  try { conns = await resolveJobConns(job); }
  catch (err) { reject(400, { error: err instanceof Error ? err.message : String(err) }); }

  let recoveredConstraintLog: string | null = null;
  if (run.interrupted) {
    try {
      const recovered = await recoverLegacyDisabledConstraints(run, conns.target);
      if (recovered.length > 0) recoveredConstraintLog = `[${new Date().toISOString()}] Recovery: constraints re-enabled on ${recovered.join(', ')}.`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.logs.push(`[${new Date().toISOString()}] Recovery ERROR: ${message}`);
      saveRun(run);
      reject(500, { error: `Cannot safely resume: constraint recovery failed. ${message}` });
    }
  }

  const releaseStartLock = await acquireRunLock(RUN_START_LOCK);
  try {
    run = loadRun(runId);
    if (!run) reject(404, { error: 'Run not found' });
    const competingRun = run.jobId ? activeRunForJob(run.jobId) : null;
    if (competingRun && competingRun.id !== run.id) reject(409, { error: `This job already has an active ${competingRun.status} run.`, activeRunId: competingRun.id });
    if (run.status === 'running' || run.status === 'pending') reject(409, { error: 'Run recovery was already accepted.', activeRunId: run.id });

    run.status = 'running';
    run.interrupted = false;
    run.completedAt = null;
    run.heartbeatAt = new Date().toISOString();
    for (const table of run.tableStates) {
      if (table.status === 'running' || table.status === 'failed') table.status = 'pending';
    }
    if (recoveredConstraintLog) run.logs.push(recoveredConstraintLog);
    run.logs.push(`[${new Date().toISOString()}] Run resumed from saved offsets (failed tables retried).`);
    saveRun(run);
  } finally {
    releaseStartLock();
  }

  const schedule = listSchedules().find(candidate => candidate.jobId === run.jobId) ?? null;
  void driveRun(run, conns.source, conns.target, schedule?.id ?? null);
  return { runId: run.id };
}
