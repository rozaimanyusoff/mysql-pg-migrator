import { MySQLTable, MigrationConfig, TableMapping, ColumnMapping, IndexStrategy } from './types';

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
  inspectionResult: { database: string; tables: MySQLTable[]; inspectedAt: string }
): MigrationConfig {
  const tables: TableMapping[] = inspectionResult.tables.map((t) => ({
    mysqlName: t.name,
    pgName: t.name,
    pgSchema: 'public',
    include: true,
    description: t.comment || '',
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
  }));

  return {
    id: `migration_${Date.now()}`,
    name: `${inspectionResult.database}_migration`,
    sourceDatabase: inspectionResult.database,
    targetDatabase: inspectionResult.database,
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
