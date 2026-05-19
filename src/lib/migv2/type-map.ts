import type { DbType } from './types';

// MySQL → PostgreSQL
const MYSQL_TO_PG: Record<string, string> = {
  'tinyint(1)': 'BOOLEAN',
  tinyint: 'SMALLINT',
  smallint: 'SMALLINT',
  mediumint: 'INTEGER',
  int: 'INTEGER',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  float: 'REAL',
  double: 'DOUBLE PRECISION',
  decimal: 'NUMERIC',
  numeric: 'NUMERIC',
  char: 'CHAR',
  varchar: 'VARCHAR',
  tinytext: 'TEXT',
  text: 'TEXT',
  mediumtext: 'TEXT',
  longtext: 'TEXT',
  binary: 'BYTEA',
  varbinary: 'BYTEA',
  tinyblob: 'BYTEA',
  blob: 'BYTEA',
  mediumblob: 'BYTEA',
  longblob: 'BYTEA',
  date: 'DATE',
  time: 'TIME',
  datetime: 'TIMESTAMP',
  timestamp: 'TIMESTAMP',
  year: 'SMALLINT',
  json: 'JSONB',
  boolean: 'BOOLEAN',
  bool: 'BOOLEAN',
  enum: 'VARCHAR(255)',
  set: 'TEXT',
  bit: 'BIT',
  uuid: 'UUID',
};

// PostgreSQL → MySQL
const PG_TO_MYSQL: Record<string, string> = {
  boolean: 'TINYINT(1)',
  bool: 'TINYINT(1)',
  smallint: 'SMALLINT',
  integer: 'INT',
  int: 'INT',
  int4: 'INT',
  int8: 'BIGINT',
  bigint: 'BIGINT',
  real: 'FLOAT',
  float4: 'FLOAT',
  'double precision': 'DOUBLE',
  float8: 'DOUBLE',
  numeric: 'DECIMAL',
  decimal: 'DECIMAL',
  char: 'CHAR',
  'character varying': 'VARCHAR(255)',
  varchar: 'VARCHAR',
  text: 'LONGTEXT',
  bytea: 'LONGBLOB',
  date: 'DATE',
  time: 'TIME',
  'time without time zone': 'TIME',
  'time with time zone': 'TIME',
  timestamp: 'DATETIME',
  'timestamp without time zone': 'DATETIME',
  'timestamp with time zone': 'DATETIME',
  jsonb: 'JSON',
  json: 'JSON',
  uuid: 'VARCHAR(36)',
  bit: 'BIT',
  serial: 'INT AUTO_INCREMENT',
  bigserial: 'BIGINT AUTO_INCREMENT',
  smallserial: 'SMALLINT AUTO_INCREMENT',
};

export function suggestTargetType(sourceType: string, from: DbType, to: DbType): string {
  const base = sourceType.toLowerCase().trim().replace(/\s+unsigned/g, '');

  if (from === 'mysql' && to === 'postgresql') {
    // Try exact match first
    if (MYSQL_TO_PG[base]) return MYSQL_TO_PG[base];
    // Try prefix match (e.g. varchar(255) → varchar)
    for (const [k, v] of Object.entries(MYSQL_TO_PG)) {
      if (base.startsWith(k + '(') || base.startsWith(k + ' ')) return v;
    }
    return sourceType.toUpperCase();
  }

  if (from === 'postgresql' && to === 'mysql') {
    if (PG_TO_MYSQL[base]) return PG_TO_MYSQL[base];
    for (const [k, v] of Object.entries(PG_TO_MYSQL)) {
      if (base.startsWith(k + '(') || base.startsWith(k + ' ') || base === k) return v;
    }
    return sourceType.toUpperCase();
  }

  // Same type system: return as-is
  return sourceType;
}

export function isPkLikeSerial(sourceType: string): boolean {
  const t = sourceType.toLowerCase();
  return t.includes('serial') || t.includes('auto_increment') ||
    t === 'int' || t === 'integer' || t === 'bigint' || t === 'smallint' ||
    t.startsWith('int(') || t.startsWith('bigint(');
}
