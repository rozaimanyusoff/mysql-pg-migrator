import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob, saveJob } from '../../../../lib/migv2/job-store';
import { listRunsForJob } from '../../../../lib/migv2/run-store';
import type { TableMap } from '../../../../lib/migv2/types';

// POST /api/migv2/jobs/restore?id=<jobId>
// Reconstructs a job's tables from its completed run history (most recent snapshot per source table).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { id } = req.query as { id?: string };
  if (!id) return res.status(400).json({ error: 'id is required' });

  const job = loadJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const runs = listRunsForJob(id).filter(r => r.status === 'completed' || r.status === 'completed_with_issues');
  if (runs.length === 0) return res.status(422).json({ error: 'No completed runs found for this job' });

  // Collect unique tables by source key, preferring the most recent run's version
  const byKey = new Map<string, TableMap>();
  for (const run of runs.slice().reverse()) { // oldest first so newest wins
    for (const t of run.tables ?? []) {
      const key = `${t.source.schema}.${t.source.table}`;
      byKey.set(key, t);
    }
  }

  const restoredTables = [...byKey.values()];
  const updated = saveJob({ ...job, tables: restoredTables });
  return res.status(200).json({ job: updated, restored: restoredTables.length });
}
