import type { NextApiRequest, NextApiResponse } from 'next';
import { listSchedulerJobs } from '../../../lib/migv2/job-store';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  return res.status(200).json({ jobs: listSchedulerJobs() });
}
