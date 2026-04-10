import type { NextApiRequest, NextApiResponse } from 'next';
import { PgConnectionConfig } from '../../lib/types';
import { testPgConnection } from '../../lib/migration-executor';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const pgConfig = req.body as PgConnectionConfig;
  if (!pgConfig?.host || !pgConfig?.database) {
    return res.status(400).json({ error: 'host and database are required' });
  }

  const result = await testPgConnection(pgConfig);
  return res.status(result.ok ? 200 : 400).json(result);
}
