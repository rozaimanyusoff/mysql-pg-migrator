import { MigrationConfig, ExportViewOptions } from './types';
import { buildSummary } from './postgres-migrator';

const DEFAULT_VIEW: ExportViewOptions = { includeSource: true, includeTarget: true };

export function generateExcelCSV(config: MigrationConfig, view: ExportViewOptions = DEFAULT_VIEW): string {
  const includeSource = view.includeSource;
  const includeTarget = view.includeTarget;
  const summary = buildSummary(config);
  const rows: string[] = [];

  // Summary sheet
  rows.push('MIGRATION SUMMARY');
  rows.push(`Migration Name,${config.name}`);
  rows.push(`Source Database,${config.sourceDatabase}`);
  rows.push(`Target Database,${config.targetDatabase}`);
  rows.push(`Status,${config.status}`);
  rows.push(`Generated,${new Date().toISOString()}`);
  rows.push('');
  rows.push('STATISTICS');
  rows.push(`Total Tables,${summary.totalTables}`);
  rows.push(`Tables to Migrate,${summary.includedTables}`);
  rows.push(`Tables Excluded,${summary.totalTables - summary.includedTables}`);
  rows.push(`Total Columns,${summary.totalColumns}`);
  rows.push(`Total Indexes,${summary.totalIndexes}`);
  rows.push(`PostgreSQL Schemas,"${summary.schemasToCreate.join(', ')}"`);
  rows.push('');

  // Mappings sheet
  rows.push('TABLE AND COLUMN MAPPINGS');
  const headers: string[] = [];
  if (includeSource) headers.push('MySQL Table');
  if (includeTarget) headers.push('PostgreSQL Schema', 'PostgreSQL Table');
  if (includeSource) headers.push('MySQL Column', 'MySQL Type');
  if (includeTarget) headers.push('PostgreSQL Column', 'PostgreSQL Type');
  headers.push('PK', 'Nullable', 'Include');
  rows.push(headers.join(','));
  for (const t of config.tables) {
    for (const c of t.columns) {
      const values: string[] = [];
      if (includeSource) values.push(t.mysqlName);
      if (includeTarget) values.push(t.pgSchema, t.pgName);
      if (includeSource) values.push(c.mysqlName, c.mysqlType);
      if (includeTarget) values.push(c.pgName, c.pgType);
      values.push(c.isPrimaryKey ? 'YES' : '', c.nullable ? 'YES' : 'NO', c.include && t.include ? 'YES' : 'NO');
      rows.push(values.join(','));
    }
  }
  rows.push('');

  // Checklist sheet
  rows.push('MIGRATION CHECKLIST');
  rows.push('Phase,Task,Status');
  const tasks = [
    ['Pre-Migration', 'Backup MySQL database', ''],
    ['Pre-Migration', 'Backup PostgreSQL database', ''],
    ['Pre-Migration', 'Test on staging environment', ''],
    ['Pre-Migration', 'Review this mapping document', ''],
    ['Pre-Migration', 'Verify data type conversions', ''],
    ['Migration', 'Create PostgreSQL schemas', ''],
    ['Migration', 'Create PostgreSQL tables', ''],
    ['Migration', 'Migrate data', ''],
    ['Migration', 'Create indexes', ''],
    ['Post-Migration', 'Verify row counts', ''],
    ['Post-Migration', 'Test application with new schema', ''],
    ['Post-Migration', 'Monitor for errors', ''],
    ['Post-Migration', 'Update connection strings', ''],
  ];
  for (const [phase, task, status] of tasks) {
    rows.push(`${phase},${task},${status}`);
  }

  return rows.join('\n');
}
