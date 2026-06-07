import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { exportDatabase, ConnCfg, ExportInclude } from '../../../lib/sql-exporter';

interface ReplaceLog { step: string; ok: boolean; text: string }

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { source, target, tables, include } = req.body as {
    source?: ConnCfg; target?: ConnCfg;
    tables?: string[] | 'all'; include?: ExportInclude;
  };

  if (!source?.host || !source?.user || !source?.database)
    return res.status(400).json({ error: 'source cfg required' });
  if (!target?.host || !target?.user || !target?.database)
    return res.status(400).json({ error: 'target cfg required' });
  if (source.db_type !== target.db_type)
    return res.status(400).json({ error: 'Cross-DB replace not supported. Use the Migration module instead.' });

  const log: ReplaceLog[] = [];
  const singleTable = Array.isArray(tables) && tables.length === 1 ? tables[0] : null;

  try {
    // Step 1: Export schema + data from source
    log.push({ step: 'export', ok: true, text: `[START] Exporting "${singleTable ?? 'all tables'}" from source "${source.database}"…` });
    const exported = await exportDatabase(source, tables ?? 'all', include ?? 'both', { conflictStrategy: 'insert_only' });
    log.push({ step: 'export', ok: true, text: `[OK] Exported ${exported.tables.length} table(s), ${exported.sql.length} bytes` });

    // Step 2: Drop + recreate on target
    const tablesToDrop = exported.tables;
    log.push({ step: 'replace', ok: true, text: `[START] Dropping and recreating ${tablesToDrop.length} table(s) in "${target.database}"…` });

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
        let fkBypassed = false;
        try { await client.query("SET session_replication_role = replica"); fkBypassed = true; } catch {}
        log.push({ step: 'replace', ok: true, text: fkBypassed
          ? '[INFO] FK checks disabled (session_replication_role = replica)'
          : '[WARN] Could not disable FK checks — CASCADE will still handle referencing constraints'
        });

        for (const t of tablesToDrop) {
          await client.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
          log.push({ step: 'drop', ok: true, text: `[DROP] "${t}"` });
        }

        await client.query(exported.sql);
        await client.query('COMMIT');
        log.push({ step: 'replace', ok: true, text: `[OK] ${tablesToDrop.length} table(s) replaced in "${target.database}"` });

        if (singleTable) {
          const { rows } = await client.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM "${singleTable}"`);
          const count = parseInt(rows[0]?.c ?? '0', 10);
          log.push({ step: 'verify', ok: true, text: `[VERIFY] "${singleTable}" — target now has ${count} rows` });
        }
      } catch (err: unknown) {
        await client.query('ROLLBACK');
        const message = err instanceof Error ? err.message : String(err);
        log.push({ step: 'replace', ok: false, text: `[FAIL] ${message}` });
        log.push({ step: 'replace', ok: false, text: '[ROLLBACK] Target rolled back — no changes applied.' });
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
        await conn.execute('SET FOREIGN_KEY_CHECKS=0');
        for (const t of tablesToDrop) {
          await conn.execute(`DROP TABLE IF EXISTS \`${t}\``);
          log.push({ step: 'drop', ok: true, text: `[DROP] "${t}"` });
        }
        await conn.execute(exported.sql);
        await conn.execute('SET FOREIGN_KEY_CHECKS=1');
        await conn.commit();
        log.push({ step: 'replace', ok: true, text: `[OK] ${tablesToDrop.length} table(s) replaced in "${target.database}"` });

        if (singleTable) {
          const [rows] = await conn.execute<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS c FROM \`${singleTable}\``);
          const count = Number((rows as mysql.RowDataPacket[])[0]?.c ?? 0);
          log.push({ step: 'verify', ok: true, text: `[VERIFY] "${singleTable}" — target now has ${count} rows` });
        }
      } catch (err: unknown) {
        await conn.rollback();
        const message = err instanceof Error ? err.message : String(err);
        log.push({ step: 'replace', ok: false, text: `[FAIL] ${message}` });
        log.push({ step: 'replace', ok: false, text: '[ROLLBACK] Target rolled back — no changes applied.' });
        return res.status(500).json({ success: false, log });
      } finally { await conn.end(); }
    }

    log.push({ step: 'replace', ok: true, text: `[DONE] Replace completed — ${exported.tables.length} table(s).` });
    return res.status(200).json({ success: true, log, tables: exported.tables });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.push({ step: 'replace', ok: false, text: `[ERROR] ${message}` });
    return res.status(500).json({ success: false, log });
  }
}
