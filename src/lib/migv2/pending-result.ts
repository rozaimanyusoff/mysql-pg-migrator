import type { MigRunTableState, TableMap } from './types';

/** Stable identity for a Pending Save result, independent of renamed objects. */
export function pendingResultId(state: MigRunTableState): string {
  return state.pendingId ?? `${state.originRunId ?? 'legacy'}:${state.id}:${state.sourceKey}:${state.targetKey}`;
}

export function pendingState(runId: string, state: MigRunTableState): MigRunTableState {
  return { ...state, pendingId: `${runId}:${state.id}`, originRunId: runId };
}

/** Physical binding identity used only as a safe fallback when table IDs differ. */
export function tableBindingSignature(table: TableMap, fallbackSourceDatabase = ''): string {
  const sourceDatabase = table.sourceDatabase || fallbackSourceDatabase;
  const targetTable = table.targetAlias?.trim() || table.target.table;
  return [sourceDatabase, table.source.schema, table.source.table, table.target.schema, targetTable].join('\u0000');
}

export function pendingTablesToAdd(
  existing: TableMap[],
  pending: TableMap[],
  existingSourceDatabase = '',
  pendingSourceDatabase = '',
): TableMap[] {
  const existingIds = new Set(existing.map(table => table.id));
  const existingBindings = new Set(existing.map(table => tableBindingSignature(table, existingSourceDatabase)));
  return pending.filter(table =>
    !existingIds.has(table.id) && !existingBindings.has(tableBindingSignature(table, pendingSourceDatabase))
  );
}
