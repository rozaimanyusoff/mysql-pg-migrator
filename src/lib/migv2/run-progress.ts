import type { MigRunTableState, TableRunStatus } from './types';

const TERMINAL_TABLE_STATUSES = new Set<TableRunStatus>([
  'completed', 'completed_with_issues', 'failed', 'rolled_back', 'aborted',
]);

export function isEmptyTableResult(state: MigRunTableState): boolean {
  return state.status === 'completed' && state.rowsSource === 0;
}

export function isMigratedTableResult(state: MigRunTableState): boolean {
  return (state.status === 'completed' || state.status === 'completed_with_issues') && state.rowsSource > 0;
}

export function displayTableStatus(state: MigRunTableState): TableRunStatus | 'empty' {
  return isEmptyTableResult(state) ? 'empty' : state.status;
}

export interface RunTableProgress {
  total: number;
  finished: number;
  remaining: number;
  completed: number;
  empty: number;
  failed: number;
  issues: number;
}

export function summarizeRunTableProgress(states: MigRunTableState[]): RunTableProgress {
  const total = states.length;
  const finished = states.filter(state => TERMINAL_TABLE_STATUSES.has(state.status)).length;
  return {
    total,
    finished,
    remaining: Math.max(0, total - finished),
    completed: states.filter(isMigratedTableResult).length,
    empty: states.filter(isEmptyTableResult).length,
    failed: states.filter(state => state.status === 'failed').length,
    issues: states.filter(state => state.status === 'completed_with_issues').length,
  };
}
