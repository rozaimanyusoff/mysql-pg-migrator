import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface SchemaInfo {
  schema: string;
  tableCount: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const conn = req.body as ExplorerConn;
  if (!conn?.type || !conn.host || !conn.username) {
    return res.status(400).json({ error: 'host, username required' });
  }

  try {
    if (conn.type === 'postgresql') {
      const schemas = await withPg(conn, async (client) => {
        const { rows } = await client.query<{ schema: string; table_count: string }>(`
          SELECT table_schema AS schema, COUNT(*) AS table_count
          FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
            AND table_type = 'BASE TABLE'
          GROUP BY table_schema
          ORDER BY table_schema
        `);
        return rows.map(r => ({ schema: r.schema, tableCount: Number(r.table_count) }));
      });
      return res.status(200).json({ schemas });
    } else {
      const schemas = await withMysql(conn, async (c) => {
        const [rows] = await c.query<any[]>(`
          SELECT TABLE_SCHEMA AS \`schema\`, COUNT(*) AS table_count
          FROM information_schema.TABLES
          WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
          GROUP BY TABLE_SCHEMA
          ORDER BY TABLE_SCHEMA
        `);
        return (rows as any[]).map(r => ({ schema: r.schema, tableCount: Number(r.table_count) }));
      });
      return res.status(200).json({ schemas });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
