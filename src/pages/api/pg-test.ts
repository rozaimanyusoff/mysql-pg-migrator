import type { NextApiRequest, NextApiResponse } from 'next';
import { PgConnectionConfig } from '../../lib/types';
import { testPgConnection } from '../../lib/migration-executor';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_pg_test_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const pgConfig = req.body as PgConnectionConfig;
  if (!pgConfig?.host || !pgConfig?.database) {
    await logApiActivity(req, 'api_pg_test_bad_request', 'warn');
    return res.status(400).json({ error: 'host and database are required' });
  }

  const result = await testPgConnection(pgConfig);
  await logApiActivity(req, result.ok ? 'api_pg_test_success' : 'api_pg_test_failed', result.ok ? 'info' : 'warn', {
    database: pgConfig.database,
  });
  return res.status(result.ok ? 200 : 400).json(result);
}
