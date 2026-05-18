import type { NextApiRequest, NextApiResponse } from 'next';
import { Client } from 'pg';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { host, port, user, password, ssl, dbName } = req.body as {
    host?: string; port?: number; user?: string; password?: string; ssl?: boolean; dbName?: string;
  };

  if (!host || !user || !dbName) return res.status(400).json({ error: 'host, user, dbName are required' });
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName))
    return res.status(400).json({ error: 'Invalid database name — use letters, digits, and underscores only' });

  // CREATE DATABASE must run outside a transaction — use Client, not Pool
  const client = new Client({
    host, port: Number(port) || 5432, user, password: password ?? '',
    database: 'postgres',
    ssl: ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
  });

  try {
    await client.connect();
    await client.query(`CREATE DATABASE "${dbName}"`);
    await logApiActivity(req, 'api_pg_create_db_success', 'info', { dbName });
    return res.status(200).json({ success: true, message: `Database "${dbName}" created` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_pg_create_db_error', 'error', { dbName, message });
    return res.status(400).json({ error: message });
  } finally {
    await client.end().catch(() => {});
  }
}
