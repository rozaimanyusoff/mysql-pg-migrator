import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { PgConnectionConfig } from '../../lib/types';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   if (req.method !== 'POST') {
      await logApiActivity(req, 'api_pg_schemas_method_not_allowed', 'warn');
      return res.status(405).json({ error: 'Method not allowed' });
   }

   const pgConfig = req.body as PgConnectionConfig;
   if (!pgConfig?.host || !pgConfig?.database) {
      await logApiActivity(req, 'api_pg_schemas_bad_request', 'warn');
      return res.status(400).json({ error: 'host and database are required' });
   }

   const pool = new Pool({
      host: pgConfig.host,
      port: pgConfig.port ?? 5432,
      user: pgConfig.user,
      password: pgConfig.password,
      database: pgConfig.database,
      ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 8000,
   });

   let client;
   try {
      client = await pool.connect();
      const result = await client.query(`
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND schema_name NOT LIKE 'pg_temp_%'
        AND schema_name NOT LIKE 'pg_toast_temp_%'
      ORDER BY schema_name
    `);
      const schemas = result.rows.map((r: { schema_name: string }) => r.schema_name);
      await logApiActivity(req, 'api_pg_schemas_success', 'info', { database: pgConfig.database, count: schemas.length });
      return res.status(200).json({ schemas });
   } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await logApiActivity(req, 'api_pg_schemas_error', 'error', { database: pgConfig.database, message: msg });
      return res.status(400).json({ error: msg });
   } finally {
      client?.release();
      await pool.end();
   }
}
