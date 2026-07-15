import os from 'os';
import fs from 'fs';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import type { MigConn, MigJob } from './types';
import { MAX_CONCURRENT_MIGRATIONS } from './run-store.ts';
import { MAX_CONCURRENT_TABLE_WORKERS } from './table-worker-pool.ts';

const DEFAULT_CHUNK_ROWS = 1_000;
const MIN_CHUNK_ROWS = 100;
const SINGLE_RUN_CHUNK_LIMIT = 5_000;
const CHUNK_MEMORY_BUDGET_PERCENT = 10;

export interface RuntimeCapability {
  hostname: string;
  platform: string;
  cpuCores: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  loadAverage1m: number;
  workspaceFreeMb: number | null;
}

export interface DatabaseCapability {
  type: 'mysql' | 'postgresql';
  version: string | null;
  latencyMs: number | null;
  settings: Record<string, string>;
  metrics: Record<string, number>;
  permissions: Record<string, boolean>;
  warnings: string[];
  error?: string;
}

export interface TransferCapabilityReport {
  runtime: RuntimeCapability;
  source: DatabaseCapability;
  target: DatabaseCapability;
  currentBatchRows: number;
  recommendedBatchRows: number;
  /** Effective ceiling after accounting for all concurrently active runs. */
  maxSafeBatchRows: number;
  singleRunMaxChunkRows: number;
  concurrencyAdjustedMaxChunkRows: number;
  assumedConcurrentRuns: number;
  estimatedWorkingRowBytes: number;
  chunkMemoryBudgetPercent: number;
  chunkRecommendationReasons: string[];
  recommendedMethod: 'copy' | 'multi-row-insert';
  currentWriter: 'copy-staging' | 'multi-row' | 'row-by-row';
  recommendedConcurrentTables: number;
  performanceTargetSeconds: number;
  targetRowsPerSecond: number;
  limitingFactors: string[];
  recommendations: string[];
  limitations: string[];
}

export interface ChunkCapability {
  recommendedBatchRows: number;
  maxSafeBatchRows: number;
  singleRunMaxChunkRows: number;
  concurrencyAdjustedMaxChunkRows: number;
  assumedConcurrentRuns: number;
  estimatedWorkingRowBytes: number;
  chunkMemoryBudgetPercent: number;
  chunkRecommendationReasons: string[];
}

function mb(bytes: number): number { return Math.round(bytes / 1024 / 1024); }

function estimatedColumnBytes(type: string): number {
  const normalized = type.trim().toLowerCase();
  const length = normalized.match(/(?:var)?char\s*\(\s*(\d+)\s*\)/)?.[1];
  if (length) return Math.max(64, Math.min(2_048, Number(length) * 2));
  if (/json|jsonb/.test(normalized)) return 2_048;
  if (/bytea|blob|binary|image/.test(normalized)) return 4_096;
  if (/text|xml/.test(normalized)) return 512;
  if (/\[\]|array/.test(normalized)) return 2_048;
  if (/uuid/.test(normalized)) return 48;
  if (/timestamp|datetime|interval/.test(normalized)) return 32;
  if (/date|time/.test(normalized)) return 24;
  if (/numeric|decimal|double|real|float|money/.test(normalized)) return 32;
  if (/bigint|integer|smallint|serial|boolean|bool/.test(normalized)) return 16;
  return 256;
}

/**
 * Estimates the live JS row footprint, including object/string conversion
 * overhead. This deliberately favours a conservative chunk recommendation;
 * it is not an estimate of the row's on-disk database size.
 */
export function estimateWorkingRowBytes(job: MigJob): number {
  const included = job.tables.filter(table => table.include);
  const largestRow = Math.max(0, ...included.map(table => table.columns
    .filter(column => column.include)
    .reduce((bytes, column) => bytes + estimatedColumnBytes(column.targetType) + 64, 256)));
  return Math.max(512, Math.ceil(largestRow * 2.5));
}

