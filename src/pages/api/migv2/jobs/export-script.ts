import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob } from '../../../../lib/migv2/job-store';
import { generateMigrationScript } from '../../../../lib/migv2/script-generator';

// Generates a standalone Node.js ESM (.mjs) migration script for a saved job.
// The script is self-contained (only needs `pg` + `mysql2`) and reproduces the
// in-app runner's transformation logic, so it can be run from a Linux terminal
// without the Next.js app — ideal for very large jobs (1000+ tables, 1M+ rows).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).end();

  const id = (req.query.id ?? (req.body as { id?: string } | undefined)?.id) as string | undefined;
  if (!id) return res.status(400).json({ error: 'id required' });

  const job = loadJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const script = generateMigrationScript(job);
  const slug = job.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';
  const filename = `migration-${slug}.mjs`;

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(script);
}
