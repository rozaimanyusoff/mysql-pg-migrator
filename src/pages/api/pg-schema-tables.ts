import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { logApiActivity } from '../../lib/audit-api';

interface PgSchemaTablesRequest {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  ssl?: boolean;
  database?: string;
}

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

interface PkRow {
  table_schema: string;
  table_name: string;
  column_name: string;
}

interface FkRow {
  child_schema: string;
  child_table: string;
  child_column: string;
  parent_schema: string;
  parent_table: string;
  parent_column: string;
  constraint_name: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_pg_schema_tables_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as PgSchemaTablesRequest;
  if (!body?.host || !body?.user || !body?.database) {
    await logApiActivity(req, 'api_pg_schema_tables_bad_request', 'warn');
    return res.status(400).json({ error: 'host, user, and database are required' });
  }

  const pool = new Pool({
    host: body.host,
    port: Number(body.port) || 5432,
    user: body.user,
    password: body.password || '',
    database: body.database,
    ssl: body.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
  });

  let client;
  try {
    client = await pool.connect();

    const [columnsResult, pkResult, fkResult] = await Promise.all([
      client.query<ColumnRow>(`
        SELECT c.table_schema, c.table_name, c.column_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema
         AND t.table_name = c.table_name
        WHERE t.table_type = 'BASE TABLE'
          AND c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND c.table_schema NOT LIKE 'pg_temp_%'
          AND c.table_schema NOT LIKE 'pg_toast_temp_%'
        ORDER BY c.table_schema, c.table_name, c.ordinal_position
      `),
      client.query<PkRow>(`
        SELECT kcu.table_schema, kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
         AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND tc.table_schema NOT LIKE 'pg_temp_%'
          AND tc.table_schema NOT LIKE 'pg_toast_temp_%'
        ORDER BY kcu.table_schema, kcu.table_name, kcu.ordinal_position
      `),
      client.query<FkRow>(`
        SELECT
          tc.table_schema AS child_schema,
          tc.table_name AS child_table,
          kcu.column_name AS child_column,
          ccu.table_schema AS parent_schema,
          ccu.table_name AS parent_table,
          ccu.column_name AS parent_column,
          tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name
         AND ccu.constraint_schema = tc.constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND tc.table_schema NOT LIKE 'pg_temp_%'
          AND tc.table_schema NOT LIKE 'pg_toast_temp_%'
        ORDER BY tc.table_schema, tc.table_name, tc.constraint_name, kcu.ordinal_position
      `),
    ]);

    const tableMap = new Map<
      string,
      { schema: string; name: string; columns: string[]; primaryKeys: string[] }
    >();

    for (const row of columnsResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const current = tableMap.get(key);
      if (current) {
        current.columns.push(row.column_name);
      } else {
        tableMap.set(key, {
          schema: row.table_schema,
          name: row.table_name,
          columns: [row.column_name],
          primaryKeys: [],
        });
      }
    }

    for (const row of pkResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const current = tableMap.get(key);
      if (current && !current.primaryKeys.includes(row.column_name)) {
        current.primaryKeys.push(row.column_name);
      }
    }

    const tables = [...tableMap.values()];
    const schemaMap = new Map<string, typeof tables>();
    for (const table of tables) {
      const list = schemaMap.get(table.schema) ?? [];
      list.push(table);
      schemaMap.set(table.schema, list);
    }

    const schemas = [...schemaMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, entries]) => ({
        name,
        tableCount: entries.length,
        tables: entries.sort((a, b) => a.name.localeCompare(b.name)),
      }));

    await logApiActivity(req, 'api_pg_schema_tables_success', 'info', {
      database: body.database,
      schemas: schemas.length,
      tables: tables.length,
      relationships: fkResult.rows.length,
    });

    return res.status(200).json({
      schemas,
      relationships: fkResult.rows,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_pg_schema_tables_error', 'error', {
      database: body.database,
      message,
    });
    return res.status(400).json({ error: message });
  } finally {
    client?.release();
    await pool.end();
  }
}
