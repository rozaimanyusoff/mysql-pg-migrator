import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob } from '../../../../lib/migv2/job-store';
import { generatePythonScript } from '../../../../lib/migv2/script-gen';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const { id } = req.query as { id?: string };
  if (!id) return res.status(400).json({ error: 'id required' });

  const job = loadJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const script = generatePythonScript(job);
  const filename = `migrate_${job.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}.py`;

  res.setHeader('Content-Type', 'text/x-python');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(script);
}
