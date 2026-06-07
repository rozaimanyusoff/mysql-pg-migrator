import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { exportDatabase, ConnCfg, ExportInclude, ConflictStrategy } from '../../../lib/sql-exporter';

interface SyncLog { step: string; ok: boolean; text: string }

async function countRowsPg(cfg: ConnCfg, table: string): Promise<number | null> {
  const pool = new Pool({
    host: cfg.host, port: cfg.port ?? 5432, user: cfg.user,
    password: cfg.password, database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
  });
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM "${table}"`);
    return parseInt(rows[0]?.c ?? '0', 10);
  } catch { return null; }
  finally { client.release(); await pool.end(); }
}

async function countRowsMysql(cfg: ConnCfg, table: string): Promise<number | null> {
  try {
    const conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port ?? 3306, user: cfg.user,
      password: cfg.password, database: cfg.database,
    });
    try {
      const [rows] = await conn.execute<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`${table}\``);
      return Number((rows as mysql.RowDataPacket[])[0]?.c ?? 0);
    } finally { await conn.end(); }
  } catch { return null; }
}

async function countRows(cfg: ConnCfg, table: string): Promise<number | null> {
  return cfg.db_type === 'postgres' ? countRowsPg(cfg, table) : countRowsMysql(cfg, table);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });


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
  const singleTable = Array.isArray(tables) && tables.length === 1 ? tables[0] : null;

  try {
    // Step 0: Diff — compare source vs target row counts before sync
    if (singleTable) {
      const [srcCount, tgtCount] = await Promise.all([
        countRows(source, singleTable),
        countRows(target, singleTable),
      ]);
      const srcStr = srcCount === null ? 'unknown' : `${srcCount} rows`;
      const tgtStr = tgtCount === null ? 'table does not exist yet' : `${tgtCount} rows`;
      const deltaStr = srcCount !== null && tgtCount !== null
        ? ` | Δ ${srcCount - tgtCount} rows to sync`
        : '';
      log.push({ step: 'diff', ok: true, text: `[DIFF] "${singleTable}" — source: ${srcStr} | target: ${tgtStr}${deltaStr}` });
    }

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
        // Disable FK constraint triggers for this session so tables can be synced
        // independently of FK dependency order. Resets when the connection is released.
        let fkBypassed = false;
        try {
          await client.query("SET session_replication_role = replica");
          fkBypassed = true;
        } catch { /* proceed without FK bypass if no replication privilege */ }
        log.push({ step: 'import', ok: true, text: fkBypassed
          ? '[INFO] FK checks disabled for this session (session_replication_role = replica)'
          : '[WARN] Could not disable FK checks — sync may fail if FK deps not satisfied'
        });
        await client.query(exported.sql);
        await client.query('COMMIT');
        log.push({ step: 'import', ok: true, text: `[OK] Committed to "${target.database}"` });
        if (singleTable) {
          const tgtCountAfter = await countRows(target, singleTable);
          if (tgtCountAfter !== null)
            log.push({ step: 'verify', ok: true, text: `[VERIFY] "${singleTable}" — target now has ${tgtCountAfter} rows` });
        }
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
        if (singleTable) {
          const tgtCountAfter = await countRows(target, singleTable);
          if (tgtCountAfter !== null)
            log.push({ step: 'verify', ok: true, text: `[VERIFY] "${singleTable}" — target now has ${tgtCountAfter} rows` });
        }
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
