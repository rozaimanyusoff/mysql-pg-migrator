import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { ConnCfg } from '../../../lib/sql-exporter';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });


  const { cfg, sql } = req.body as { cfg?: ConnCfg; sql?: string };
  if (!cfg?.host || !cfg?.user || !cfg?.database || !cfg?.db_type)
    return res.status(400).json({ error: 'cfg (db_type, host, user, database) required' });
  if (!sql?.trim()) return res.status(400).json({ error: 'sql is required' });

  try {
    if (cfg.db_type === 'postgres') {
      const pool = new Pool({
        host: cfg.host, port: cfg.port ?? 5432, user: cfg.user,
        password: cfg.password, database: cfg.database,
        ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 15000,
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('COMMIT');
        return res.status(200).json({ success: true, log: [`[OK] SQL imported and committed to "${cfg.database}"`] });
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({
          success: false, rolledBack: true,
          log: [
            `[FAIL] Import failed on "${cfg.database}"`,
            '[ROLLBACK] Transaction rolled back — database state is unchanged.',
            `[ERROR] ${message}`,
          ],
        });
      } finally { client.release(); await pool.end(); }
    } else {
      // MySQL — multipleStatements required for SQL dumps
      const conn = await mysql.createConnection({
        host: cfg.host, port: cfg.port ?? 3306, user: cfg.user,
        password: cfg.password, database: cfg.database,
        multipleStatements: true,
      });
      try {
        await conn.beginTransaction();
        await conn.execute(sql);
        await conn.commit();
        return res.status(200).json({ success: true, log: [`[OK] SQL imported and committed to "${cfg.database}"`] });
      } catch (err: unknown) {
        await conn.rollback();
        const message = err instanceof Error ? err.message : String(err);
        return res.status(500).json({
          success: false, rolledBack: true,
          log: [
            `[FAIL] Import failed on "${cfg.database}"`,
            '[ROLLBACK] Transaction rolled back — database state is unchanged.',
            `[ERROR] ${message}`,
          ],
        });
      } finally { await conn.end(); }
    }
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
