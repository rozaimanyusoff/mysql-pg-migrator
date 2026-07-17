import type { NextApiRequest, NextApiResponse } from 'next';
import { listJobs, saveJob } from '../../../../lib/migv2/job-store';
import type { MigJob } from '../../../../lib/migv2/types';
import { randomUUID } from 'crypto';

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' }, responseLimit: '50mb' },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {

  if (req.method === 'GET') {
    return res.status(200).json({ jobs: listJobs() });
  }

  if (req.method === 'POST') {
    const body = req.body as Partial<MigJob>;
    if (!body.name || !body.tables) return res.status(400).json({ error: 'name and tables required' });
    const job: MigJob = {
      id: body.id ?? randomUUID(),
      name: body.name,
      description: body.description ?? '',
      version: 0,
      createdAt: '',
      updatedAt: '',
      sourceMeta: body.sourceMeta!,
      targetMeta: body.targetMeta!,
      mappingMode: body.mappingMode,
      syncStrategy: body.syncStrategy,
      initialRunOptions: body.initialRunOptions,
      tables: body.tables,
    };
    const saved = saveJob(job);
    return res.status(200).json({ job: saved });
  }

  return res.status(405).end();
}
