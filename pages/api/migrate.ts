import type { NextApiRequest, NextApiResponse } from 'next';
import { MigrationConfig, PgConnectionConfig } from '../../lib/types';
import { executeMigration } from '../../lib/migration-executor';
import { logApiActivity } from '../../lib/audit-api';

// Disable body size limit for large datasets
export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_migrate_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { migrationConfig, pgConfig, mysqlConfig } = req.body as {
    migrationConfig: MigrationConfig;
    pgConfig: PgConnectionConfig;
    mysqlConfig: { host: string; port: number; user: string; password: string; database: string };
  };

  if (!migrationConfig || !pgConfig || !mysqlConfig) {
    await logApiActivity(req, 'api_migrate_bad_request', 'warn');
    return res.status(400).json({ error: 'migrationConfig, pgConfig, and mysqlConfig are required' });
  }

  try {
    const result = await executeMigration(migrationConfig, pgConfig, mysqlConfig);
    await logApiActivity(req, 'api_migrate_success', 'info', {
      success: result.success,
      tables: result.tableResults.length,
      rows: result.totalRowsMigrated,
    });
    return res.status(200).json({ success: result.success, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_migrate_error', 'error', { message });
    return res.status(500).json({ success: false, error: message });
  }
}
