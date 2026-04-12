import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';

const CONFIG_DIR = path.join(process.cwd(), 'public', 'uploads', 'config');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const moduleName = String(req.query.module || 'migration').toLowerCase().replace(/[^a-z0-9_-]/g, '');

  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    const files = await fs.readdir(CONFIG_DIR);
    const items = files
      .filter((f) => f.endsWith('.json') && f.startsWith(`${moduleName}_conn_`))
      .sort((a, b) => b.localeCompare(a));
    return res.status(200).json({ success: true, files: items });
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
