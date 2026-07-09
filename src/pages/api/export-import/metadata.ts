import type { NextApiRequest, NextApiResponse } from 'next';
import type { ConnCfg } from '../../../lib/sql-exporter';
import { listMaintenanceMetadata } from '../../../lib/export-import-metadata';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cfg } = req.body as { cfg?: ConnCfg };
  if (!cfg?.host || !cfg?.user || !cfg?.db_type) {
    return res.status(400).json({ error: 'cfg (db_type, host, user) required' });
  }

  return res.status(200).json({ metadata: listMaintenanceMetadata(cfg) });
}
