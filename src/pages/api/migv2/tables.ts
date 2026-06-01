import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface MigTableInfo {
  schema: string;
  name: string;
  rowCount: number;
  columnCount: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const conn = req.body as ExplorerConn;
  if (!conn?.type || !conn.host || !conn.username) {
    return res.status(400).json({ error: 'connection required' });
  }

  try {
    if (conn.type === 'postgresql') {
      const tables = await withPg(conn, async c => {
        const { rows } = await c.query<any>(`
          SELECT t.table_schema AS schema, t.table_name AS name,
            COALESCE(s.n_live_tup, 0) AS row_count,
            COUNT(col.column_name) AS col_count
          FROM information_schema.tables t
          LEFT JOIN pg_stat_user_tables s ON s.schemaname = t.table_schema AND s.relname = t.table_name
          LEFT JOIN information_schema.columns col ON col.table_schema = t.table_schema AND col.table_name = t.table_name
          WHERE t.table_type = 'BASE TABLE'
            AND t.table_schema NOT IN ('pg_catalog','information_schema','pg_toast')
          GROUP BY t.table_schema, t.table_name, s.n_live_tup
          ORDER BY t.table_schema, t.table_name
        `);
        return rows.map((r: any) => ({
          schema: r.schema, name: r.name,
          rowCount: Number(r.row_count), columnCount: Number(r.col_count),
        }));
      });
      return res.status(200).json({ tables });
    } else {
      const tables = await withMysql(conn, async c => {
        const params: string[] = [];
        const dbFilter = conn.database
          ? (params.push(conn.database), 'AND t.TABLE_SCHEMA = ?')
          : '';
        const [rows] = await c.query<any[]>(`
          SELECT t.TABLE_SCHEMA AS \`schema\`, t.TABLE_NAME AS name,
            COALESCE(t.TABLE_ROWS, 0) AS row_count,
            COUNT(col.COLUMN_NAME) AS col_count
          FROM information_schema.TABLES t
          LEFT JOIN information_schema.COLUMNS col ON col.TABLE_SCHEMA = t.TABLE_SCHEMA AND col.TABLE_NAME = t.TABLE_NAME
          WHERE t.TABLE_TYPE = 'BASE TABLE'
            AND t.TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
            ${dbFilter}
          GROUP BY t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_ROWS
          ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME
        `, params);
        return (rows as any[]).map(r => ({
          schema: r.schema, name: r.name,
          rowCount: Number(r.row_count), columnCount: Number(r.col_count),
        }));
      });
      return res.status(200).json({ tables });
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
