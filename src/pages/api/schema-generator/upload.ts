import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { verifyAccessToken } from '../../../lib/auth-store';
import { UPLOAD_DIR } from '../../../lib/paths';
import { logApiActivity } from '../../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  const username = token ? verifyAccessToken(token) : null;
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const { filename, content } = req.body as { filename?: string; content?: string };
  if (!filename || typeof content !== 'string')
    return res.status(400).json({ error: 'filename and content are required' });

  // Sanitize: keep only safe characters in the original filename
  const safeName = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const uid = crypto.randomBytes(6).toString('hex');
  const stored = `${uid}_${safeName}`;

  const dir = path.join(UPLOAD_DIR, 'schema-generator', username, dateStr);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, stored);
  await fs.writeFile(filePath, content, 'utf8');

  await logApiActivity(req, 'schema_generator_upload', 'info', { username, filename: stored });
  return res.status(200).json({ storedFilename: stored, filePath });
}
