import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { exportDatabase, ConnCfg, ExportInclude } from '../../../lib/sql-exporter';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  if (!token || !verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { cfg, tables, include } = req.body as {
    cfg?: ConnCfg;
    tables?: string[] | 'all';
    include?: ExportInclude;
  };

  if (!cfg?.host || !cfg?.user || !cfg?.database || !cfg?.db_type)
    return res.status(400).json({ error: 'cfg (db_type, host, user, database) required' });

  try {
    const result = await exportDatabase(cfg, tables ?? 'all', include ?? 'both');
    return res.status(200).json(result);
  } catch (err: unknown) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
