import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import { PgConnectionConfig } from '../../lib/types';

const CONFIG_DIR = path.join(process.cwd(), 'public', 'uploads', 'config');

function sanitize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

interface ConnectionSnapshot {
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { module, name, mysql, pg } = req.body as {
    module?: string;
    name?: string;
    mysql?: ConnectionSnapshot['mysql'];
    pg?: ConnectionSnapshot['pg'];
  };

  if (!module || !mysql || !pg) return res.status(400).json({ error: 'module, mysql, and pg are required' });

  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    const mod = sanitize(module) || 'migration';
    const label = sanitize(name || 'connection') || 'connection';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${mod}_conn_${label}_${stamp}.json`;

    const payload: ConnectionSnapshot = {
      module: mod,
      savedAt: new Date().toISOString(),
      mysql,
      pg,
    };

    await fs.writeFile(path.join(CONFIG_DIR, fileName), JSON.stringify(payload, null, 2), 'utf8');
    return res.status(200).json({ success: true, fileName });
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
