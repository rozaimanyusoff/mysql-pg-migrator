import type { NextApiRequest, NextApiResponse } from 'next';
import { listJobs } from '../../../../lib/migv2/job-store';

export interface TableRef {
  targetKey: string; // "assetdata.types"
  sourceKey: string; // "assets.types"
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const seen = new Set<string>();
  const refs: TableRef[] = [];

  for (const summary of listJobs()) {
    for (const t of summary.tables) {
      if (!t.target.table || !t.source.table) continue;
      const targetKey = `${t.target.schema}.${t.target.table}`;
      const sourceKey = `${t.source.schema}.${t.source.table}`;
      if (!seen.has(targetKey)) {
        seen.add(targetKey);
        refs.push({ targetKey, sourceKey });
      }
    }
  }

  return res.status(200).json({ refs });
}
