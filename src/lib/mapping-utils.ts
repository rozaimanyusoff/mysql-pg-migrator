import { MySQLTable, MigrationConfig, TableMapping, ColumnMapping, IndexStrategy } from './types';

// ─── Storage key helpers ──────────────────────────────────────────────────

export function tableStorageKey(database: string, tableName: string): string {
  return `table_mappings_${database}_${tableName}`;
}

// ─── MySQL → PostgreSQL type mapping table ─────────────────────────────────

const TYPE_MAP: Record<string, string> = {
  // Integers
  tinyint: 'SMALLINT',
  'tinyint(1)': 'BOOLEAN',
  smallint: 'SMALLINT',
  mediumint: 'INTEGER',
  int: 'INTEGER',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  // Floats
  float: 'REAL',
  double: 'DOUBLE PRECISION',
  decimal: 'NUMERIC',
  numeric: 'NUMERIC',
  // Strings
  char: 'CHAR',
  varchar: 'VARCHAR',
  tinytext: 'TEXT',
  text: 'TEXT',
  mediumtext: 'TEXT',
  longtext: 'TEXT',
  // Binary
  binary: 'BYTEA',
  varbinary: 'BYTEA',
  tinyblob: 'BYTEA',
  blob: 'BYTEA',
  mediumblob: 'BYTEA',
  longblob: 'BYTEA',
  // Date/Time
  date: 'DATE',
  time: 'TIME WITHOUT TIME ZONE',
  datetime: 'TIMESTAMP WITHOUT TIME ZONE',
  timestamp: 'TIMESTAMP WITHOUT TIME ZONE',
  year: 'SMALLINT',
  // JSON
  json: 'JSONB',
  // Misc
  boolean: 'BOOLEAN',
  bool: 'BOOLEAN',
  enum: 'VARCHAR',
  set: 'TEXT',
  bit: 'BIT',
  uuid: 'UUID',
};

export function mapMySQLTypeToPg(mysqlType: string): string {
  // Strip length/precision for lookup, e.g. varchar(255) → varchar
  const base = mysqlType.toLowerCase().replace(/\s*unsigned/g, '').trim();
  // Exact match first
  if (TYPE_MAP[base]) return TYPE_MAP[base];
  // Match by prefix
  for (const [key, pg] of Object.entries(TYPE_MAP)) {
    if (base.startsWith(key + '(') || base === key) return pg;
  }
  // Preserve original casing for unknown types
  return mysqlType.toUpperCase();
}

export function initializeMigrationConfig(
  inspectionResult: { database: string; tables: MySQLTable[]; inspectedAt: string } | { database: string; tables: MySQLTable[]; inspectedAt: string }[]
): MigrationConfig {
  const results = Array.isArray(inspectionResult) ? inspectionResult : [inspectionResult];
  const tables: TableMapping[] = results.flatMap((r) =>
    r.tables.map((t) => ({
      mysqlName: t.name,
      pgName: t.name,
      pgSchema: 'public',
      include: true,
      description: t.comment || '',
      sourceDatabase: r.database,
      columns: t.columns.map((c): ColumnMapping => {
        const strategy: IndexStrategy = c.isPrimaryKey ? 'sequential' : 'none';
        return {
          mysqlName: c.name,
          pgName: c.name,
          mysqlType: c.type,
          pgType: mapMySQLTypeToPg(c.type),
          nullable: c.nullable,
          defaultValue: c.defaultValue,
          isPrimaryKey: c.isPrimaryKey,
          isUnique: c.isUnique,
          indexStrategy: strategy,
          description: c.comment || '',
          include: true,
        };
      }),
    }))
  );

  const databases = [...new Set(results.map((r) => r.database))];
  const sourceName = databases.join('+');

  return {
    id: `migration_${Date.now()}`,
    name: `${sourceName}_migration`,
    sourceDatabase: databases[0],
    targetDatabase: databases[0],
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tables,
  };
}

export function validateColumnName(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/i.test(name) && name.length <= 63;
}

export function validateTableName(name: string): boolean {
  return /^[a-z_][a-z0-9_]*$/i.test(name) && name.length <= 63;
}

function normalizeLegacyPk(columns: ColumnMapping[]): ColumnMapping[] {
  return columns.map((c) => {
    if (!c.isPrimaryKey) return c;
    if (c.pkHandling === 'migrate_to_id' || !c.include) {
      return { ...c, include: true, pkHandling: 'keep' };
    }
    return { ...c, pkHandling: 'keep' };
  });
}

/**
 * Merges per-table localStorage column mappings (saved in Phase 1) into a
 * MigrationConfig.  Handles both old ColumnMapping[] format and new
 * { pgName, columns } format.  Updates pgName if saved.
 */
export function mergePhase1Mappings(config: MigrationConfig): MigrationConfig {
  if (typeof window === 'undefined') return config;
  const tables = config.tables.map((t) => {
    const db = (t as { sourceDatabase?: string }).sourceDatabase ?? config.sourceDatabase;
    const key = tableStorageKey(db, t.mysqlName);
    const raw = localStorage.getItem(key);
    if (!raw) return t;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Backward compat: old format was ColumnMapping[]
        return { ...t, columns: normalizeLegacyPk(parsed as ColumnMapping[]) };
      } else {
        const stored = parsed as { pgName: string; columns: ColumnMapping[]; tableDescription?: string };
        return {
          ...t,
          pgName: stored.pgName || t.pgName,
          columns: normalizeLegacyPk(stored.columns),
          description: stored.tableDescription ?? t.description,
        };
      }
    } catch {
      return t;
    }
  });
  return { ...config, tables };
}

/**
 * Generates CREATE TABLE SQL DDL from a MigrationConfig.
 * Preserves source primary key columns when included.
 */
export function generateMappingSQL(config: MigrationConfig): string {
  const out: string[] = [
    '-- MySQL → PostgreSQL Migration DDL',
    `-- Generated: ${new Date().toISOString()}`,
    `-- Source: ${config.sourceDatabase}  →  Target: ${config.targetDatabase}`,
    '',
  ];

  const schemas = [
    ...new Set(
      config.tables
        .filter((t) => t.include)
        .map((t) => t.pgSchema)
        .filter((s) => s !== 'public')
    ),
  ];
  for (const s of schemas) out.push(`CREATE SCHEMA IF NOT EXISTS "${s}";`);
  if (schemas.length) out.push('');

  for (const t of config.tables) {
    if (!t.include) continue;

    out.push(`-- ${t.mysqlName}  →  ${t.pgSchema}.${t.pgName}`);
    out.push(`CREATE TABLE IF NOT EXISTS "${t.pgSchema}"."${t.pgName}" (`);

    const defs: string[] = [];

    for (const c of t.columns) {
      if (!c.include) continue;
      let line = `  "${c.pgName}" ${c.pgType}`;
      if (!c.nullable) line += ' NOT NULL';
      defs.push(line);
    }

    const pkCols = t.columns.filter((c) => c.isPrimaryKey && c.include);
    if (pkCols.length) {
      defs.push(
        `  CONSTRAINT "pk_${t.pgName}" PRIMARY KEY (${pkCols
          .map((c) => `"${c.pgName}"`)
          .join(', ')})`
      );
    }

    out.push(defs.join(',\n'));
    out.push(');');
    out.push('');
  }

  return out.join('\n');
}
