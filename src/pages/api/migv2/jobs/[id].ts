import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob, saveJob, deleteJob } from '../../../../lib/migv2/job-store';
import type { MigJob } from '../../../../lib/migv2/types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {

  const { id } = req.query as { id: string };

  if (req.method === 'GET') {
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ job });
  }

  if (req.method === 'PUT') {
    const existing = loadJob(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const updated = saveJob({ ...existing, ...(req.body as Partial<MigJob>), id });
    return res.status(200).json({ job: updated });
  }

  if (req.method === 'DELETE') {
    const ok = deleteJob(id);
    return res.status(ok ? 200 : 404).json({ ok });
  }

  return res.status(405).end();
}
