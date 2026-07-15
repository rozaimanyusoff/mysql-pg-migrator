import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { loadJob, saveJob } from '../../../../lib/migv2/job-store';
import { createPortableJob, parsePortableJob } from '../../../../lib/migv2/job-portability';

export const config = {
  api: { bodyParser: { sizeLimit: '5mb' } },
};

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'migration-job';
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const id = typeof req.query.id === 'string' ? req.query.id : '';
    const job = id ? loadJob(id) : null;
    if (!job) return res.status(404).json({ error: 'Saved job not found.' });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(job.name)}.migjob.json"`);
    return res.status(200).send(JSON.stringify(createPortableJob(job), null, 2));
  }

  if (req.method === 'POST') {
    try {
      const imported = parsePortableJob(req.body);
      const job = saveJob({
        ...imported,
        id: randomUUID(),
        version: 0,
        createdAt: '',
        updatedAt: '',
      });
      return res.status(201).json({ job, credentialsRequired: true });
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid saved-job file.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
