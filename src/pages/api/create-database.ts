import type { NextApiRequest, NextApiResponse } from 'next';
import { Client } from 'pg';
import mysql from 'mysql2/promise';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });


  const { db_type, host, port, user, password, ssl, dbName } = req.body as {
    db_type?: string; host?: string; port?: number;
    user?: string; password?: string; ssl?: boolean; dbName?: string;
  };

  if (!host || !user || !dbName || !db_type)
    return res.status(400).json({ error: 'db_type, host, user, dbName are required' });

  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dbName))
    return res.status(400).json({ error: 'Invalid database name — letters, digits, and underscores only' });

  try {
    if (db_type === 'postgres') {
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
      } finally { await client.end().catch(() => {}); }
    } else {
      const conn = await mysql.createConnection({
        host, port: Number(port) || 3306, user, password: password ?? '',
        multipleStatements: false,
      });
      try {
        await conn.execute(`CREATE DATABASE \`${dbName}\``);
      } finally { await conn.end(); }
    }

    await logApiActivity(req, 'create_database_success', 'info', { db_type, dbName });
    return res.status(200).json({ success: true, message: `Database "${dbName}" created` });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'create_database_error', 'error', { db_type, dbName, message });
    return res.status(400).json({ error: message });
  }
}
