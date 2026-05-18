import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { logApiActivity } from '../../lib/audit-api';

interface PgDatabaseRequest {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  ssl?: boolean;
  maintenanceDb?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_pg_databases_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body as PgDatabaseRequest;
  if (!body?.host || !body?.user) {
    await logApiActivity(req, 'api_pg_databases_bad_request', 'warn');
    return res.status(400).json({ error: 'host and user are required' });
  }

  const database = (body.maintenanceDb || 'postgres').trim() || 'postgres';
  const pool = new Pool({
    host: body.host,
    port: Number(body.port) || 5432,
    user: body.user,
    password: body.password || '',
    database,
    ssl: body.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 8000,
  });

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(`
      SELECT datname
      FROM pg_database
      WHERE datistemplate = false
        AND datallowconn = true
      ORDER BY datname
    `);
    const databases = result.rows.map((r: { datname: string }) => r.datname);
    await logApiActivity(req, 'api_pg_databases_success', 'info', { count: databases.length });
    return res.status(200).json({ databases });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_pg_databases_error', 'error', { message });
    return res.status(400).json({ error: message });
  } finally {
    client?.release();
    await pool.end();
  }
}
