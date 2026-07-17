import type { ColumnMap, MigrationAdvisory, TableMap } from './types';

export interface RecurringConfigIssue {
  tableId: string;
  sourceKey: string;
  message: string;
}

export type MigrationConfigNotice = MigrationAdvisory;

export interface MigrationAssessment {
  oneOffReady: boolean;
  recurringReady: boolean;
  oneOffIssues: RecurringConfigIssue[];
  recurringIssues: RecurringConfigIssue[];
  notices: MigrationConfigNotice[];
}

function targetColumnName(column: ColumnMap): string {
  return column.targetName?.trim() || column.targetCol;
}

function inferredKey(table: TableMap): string | null {
  return table.columns.find(column =>
    column.include && column.sourceCol && (
      column.conversion === 'serial_to_uuid'
      || column.sourceCol.toLowerCase() === 'id'
      || targetColumnName(column).toLowerCase() === 'id'
    )
  )?.sourceCol ?? null;
}

function validateBaseTable(table: TableMap): RecurringConfigIssue[] {
  if (!table.include) return [];
  const sourceKey = `${table.source.schema}.${table.source.table}`;
  const issue = (message: string): RecurringConfigIssue => ({ tableId: table.id, sourceKey, message });
  const issues: RecurringConfigIssue[] = [];
  const includedColumns = table.columns.filter(column => column.include);

  if (!table.target.schema || !(table.targetAlias?.trim() || table.target.table)) issues.push(issue('Target table has not been configured.'));
  if (table.targetMode === 'existing' && !includedColumns.length) issues.push(issue('Column mapping has not been configured.'));

  for (const column of includedColumns) {
    if (!targetColumnName(column)) {
      issues.push(issue(`Source column "${column.sourceCol ?? '(target-only)'}" has not been assigned to a target column.`));
      continue;
    }
    if (column.conversion === 'serial_to_uuid' && column.targetType.toLowerCase() !== 'uuid') {
      issues.push(issue(`Column "${targetColumnName(column)}" uses serial-to-UUID conversion but its target type is not UUID.`));
    }
    if (column.sourceCol === null && !column.nullable && (column.defaultValue == null || column.defaultValue === '')) {
      issues.push(issue(`Target-only column "${targetColumnName(column)}" is NOT NULL and has no default.`));
    }
    const targetNullable = column.targetNullable ?? column.nullable;
    if (column.sourceCol !== null && !targetNullable) {
      const policy = column.nullPolicy ?? 'fail';
      if (policy === 'target_default' && (column.targetDefaultValue ?? column.defaultValue) == null) {
        issues.push(issue(`Column "${targetColumnName(column)}" selects target default for NULL, but the target has no default.`));
      }
      if (policy === 'fallback' && (column.nullFallback == null || column.nullFallback === '')) {
        issues.push(issue(`Column "${targetColumnName(column)}" needs a fallback value for NULL.`));
      }
    }
  }
  return issues;
}

function validateRecurringTableOnly(table: TableMap): RecurringConfigIssue[] {
  if (!table.include) return [];
  const sourceKey = `${table.source.schema}.${table.source.table}`;
  const issue = (message: string): RecurringConfigIssue => ({ tableId: table.id, sourceKey, message });
  const issues: RecurringConfigIssue[] = [];
  const includedColumns = table.columns.filter(column => column.include);

  if (!includedColumns.length) issues.push(issue('Column mapping has not been configured for recurring execution.'));

  if (table.syncMode === 'incremental') {
    if (!table.incrementalCol) {
    issues.push(issue('Incremental changes need a tracking column, or change the strategy to Full scan · Insert & update.'));
    } else if (includedColumns.length && !includedColumns.some(column => column.sourceCol === table.incrementalCol)) {
      issues.push(issue(`Tracking column "${table.incrementalCol}" is not included in the mapping.`));
    }
    if (table.incrementalStrategy === 'timestamp' && !table.incrementalTieCol && !inferredKey(table)) {
      issues.push(issue('Timestamp incremental sync needs a unique tie-breaker column.'));
    }
  }

  if ((table.syncMode ?? 'full') === 'full' && table.fullSyncStrategy === 'upsert' && !inferredKey(table)) {
    issues.push(issue('Full scan · Insert & update needs a mapped key, normally the source/target id column.'));
  }

  return issues;
}

function configurationNotices(tables: TableMap[]): MigrationConfigNotice[] {
  const included = tables.filter(table => table.include);
  const notices: MigrationConfigNotice[] = [];
  const indexByKey = new Map<string, number>();
  included.forEach((table, index) => {
    indexByKey.set(`${table.source.schema}.${table.source.table}`.toLowerCase(), index);
    indexByKey.set(`${table.target.schema}.${table.targetAlias?.trim() || table.target.table}`.toLowerCase(), index);
  });

  included.forEach((table, childIndex) => {
    const sourceKey = `${table.source.schema}.${table.source.table}`;
    const refs = new Set(table.columns
      .filter(column => column.include && column.fkRef)
      .map(column => column.fkRef!.split('.').slice(-2).join('.').toLowerCase()));
    for (const ref of refs) {
      const parentIndex = indexByKey.get(ref);
      if (parentIndex !== undefined && parentIndex > childIndex) {
        notices.push({
          tableId: table.id,
          sourceKey,
          level: 'warning',
          message: `References "${ref}" which is ordered later. Move the parent earlier if the target enforces foreign keys.`,
          reason: `This table references "${ref}", but that parent is ordered later in the job.`,
          impact: 'The recurring run may hit a foreign-key violation when the target enforces that relationship.',
          action: 'Move the referenced parent table earlier than this table in the job order.',
        });
      }
    }
    if ((table.syncMode ?? 'full') === 'full') {
      notices.push(table.fullSyncStrategy === 'upsert'
        ? {
            tableId: table.id,
            sourceKey,
            level: 'info',
            message: 'Full scan · Insert & update does not mirror source deletions.',
            reason: 'Upsert inserts new rows and updates matching rows, but it does not remove target rows missing from the source.',
            impact: 'Deleted source records can remain in the target after recurring runs.',
            action: 'Accept this retention behaviour or manage target deletions through a separate reviewed process.',
          }
        : {
            tableId: table.id,
            sourceKey,
            level: 'warning',
            message: 'Full scan · Insert new only does not copy updates to rows already present in the target.',
            reason: 'Insert missing only adds rows whose key is not already present in the target.',
            impact: 'Changes to existing source records will not be reflected in the target.',
            action: 'Use Full scan · Insert & update when a mapped key is available, or configure Incremental changes when appropriate.',
          });
    }
  });
  return notices;
}

export function assessMigrationTables(tables: TableMap[]): MigrationAssessment {
  const included = tables.filter(table => table.include);
  const jobIssue = (): RecurringConfigIssue => ({ tableId: '', sourceKey: 'job', message: 'No tables are included in this job.' });
  const oneOffIssues = included.length ? included.flatMap(validateBaseTable) : [jobIssue()];
  const recurringOnlyIssues = included.flatMap(validateRecurringTableOnly);
  const recurringIssues = [...oneOffIssues, ...recurringOnlyIssues];
  return {
    oneOffReady: oneOffIssues.length === 0,
    recurringReady: recurringIssues.length === 0,
    oneOffIssues,
    recurringIssues,
    notices: configurationNotices(tables),
  };
}

export function validateRecurringTable(table: TableMap): RecurringConfigIssue[] {
  if (!table.include) return [];
  return assessMigrationTables([table]).recurringIssues;
}

export function validateRecurringTables(tables: TableMap[]): RecurringConfigIssue[] {
  return assessMigrationTables(tables).recurringIssues;
}
