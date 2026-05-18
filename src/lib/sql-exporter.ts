import { Pool, PoolClient } from 'pg';
import mysql from 'mysql2/promise';

export interface ConnCfg {
  db_type: 'postgres' | 'mysql';
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export type ExportInclude = 'schema' | 'data' | 'both';

// ── value escaping ─────────────────────────────────────────────────────────────

function pgVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return `'${v.toISOString().replace('T', ' ').replace('Z', '+00')}'`;
  if (Buffer.isBuffer(v)) return `'\\x${v.toString('hex')}'`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
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

// ── PostgreSQL ─────────────────────────────────────────────────────────────────

async function pgListTables(client: PoolClient, database: string): Promise<string[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
  );
  void database;
  return rows.map((r) => r.table_name);
}

async function pgExportSchema(client: PoolClient, table: string): Promise<string> {
  const { rows: cols } = await client.query<{
    column_name: string; data_type: string; udt_name: string;
    character_maximum_length: number | null; numeric_precision: number | null;
    numeric_scale: number | null; is_nullable: string; column_default: string | null;
  }>(
    `SELECT column_name, data_type, udt_name, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );

  const { rows: pkCols } = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = 'public'
     ORDER BY kcu.ordinal_position`,
    [table],
  );

  const { rows: fks } = await client.query<{
    constraint_name: string; column_name: string; foreign_table: string; foreign_column: string;
  }>(
    `SELECT tc.constraint_name, kcu.column_name,
            ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.referential_constraints rc
       ON tc.constraint_name = rc.constraint_name
     JOIN information_schema.constraint_column_usage ccu
       ON rc.unique_constraint_name = ccu.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = 'public'`,
    [table],
  );

  const { rows: idxs } = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = $1 AND schemaname = 'public'
       AND indexname NOT IN (
         SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_name = $1 AND table_schema = 'public'
       )`,
    [table],
  );

  const colDefs = cols.map((c) => {
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
    colDefs.push(`  PRIMARY KEY (${pkCols.map((r) => `"${r.column_name}"`).join(', ')})`);

  for (const fk of fks)
    colDefs.push(
      `  CONSTRAINT "${fk.constraint_name}" FOREIGN KEY ("${fk.column_name}") REFERENCES "${fk.foreign_table}" ("${fk.foreign_column}")`,
    );

  let sql = `CREATE TABLE IF NOT EXISTS "${table}" (\n${colDefs.join(',\n')}\n);\n`;
  for (const idx of idxs) sql += `${idx.indexdef};\n`;
  return sql;
}

async function pgExportData(client: PoolClient, table: string): Promise<string> {
  const { rows, fields } = await client.query(`SELECT * FROM "${table}"`);
  if (rows.length === 0) return '';
  const cols = fields.map((f) => `"${f.name}"`).join(', ');
  const vals = rows
    .map((r) => `(${fields.map((f) => pgVal(r[f.name])).join(', ')})`)
    .join(',\n');
  return `INSERT INTO "${table}" (${cols}) VALUES\n${vals};\n`;
}

// ── MySQL ──────────────────────────────────────────────────────────────────────

async function myListTables(conn: mysql.Connection, database: string): Promise<string[]> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [database],
  );
  return rows.map((r) => r.TABLE_NAME as string);
}

async function myExportSchema(conn: mysql.Connection, database: string, table: string): Promise<string> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SHOW CREATE TABLE \`${database}\`.\`${table}\``,
  );
  const ddl = rows[0]['Create Table'] as string;
  return `${ddl};\n`;
}

async function myExportData(conn: mysql.Connection, database: string, table: string): Promise<string> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM \`${database}\`.\`${table}\``,
  );
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const cols = Object.keys(rows[0]).map((k) => `\`${k}\``).join(', ');
  const vals = rows
    .map((r) => `(${Object.values(r).map(myVal).join(', ')})`)
    .join(',\n');
  return `INSERT INTO \`${table}\` (${cols}) VALUES\n${vals};\n`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function listTables(cfg: ConnCfg): Promise<string[]> {
  if (cfg.db_type === 'postgres') {
    const pool = makePgPool(cfg);
    const client = await pool.connect();
    try { return await pgListTables(client, cfg.database); }
    finally { client.release(); await pool.end(); }
  } else {
    const conn = await makeMySQLConn(cfg);
    try { return await myListTables(conn, cfg.database); }
    finally { await conn.end(); }
  }
}

export interface ExportResult {
  sql: string;
  tables: string[];
  include: ExportInclude;
}

export async function exportDatabase(
  cfg: ConnCfg,
  tables: string[] | 'all',
  include: ExportInclude,
): Promise<ExportResult> {
  const header = `-- Export: ${cfg.database} (${cfg.db_type})\n-- Generated: ${new Date().toISOString()}\n-- Include: ${include}\n\n`;
  const parts: string[] = [header];

  if (cfg.db_type === 'postgres') {
    const pool = makePgPool(cfg);
    const client = await pool.connect();
    try {
      const all = await pgListTables(client, cfg.database);
      const target = tables === 'all' ? all : tables;
      parts.push('SET client_min_messages TO WARNING;\n\n');
      for (const t of target) {
        parts.push(`-- Table: ${t}\n`);
        if (include !== 'data') parts.push(await pgExportSchema(client, t));
        if (include !== 'schema') parts.push(await pgExportData(client, t));
        parts.push('\n');
      }
      return { sql: parts.join(''), tables: target, include };
    } finally { client.release(); await pool.end(); }
  } else {
    const conn = await makeMySQLConn(cfg);
    try {
      const all = await myListTables(conn, cfg.database);
      const target = tables === 'all' ? all : tables;
      parts.push(`USE \`${cfg.database}\`;\nSET FOREIGN_KEY_CHECKS=0;\n\n`);
      for (const t of target) {
        parts.push(`-- Table: ${t}\n`);
        if (include !== 'data') parts.push(await myExportSchema(conn, cfg.database, t));
        if (include !== 'schema') parts.push(await myExportData(conn, cfg.database, t));
        parts.push('\n');
      }
      parts.push('SET FOREIGN_KEY_CHECKS=1;\n');
      return { sql: parts.join(''), tables: target, include };
    } finally { await conn.end(); }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePgPool(cfg: ConnCfg) {
  return new Pool({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, ssl: cfg.ssl ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 15000,
  });
}

async function makeMySQLConn(cfg: ConnCfg) {
  return mysql.createConnection({
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password,
    database: cfg.database, multipleStatements: false,
  });
}
