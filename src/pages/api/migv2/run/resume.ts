import type { NextApiRequest, NextApiResponse } from 'next';
import { activeRunCount, loadRun, MAX_CONCURRENT_MIGRATIONS, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { listSchedules } from '../../../../lib/migv2/schedule-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import { recoverLegacyDisabledConstraints } from '../../../../lib/migv2/runner';

// POST { runId } → resume an interrupted/failed run from its last saved offsets.
// advanceRun only touches tables still 'pending'/'running', so completed tables
// are skipped and partially-done tables continue from ts.offset. Idempotent
// inserts (ON CONFLICT DO NOTHING) make re-processing the in-flight chunk safe.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { runId } = req.body as { runId?: string };
  if (!runId) return res.status(400).json({ error: 'runId is required' });

  const run = loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status === 'running') return res.status(400).json({ error: 'Run is already in progress' });
  if (run.status === 'completed') return res.status(400).json({ error: 'Run already completed' });
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
  if (run.interrupted) {
    try {
      const recovered = await recoverLegacyDisabledConstraints(run, conns.target);
      if (recovered.length > 0) {
        run.logs.push(`[${new Date().toISOString()}] Recovery: constraints re-enabled on ${recovered.join(', ')}.`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      run.logs.push(`[${new Date().toISOString()}] Recovery ERROR: ${message}`);
      saveRun(run);
      return res.status(500).json({ error: `Cannot safely resume: constraint recovery failed. ${message}` });
    }
  }

  // Reopen the run: clear terminal flags, re-arm in-flight tables that were
  // mid-chunk when the process died (failed tables stay failed and are skipped).
  run.status = 'running';
  run.interrupted = false;
  run.completedAt = null;
  run.heartbeatAt = new Date().toISOString();
  for (const ts of run.tableStates) {
    if (ts.status === 'running' || ts.status === 'failed') ts.status = 'pending';
  }
  run.logs.push(`[${new Date().toISOString()}] Run resumed from saved offsets (failed tables retried).`);
  saveRun(run);

  const schedule = listSchedules().find(s => s.jobId === run.jobId) ?? null;
  void driveRun(run, conns.source, conns.target, schedule?.id ?? null);

  return res.status(200).json({ runId: run.id });
}
