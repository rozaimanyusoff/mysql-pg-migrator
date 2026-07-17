import type { TransferCapabilityReport } from './server-capabilities';
import type { RunExecutionPolicy } from './types';

export const DEFAULT_CHUNK_ROWS = 1_000;
export const MIN_CHUNK_ROWS = 100;
export const MAX_CHUNK_ROWS = 5_000;

function clamp(value: number, ceiling = MAX_CHUNK_ROWS): number {
  return Math.max(MIN_CHUNK_ROWS, Math.min(MAX_CHUNK_ROWS, ceiling, Math.floor(value)));
}

export function createRunExecutionPolicy(
  capability?: TransferCapabilityReport | null,
  requestedChunkRows?: number | null,
): RunExecutionPolicy {
  const fixed = requestedChunkRows != null && Number.isFinite(requestedChunkRows);
  const concurrentCeilingRows = clamp(capability?.concurrencyAdjustedMaxChunkRows ?? capability?.maxSafeBatchRows ?? MAX_CHUNK_ROWS);
  const singleRunCeilingRows = clamp(capability?.singleRunMaxChunkRows ?? MAX_CHUNK_ROWS);
  const safeCeilingRows = fixed ? singleRunCeilingRows : concurrentCeilingRows;
  const recommendedChunkRows = clamp(capability?.recommendedBatchRows ?? DEFAULT_CHUNK_ROWS, concurrentCeilingRows);
  return {
    mode: fixed ? 'fixed' : 'auto',
    chunkRows: fixed ? clamp(requestedChunkRows, safeCeilingRows) : recommendedChunkRows,
    recommendedChunkRows,
    concurrentCeilingRows,
    safeCeilingRows,
    singleRunCeilingRows,
    assumedConcurrentRuns: capability?.assumedConcurrentRuns ?? 1,
    maxConcurrentTables: Math.max(1, Math.min(5, capability?.recommendedConcurrentTables ?? 5)),
    writerMethod: capability?.currentWriter ?? 'copy-staging',
    performanceTargetSeconds: capability?.performanceTargetSeconds ?? 15 * 60,
    source: capability ? 'preflight' : 'system_default',
    capturedAt: new Date().toISOString(),
  };
}

export function runChunkRows(policy?: RunExecutionPolicy | null): number {
  return clamp(policy?.chunkRows ?? DEFAULT_CHUNK_ROWS, policy?.safeCeilingRows ?? MAX_CHUNK_ROWS);
}
