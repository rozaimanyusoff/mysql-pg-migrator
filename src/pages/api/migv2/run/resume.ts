import type { NextApiRequest, NextApiResponse } from 'next';
import { acquireRunLock, activeRunCount, activeRunForJob, loadRun, MAX_CONCURRENT_MIGRATIONS, RUN_START_LOCK, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { listSchedules } from '../../../../lib/migv2/schedule-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import { recoverLegacyDisabledConstraints } from '../../../../lib/migv2/runner';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';

// POST { runId } → resume an interrupted/failed run from its last saved offsets.
// advanceRun only touches tables still 'pending'/'running', so completed tables
// are skipped and partially-done tables continue from ts.offset. Idempotent
// inserts (ON CONFLICT DO NOTHING) make re-processing the in-flight chunk safe.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;

  const { runId } = req.body as { runId?: string };
  if (!runId) return res.status(400).json({ error: 'runId is required' });

  let run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status === 'running') return res.status(400).json({ error: 'Run is already in progress' });
  if (run.status === 'completed' || run.status === 'completed_with_issues') return res.status(400).json({ error: 'Run already completed; restart the affected table to retry unresolved rows.' });
  if (activeRunCount(run.id) >= MAX_CONCURRENT_MIGRATIONS) return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  if (!run.jobId) return res.status(400).json({ error: 'Run has no job to resolve connections from' });

  const job = loadJob(run.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found — cannot resolve connections' });

  let conns;
  try {
    conns = await resolveJobConns(job);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  // Runs interrupted under the former persistent ALTER TABLE implementation
  // may have left target triggers disabled. Repair that state before reopening
  // the run; fail closed if cleanup cannot be confirmed.
  let recoveredConstraintLog: string | null = null;
  if (run.interrupted) {
    try {
      const recovered = await recoverLegacyDisabledConstraints(run, conns.target);
      if (recovered.length > 0) {
        recoveredConstraintLog = `[${new Date().toISOString()}] Recovery: constraints re-enabled on ${recovered.join(', ')}.`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.logs.push(`[${new Date().toISOString()}] Recovery ERROR: ${message}`);
      saveRun(run);
      return res.status(500).json({ error: `Cannot safely resume: constraint recovery failed. ${message}` });
    }
  }

  // Reopen under the same global boundary used by every run-creation endpoint.
  // This prevents recovery racing a fresh manual or scheduled invocation.
  const releaseStartLock = await acquireRunLock(RUN_START_LOCK);
  run = loadRun(runId);
  if (!run) {
    releaseStartLock();
    return res.status(404).json({ error: 'Run not found' });
  }
  const competingRun = run.jobId ? activeRunForJob(run.jobId) : null;
  if (competingRun && competingRun.id !== run.id) {
    releaseStartLock();
    return res.status(409).json({ error: `This job already has an active ${competingRun.status} run.`, activeRunId: competingRun.id });
  }
  if (run.status === 'running' || run.status === 'pending') {
    releaseStartLock();
    return res.status(409).json({ error: 'Run recovery was already accepted.', activeRunId: run.id });
  }

  // Clear terminal flags and re-arm only unfinished tables. Completed tables
  // remain completed; failed/in-flight tables continue from saved checkpoints.
  run.status = 'running';
  run.interrupted = false;
  run.completedAt = null;
  run.heartbeatAt = new Date().toISOString();
  for (const ts of run.tableStates) {
    if (ts.status === 'running' || ts.status === 'failed') ts.status = 'pending';
  }
  if (recoveredConstraintLog) run.logs.push(recoveredConstraintLog);
  run.logs.push(`[${new Date().toISOString()}] Run resumed from saved offsets (failed tables retried).`);
  try { saveRun(run); } finally { releaseStartLock(); }

  const schedule = listSchedules().find(s => s.jobId === run.jobId) ?? null;
  void driveRun(run, conns.source, conns.target, schedule?.id ?? null);

  return res.status(200).json({ runId: run.id });
}
