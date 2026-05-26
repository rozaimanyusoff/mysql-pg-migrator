import type { NextApiRequest, NextApiResponse } from 'next';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import { verifyAccessToken } from '../../../lib/auth-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { type, host, port, username, password, newDatabase } = req.body as {
    type: 'postgresql' | 'mysql';
    host: string; port: number;
    username: string; password: string;
    newDatabase: string;
  };

  if (!newDatabase?.trim()) return res.status(400).json({ error: 'newDatabase required' });
  if (!/^[a-zA-Z0-9_-]+$/.test(newDatabase.trim())) {
    return res.status(400).json({ error: 'Invalid database name (alphanumeric, _ and - only)' });
  }

  const dbName = newDatabase.trim();

  try {
    if (type === 'postgresql') {
      // CREATE DATABASE must run outside a transaction — connect to 'postgres' db
      const c = new PgClient({
        host, port: Number(port), user: username, password,
        database: 'postgres',
        connectionTimeoutMillis: 10_000,
      });
      await c.connect();
      try {
        await c.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await c.end();
      }
    } else {
      const c = await mysql.createConnection({
        host, port: Number(port), user: username, password,
        connectTimeout: 10_000, multipleStatements: false,
      });
      try {
        await c.query(`CREATE DATABASE \`${dbName}\``);
      } finally {
        await c.end();
      }
    }
    return res.status(200).json({ ok: true, database: dbName });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
