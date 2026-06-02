import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface ColumnConstraints {
  fkConstraints: { colName: string; constraintName: string; toTable: string; toCol: string }[];
  uniqueConstraints: { colName: string; constraintName: string }[];
  checkConstraints: { name: string; clause: string }[];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { conn, schema, table } = req.body as { conn: ExplorerConn; schema: string; table: string };
  if (!conn || !table) return res.status(400).json({ error: 'conn, schema, table required' });

  const sc = schema || 'public';

  try {
    if (conn.type === 'postgresql') {
      const result = await withPg(conn, async (client) => {
        const { rows: uc } = await client.query<any>(`
          SELECT tc.constraint_name, kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'UNIQUE'
          ORDER BY kcu.ordinal_position
        `, [sc, table]);

        const { rows: fk } = await client.query<any>(`
          SELECT
            tc.constraint_name,
            kcu.column_name,
            ccu.table_name  AS to_table,
            ccu.column_name AS to_col
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
          JOIN information_schema.key_column_usage ccu
            ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = rc.unique_constraint_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'
        `, [sc, table]);

        const { rows: cc } = await client.query<any>(`
          SELECT tc.constraint_name, cc.check_clause
          FROM information_schema.table_constraints tc
          JOIN information_schema.check_constraints cc
            ON cc.constraint_name = tc.constraint_name AND cc.constraint_schema = tc.constraint_schema
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'CHECK'
            AND tc.constraint_name NOT LIKE '%_not_null'
        `, [sc, table]);

        return {
          uniqueConstraints: uc.map((r: any) => ({ colName: r.column_name, constraintName: r.constraint_name })),
          fkConstraints: fk.map((r: any) => ({ colName: r.column_name, constraintName: r.constraint_name, toTable: r.to_table, toCol: r.to_col })),
          checkConstraints: cc.map((r: any) => ({ name: r.constraint_name, clause: r.check_clause })),
        } as ColumnConstraints;
      });
      return res.status(200).json(result);
    } else {
      const result = await withMysql(conn, async (c) => {
        const [fk] = await c.query<any[]>(`
          SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME AS to_table, kcu.REFERENCED_COLUMN_NAME AS to_col
          FROM information_schema.KEY_COLUMN_USAGE kcu
          JOIN information_schema.TABLE_CONSTRAINTS tc
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY' AND kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
        `, [sc, table]);

        const [uc] = await c.query<any[]>(`
          SELECT tc.CONSTRAINT_NAME, kcu.COLUMN_NAME
          FROM information_schema.TABLE_CONSTRAINTS tc
          JOIN information_schema.KEY_COLUMN_USAGE kcu
            ON kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'UNIQUE' AND tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ?
        `, [sc, table]);

        return {
          fkConstraints: (fk as any[]).map(r => ({ colName: r.COLUMN_NAME, constraintName: r.CONSTRAINT_NAME, toTable: r.to_table, toCol: r.to_col })),
          uniqueConstraints: (uc as any[]).map(r => ({ colName: r.COLUMN_NAME, constraintName: r.CONSTRAINT_NAME })),
          checkConstraints: [],
        } as ColumnConstraints;
      });
      return res.status(200).json(result);
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
