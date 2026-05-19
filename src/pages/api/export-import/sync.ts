import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { verifyAccessToken } from '../../../lib/auth-store';
import { exportDatabase, ConnCfg, ExportInclude, ConflictStrategy } from '../../../lib/sql-exporter';

interface SyncLog { step: string; ok: boolean; text: string }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  if (!token || !verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { source, target, tables, include, conflict } = req.body as {
    source?: ConnCfg; target?: ConnCfg;
    tables?: string[] | 'all'; include?: ExportInclude;
    conflict?: ConflictStrategy;
  };

  if (!source?.host || !source?.user || !source?.database)
    return res.status(400).json({ error: 'source cfg required' });
  if (!target?.host || !target?.user || !target?.database)
    return res.status(400).json({ error: 'target cfg required' });
  if (source.db_type !== target.db_type)
    return res.status(400).json({ error: 'Cross-DB sync (MySQL↔PostgreSQL) is not supported in this module. Use the Migration module instead.' });

  const strategy: ConflictStrategy = conflict ?? 'insert_only';
  const log: SyncLog[] = [];

  try {
    // Step 1: Export from source (with conflict strategy embedded in SQL)
    log.push({ step: 'export', ok: true, text: `[START] Exporting from source "${source.database}" (${source.db_type})…` });
    const exported = await exportDatabase(source, tables ?? 'all', include ?? 'both', { conflictStrategy: strategy });
    log.push({ step: 'export', ok: true, text: `[OK] Exported ${exported.tables.length} table(s), ${exported.sql.length} bytes` });

    // Step 2: Import into target
    const strategyLabel = strategy === 'insert_only' ? 'INSERT only' : strategy === 'truncate_insert' ? 'TRUNCATE + INSERT' : 'UPSERT';
    log.push({ step: 'import', ok: true, text: `[START] Importing into target "${target.database}" (${target.db_type}) — strategy: ${strategyLabel}…` });

    if (target.db_type === 'postgres') {
      const pool = new Pool({
        host: target.host, port: target.port ?? 5432, user: target.user,
        password: target.password, database: target.database,
        ssl: target.ssl ? { rejectUnauthorized: false } : false,
        connectionTimeoutMillis: 15000,
      });
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(exported.sql);
        await client.query('COMMIT');
        log.push({ step: 'import', ok: true, text: `[OK] Committed to "${target.database}"` });
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);
        log.push({ step: 'import', ok: false, text: `[FAIL] ${message}` });
        log.push({ step: 'import', ok: false, text: '[ROLLBACK] Target rolled back — no changes applied.' });
        return res.status(500).json({ success: false, log });
      } finally { client.release(); await pool.end(); }
    } else {
      const conn = await mysql.createConnection({
        host: target.host, port: target.port ?? 3306, user: target.user,
        password: target.password, database: target.database,
        multipleStatements: true,
      });
      try {
        await conn.beginTransaction();
        await conn.execute(exported.sql);
        await conn.commit();
        log.push({ step: 'import', ok: true, text: `[OK] Committed to "${target.database}"` });
      } catch (err: unknown) {
        await conn.rollback();
        const message = err instanceof Error ? err.message : String(err);
        log.push({ step: 'import', ok: false, text: `[FAIL] ${message}` });
        log.push({ step: 'import', ok: false, text: '[ROLLBACK] Target rolled back — no changes applied.' });
        return res.status(500).json({ success: false, log });
      } finally { await conn.end(); }
    }

    log.push({ step: 'sync', ok: true, text: `[DONE] Sync completed — ${exported.tables.length} table(s) synced.` });
    return res.status(200).json({ success: true, log, tables: exported.tables });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.push({ step: 'sync', ok: false, text: `[ERROR] ${message}` });
    return res.status(500).json({ success: false, log });
  }
}
