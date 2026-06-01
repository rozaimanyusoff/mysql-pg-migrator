import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface ColumnInfo {
  name: string;
  dataType: string;
  fullType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPk: boolean;
  isUnique: boolean;
  isFk: boolean;
  fkRef: string | null; // "schema.table.column"
  maxLength: number | null;
  comment: string | null;
}

export interface FkInfo {
  fromCol: string;
  toSchema: string;
  toTable: string;
  toCol: string;
}

export interface TableColumnsResult {
  columns: ColumnInfo[];
  fks: FkInfo[];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();


  const { conn, tableKey } = req.body as { conn: ExplorerConn; tableKey: string };
  if (!conn || !tableKey) return res.status(400).json({ error: 'conn and tableKey required' });

  const parts = tableKey.split('.');
  const [schema, table] = parts.length === 2 ? parts : ['public', parts[0]];

  try {
    if (conn.type === 'postgresql') {
      const result = await withPg(conn, async (client) => {
        // columns + pk/unique
        const { rows: cols } = await client.query<any>(`
          SELECT
            c.column_name,
            c.data_type,
            c.udt_name,
            c.character_maximum_length,
            c.is_nullable,
            c.column_default,
            EXISTS (
              SELECT 1 FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
              WHERE tc.constraint_type = 'PRIMARY KEY'
                AND tc.table_schema = $1 AND tc.table_name = $2
                AND kcu.column_name = c.column_name
            ) AS is_pk,
            EXISTS (
              SELECT 1 FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
              WHERE tc.constraint_type = 'UNIQUE'
                AND tc.table_schema = $1 AND tc.table_name = $2
                AND kcu.column_name = c.column_name
            ) AS is_unique,
            pgd.description AS comment
          FROM information_schema.columns c
          LEFT JOIN pg_catalog.pg_statio_all_tables st
            ON st.schemaname = c.table_schema AND st.relname = c.table_name
          LEFT JOIN pg_catalog.pg_description pgd
            ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
          WHERE c.table_schema = $1 AND c.table_name = $2
          ORDER BY c.ordinal_position
        `, [schema, table]);

        // foreign keys
        const { rows: fkRows } = await client.query<any>(`
          SELECT
            kcu.column_name AS from_col,
            ccu.table_schema AS to_schema,
            ccu.table_name  AS to_table,
            ccu.column_name AS to_col
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
          JOIN information_schema.key_column_usage ccu
            ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = rc.unique_constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1 AND tc.table_name = $2
        `, [schema, table]);

        const fkMap = new Map<string, string>();
        const fks: FkInfo[] = fkRows.map(r => {
          fkMap.set(r.from_col, `${r.to_schema}.${r.to_table}.${r.to_col}`);
          return { fromCol: r.from_col, toSchema: r.to_schema, toTable: r.to_table, toCol: r.to_col };
        });

        const columns: ColumnInfo[] = cols.map(c => ({
          name: c.column_name,
          dataType: c.data_type,
          fullType: c.character_maximum_length
            ? `${c.udt_name}(${c.character_maximum_length})`
            : c.udt_name,
          nullable: c.is_nullable === 'YES',
          defaultValue: c.column_default ?? null,
          isPk: c.is_pk === true,
          isUnique: c.is_unique === true,
          isFk: fkMap.has(c.column_name),
          fkRef: fkMap.get(c.column_name) ?? null,
          maxLength: c.character_maximum_length ? Number(c.character_maximum_length) : null,
          comment: c.comment ?? null,
        }));

        return { columns, fks };
      });
      return res.status(200).json(result);
    } else {
      const result = await withMysql(conn, async (c) => {
        const [cols] = await c.query<any[]>(`
          SELECT
            COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
            COLUMN_DEFAULT, COLUMN_KEY, CHARACTER_MAXIMUM_LENGTH, COLUMN_COMMENT
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
        `, [schema, table]);

        const [fkRows] = await c.query<any[]>(`
          SELECT
            kcu.COLUMN_NAME AS from_col,
            kcu.REFERENCED_TABLE_SCHEMA AS to_schema,
            kcu.REFERENCED_TABLE_NAME   AS to_table,
            kcu.REFERENCED_COLUMN_NAME  AS to_col
          FROM information_schema.KEY_COLUMN_USAGE kcu
          JOIN information_schema.TABLE_CONSTRAINTS tc
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
            AND kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
        `, [schema, table]);

        const fkMap = new Map<string, string>();
        const fks: FkInfo[] = (fkRows as any[]).map(r => {
          fkMap.set(r.from_col, `${r.to_schema}.${r.to_table}.${r.to_col}`);
          return { fromCol: r.from_col, toSchema: r.to_schema, toTable: r.to_table, toCol: r.to_col };
        });

        const columns: ColumnInfo[] = (cols as any[]).map(c => ({
          name: c.COLUMN_NAME,
          dataType: c.DATA_TYPE,
          fullType: c.COLUMN_TYPE,
          nullable: c.IS_NULLABLE === 'YES',
          defaultValue: c.COLUMN_DEFAULT ?? null,
          isPk: c.COLUMN_KEY === 'PRI',
          isUnique: c.COLUMN_KEY === 'UNI',
          isFk: fkMap.has(c.COLUMN_NAME),
          fkRef: fkMap.get(c.COLUMN_NAME) ?? null,
          maxLength: c.CHARACTER_MAXIMUM_LENGTH ? Number(c.CHARACTER_MAXIMUM_LENGTH) : null,
          comment: c.COLUMN_COMMENT || null,
        }));

        return { columns, fks };
      });
      return res.status(200).json(result);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
