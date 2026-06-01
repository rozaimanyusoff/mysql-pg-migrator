import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface TableInfo {
  schema: string;
  name: string;
  rowCount: number;
  columnCount: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();


  const { conn, schemas: schemaFilter } = req.body as { conn: ExplorerConn; schemas?: string[] };
  if (!conn?.type || !conn.host || !conn.username) {
    return res.status(400).json({ error: 'conn required' });
  }

  try {
    if (conn.type === 'postgresql') {
      const tables = await withPg(conn, async (client) => {
        const schemaClause = schemaFilter?.length
          ? `AND t.table_schema = ANY($1::text[])`
          : `AND t.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')`;
        const params = schemaFilter?.length ? [schemaFilter] : [];

        const { rows } = await client.query<{
          schema: string; name: string; row_count: string; col_count: string;
        }>(`
          SELECT
            t.table_schema AS schema,
            t.table_name  AS name,
            COALESCE(s.n_live_tup, 0) AS row_count,
            COUNT(c.column_name) AS col_count
          FROM information_schema.tables t
          LEFT JOIN pg_stat_user_tables s
            ON s.schemaname = t.table_schema AND s.relname = t.table_name
          LEFT JOIN information_schema.columns c
            ON c.table_schema = t.table_schema AND c.table_name = t.table_name
          WHERE t.table_type = 'BASE TABLE'
            ${schemaClause}
          GROUP BY t.table_schema, t.table_name, s.n_live_tup
          ORDER BY t.table_schema, t.table_name
        `, params);

        return rows.map(r => ({
          schema: r.schema,
          name: r.name,
          rowCount: Number(r.row_count),
          columnCount: Number(r.col_count),
        }));
      });
      return res.status(200).json({ tables });
    } else {
      const tables = await withMysql(conn, async (c) => {
        const schemaClause = schemaFilter?.length
          ? `AND t.TABLE_SCHEMA IN (${schemaFilter.map(() => '?').join(',')})`
          : `AND t.TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')`;
        const params = schemaFilter?.length ? schemaFilter : [];

        const [rows] = await c.query<any[]>(`
          SELECT
            t.TABLE_SCHEMA AS \`schema\`,
            t.TABLE_NAME   AS name,
            COALESCE(t.TABLE_ROWS, 0) AS row_count,
            COUNT(c.COLUMN_NAME) AS col_count
          FROM information_schema.TABLES t
          LEFT JOIN information_schema.COLUMNS c
            ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
          WHERE t.TABLE_TYPE = 'BASE TABLE'
            ${schemaClause}
          GROUP BY t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_ROWS
          ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
        `, params);

        return (rows as any[]).map(r => ({
          schema: r.schema,
          name: r.name,
          rowCount: Number(r.row_count),
          columnCount: Number(r.col_count),
        }));
      });
      return res.status(200).json({ tables });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
