import { MigrationConfig } from './types';
import { buildSummary } from './postgres-migrator';

export function generateExcelCSV(config: MigrationConfig): string {
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
  rows.push('MySQL Table,PostgreSQL Schema,PostgreSQL Table,MySQL Column,PostgreSQL Column,PostgreSQL Type,PK,Nullable,Include');
  for (const t of config.tables) {
    for (const c of t.columns) {
      rows.push(
        [
          t.mysqlName,
          t.pgSchema,
          t.pgName,
          c.mysqlName,
          c.pgName,
          c.pgType,
          c.isPrimaryKey ? 'YES' : '',
          c.nullable ? 'YES' : 'NO',
          c.include && t.include ? 'YES' : 'NO',
        ].join(',')
      );
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
