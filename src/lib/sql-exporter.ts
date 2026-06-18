import { Pool, PoolClient, types as pgTypes } from 'pg';
import mysql from 'mysql2/promise';

// Per-query type parsers used when reading rows for export. The default pg
// parser turns `timestamp without time zone`, `timestamptz` and `date` into JS
// Date objects interpreted in the process timezone; emitting those via
// toISOString() (UTC) shifts wall-clock values by the server's TZ offset and
// corrupts the data. Returning the raw string instead emits each value exactly
// as stored (timestamptz keeps its +HH offset; bare timestamps stay wall-clock).
const RAW = (v: string) => v;
const exportTypeParsers = {
  getTypeParser(oid: number, format?: unknown) {
    // 1082 = date, 1114 = timestamp without tz, 1184 = timestamptz
    if (oid === 1082 || oid === 1114 || oid === 1184) return RAW;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (pgTypes.getTypeParser as any)(oid, format);
  },
};

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
export type ConflictStrategy = 'insert_only' | 'truncate_insert' | 'upsert';

export interface TableInfo {
  name: string;
  rowCount: number;
}

// ── Value escaping ─────────────────────────────────────────────────────────────

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

function csvVal(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── PostgreSQL ─────────────────────────────────────────────────────────────────

// List all user (non-system) schemas. Used for whole-database export.
async function pgListUserSchemas(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       AND nspname NOT LIKE 'pg_temp%' AND nspname NOT LIKE 'pg_toast_temp%'
     ORDER BY nspname`,
  );
  return rows.map((r) => r.nspname);
}

// Export user-defined ENUM types in the schema as idempotent CREATE TYPE
// statements. Column definitions reference these by udt_name, so the types must
// exist before any CREATE TABLE that uses them. When `qualify` is set (whole-DB
// export across schemas) the type is created in its own schema.
async function pgExportEnumTypes(client: PoolClient, schema = 'public', qualify = false): Promise<string> {
  const { rows } = await client.query<{ typname: string; labels: string }>(
    `SELECT t.typname,
            (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
             FROM pg_enum e WHERE e.enumtypid = t.oid) AS labels
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = $1 AND t.typtype = 'e'
     ORDER BY t.typname`,
    [schema],
  );
  if (rows.length === 0) return '';
  // PG has no CREATE TYPE IF NOT EXISTS — wrap in a DO block so re-imports are idempotent.
  return rows
    .map((r) => {
      const name = qualify ? `"${schema}"."${r.typname}"` : `"${r.typname}"`;
      return `DO $$ BEGIN\n  CREATE TYPE ${name} AS ENUM (${r.labels});\nEXCEPTION WHEN duplicate_object THEN NULL;\nEND $$;\n`;
    })
    .join('');
}

async function pgListTablesWithCounts(client: PoolClient, schema = 'public'): Promise<TableInfo[]> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = $1 AND table_type = 'BASE TABLE'
     ORDER BY table_name`,
    [schema],
  );
  const tables = rows.map((r) => r.table_name);
  const counts = await Promise.all(
    tables.map(async (t) => {
      const { rows: cr } = await client.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM "${schema}"."${t}"`);
      return { name: t, rowCount: parseInt(cr[0]?.c ?? '0', 10) };
    }),
  );
  return counts;
}

async function pgExportSchema(
  client: PoolClient, table: string, schema = 'public', qualify = false,
): Promise<{ tableSql: string; fkSql: string }> {
  const { rows: cols } = await client.query<{
    column_name: string; data_type: string; udt_name: string; udt_schema: string;
    character_maximum_length: number | null; numeric_precision: number | null;
    numeric_scale: number | null; is_nullable: string; column_default: string | null;
  }>(
    `SELECT column_name, data_type, udt_name, udt_schema, character_maximum_length,
            numeric_precision, numeric_scale, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $2 AND table_name = $1
     ORDER BY ordinal_position`,
    [table, schema],
  );

  const { rows: pkCols } = await client.query<{ column_name: string }>(
    `SELECT kcu.column_name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = $1 AND tc.table_schema = $2
     ORDER BY kcu.ordinal_position`,
    [table, schema],
  );

  const { rows: fks } = await client.query<{
    constraint_name: string; column_name: string; foreign_table: string; foreign_column: string;
    foreign_schema: string;
  }>(
    `SELECT tc.constraint_name, kcu.column_name,
            ccu.table_name AS foreign_table, ccu.column_name AS foreign_column,
            ccu.table_schema AS foreign_schema
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.referential_constraints rc
       ON tc.constraint_name = rc.constraint_name
     JOIN information_schema.constraint_column_usage ccu
       ON rc.unique_constraint_name = ccu.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = $2`,
    [table, schema],
  );

  // Exclude only the PRIMARY KEY's backing index (emitted inline in CREATE TABLE).
  // UNIQUE-constraint indexes ARE included here so their uniqueness is preserved —
  // they re-emit as CREATE UNIQUE INDEX, which still enforces uniqueness and can
  // back a foreign key. Without this they were dropped on export entirely.
  const { rows: idxs } = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = $1 AND schemaname = $2
       AND indexname NOT IN (
         SELECT constraint_name FROM information_schema.table_constraints
         WHERE table_name = $1 AND table_schema = $2 AND constraint_type = 'PRIMARY KEY'
       )`,
    [table, schema],
  );

  // Single-schema export strips the source-schema qualifier from default
  // expressions (enum casts like ::core.user_type, nextval('core.seq')) so they
  // resolve to whatever target schema the import lands in. Whole-DB export
  // (qualify) keeps every reference fully schema-qualified instead, so each
  // object is recreated in its original schema regardless of search_path.
  const schemaRe = new RegExp(`(^|[^\\w."])"?${schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\.`, 'g');
  const deQualify = (expr: string) => (qualify ? expr : expr.replace(schemaRe, '$1'));
  const qname = qualify ? `"${schema}"."${table}"` : `"${table}"`;

  const colDefs = cols.map((c) => {
    let type: string;
    if (c.data_type === 'USER-DEFINED') {
      // Qualify the enum/domain type with its own schema in whole-DB export.
      type = qualify ? `"${c.udt_schema}"."${c.udt_name}"` : c.udt_name;
    } else if (c.data_type === 'ARRAY') {
      // udt_name for arrays is '_text', '_int4', etc. — strip leading '_' and append '[]'
      type = c.udt_name.startsWith('_') ? c.udt_name.slice(1) + '[]' : 'text[]';
    } else {
      type = c.data_type;
    }
    if (c.character_maximum_length) type += `(${c.character_maximum_length})`;
    else if (c.numeric_precision != null && c.data_type === 'numeric')
      type += `(${c.numeric_precision},${c.numeric_scale ?? 0})`;
    let def = `  "${c.column_name}" ${type}`;
    if (c.column_default != null) def += ` DEFAULT ${deQualify(c.column_default)}`;
    if (c.is_nullable === 'NO') def += ' NOT NULL';
    return def;
  });

  if (pkCols.length > 0)
    colDefs.push(`  PRIMARY KEY (${pkCols.map((r) => `"${r.column_name}"`).join(', ')})`);

  // Emit CREATE SEQUENCE IF NOT EXISTS for any nextval(...::regclass) column defaults.
  // PostgreSQL resolves ::regclass to an OID at CREATE TABLE analysis time, so the
  // sequence must exist before the table is created (mirrors pg_dump behaviour).
  const seqDefs: string[] = [];
  for (const c of cols) {
    if (c.column_default?.includes('nextval(')) {
      const m = c.column_default.match(/nextval\('([^']+)'(?:::[\w.]+)?\)/i);
      if (m) {
        const parts = m[1].split('.').map((p) => p.replace(/^"|"$/g, ''));
        const seqName = parts.pop()!;
        // Whole-DB export keeps the sequence in its source schema (from the
        // nextval ref, falling back to the table's schema); single-schema export
        // creates it unqualified so it lands wherever the table is imported.
        const seqRef = qualify ? `"${parts[0] ?? schema}"."${seqName}"` : `"${seqName}"`;
        const stmt = `CREATE SEQUENCE IF NOT EXISTS ${seqRef};\n`;
        if (!seqDefs.includes(stmt)) seqDefs.push(stmt);
      }
    }
  }

  // FK constraints are intentionally omitted from CREATE TABLE and emitted as
  // separate ALTER TABLE statements after all tables are created, so that
  // alphabetical export order doesn't cause "referenced table doesn't exist" errors on re-import.
  let tableSql = seqDefs.join('') + `CREATE TABLE IF NOT EXISTS ${qname} (\n${colDefs.join(',\n')}\n);\n`;
  for (const idx of idxs) {
    // Add IF NOT EXISTS so re-running schema on an existing DB doesn't fail.
    // Single-schema export strips the source schema qualifier from the ON clause
    // (ON billings.foo → ON foo) so the dump re-imports into any target schema;
    // whole-DB export keeps it so the index lands on the right schema's table.
    let def = idx.indexdef
      .replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
      .replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ');
    if (!qualify) def = def.replace(new RegExp(` ON "?${schema}"?\\.`), ' ON ');
    tableSql += `${def};\n`;
  }

  // Wrap each FK in a DO $$ EXCEPTION block so the dump is idempotent.
  // Uses WHEN OTHERS to also tolerate cross-schema references that don't exist
  // in the target (e.g. a table in a different schema not included in this dump).
  const fkSql = fks
    .map((fk) => {
      // Qualify the referenced table with its schema when it lives outside the
      // exported schema, so the FK can resolve even without a matching search_path.
      const foreignRef = qualify || fk.foreign_schema !== schema
        ? `"${fk.foreign_schema}"."${fk.foreign_table}"`
        : `"${fk.foreign_table}"`;
      return `DO $$ BEGIN\n  ALTER TABLE ${qname} ADD CONSTRAINT "${fk.constraint_name}" FOREIGN KEY ("${fk.column_name}") REFERENCES ${foreignRef} ("${fk.foreign_column}");\nEXCEPTION WHEN OTHERS THEN NULL;\nEND $$;\n`;
    })
    .join('');

  return { tableSql, fkSql };
}

async function pgExportData(
  client: PoolClient, table: string,
  whereClause?: string, conflictStrategy?: ConflictStrategy, schema = 'public', qualify = false,
): Promise<string> {
  const where = whereClause?.trim() ? ` WHERE ${whereClause}` : '';
  const { rows, fields } = await client.query({ text: `SELECT * FROM "${schema}"."${table}"${where}`, types: exportTypeParsers });
  if (rows.length === 0) return '';
  const target = qualify ? `"${schema}"."${table}"` : `"${table}"`;
  const cols = fields.map((f) => `"${f.name}"`).join(', ');
  const vals = rows.map((r) => `(${fields.map((f) => pgVal(r[f.name])).join(', ')})`).join(',\n');

  if (conflictStrategy === 'upsert') {
    return `INSERT INTO ${target} (${cols}) VALUES\n${vals}\nON CONFLICT DO NOTHING;\n`;
  }
  return `INSERT INTO ${target} (${cols}) VALUES\n${vals};\n`;
}

async function pgExportDataCsv(client: PoolClient, table: string, whereClause?: string, schema = 'public'): Promise<string> {
  const where = whereClause?.trim() ? ` WHERE ${whereClause}` : '';
  const { rows, fields } = await client.query({ text: `SELECT * FROM "${schema}"."${table}"${where}`, types: exportTypeParsers });
  const header = fields.map((f) => f.name).join(',');
  if (rows.length === 0) return header + '\n';
  const dataRows = rows.map((r) => fields.map((f) => csvVal(r[f.name])).join(','));
  return [header, ...dataRows].join('\n') + '\n';
}

// ── MySQL ──────────────────────────────────────────────────────────────────────

async function myListTablesWithCounts(conn: mysql.Connection, database: string): Promise<TableInfo[]> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [database],
  );
  return rows.map((r) => ({ name: r.TABLE_NAME as string, rowCount: Number(r.TABLE_ROWS ?? 0) }));
}

