import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { logApiActivity } from '../../lib/audit-api';

const CONFIG_DIR = path.join(process.cwd(), 'public', 'uploads', 'config');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    await logApiActivity(req, 'api_module_config_list_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    const files = await fs.readdir(CONFIG_DIR);
    const modules = files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
    await logApiActivity(req, 'api_module_config_list_success', 'info', { count: modules.length });
    return res.status(200).json({ success: true, modules });
  } catch (err: unknown) {
    await logApiActivity(req, 'api_module_config_list_error', 'error', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
