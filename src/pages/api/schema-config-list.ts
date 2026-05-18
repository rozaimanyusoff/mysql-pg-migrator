import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { logApiActivity } from '../../lib/audit-api';

const SCHEMA_DIR = path.join(process.cwd(), 'public', 'uploads', 'schema');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    await logApiActivity(req, 'api_schema_config_list_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const moduleName = String(req.query.module || '').trim().toLowerCase();

  try {
    await fs.mkdir(SCHEMA_DIR, { recursive: true });
    const files = await fs.readdir(SCHEMA_DIR);
    const configs = files
      .filter((f) => f.endsWith('.json'))
      .filter((f) => (moduleName ? f.toLowerCase().startsWith(`${moduleName}_`) : true))
      .sort((a, b) => b.localeCompare(a));
    await logApiActivity(req, 'api_schema_config_list_success', 'info', { module: moduleName || 'all', count: configs.length });
    return res.status(200).json({ success: true, files: configs });
  } catch (err: unknown) {
    await logApiActivity(req, 'api_schema_config_list_error', 'error', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
