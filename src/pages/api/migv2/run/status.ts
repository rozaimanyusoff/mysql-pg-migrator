import type { NextApiRequest, NextApiResponse } from 'next';
import { loadRun, listRuns } from '../../../../lib/migv2/run-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const { id } = req.query as { id?: string };
  if (id) {
    const run = loadRun(id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ run });
  }
  return res.status(200).json({ runs: listRuns() });
}