export function calculateChunkCapability(
  job: MigJob,
  freeMemoryMb: number,
  assumedConcurrentRuns = MAX_CONCURRENT_MIGRATIONS,
): ChunkCapability {
  const concurrency = Math.max(1, Math.floor(assumedConcurrentRuns));
  const estimatedWorkingRowBytes = estimateWorkingRowBytes(job);
  const memoryBudgetBytes = Math.max(0, freeMemoryMb) * 1024 * 1024 * (CHUNK_MEMORY_BUDGET_PERCENT / 100);
  const rowsForMemory = (budget: number) => Math.max(MIN_CHUNK_ROWS, Math.floor(budget / estimatedWorkingRowBytes));
  const singleRunMaxChunkRows = Math.min(SINGLE_RUN_CHUNK_LIMIT, rowsForMemory(memoryBudgetBytes));
  const concurrencyAdjustedMaxChunkRows = Math.min(singleRunMaxChunkRows, rowsForMemory(memoryBudgetBytes / concurrency));
  const recommendedBatchRows = Math.min(DEFAULT_CHUNK_ROWS, concurrencyAdjustedMaxChunkRows);
  const chunkRecommendationReasons = [
    `Auto-selection is capped at ${DEFAULT_CHUNK_ROWS.toLocaleString()} rows for predictable run behaviour.`,
    `${CHUNK_MEMORY_BUDGET_PERCENT}% of currently free application memory is reserved for migration chunks.`,
    `The memory budget is shared across up to ${concurrency} concurrent migration run${concurrency === 1 ? '' : 's'}.`,
  ];
  if (concurrencyAdjustedMaxChunkRows < singleRunMaxChunkRows) {
    chunkRecommendationReasons.push(`Concurrency reduces the ceiling from ${singleRunMaxChunkRows.toLocaleString()} to ${concurrencyAdjustedMaxChunkRows.toLocaleString()} rows.`);
  }
  if (singleRunMaxChunkRows === SINGLE_RUN_CHUNK_LIMIT) {
    chunkRecommendationReasons.push(`${SINGLE_RUN_CHUNK_LIMIT.toLocaleString()} rows is the product ceiling for a single run, not an automatic selection.`);
  }
  return {
    recommendedBatchRows,
    maxSafeBatchRows: concurrencyAdjustedMaxChunkRows,
    singleRunMaxChunkRows,
    concurrencyAdjustedMaxChunkRows,
    assumedConcurrentRuns: concurrency,
    estimatedWorkingRowBytes,
    chunkMemoryBudgetPercent: CHUNK_MEMORY_BUDGET_PERCENT,
    chunkRecommendationReasons,
  };
}