async function myExportSchema(conn: mysql.Connection, database: string, table: string): Promise<string> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SHOW CREATE TABLE \`${database}\`.\`${table}\``,
  );
  return `${rows[0]['Create Table'] as string};\n`;
}

async function myExportData(
  conn: mysql.Connection, database: string, table: string,
  whereClause?: string, conflictStrategy?: ConflictStrategy,
): Promise<string> {
  const where = whereClause?.trim() ? ` WHERE ${whereClause}` : '';
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM \`${database}\`.\`${table}\`${where}`,
  );
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const cols = Object.keys(rows[0]).map((k) => `\`${k}\``).join(', ');
  const vals = rows.map((r) => `(${Object.values(r).map(myVal).join(', ')})`).join(',\n');

  if (conflictStrategy === 'upsert') {
    return `INSERT IGNORE INTO \`${table}\` (${cols}) VALUES\n${vals};\n`;
  }
  return `INSERT INTO \`${table}\` (${cols}) VALUES\n${vals};\n`;
}

async function myExportDataCsv(
  conn: mysql.Connection, database: string, table: string, whereClause?: string,
): Promise<string> {
  const where = whereClause?.trim() ? ` WHERE ${whereClause}` : '';
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT * FROM \`${database}\`.\`${table}\`${where}`,
  );
  if (!Array.isArray(rows) || rows.length === 0) return '';
  const keys = Object.keys(rows[0]);
  const header = keys.join(',');
  const dataRows = (rows as Record<string, unknown>[]).map(
    (r) => keys.map((k) => csvVal(r[k])).join(','),
  );
  return [header, ...dataRows].join('\n') + '\n';
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function listTablesWithCounts(cfg: ConnCfg): Promise<TableInfo[]> {
  if (cfg.db_type === 'postgres') {
    const pool = makePgPool(cfg);
    const client = await pool.connect();
    try { return await pgListTablesWithCounts(client); }
    finally { client.release(); await pool.end(); }
  } else {
    const conn = await makeMySQLConn(cfg);
    try { return await myListTablesWithCounts(conn, cfg.database); }
    finally { await conn.end(); }
  }
}

