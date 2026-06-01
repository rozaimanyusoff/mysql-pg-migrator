import type { NextApiRequest, NextApiResponse } from 'next';
import { listTablesWithCounts, ConnCfg } from '../../../lib/sql-exporter';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });


  const { cfg } = req.body as { cfg?: ConnCfg };
  if (!cfg?.host || !cfg?.user || !cfg?.database || !cfg?.db_type)
    return res.status(400).json({ error: 'cfg (db_type, host, user, database) required' });

  try {
    const tables = await listTablesWithCounts(cfg);
    return res.status(200).json({ tables });
  } catch (err: unknown) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
