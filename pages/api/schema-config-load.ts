import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { logApiActivity } from '../../lib/audit-api';

const SCHEMA_DIR = path.join(process.cwd(), 'public', 'uploads', 'schema');

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    await logApiActivity(req, 'api_schema_config_load_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const file = safeFileName(String(req.query.file || ''));
  if (!file || !file.endsWith('.json')) {
    await logApiActivity(req, 'api_schema_config_load_bad_request', 'warn');
    return res.status(400).json({ error: 'file (.json) is required' });
  }

  try {
    const fullPath = path.join(SCHEMA_DIR, file);
    const raw = await fs.readFile(fullPath, 'utf8');
    const snapshot = JSON.parse(raw) as Record<string, unknown>;
    await logApiActivity(req, 'api_schema_config_load_success', 'info', { file });
    return res.status(200).json({ success: true, file, snapshot });
  } catch (err: unknown) {
    await logApiActivity(req, 'api_schema_config_load_error', 'error', { file, message: err instanceof Error ? err.message : String(err) });
    return res.status(404).json({ success: false, error: 'Config file not found or invalid JSON' });
  }
}
