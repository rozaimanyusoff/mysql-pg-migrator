import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import mysql from 'mysql2/promise';
import { ConnCfg } from '../../../lib/sql-exporter';

export interface AnalyseRow {
  name: string;
  sourceRows: number | null;  // null = table missing in source
  targetRows: number | null;  // null = table missing in target
  owner?: string;             // PG table owner (source)
  status: 'match' | 'diff' | 'source_only' | 'target_only';
}

export interface AnalyseResult {
  sourceSchema: string;
  targetSchema: string;
  rows: AnalyseRow[];
  sourceTotal: number;
  targetTotal: number;
}

interface TableMeta { name: string; rowCount: number; owner?: string }

async function pgTables(cfg: ConnCfg, schema: string): Promise<TableMeta[]> {
  const pool = new Pool({
    host: cfg.host, port: cfg.port ?? 5432, user: cfg.user,
    password: cfg.password, database: cfg.database,
    ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 12000,
  });
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ table_name: string; tableowner: string }>(
      `SELECT t.table_name, pg_catalog.pg_get_userbyid(c.relowner) AS tableowner
       FROM information_schema.tables t
       JOIN pg_class c ON c.relname = t.table_name
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.table_schema
       WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE'
       ORDER BY t.table_name`,
      [schema || 'public'],
    );
    const counts = await Promise.all(rows.map(async (r) => {
      const { rows: cr } = await client.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM "${schema || 'public'}"."${r.table_name}"`,
      );
      return { name: r.table_name, rowCount: parseInt(cr[0]?.c ?? '0', 10), owner: r.tableowner };
    }));
    return counts;
  } finally { client.release(); await pool.end(); }
}

async function myTables(cfg: ConnCfg): Promise<TableMeta[]> {
  const conn = await mysql.createConnection({
    host: cfg.host, port: cfg.port ?? 3306, user: cfg.user,
    password: cfg.password, database: cfg.database,
  });
  try {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [cfg.database],
    );
    return rows.map(r => ({ name: r.TABLE_NAME as string, rowCount: Number(r.TABLE_ROWS ?? 0) }));
  } finally { await conn.end(); }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { source, target, sourceSchema, targetSchema } = req.body as {
    source?: ConnCfg; target?: ConnCfg;
    sourceSchema?: string; targetSchema?: string;
  };

  if (!source?.host || !source?.user || !source?.database)
    return res.status(400).json({ error: 'source cfg required' });
  if (!target?.host || !target?.user || !target?.database)
    return res.status(400).json({ error: 'target cfg required' });

  try {
    const [srcTables, tgtTables] = await Promise.all([
      source.db_type === 'postgres' ? pgTables(source, sourceSchema ?? 'public') : myTables(source),
      target.db_type === 'postgres' ? pgTables(target, targetSchema ?? 'public') : myTables(target),
    ]);

    const srcMap = new Map(srcTables.map(t => [t.name, t]));
    const tgtMap = new Map(tgtTables.map(t => [t.name, t]));
    const allNames = [...new Set([...srcMap.keys(), ...tgtMap.keys()])].sort();

    const rows: AnalyseRow[] = allNames.map(name => {
      const src = srcMap.get(name);
      const tgt = tgtMap.get(name);
      let status: AnalyseRow['status'];
      if (!src)       status = 'target_only';
      else if (!tgt)  status = 'source_only';
      else            status = src.rowCount === tgt.rowCount ? 'match' : 'diff';
      return {
        name,
        sourceRows: src?.rowCount ?? null,
        targetRows: tgt?.rowCount ?? null,
        owner: src?.owner,
        status,
      };
    });

    const result: AnalyseResult = {
      sourceSchema: sourceSchema ?? 'public',
      targetSchema: targetSchema ?? 'public',
      rows,
      sourceTotal: srcTables.length,
      targetTotal: tgtTables.length,
    };
    return res.status(200).json(result);
  } catch (err: unknown) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
