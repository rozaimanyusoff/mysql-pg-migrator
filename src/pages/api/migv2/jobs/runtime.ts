import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob } from '../../../../lib/migv2/job-store';
import { resetJobRuntimeCursor } from '../../../../lib/migv2/job-runtime-store';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'DELETE') return res.status(405).end();
  const { id, tableId } = req.query as { id?: string; tableId?: string };
  if (!id) return res.status(400).json({ error: 'id is required' });
  const job = loadJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (tableId && !job.tables.some(table => table.id === tableId)) {
    return res.status(404).json({ error: 'Table not found in job' });
  }
  resetJobRuntimeCursor(id, tableId);
  return res.status(200).json({ job: loadJob(id) });
}
