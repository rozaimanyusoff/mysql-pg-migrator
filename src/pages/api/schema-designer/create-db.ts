import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql } from '../../../lib/explorer-db';

interface ConnPayload {
  type: 'postgresql' | 'mysql';
  host: string;
  port: number;
  username: string;
  password: string;
}

const SAFE_NAME = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '');

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();


  const { type, host, port, username, password, dbName } = req.body as ConnPayload & { dbName: string };
  if (!type || !host || !username || !dbName?.trim()) return res.status(400).json({ error: 'type, host, username, dbName required' });

  const safe = SAFE_NAME(dbName.trim());
  if (!safe) return res.status(400).json({ error: 'Invalid database name' });

  try {
    if (type === 'postgresql') {
      // CREATE DATABASE cannot run inside a transaction
      const conn = { type: 'postgresql' as const, host, port: port ?? 5432, database: 'postgres', username, password: password ?? '' };
      await withPg(conn, async (client) => {
        await client.query(`CREATE DATABASE "${safe}"`);
      });
    } else {
      const conn = { type: 'mysql' as const, host, port: port ?? 3306, database: '', username, password: password ?? '' };
      await withMysql(conn, async (c) => {
        await c.query(`CREATE DATABASE IF NOT EXISTS \`${safe}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      });
    }
    return res.status(200).json({ success: true, dbName: safe });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
