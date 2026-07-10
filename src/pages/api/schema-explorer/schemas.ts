import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface SchemaInfo {
  schema: string;
  tableCount: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();


  const conn = req.body as ExplorerConn;
  if (!conn?.type || !conn.host || !conn.username) {
    return res.status(400).json({ error: 'host, username required' });
  }

  try {
    if (conn.type === 'postgresql') {
      const schemas = await withPg(conn, async (client) => {
        const { rows } = await client.query<{ schema: string; table_count: string }>(`
          SELECT
            s.schema_name AS schema,
            COUNT(t.table_name) AS table_count
          FROM information_schema.schemata s
          LEFT JOIN information_schema.tables t
            ON t.table_schema = s.schema_name
           AND t.table_type = 'BASE TABLE'
          WHERE s.schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
            AND s.schema_name NOT LIKE 'pg_temp_%'
            AND s.schema_name NOT LIKE 'pg_toast_temp_%'
          GROUP BY s.schema_name
          ORDER BY s.schema_name
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
