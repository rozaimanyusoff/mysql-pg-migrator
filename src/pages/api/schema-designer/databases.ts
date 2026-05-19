import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { withPg, withMysql } from '../../../lib/explorer-db';

interface ConnPayload {
  type: 'postgresql' | 'mysql';
  host: string;
  port: number;
  username: string;
  password: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { type, host, port, username, password } = req.body as ConnPayload;
  if (!type || !host || !username) return res.status(400).json({ error: 'type, host, username required' });

  try {
    if (type === 'postgresql') {
      const conn = { type: 'postgresql' as const, host, port: port ?? 5432, database: 'postgres', username, password: password ?? '' };
      const databases = await withPg(conn, async (client) => {
        const { rows } = await client.query<{ datname: string }>(
          `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`
        );
        return rows.map(r => r.datname);
      });
      return res.status(200).json({ databases });
    } else {
      const conn = { type: 'mysql' as const, host, port: port ?? 3306, database: '', username, password: password ?? '' };
      const databases = await withMysql(conn, async (c) => {
        const [rows] = await c.query<any[]>('SHOW DATABASES');
        return (rows as any[]).map((r: any) => String(r.Database));
      });
      return res.status(200).json({ databases });
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
