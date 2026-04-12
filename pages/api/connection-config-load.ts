import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';

const CONFIG_DIR = path.join(process.cwd(), 'public', 'uploads', 'config');

function safeFile(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const file = safeFile(String(req.query.file || ''));
  if (!file || !file.endsWith('.json')) return res.status(400).json({ error: 'file (.json) is required' });

  try {
    const raw = await fs.readFile(path.join(CONFIG_DIR, file), 'utf8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    return res.status(200).json({ success: true, config });
  } catch {
    return res.status(404).json({ success: false, error: 'Connection config file not found' });
  }
}
