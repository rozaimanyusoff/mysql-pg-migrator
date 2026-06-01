import type { NextApiRequest, NextApiResponse } from 'next';
import { loadRun } from '../../../lib/migv2/run-store';
import { buildMigrationMd } from '../../../lib/migv2/runner';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const { id } = req.query as { id?: string };
  if (!id) return res.status(400).json({ error: 'id required' });

  const run = loadRun(id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const md = buildMigrationMd(run);
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="migration-${run.id.slice(0, 8)}.md"`);
  return res.status(200).send(md);
}