function runtimeCapability(): RuntimeCapability {
  let workspaceFreeMb: number | null = null;
  try { workspaceFreeMb = mb(Number(fs.statfsSync(process.cwd()).bavail) * Number(fs.statfsSync(process.cwd()).bsize)); }
  catch { /* unavailable on some runtimes */ }
  return {
    hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`,
    cpuCores: os.cpus().length, totalMemoryMb: mb(os.totalmem()), freeMemoryMb: mb(os.freemem()),
    loadAverage1m: Number(os.loadavg()[0].toFixed(2)), workspaceFreeMb,
  };
}

async function pgCapability(conn: MigConn, targetSchemas: string[]): Promise<DatabaseCapability> {
  const result: DatabaseCapability = { type: 'postgresql', version: null, latencyMs: null, settings: {}, metrics: {}, permissions: {}, warnings: [] };
  const client = new PgClient({ host: conn.host, port: conn.port, database: conn.database, user: conn.username, password: conn.password, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const timings: number[] = [];
    for (let i = 0; i < 3; i++) { const start = Date.now(); await client.query('SELECT 1'); timings.push(Date.now() - start); }
    result.latencyMs = Math.round(timings.reduce((sum, value) => sum + value, 0) / timings.length);
    const version = await client.query<{ version: string }>('SELECT version()');
    result.version = version.rows[0]?.version ?? null;
    const names = ['server_version_num', 'max_connections', 'shared_buffers', 'work_mem', 'maintenance_work_mem', 'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'synchronous_commit', 'wal_level', 'max_wal_size', 'checkpoint_timeout'];
    const settings = await client.query<{ name: string; setting: string; unit: string | null }>(
      'SELECT name, setting, unit FROM pg_settings WHERE name = ANY($1::text[])', [names]
    );
    for (const row of settings.rows) result.settings[row.name] = row.unit ? `${row.setting} ${row.unit}` : row.setting;
    const metrics = await client.query<{ connections: string; database_bytes: string; is_superuser: boolean }>(
      `SELECT (SELECT COUNT(*)::text FROM pg_stat_activity WHERE datname = current_database()) AS connections,
              pg_database_size(current_database())::text AS database_bytes,
              COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS is_superuser`
    );
    result.metrics.currentConnections = Number(metrics.rows[0]?.connections ?? 0);
    result.metrics.databaseSizeMb = mb(Number(metrics.rows[0]?.database_bytes ?? 0));
    result.permissions.connect = true;
    result.permissions.sessionReplicationRole = Boolean(metrics.rows[0]?.is_superuser);
    for (const schema of [...new Set(targetSchemas)]) {
      const permission = await client.query<{ usage: boolean; create: boolean }>(
        `SELECT COALESCE(has_schema_privilege(current_user, to_regnamespace($1), 'USAGE'), false) AS usage,
                COALESCE(has_schema_privilege(current_user, to_regnamespace($1), 'CREATE'), false) AS create`, [schema]
      );
      result.permissions[`schema:${schema}:usage`] = Boolean(permission.rows[0]?.usage);
      result.permissions[`schema:${schema}:create`] = Boolean(permission.rows[0]?.create);
    }
    const maxConnections = Number(result.settings.max_connections ?? 0);
    if (maxConnections > 0 && result.metrics.currentConnections / maxConnections >= 0.8) result.warnings.push('PostgreSQL connection usage is at or above 80%.');
    if (result.settings.statement_timeout && Number.parseFloat(result.settings.statement_timeout) > 0) result.warnings.push(`statement_timeout is ${result.settings.statement_timeout}; large writes may be cancelled.`);
    if (!result.permissions.sessionReplicationRole) result.warnings.push('Current PostgreSQL role cannot bypass constraints with session_replication_role.');
  } catch (err) { result.error = err instanceof Error ? err.message : String(err); }
  finally { try { await client.end(); } catch { /* ignore */ } }
  return result;
}

async function mysqlCapability(conn: MigConn): Promise<DatabaseCapability> {
  const result: DatabaseCapability = { type: 'mysql', version: null, latencyMs: null, settings: {}, metrics: {}, permissions: { select: true }, warnings: [] };
  let client: mysql.Connection | null = null;
  try {
    client = await mysql.createConnection({ host: conn.host, port: conn.port, database: conn.database, user: conn.username, password: conn.password, connectTimeout: 10_000, dateStrings: true });
    const timings: number[] = [];
    for (let i = 0; i < 3; i++) { const start = Date.now(); await client.query('SELECT 1'); timings.push(Date.now() - start); }
    result.latencyMs = Math.round(timings.reduce((sum, value) => sum + value, 0) / timings.length);
    const [versionRows] = await client.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
    result.version = String(versionRows[0]?.version ?? '');
    const [variables] = await client.query<mysql.RowDataPacket[]>(
      "SHOW VARIABLES WHERE Variable_name IN ('max_allowed_packet','net_read_timeout','net_write_timeout','wait_timeout','max_connections')"
    );
    for (const row of variables) result.settings[String(row.Variable_name)] = String(row.Value);
    const [status] = await client.query<mysql.RowDataPacket[]>("SHOW STATUS LIKE 'Threads_connected'");
    result.metrics.currentConnections = Number(status[0]?.Value ?? 0);
    const packet = Number(result.settings.max_allowed_packet ?? 0);
    if (packet > 0 && packet < 16 * 1024 * 1024) result.warnings.push(`max_allowed_packet is only ${mb(packet)} MB; large batches may fail.`);
  } catch (err) { result.error = err instanceof Error ? err.message : String(err); }
  finally { if (client) try { await client.end(); } catch { /* ignore */ } }
  return result;
}

async function databaseCapability(conn: MigConn, targetSchemas: string[] = []): Promise<DatabaseCapability> {
  return conn.type === 'postgresql' ? pgCapability(conn, targetSchemas) : mysqlCapability(conn);
}

export async function inspectServerCapabilities(job: MigJob, source: MigConn, target: MigConn): Promise<TransferCapabilityReport> {
  const runtime = runtimeCapability();
  const targetSchemas = job.tables.filter(table => table.include).map(table => table.target.schema);
  const [sourceCapability, targetCapability] = await Promise.all([
    databaseCapability(source), databaseCapability(target, targetSchemas),
  ]);
  const hasIncremental = job.tables.some(table => table.include && table.syncMode === 'incremental');
  const chunkCapability = calculateChunkCapability(job, runtime.freeMemoryMb);
  const limitingFactors: string[] = [];
  const recommendations: string[] = [];
  if (runtime.freeMemoryMb < 2_048) limitingFactors.push('Application server has less than 2 GB free memory.');
  if ((sourceCapability.latencyMs ?? 0) > 20) limitingFactors.push(`Source database latency is ${sourceCapability.latencyMs} ms.`);
  if ((targetCapability.latencyMs ?? 0) > 20) limitingFactors.push(`Target database latency is ${targetCapability.latencyMs} ms.`);
  if (chunkCapability.concurrencyAdjustedMaxChunkRows < chunkCapability.singleRunMaxChunkRows) {
    limitingFactors.push(`Concurrent-run memory budget limits chunks to ${chunkCapability.concurrencyAdjustedMaxChunkRows.toLocaleString()} rows when up to ${chunkCapability.assumedConcurrentRuns} runs are active.`);
  }
  limitingFactors.push(...sourceCapability.warnings, ...targetCapability.warnings);
  recommendations.push(target.type === 'postgresql'
    ? 'Use COPY into a temporary staging table, then merge into the target for conflict-safe bulk writes.'
    : 'Use multi-row INSERT for bulk writes.');
  recommendations.push('Keep source and target connections open for the duration of each run.');
  recommendations.push('Use indexed keyset pagination instead of OFFSET for large source tables.');
  recommendations.push('After application memory, concurrency or database tuning changes, run Pre-flight again; existing run policies remain unchanged.');
  const recommendedConcurrentTables = Math.max(1, Math.min(
    MAX_CONCURRENT_TABLE_WORKERS,
    job.tables.filter(table => table.include).length,
    runtime.cpuCores || 1,
  ));
  return {
    runtime, source: sourceCapability, target: targetCapability,
    currentBatchRows: DEFAULT_CHUNK_ROWS, ...chunkCapability,
    recommendedMethod: target.type === 'postgresql' && !hasIncremental ? 'copy' : 'multi-row-insert',
    currentWriter: target.type === 'postgresql' ? 'copy-staging' : 'multi-row',
    recommendedConcurrentTables,
    performanceTargetSeconds: 15 * 60,
    targetRowsPerSecond: 1_400,
    limitingFactors, recommendations,
    limitations: [
      'Remote database CPU, RAM and free disk cannot be read without an OS-level agent or SSH access.',
      'Capability values are advisory; the 15-minute target must be verified with representative row width, constraints and conflict ratio.',
      'The source read chunk and COPY staging batch share the current memory ceiling.',
      'Concurrent migration jobs share the global five-table worker budget, so the 15-minute target assumes sufficient worker capacity is available to this job.',
    ],
  };
}
