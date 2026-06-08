import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const conn = req.body as ExplorerConn;
  if (!conn?.type || !conn.host || !conn.username) {
    return res.status(400).json({ error: 'conn required' });
  }

  try {
    if (conn.type === 'mysql') {
      const databases = await withMysql({ ...conn, database: 'information_schema' }, async c => {
        const [rows] = await c.query<any[]>(`
          SELECT SCHEMA_NAME AS name
          FROM information_schema.SCHEMATA
          WHERE SCHEMA_NAME NOT IN ('mysql','information_schema','performance_schema','sys')
          ORDER BY SCHEMA_NAME
        `);
        return (rows as any[]).map(r => r.name as string);
      });
      return res.status(200).json({ databases });
    } else {
      const databases = await withPg(conn, async c => {
        const { rows } = await c.query<any>(`
          SELECT datname AS name
          FROM pg_database
          WHERE datistemplate = false
          ORDER BY datname
        `);
        return rows.map((r: any) => r.name as string);
      });
      return res.status(200).json({ databases });
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
