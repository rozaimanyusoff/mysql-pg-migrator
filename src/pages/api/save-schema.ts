import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { MigrationConfig } from '../../lib/types';
import { generateSQLDocumentation } from '../../lib/documentation-generator';
import { logApiActivity } from '../../lib/audit-api';

function sanitizeFilePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_save_schema_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { config, sqlScript } = req.body as { config?: MigrationConfig; sqlScript?: string };
  if (!config) {
    await logApiActivity(req, 'api_save_schema_bad_request', 'warn');
    return res.status(400).json({ error: 'config is required' });
  }

  try {
    const schemaDir = path.join(process.cwd(), 'public', 'uploads', 'schema');
    await fs.mkdir(schemaDir, { recursive: true });

    const baseName = sanitizeFilePart(config.name || 'migration_schema') || 'migration_schema';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${baseName}_${stamp}.sql`;
    const absolutePath = path.join(schemaDir, fileName);
    const relativePath = path.posix.join('public', 'uploads', 'schema', fileName);
    const publicUrl = path.posix.join('/uploads/schema', fileName);
    const content = sqlScript && sqlScript.trim() ? sqlScript : generateSQLDocumentation(config);

    await fs.writeFile(absolutePath, content, 'utf8');
    await logApiActivity(req, 'api_save_schema_success', 'info', { fileName });

    return res.status(200).json({
      success: true,
      fileName,
      relativePath,
      publicUrl,
    });
  } catch (err: unknown) {
    await logApiActivity(req, 'api_save_schema_error', 'error', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
