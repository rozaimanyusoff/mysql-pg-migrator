import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { logApiActivity } from '../../lib/audit-api';

const SCHEMA_DIR = path.join(process.cwd(), 'public', 'uploads', 'schema');

function sanitize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

function localStamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_schema_config_save_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { module, name, snapshot, fileName } = req.body as {
    module?: string;
    name?: string;
    snapshot?: Record<string, unknown>;
    fileName?: string;
  };

  if (!module || !snapshot) {
    await logApiActivity(req, 'api_schema_config_save_bad_request', 'warn');
    return res.status(400).json({ error: 'module and snapshot are required' });
  }

  try {
    await fs.mkdir(SCHEMA_DIR, { recursive: true });
    const modulePart = sanitize(module) || 'module';
    const namePart = sanitize(name || 'config') || 'config';
    const stamp = localStamp();
    const explicit = (fileName || '').trim().toLowerCase();
    const validExplicit = /^[a-z0-9_-]+\.json$/.test(explicit) ? explicit : '';
    const finalFileName = validExplicit || `${modulePart}_${namePart}_${stamp}.json`;
    const fullPath = path.join(SCHEMA_DIR, finalFileName);

    const normalizedSnapshot = { ...snapshot } as Record<string, unknown>;
    const meta = (normalizedSnapshot.meta ?? {}) as Record<string, unknown>;
    normalizedSnapshot.meta = { ...meta, savedAt: localStamp() };

    await fs.writeFile(fullPath, JSON.stringify(normalizedSnapshot, null, 2), 'utf8');
    await logApiActivity(req, 'api_schema_config_save_success', 'info', { fileName: finalFileName, module: modulePart });

    return res.status(200).json({
      success: true,
      fileName: finalFileName,
      relativePath: path.posix.join('public', 'uploads', 'schema', finalFileName),
      publicUrl: path.posix.join('/uploads/schema', finalFileName),
    });
  } catch (err: unknown) {
    await logApiActivity(req, 'api_schema_config_save_error', 'error', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
