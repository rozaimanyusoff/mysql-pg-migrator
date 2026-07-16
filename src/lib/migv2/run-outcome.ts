import type { MigRunTableState, TableRunStatus } from './types';

export function tableHasIssues(state: MigRunTableState): boolean {
  return state.rowsErrored > 0 || (state.rowsRejected ?? 0) > 0;
}

export function completedTableStatus(state: MigRunTableState): Extract<TableRunStatus, 'completed' | 'completed_with_issues'> {
  return tableHasIssues(state) ? 'completed_with_issues' : 'completed';
}

export function canPersistWatermark(state: MigRunTableState): boolean {
  return state.newWatermark != null
    && state.rowsErrored === 0
    && (state.status === 'completed' || state.status === 'completed_with_issues');
}

export interface RollbackAvailability {
  available: boolean;
  insertedRows: number;
  reason: string | null;
}

/** Exact rollback is possible only when every inserted row has a recorded PK. */
export function rollbackAvailability(state: MigRunTableState): RollbackAvailability {
  if (state.rowsMigrated === 0) return { available: true, insertedRows: 0, reason: null };
  if (state.pkOverflow) {
    return { available: false, insertedRows: state.rowsMigrated, reason: 'Inserted-row evidence exceeded the rollback tracking limit.' };
  }
  if (!state.targetPkCol) {
    return { available: false, insertedRows: state.rowsMigrated, reason: 'The target has no tracked primary key for exact rollback.' };
  }
  if (state.insertedPks.length !== state.rowsMigrated) {
    return { available: false, insertedRows: state.rowsMigrated, reason: 'This run inserted or updated rows without a complete inserted-key list.' };
  }
  return { available: true, insertedRows: state.rowsMigrated, reason: null };
}
