import { MigrationConfig, DryRunResult, MigrationSummary, TableMapping, ColumnMapping } from './types';

// ─── SQL Generation ───────────────────────────────────────────────────────────

export function generateCreateSchemasSQL(config: MigrationConfig): string {
  const schemas = new Set<string>();
  for (const t of config.tables) {
    if (t.include && t.pgSchema !== 'public') schemas.add(t.pgSchema);
  }
  if (schemas.size === 0) return '';
  return Array.from(schemas)
    .map((s) => `CREATE SCHEMA IF NOT EXISTS "${s}";`)
    .join('\n');
}

function columnDDL(col: ColumnMapping): string {
  let type = col.pgType;
  if (col.isPrimaryKey && col.indexStrategy === 'sequential') {
    if (type === 'INTEGER') type = 'INTEGER GENERATED ALWAYS AS IDENTITY';
    else if (type === 'BIGINT') type = 'BIGINT GENERATED ALWAYS AS IDENTITY';
  } else if (col.isPrimaryKey && col.indexStrategy === 'uuid') {
    type = 'UUID DEFAULT gen_random_uuid()';
  }

  const nullPart = col.nullable ? 'NULL' : 'NOT NULL';
  const pkPart = col.isPrimaryKey ? ' PRIMARY KEY' : '';
  const uniquePart = !col.isPrimaryKey && col.isUnique ? ' UNIQUE' : '';

  let defaultPart = '';
  if (!col.isPrimaryKey && col.defaultValue !== null && col.defaultValue !== undefined) {
    defaultPart = ` DEFAULT ${col.defaultValue === '' ? "''" : col.defaultValue}`;
  }

  return `    "${col.pgName}" ${type} ${nullPart}${defaultPart}${pkPart}${uniquePart}`;
}

export function generateCreateTableSQL(table: TableMapping): string {
  const includedCols = table.columns.filter((c) => c.include);
  if (includedCols.length === 0) return '';

  const colLines = includedCols.map(columnDDL).join(',\n');
  return `CREATE TABLE IF NOT EXISTS "${table.pgSchema}"."${table.pgName}" (\n${colLines}\n);`;
}

export function generateIndexesSQL(table: TableMapping): string[] {
  const sqls: string[] = [];
  for (const col of table.columns) {
    if (!col.include || col.isPrimaryKey || col.isUnique) continue;
    if (col.indexStrategy !== 'none') {
      sqls.push(
        `CREATE INDEX IF NOT EXISTS "idx_${table.pgName}_${col.pgName}" ON "${table.pgSchema}"."${table.pgName}" ("${col.pgName}");`
      );
    }
  }
  return sqls;
}

export function generateMigrationSQL(config: MigrationConfig): string {
  const lines: string[] = [
    `-- MySQL → PostgreSQL Migration Script`,
    `-- Generated: ${new Date().toISOString()}`,
    `-- Migration: ${config.name}`,
    `-- THIS IS A DRY RUN PREVIEW — Review before executing`,
    '',
    `-- 1. Create Schemas`,
    `-- =================`,
  ];

  const schemas = generateCreateSchemasSQL(config);
  if (schemas) lines.push(schemas);
  lines.push('');

  lines.push(`-- 2. Create Tables`, `-- =================`);
  for (const t of config.tables) {
    if (!t.include) continue;
    lines.push(``, `-- Schema: ${t.pgSchema}, Table: ${t.pgName}`);
    const ddl = generateCreateTableSQL(t);
    if (ddl) lines.push(ddl);
  }

  lines.push('', `-- 3. Create Indexes`, `-- =================`);
  for (const t of config.tables) {
    if (!t.include) continue;
    const idxSQLs = generateIndexesSQL(t);
    lines.push(...idxSQLs);
  }

  return lines.join('\n');
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateMigrationConfig(config: MigrationConfig): DryRunResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const included = config.tables.filter((t) => t.include);

  if (included.length === 0) errors.push('No tables selected for migration');

  // Duplicate table names per schema
  const tableKeys = new Set<string>();
  for (const t of included) {
    const key = `${t.pgSchema}.${t.pgName}`;
    if (tableKeys.has(key)) errors.push(`Duplicate table name: "${t.pgSchema}"."${t.pgName}"`);
    else tableKeys.add(key);

    // Duplicate column names
    const colNames = new Set<string>();
    const includedCols = t.columns.filter((c) => c.include);
    for (const c of includedCols) {
      if (colNames.has(c.pgName)) errors.push(`Duplicate column "${c.pgName}" in table "${t.pgName}"`);
      else colNames.add(c.pgName);
    }

    // Primary key warning
    const hasPK = includedCols.some((c) => c.isPrimaryKey);
    if (!hasPK) warnings.push(`Table "${t.pgName}" has no primary key`);
  }

  const summary = buildSummary(config);
  const sqlScript = generateMigrationSQL(config);

  return { valid: errors.length === 0, errors, warnings, summary, sqlScript };
}

export function buildSummary(config: MigrationConfig): MigrationSummary {
  const included = config.tables.filter((t) => t.include);
  const schemas = new Set(included.map((t) => t.pgSchema));
  let totalColumns = 0;
  let totalIndexes = 0;
  for (const t of included) {
    const cols = t.columns.filter((c) => c.include);
    totalColumns += cols.length;
    totalIndexes += cols.filter((c) => !c.isPrimaryKey && c.indexStrategy !== 'none').length;
  }
  const estimatedStatements =
    (schemas.size > 1 ? schemas.size - 1 : 0) + included.length + totalIndexes;

  return {
    totalTables: config.tables.length,
    includedTables: included.length,
    totalColumns,
    totalIndexes,
    schemasToCreate: Array.from(schemas),
    estimatedStatements,
  };
}