// Keep the original for backwards compat
export async function listTables(cfg: ConnCfg): Promise<string[]> {
  return (await listTablesWithCounts(cfg)).map((t) => t.name);
}

export interface ExportResult {
  sql: string;
  tables: string[];
  include: ExportInclude;
}

export interface ExportOptions {
  whereClause?: string;
  conflictStrategy?: ConflictStrategy;
  schema?: string;            // PostgreSQL source schema (default 'public'); '*' = whole database, all schemas
}

export async function exportDatabase(
  cfg: ConnCfg,
  tables: string[] | 'all',
  include: ExportInclude,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const { whereClause, conflictStrategy } = opts;
  const allSchemas = opts.schema === '*';
  const schema = opts.schema && !allSchemas ? opts.schema : 'public';
  const header = `-- Export: ${cfg.database} (${cfg.db_type})\n-- Generated: ${new Date().toISOString()}\n-- Include: ${include}${allSchemas ? ' (all schemas)' : ''}\n\n`;
  const parts: string[] = [header];

  if (cfg.db_type === 'postgres') {
    const pool = makePgPool(cfg);
    const client = await pool.connect();
    try {
      parts.push('SET client_min_messages TO WARNING;\n\n');

      // Whole-DB export: every non-system schema, fully schema-qualified so each
      // object is recreated in its original schema. An explicit table list is
      // only meaningful for a single schema, so all-schemas implies 'all' tables.
      const schemaList = allSchemas ? await pgListUserSchemas(client) : [schema];
      if (allSchemas) {
        for (const s of schemaList) parts.push(`CREATE SCHEMA IF NOT EXISTS "${s}";\n`);
        parts.push('\n');
      }

      // Ordered passes (per pg_dump): enums → CREATE TABLE → data → FKs.
      //   - All enums come before any table: a table in one schema may reference
      //     an enum defined in a schema that sorts later, so every type must
      //     exist first.
      //   - FKs come last: data loads in alphabetical table order, so a child
      //     may be inserted before its parent — and cross-schema FKs need every
      //     schema's tables to exist. Deferring all FKs to the end avoids both.
      const label = (s: string, t: string) => (allSchemas ? `${s}.${t}` : t);
      const tablesBySchema = new Map<string, string[]>();
      for (const s of schemaList) {
        const allNames = (await pgListTablesWithCounts(client, s)).map((t) => t.name);
        tablesBySchema.set(s, (tables === 'all' || allSchemas) ? allNames : tables);
      }

      const fkParts: string[] = [];
      const resultTables: string[] = [];

      if (include !== 'data') {
        for (const s of schemaList) {
          const enumSql = await pgExportEnumTypes(client, s, allSchemas);
          if (enumSql) {
            parts.push(`-- Enum types${allSchemas ? ` (${s})` : ''}\n`);
            parts.push(enumSql);
            parts.push('\n');
          }
        }
        for (const s of schemaList) {
          for (const t of tablesBySchema.get(s)!) {
            parts.push(`-- Table: ${label(s, t)}\n`);
            const { tableSql, fkSql } = await pgExportSchema(client, t, s, allSchemas);
            parts.push(tableSql);
            parts.push('\n');
            if (fkSql) fkParts.push(fkSql);
          }
        }
      }

      if (include !== 'schema') {
        // Single-schema truncate_insert: clear tables (reverse order) before data.
        if (!allSchemas && conflictStrategy === 'truncate_insert') {
          for (const t of [...tablesBySchema.get(schema)!].reverse())
            parts.push(`TRUNCATE TABLE "${t}" CASCADE;\n`);
          parts.push('\n');
        }
        for (const s of schemaList) {
          for (const t of tablesBySchema.get(s)!) {
            parts.push(`-- Data: ${label(s, t)}\n`);
            parts.push(await pgExportData(client, t, whereClause, conflictStrategy, s, allSchemas));
            parts.push('\n');
          }
        }
      }

      for (const s of schemaList) resultTables.push(...tablesBySchema.get(s)!.map((t) => label(s, t)));

      if (fkParts.length > 0) {
        parts.push('-- Foreign key constraints\n');
        parts.push(fkParts.join(''));
        parts.push('\n');
      }

      return { sql: parts.join(''), tables: resultTables, include };
    } finally { client.release(); await pool.end(); }
  } else {
    const conn = await makeMySQLConn(cfg);
    try {
      const allInfo = await myListTablesWithCounts(conn, cfg.database);
      const allNames = allInfo.map((t) => t.name);
      const target = tables === 'all' ? allNames : tables;
      parts.push(`USE \`${cfg.database}\`;\nSET FOREIGN_KEY_CHECKS=0;\n\n`);

      if (conflictStrategy === 'truncate_insert' && include !== 'schema') {
        for (const t of target) parts.push(`TRUNCATE TABLE \`${t}\`;\n`);
        parts.push('\n');
      }

      for (const t of target) {
        parts.push(`-- Table: ${t}\n`);
        if (include !== 'data') parts.push(await myExportSchema(conn, cfg.database, t));
        if (include !== 'schema') parts.push(await myExportData(conn, cfg.database, t, whereClause, conflictStrategy));
        parts.push('\n');
      }
      parts.push('SET FOREIGN_KEY_CHECKS=1;\n');
      return { sql: parts.join(''), tables: target, include };
    } finally { await conn.end(); }
  }
}

