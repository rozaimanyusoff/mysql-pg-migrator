import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob } from '../../../lib/migv2/job-store';
import { resolveJobConns } from '../../../lib/migv2/resolve-conns';
import { runPreflight } from '../../../lib/migv2/preflight';

// POST { jobId } → PreflightReport
// Validates a saved job before a (potentially long) run: connectivity, real
// source row counts, target-table existence, type/FK sanity, and a duration ETA.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { jobId } = req.body as { jobId?: string };
  if (!jobId) return res.status(400).json({ error: 'jobId is required' });

  const job = loadJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  try {
    const { source, target } = await resolveJobConns(job);
    const report = await runPreflight(job, source, target);
    return res.status(200).json({ report });
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
