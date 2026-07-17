import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db.ts';
import type { MigColumnInfo } from './columns.ts';

interface TableRef { schema: string; table: string }

export const MAX_TABLES_PER_REQUEST = 250;

export const config = {
  api: { bodyParser: { sizeLimit: '2mb' }, responseLimit: '20mb' },
};

function tableKey(schema: string, table: string): string {
  return `${schema}.${table}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const { conn, tables } = req.body as { conn?: ExplorerConn; tables?: TableRef[] };
  if (!conn?.type || !conn.host || !conn.username || !Array.isArray(tables) || tables.length === 0) {
    return res.status(400).json({ error: 'conn and tables are required' });
  }
  if (tables.length > MAX_TABLES_PER_REQUEST) {
    return res.status(400).json({ error: `A maximum of ${MAX_TABLES_PER_REQUEST} tables may be inspected per request` });
  }
  const requested = [...new Map(tables.map(table => [tableKey(table.schema, table.table), table])).values()];

  try {
    if (conn.type === 'postgresql') {
      const columnsByTable = await withPg(conn, async client => {
        const params = requested.flatMap(table => [table.schema, table.table]);
        const tuples = requested.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2})`).join(', ');
        const { rows: columns } = await client.query<any>(`
          SELECT c.table_schema, c.table_name, c.column_name, c.udt_name, c.data_type,
            c.character_maximum_length, c.numeric_precision, c.numeric_scale,
            c.is_nullable, c.column_default
          FROM information_schema.columns c
          WHERE (c.table_schema, c.table_name) IN (${tuples})
          ORDER BY c.table_schema, c.table_name, c.ordinal_position
        `, params);
        const { rows: constraints } = await client.query<any>(`
          SELECT tc.table_schema, tc.table_name, kcu.column_name, tc.constraint_type
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
          WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
            AND (tc.table_schema, tc.table_name) IN (${tuples})
        `, params);
        const { rows: foreignKeys } = await client.query<any>(`
          SELECT kcu.table_schema, kcu.table_name, kcu.column_name,
            ccu.table_schema AS to_schema, ccu.table_name AS to_table, ccu.column_name AS to_col
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
          JOIN information_schema.key_column_usage ccu
            ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = rc.unique_constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND (tc.table_schema, tc.table_name) IN (${tuples})
        `, params);
        const flags = new Map<string, Set<string>>();
        for (const constraint of constraints) {
          const key = `${constraint.table_schema}.${constraint.table_name}.${constraint.column_name}`;
          const set = flags.get(key) ?? new Set<string>();
          set.add(constraint.constraint_type);
          flags.set(key, set);
        }
        const fkMap = new Map(foreignKeys.map(row => [
          `${row.table_schema}.${row.table_name}.${row.column_name}`,
          `${row.to_schema}.${row.to_table}.${row.to_col}`,
        ]));
        const result: Record<string, MigColumnInfo[]> = Object.fromEntries(requested.map(table => [tableKey(table.schema, table.table), []]));
        for (const column of columns) {
          let rawType = column.udt_name;
          if (column.character_maximum_length) rawType += `(${column.character_maximum_length})`;
          else if (column.numeric_precision && ['numeric', 'decimal'].includes(column.data_type)) rawType += `(${column.numeric_precision},${column.numeric_scale ?? 0})`;
          const columnKey = `${column.table_schema}.${column.table_name}.${column.column_name}`;
          const columnFlags = flags.get(columnKey) ?? new Set<string>();
          const fkRef = fkMap.get(columnKey) ?? null;
          result[tableKey(column.table_schema, column.table_name)].push({
            name: column.column_name,
            rawType,
            nullable: column.is_nullable === 'YES',
            defaultValue: column.column_default ?? null,
            isPk: columnFlags.has('PRIMARY KEY'),
            isUnique: columnFlags.has('UNIQUE'),
            isFk: fkRef !== null,
            fkRef,
            isAutoIncrement: (column.column_default ?? '').includes('nextval'),
          });
        }
        return result;
      });
      return res.status(200).json({ columnsByTable });
    }

    const columnsByTable = await withMysql(conn, async client => {
      const tupleSql = requested.map(() => '(?, ?)').join(', ');
      const params = requested.flatMap(table => [table.schema, table.table]);
      const [columns] = await client.query<any[]>(`
        SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
          COLUMN_DEFAULT, COLUMN_KEY, EXTRA
        FROM information_schema.COLUMNS
        WHERE (TABLE_SCHEMA, TABLE_NAME) IN (${tupleSql})
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
      `, params);
      const [foreignKeys] = await client.query<any[]>(`
        SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME,
          REFERENCED_TABLE_SCHEMA AS to_schema, REFERENCED_TABLE_NAME AS to_table,
          REFERENCED_COLUMN_NAME AS to_col
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_NAME IS NOT NULL
          AND (TABLE_SCHEMA, TABLE_NAME) IN (${tupleSql})
      `, params);
      const fkMap = new Map((foreignKeys as any[]).map(row => [
        `${row.TABLE_SCHEMA}.${row.TABLE_NAME}.${row.COLUMN_NAME}`,
        `${row.to_schema}.${row.to_table}.${row.to_col}`,
      ]));
      const result: Record<string, MigColumnInfo[]> = Object.fromEntries(requested.map(table => [tableKey(table.schema, table.table), []]));
      for (const column of columns as any[]) {
        const columnKey = `${column.TABLE_SCHEMA}.${column.TABLE_NAME}.${column.COLUMN_NAME}`;
        const fkRef = fkMap.get(columnKey) ?? null;
        result[tableKey(column.TABLE_SCHEMA, column.TABLE_NAME)].push({
          name: column.COLUMN_NAME,
          rawType: column.COLUMN_TYPE,
          nullable: column.IS_NULLABLE === 'YES',
          defaultValue: column.COLUMN_DEFAULT ?? null,
          isPk: column.COLUMN_KEY === 'PRI',
          isUnique: column.COLUMN_KEY === 'UNI',
          isFk: fkRef !== null,
          fkRef,
          isAutoIncrement: (column.EXTRA ?? '').includes('auto_increment'),
        });
      }
      return result;
    });
    return res.status(200).json({ columnsByTable });
  } catch (error) {
    return res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
      inspectedTables: requested.map(table => tableKey(table.schema, table.table)),
    });
  }
}