export interface CsvExportResult {
  csvFiles: { table: string; csv: string }[];
  tables: string[];
}

export async function exportDatabaseCsv(
  cfg: ConnCfg,
  tables: string[] | 'all',
  whereClause?: string,
  schema = 'public',
): Promise<CsvExportResult> {
  if (cfg.db_type === 'postgres') {
    const pool = makePgPool(cfg);
    const client = await pool.connect();
    try {
      // Whole-DB CSV export spans every schema; file names are prefixed with the
      // schema so tables of the same name in different schemas don't collide.
      const allSchemas = schema === '*';
      const schemaList = allSchemas ? await pgListUserSchemas(client) : [schema];
      const csvFiles: { table: string; csv: string }[] = [];
      const resultTables: string[] = [];
      for (const s of schemaList) {
        const allNames = (await pgListTablesWithCounts(client, s)).map((t) => t.name);
        const target = (tables === 'all' || allSchemas) ? allNames : tables;
        for (const t of target) {
          const name = allSchemas ? `${s}.${t}` : t;
          csvFiles.push({ table: name, csv: await pgExportDataCsv(client, t, whereClause, s) });
          resultTables.push(name);
        }
      }
      return { csvFiles, tables: resultTables };
    } finally { client.release(); await pool.end(); }
  } else {
    const conn = await makeMySQLConn(cfg);
    try {
      const allInfo = await myListTablesWithCounts(conn, cfg.database);
      const allNames = allInfo.map((t) => t.name);
      const target = tables === 'all' ? allNames : tables;
      const csvFiles = await Promise.all(
        target.map(async (t) => ({ table: t, csv: await myExportDataCsv(conn, cfg.database, t, whereClause) })),
      );
      return { csvFiles, tables: target };
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
