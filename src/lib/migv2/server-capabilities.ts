import os from 'os';
import fs from 'fs';
import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import type { MigConn, MigJob } from './types';

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
  maxSafeBatchRows: number;
  recommendedMethod: 'copy' | 'multi-row-insert';
  currentWriter: 'row-by-row';
  limitingFactors: string[];
  recommendations: string[];
  limitations: string[];
}

function mb(bytes: number): number { return Math.round(bytes / 1024 / 1024); }

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
  const maxColumns = Math.max(1, ...job.tables.filter(table => table.include).map(table => Math.max(1, table.columns.filter(column => column.include).length)));
  const hasIncremental = job.tables.some(table => table.include && table.syncMode === 'incremental');
  const parameterSafeRows = Math.max(1, Math.floor(60_000 / maxColumns));
  const maxSafeBatchRows = Math.min(5_000, parameterSafeRows);
  const recommendedBatchRows = Math.min(1_000, maxSafeBatchRows);
  const limitingFactors: string[] = [];
  const recommendations: string[] = [];
  if (runtime.freeMemoryMb < 2_048) limitingFactors.push('Application server has less than 2 GB free memory.');
  if ((sourceCapability.latencyMs ?? 0) > 20) limitingFactors.push(`Source database latency is ${sourceCapability.latencyMs} ms.`);
  if ((targetCapability.latencyMs ?? 0) > 20) limitingFactors.push(`Target database latency is ${targetCapability.latencyMs} ms.`);
  if (maxSafeBatchRows < 1_000) limitingFactors.push(`${maxColumns} mapped columns limit the safe PostgreSQL parameter budget.`);
  limitingFactors.push(...sourceCapability.warnings, ...targetCapability.warnings);
  recommendations.push('Use multi-row INSERT for incremental/upsert migrations.');
  if (target.type === 'postgresql') recommendations.push('Use COPY FROM STDIN for full migrations into empty target tables.');
  recommendations.push('Keep source and target connections open for the duration of each run.');
  recommendations.push('Use indexed keyset pagination instead of OFFSET for large source tables.');
  return {
    runtime, source: sourceCapability, target: targetCapability,
    currentBatchRows: 1_000, recommendedBatchRows, maxSafeBatchRows,
    recommendedMethod: target.type === 'postgresql' && !hasIncremental ? 'copy' : 'multi-row-insert',
    currentWriter: 'row-by-row', limitingFactors, recommendations,
    limitations: ['Remote database CPU, RAM and free disk cannot be read without an OS-level agent or SSH access.', 'Capability values are advisory; temporary-table write benchmarking is not yet enabled.'],
  };
}
