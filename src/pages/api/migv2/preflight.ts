import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { loadJob } from '../../../lib/migv2/job-store';
import { resolveJobConns } from '../../../lib/migv2/resolve-conns';
import { runPreflight } from '../../../lib/migv2/preflight';
import { getPreflightResult, getPreflightStatus, savePreflightRecord } from '../../../lib/migv2/preflight-store';
import { assessMigrationTables } from '../../../lib/migv2/recurring-validation';

// POST { jobId } → PreflightReport
// Validates a saved job before a (potentially long) run: connectivity, real
// source row counts, target-table existence, server capability, and a duration ETA.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const jobId = typeof req.query.jobId === 'string' ? req.query.jobId : '';
    if (!jobId) return res.status(400).json({ error: 'jobId is required' });
    const job = loadJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    return res.status(200).json(getPreflightResult(job));
  }
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body as { jobId?: string };
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  const requestId = randomUUID();
  let stage = 'load_job';
  try {
    const job = loadJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found', stage, requestId });
    const assessment = assessMigrationTables(job.tables);
    if (!assessment.recurringReady) {
      return res.status(422).json({
        error: `This job has ${assessment.recurringIssues.length} Migration setup issue${assessment.recurringIssues.length !== 1 ? 's' : ''}.`,
        detail: 'Resolve the configuration in Migration before running operational Pre-flight.',
        stage: 'validate_setup',
        requestId,
        setupRequired: true,
      });
    }

    stage = 'resolve_connections';
    const { source, target } = await resolveJobConns(job);
    stage = 'run_checks';
    const report = await runPreflight(job, source, target);
    stage = 'save_result';
    const record = savePreflightRecord(job, report);
    return res.status(200).json({ report, status: getPreflightStatus(job), expiresAt: record.expiresAt });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const labels: Record<string, string> = {
      load_job: 'loading the saved job',
      resolve_connections: 'resolving saved connections',
      run_checks: 'checking database connectivity and capacity',
      save_result: 'saving the result',
    };
    console.error(`[preflight:${requestId}] Failed while ${labels[stage] ?? stage}`, err);
    return res.status(500).json({
      error: `Pre-flight failed while ${labels[stage] ?? stage}.`,
      detail,
      stage,
      requestId,
    });
  }
}
