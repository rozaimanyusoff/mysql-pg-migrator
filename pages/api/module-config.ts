import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { PgConnectionConfig } from '../../lib/types';
import { logApiActivity } from '../../lib/audit-api';

interface ModuleDbConfig {
  module: string;
  savedAt: string;
  mysql: {
    host: string;
    port: string;
    user: string;
    password: string;
    database: string;
    connected: boolean;
    databases: string[];
  };
  pg: {
    form: PgConnectionConfig;
    connected: boolean;
    schemas: string[];
  };
}

const CONFIG_DIR = path.join(process.cwd(), 'public', 'uploads', 'config');

function safeModuleName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
}

async function ensureDir() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const moduleName = safeModuleName(String(req.query.module || req.body?.module || ''));
  if (!moduleName) {
    await logApiActivity(req, 'api_module_config_bad_request', 'warn');
    return res.status(400).json({ error: 'module is required' });
  }

  const filePath = path.join(CONFIG_DIR, `${moduleName}.json`);

  if (req.method === 'GET') {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const config = JSON.parse(raw) as ModuleDbConfig;
      await logApiActivity(req, 'api_module_config_get_success', 'info', { module: moduleName });
      return res.status(200).json({ success: true, config });
    } catch {
      await logApiActivity(req, 'api_module_config_get_not_found', 'warn', { module: moduleName });
      return res.status(404).json({ success: false, error: 'Config file not found' });
    }
  }

  if (req.method === 'POST') {
    const body = req.body as Omit<ModuleDbConfig, 'savedAt'> & { savedAt?: string };
    if (!body?.mysql || !body?.pg) {
      await logApiActivity(req, 'api_module_config_post_bad_request', 'warn', { module: moduleName });
      return res.status(400).json({ error: 'mysql and pg config are required' });
    }

    try {
      await ensureDir();
      const payload: ModuleDbConfig = {
        module: moduleName,
        savedAt: new Date().toISOString(),
        mysql: body.mysql,
        pg: body.pg,
      };
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
      await logApiActivity(req, 'api_module_config_post_success', 'info', { module: moduleName });
      return res.status(200).json({
        success: true,
        module: moduleName,
        relativePath: path.posix.join('public', 'uploads', 'config', `${moduleName}.json`),
      });
    } catch (err: unknown) {
      await logApiActivity(req, 'api_module_config_post_error', 'error', { module: moduleName, message: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await logApiActivity(req, 'api_module_config_method_not_allowed', 'warn', { module: moduleName });
  return res.status(405).json({ error: 'Method not allowed' });
}
