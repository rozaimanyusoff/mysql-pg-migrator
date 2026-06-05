import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool, type PoolClient } from 'pg';
import mysql from 'mysql2/promise';

interface SourceCfg {
  db_type: 'postgres' | 'mysql';
  host: string; port: number; user: string; password: string;
  database: string; ssl?: boolean;
  schema: string;
}
interface TargetCfg {
  db_type: 'postgres' | 'mysql';
  host: string; port: number; user: string; password: string;
  database: string; ssl?: boolean;
  schema?: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { source, target, mode, include } = req.body as {
    source: SourceCfg;
    target: TargetCfg;
    mode: 'copy' | 'move';
    include: 'both' | 'schema' | 'data';
  };

  if (!source?.host || !target?.host) return res.status(400).json({ error: 'source and target required' });

  if (source.db_type !== target.db_type) {
    return res.status(400).json({
      success: false,
      log: ['[ERROR] Cross-type transfer (MySQL ↔ PostgreSQL) is not supported. Use the Migration module instead.'],
    });
  }

  const log: string[] = [];
  try {
    if (source.db_type === 'postgres') {
      await transferPostgres(source, target, mode, include, log);
    } else {
      await transferMySQL(source, target, mode, include, log);
    }
    return res.status(200).json({ success: true, log });
  } catch (err: unknown) {
    log.push(`[ERROR] ${err instanceof Error ? err.message : String(err)}`);
    return res.status(500).json({ success: false, log });
  }
}

// ── PostgreSQL ─────────────────────────────────────────────────────────────────

async function transferPostgres(
  source: SourceCfg, target: TargetCfg,
  mode: 'copy' | 'move', include: 'both' | 'schema' | 'data',
  log: string[],
) {
  const srcSchema = source.schema;
  const tgtSchema = target.schema ?? source.schema;

  const srcPool = new Pool({
    host: source.host, port: source.port ?? 5432,
    user: source.user, password: source.password, database: source.database,
    ssl: source.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
  });
  const tgtPool = new Pool({
    host: target.host, port: target.port ?? 5432,
    user: target.user, password: target.password, database: target.database,
    ssl: target.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
  });

  const srcClient = await srcPool.connect();
  const tgtClient = await tgtPool.connect();
  try {
    // List tables
    const { rows: tableRows } = await srcClient.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [srcSchema],
    );
    const tableNames = tableRows.map(r => r.table_name);
    log.push(`[INFO] Found ${tableNames.length} table(s) in schema "${srcSchema}"`);
    if (tableNames.length === 0) { log.push(`[WARN] No tables found — nothing to transfer`); return; }

    // Build SQL
    const parts: string[] = [
      `-- Transfer: "${source.database}"."${srcSchema}" → "${target.database}"."${tgtSchema}"\n`,
      `-- Generated: ${new Date().toISOString()}\n\n`,
      `SET client_min_messages TO WARNING;\n`,
      `CREATE SCHEMA IF NOT EXISTS "${tgtSchema}";\n\n`,
    ];

    for (const t of tableNames) {
      log.push(`[INFO] Processing "${srcSchema}"."${t}"…`);
      if (include !== 'data') parts.push(await pgTableDdl(srcClient, srcSchema, t, tgtSchema));
      if (include !== 'schema') parts.push(await pgTableData(srcClient, srcSchema, t, tgtSchema));
    }

    // Import into target
    await tgtClient.query('BEGIN');
    try {
      await tgtClient.query(parts.join(''));
      await tgtClient.query('COMMIT');
      log.push(`[OK] Transferred ${tableNames.length} table(s) to "${target.database}"."${tgtSchema}"`);
    } catch (err) {
      await tgtClient.query('ROLLBACK');
      throw err;
    }

    // Move: drop source schema
    if (mode === 'move') {
      log.push(`[INFO] Dropping source schema "${srcSchema}"…`);
      await srcClient.query(`DROP SCHEMA "${srcSchema}" CASCADE`);
      log.push(`[OK] Source schema "${srcSchema}" dropped`);
    }
  } finally {
    srcClient.release(); tgtClient.release();
    await srcPool.end().catch(() => {}); await tgtPool.end().catch(() => {});
  }
}

