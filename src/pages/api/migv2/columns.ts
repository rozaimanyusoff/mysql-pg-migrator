import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface MigColumnInfo {
  name: string;
  rawType: string;       // e.g. "varchar(255)" or "int unsigned"
  nullable: boolean;
  defaultValue: string | null;
  isPk: boolean;
  isUnique: boolean;
  isFk: boolean;
  fkRef: string | null;  // "schema.table.column"
  isAutoIncrement: boolean;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { conn, tableKey } = req.body as { conn: ExplorerConn; tableKey: string };
  if (!conn || !tableKey) return res.status(400).json({ error: 'conn and tableKey required' });

  const parts = tableKey.split('.');
  const [schema, table] = parts.length === 2 ? parts : ['public', parts[0]];

  try {
    if (conn.type === 'postgresql') {
      const columns = await withPg(conn, async c => {
        const { rows: cols } = await c.query<any>(`
          SELECT
            c.column_name, c.udt_name, c.data_type,
            c.character_maximum_length, c.numeric_precision, c.numeric_scale,
            c.is_nullable, c.column_default,
            EXISTS(
              SELECT 1 FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
              WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 AND kcu.column_name = c.column_name
            ) AS is_pk,
            EXISTS(
              SELECT 1 FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
              WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1 AND tc.table_name = $2 AND kcu.column_name = c.column_name
            ) AS is_unique
          FROM information_schema.columns c
          WHERE c.table_schema = $1 AND c.table_name = $2
          ORDER BY c.ordinal_position
        `, [schema, table]);

        const { rows: fkRows } = await c.query<any>(`
          SELECT kcu.column_name AS from_col, ccu.table_schema AS to_schema,
            ccu.table_name AS to_table, ccu.column_name AS to_col
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
          JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
          JOIN information_schema.key_column_usage ccu ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = rc.unique_constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2
        `, [schema, table]);

        const fkMap = new Map(fkRows.map(r => [r.from_col, `${r.to_schema}.${r.to_table}.${r.to_col}`]));

        return cols.map((c: any): MigColumnInfo => {
          let rawType = c.udt_name;
          if (c.character_maximum_length) rawType += `(${c.character_maximum_length})`;
          else if (c.numeric_precision && ['numeric','decimal'].includes(c.data_type))
            rawType += `(${c.numeric_precision},${c.numeric_scale ?? 0})`;
          return {
            name: c.column_name, rawType,
            nullable: c.is_nullable === 'YES',
            defaultValue: c.column_default ?? null,
            isPk: c.is_pk === true,
            isUnique: c.is_unique === true,
            isFk: fkMap.has(c.column_name),
            fkRef: fkMap.get(c.column_name) ?? null,
            isAutoIncrement: (c.column_default ?? '').includes('nextval'),
          };
        });
      });
      return res.status(200).json({ columns });
    } else {
      const columns = await withMysql(conn, async c => {
        const [cols] = await c.query<any[]>(`
          SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT,
            COLUMN_KEY, EXTRA, CHARACTER_MAXIMUM_LENGTH
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
        `, [schema, table]);

        const [fkRows] = await c.query<any[]>(`
          SELECT kcu.COLUMN_NAME AS from_col,
            kcu.REFERENCED_TABLE_SCHEMA AS to_schema,
            kcu.REFERENCED_TABLE_NAME AS to_table,
            kcu.REFERENCED_COLUMN_NAME AS to_col
          FROM information_schema.KEY_COLUMN_USAGE kcu
          JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY' AND kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
        `, [schema, table]);

        const fkMap = new Map((fkRows as any[]).map(r => [r.from_col, `${r.to_schema}.${r.to_table}.${r.to_col}`]));

        return (cols as any[]).map((c): MigColumnInfo => ({
          name: c.COLUMN_NAME,
          rawType: c.COLUMN_TYPE,
          nullable: c.IS_NULLABLE === 'YES',
          defaultValue: c.COLUMN_DEFAULT ?? null,
          isPk: c.COLUMN_KEY === 'PRI',
          isUnique: c.COLUMN_KEY === 'UNI',
          isFk: fkMap.has(c.COLUMN_NAME),
          fkRef: fkMap.get(c.COLUMN_NAME) ?? null,
          isAutoIncrement: (c.EXTRA ?? '').includes('auto_increment'),
        }));
      });
      return res.status(200).json({ columns });
    }
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
