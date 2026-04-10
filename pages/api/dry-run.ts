import type { NextApiRequest, NextApiResponse } from 'next';
import { MigrationConfig } from '../../lib/types';
import { validateMigrationConfig } from '../../lib/postgres-migrator';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { config } = req.body as { config: MigrationConfig };
  if (!config) return res.status(400).json({ error: 'config is required' });

  try {
    const result = validateMigrationConfig(config);
    return res.status(200).json({ success: true, ...result });
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