async function pgTableDdl(client: PoolClient, srcSchema: string, table: string, tgtSchema: string): Promise<string> {
  const { rows: cols } = await client.query<{
    column_name: string; data_type: string; udt_name: string;
    character_maximum_length: number | null; numeric_precision: number | null;
    numeric_scale: number | null; is_nullable: string; column_default: string | null;
  }>(
    `SELECT column_name, data_type, udt_name, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
    [srcSchema, table],
  );

  const { rows: pkCols } = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = $2
     ORDER BY kcu.ordinal_position`,
    [table, srcSchema],
  );

  const { rows: idxs } = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = $1 AND schemaname = $2
       AND indexname NOT IN (
         SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_name = $1 AND table_schema = $2)`,
    [table, srcSchema],
  );

  const colDefs = cols.map(c => {
    let type = c.data_type === 'USER-DEFINED' ? c.udt_name : c.data_type;
    if (c.character_maximum_length) type += `(${c.character_maximum_length})`;
    else if (c.numeric_precision != null && c.data_type === 'numeric')
      type += `(${c.numeric_precision},${c.numeric_scale ?? 0})`;
    let def = `  "${c.column_name}" ${type}`;
    if (c.column_default != null) def += ` DEFAULT ${c.column_default}`;
    if (c.is_nullable === 'NO') def += ' NOT NULL';
    return def;
  });
  if (pkCols.length > 0)
    colDefs.push(`  PRIMARY KEY (${pkCols.map(r => `"${r.column_name}"`).join(', ')})`);

  let sql = `CREATE TABLE IF NOT EXISTS "${tgtSchema}"."${table}" (\n${colDefs.join(',\n')}\n);\n`;
  for (const idx of idxs) {
    const fixedDef = idx.indexdef.replace(
      new RegExp(`\\bON\\s+(?:"?${srcSchema}"?\\.)?(?:"?${table}"?)`, 'i'),
      `ON "${tgtSchema}"."${table}"`,
    );
    sql += `${fixedDef.replace(idx.indexname, `${idx.indexname}_${tgtSchema}`)};\n`;
  }
  return sql + '\n';
}

async function pgTableData(client: PoolClient, srcSchema: string, table: string, tgtSchema: string): Promise<string> {
  const { rows, fields } = await client.query(`SELECT * FROM "${srcSchema}"."${table}"`);
  if (rows.length === 0) return '';
  const cols = fields.map(f => `"${f.name}"`).join(', ');
  const vals = rows.map(r => `(${fields.map(f => pgVal(r[f.name])).join(', ')})`).join(',\n');
  return `INSERT INTO "${tgtSchema}"."${table}" (${cols}) VALUES\n${vals};\n\n`;
}

function pgVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').replace('Z', '+00')}'`;
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── MySQL ──────────────────────────────────────────────────────────────────────

async function transferMySQL(
  source: SourceCfg, target: TargetCfg,
  mode: 'copy' | 'move', include: 'both' | 'schema' | 'data',
  log: string[],
) {
  // For MySQL, schema = database
  const srcDb = source.schema;
  const tgtDb = target.database;

  const srcConn = await mysql.createConnection({
    host: source.host, port: source.port ?? 3306,
    user: source.user, password: source.password,
    database: srcDb, multipleStatements: false,
  });
  const tgtConn = await mysql.createConnection({
    host: target.host, port: target.port ?? 3306,
    user: target.user, password: target.password,
    database: tgtDb, multipleStatements: true,
  });

  try {
    const [tableRows] = await srcConn.execute<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [srcDb],
    );
    const tableNames = tableRows.map(r => r.TABLE_NAME as string);
    log.push(`[INFO] Found ${tableNames.length} table(s) in database "${srcDb}"`);
    if (tableNames.length === 0) { log.push(`[WARN] No tables found — nothing to transfer`); return; }

    const parts: string[] = [`USE \`${tgtDb}\`;\nSET FOREIGN_KEY_CHECKS=0;\n\n`];
    for (const t of tableNames) {
      log.push(`[INFO] Processing "${srcDb}"."${t}"…`);
      if (include !== 'data') {
        const [rows] = await srcConn.execute<mysql.RowDataPacket[]>(`SHOW CREATE TABLE \`${srcDb}\`.\`${t}\``);
        parts.push(`${rows[0]['Create Table'] as string};\n`);
      }
      if (include !== 'schema') {
        const [rows] = await srcConn.execute<mysql.RowDataPacket[]>(`SELECT * FROM \`${srcDb}\`.\`${t}\``);
        if (Array.isArray(rows) && rows.length > 0) {
          const colKeys = Object.keys(rows[0]);
          const cols = colKeys.map(k => `\`${k}\``).join(', ');
          const vals = (rows as Record<string, unknown>[]).map(
            r => `(${colKeys.map(k => myVal(r[k])).join(', ')})`
          ).join(',\n');
          parts.push(`INSERT INTO \`${t}\` (${cols}) VALUES\n${vals};\n`);
        }
      }
      parts.push('\n');
    }
    parts.push('SET FOREIGN_KEY_CHECKS=1;\n');

    await tgtConn.beginTransaction();
    try {
      await tgtConn.execute(parts.join(''));
      await tgtConn.commit();
      log.push(`[OK] Transferred ${tableNames.length} table(s) to database "${tgtDb}"`);
    } catch (err) {
      await tgtConn.rollback();
      throw err;
    }

    if (mode === 'move') {
      log.push(`[INFO] Dropping source tables from "${srcDb}"…`);
      await srcConn.execute('SET FOREIGN_KEY_CHECKS=0');
      for (const t of tableNames)
        await srcConn.execute(`DROP TABLE IF EXISTS \`${srcDb}\`.\`${t}\``);
      await srcConn.execute('SET FOREIGN_KEY_CHECKS=1');
      log.push(`[OK] Dropped ${tableNames.length} table(s) from "${srcDb}"`);
    }
  } finally {
    await srcConn.end().catch(() => {}); await tgtConn.end().catch(() => {});
  }
}

function myVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return `'${v.toISOString().slice(0, 19).replace('T', ' ')}'`;
  if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "\\'")}'`;
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
