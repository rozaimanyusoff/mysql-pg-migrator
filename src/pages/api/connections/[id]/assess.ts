import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../../lib/db';
import { inspectDatabaseCapability } from '../../../../lib/migv2/server-capabilities';
import type { MigConn } from '../../../../lib/migv2/types';

interface SavedConnection {
  db_type: 'mysql' | 'postgres';
  host: string;
  port: number;
  username: string;
  password_enc: string | null;
  database_name: string;
  ssl_enabled: boolean;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid connection id' });
  const { rows } = await getPool().query<SavedConnection>(
    `SELECT db_type, host, port, username, password_enc, database_name, ssl_enabled
       FROM dbt_connections WHERE id = $1`, [id]
  );
  const saved = rows[0];
  if (!saved) return res.status(404).json({ error: 'Connection not found' });
  const conn: MigConn = {
    type: saved.db_type === 'postgres' ? 'postgresql' : 'mysql',
    host: saved.host,
    port: saved.port,
    username: saved.username,
    password: saved.password_enc ?? '',
    database: saved.database_name,
    ssl: saved.ssl_enabled,
  };
  const capability = await inspectDatabaseCapability(conn);
  res.setHeader('Cache-Control', 'no-store');
  return res.status(capability.error ? 422 : 200).json({ capability, assessedAt: new Date().toISOString() });
}
