import type { TableMap } from './types';

export function usesUpsertStrategy(table: Pick<TableMap, 'syncMode' | 'fullSyncStrategy' | 'incrementalStrategy' | 'incrementalCol'>): boolean {
  const incremental = table.syncMode === 'incremental' && Boolean(table.incrementalCol);
  return incremental
    ? table.incrementalStrategy === 'timestamp'
    : table.fullSyncStrategy === 'upsert';
}
