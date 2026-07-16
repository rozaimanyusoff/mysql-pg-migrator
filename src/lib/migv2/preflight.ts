import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import type { MigConn, MigJob, TableMap } from './types';
import { inspectServerCapabilities, type TransferCapabilityReport } from './server-capabilities';

// Conservative throughput assumption for ETA (rows/sec written, single-threaded).
// Temporary fallback until capability-based write benchmarking is available.
const ASSUMED_ROWS_PER_SEC = 2000;

export interface PreflightIssue {
  level: 'error' | 'warning' | 'info';
  message: string;
  code?: 'target_schema_compatibility' | 'binding_missing';
}

export interface BindingValidationIssue {
  tableId: string;
  side: 'source' | 'target';
  message: string;
}

export interface PreflightTableCheck {
  tableId: string;
  sourceKey: string;
  targetKey: string;
  sourceRows: number | null;   // null = count failed
  targetExists: boolean;
  issues: PreflightIssue[];
}

export interface PreflightReport {
  ok: boolean;                 // no error-level issues anywhere
  generatedAt: string;
  tableCount: number;
  totalRows: number;
  estimatedSeconds: number;
  source: { reachable: boolean; error?: string };
  target: { reachable: boolean; error?: string };
  capabilities: TransferCapabilityReport;
  performanceTarget?: {
    targetSeconds: number;
    requiredRowsPerSecond: number;
    planningRowsPerSecond: number;
    projectedSeconds: number;
    status: 'expected' | 'at_risk';
    reasons: string[];
  };
  globalIssues: PreflightIssue[];
  tables: PreflightTableCheck[];
}

// ── connection helpers (self-contained; mirrors runner.ts) ────────────────────

async function withPg<T>(conn: MigConn, fn: (c: PgClient) => Promise<T>): Promise<T> {
  const c = new PgClient({
    host: conn.host, port: conn.port,
    database: conn.database || 'postgres',
    user: conn.username, password: conn.password,
    connectionTimeoutMillis: 10_000,
  });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function withMysql<T>(conn: MigConn, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({
    host: conn.host, port: conn.port,
    database: conn.database || undefined,
    user: conn.username, password: conn.password,
    connectTimeout: 10_000, multipleStatements: false,
  });
  try { return await fn(c); } finally { await c.end(); }
}

// ── filtered COUNT(*) mirroring runner's WHERE (range + incremental watermark) ──

function buildCountWhere(
  dbType: 'postgresql' | 'mysql',
  tableMap: TableMap,
  job: MigJob,
): { where: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  const q = (col: string) => dbType === 'postgresql' ? `"${col}"` : `\`${col}\``;
  const p = () => dbType === 'postgresql' ? `$${params.length}` : '?';

  const isIncremental = tableMap.syncMode === 'incremental' && !!tableMap.incrementalCol;
  if (isIncremental && tableMap.lastSyncedValue) {
    params.push(tableMap.lastSyncedValue);
    conds.push(`${q(tableMap.incrementalCol!)} > ${p()}`);
  }
  if (job.filterCol) {
    if (job.filterFrom) { params.push(job.filterFrom); conds.push(`${q(job.filterCol)} >= ${p()}`); }
    if (job.filterTo)   { params.push(job.filterTo);   conds.push(`${q(job.filterCol)} <= ${p()}`); }
  }
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

async function countRows(conn: MigConn, schema: string, table: string, where: string, params: unknown[]): Promise<number> {
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const { rows } = await c.query<{ n: string }>(`SELECT COUNT(*) AS n FROM "${schema}"."${table}" ${where}`, params);
      return Number(rows[0].n);
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query<any[]>(`SELECT COUNT(*) AS n FROM \`${schema}\`.\`${table}\` ${where}`, params);
    return Number((rows as any[])[0].n);
  });
}

async function tableExists(conn: MigConn, schema: string, table: string): Promise<boolean> {
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [schema, table]
      );
      return Number(rows[0].n) > 0;
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query<any[]>(
      `SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
      [schema, table]
    );
    return Number((rows as any[])[0].n) > 0;
  });
}

async function columnNames(conn: MigConn, schema: string, table: string): Promise<Set<string>> {
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const { rows } = await c.query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        [schema, table]
      );
      return new Set(rows.map(row => row.column_name.toLowerCase()));
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query<any[]>(
      'SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
      [schema, table]
    );
    return new Set((rows as Array<{ column_name: string }>).map(row => row.column_name.toLowerCase()));
  });
}

async function ping(conn: MigConn): Promise<{ reachable: boolean; error?: string }> {
  try {
    if (conn.type === 'postgresql') await withPg(conn, c => c.query('SELECT 1'));
    else await withMysql(conn, c => c.query('SELECT 1'));
    return { reachable: true };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function targetTableName(tm: TableMap): string {
  return tm.targetAlias?.trim() || tm.target.table;
}

/**
 * Validate physical saved-job bindings immediately before execution. This is
 * deliberately server-side so a stale browser view cannot bypass rename or
 * deletion detection.
 */
export async function validateMigrationBindings(
  tables: TableMap[],
  source: MigConn,
  target: MigConn,
): Promise<BindingValidationIssue[]> {
  const issues: BindingValidationIssue[] = [];
  for (const tm of tables.filter(table => table.include)) {
    const tableSource = tm.sourceDatabase && tm.sourceDatabase !== source.database
      ? { ...source, database: tm.sourceDatabase }
      : source;
    try {
      if (!await tableExists(tableSource, tm.source.schema, tm.source.table)) {
        issues.push({
          tableId: tm.id,
          side: 'source',
          message: `Source ${tableSource.database}.${tm.source.schema}.${tm.source.table} no longer exists. Rebind the saved job before running.`,
        });
      }
    } catch (err) {
      issues.push({
        tableId: tm.id,
        side: 'source',
        message: `Source binding could not be verified: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    const targetMode = tm.targetMode ?? (tm.target.table === tm.source.table ? 'source_clone' : 'existing');
    if (targetMode !== 'existing') continue;
    try {
      if (!await tableExists(target, tm.target.schema, targetTableName(tm))) {
        issues.push({
          tableId: tm.id,
          side: 'target',
          message: `Existing target ${target.database}.${tm.target.schema}.${targetTableName(tm)} no longer exists. Rebind the saved job before running.`,
        });
      }
    } catch (err) {
      issues.push({
        tableId: tm.id,
        side: 'target',
        message: `Target binding could not be verified: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return issues;
}

// ── main entry ────────────────────────────────────────────────────────────────

export async function runPreflight(job: MigJob, source: MigConn, target: MigConn): Promise<PreflightReport> {
  const included = job.tables.filter(t => t.include);
  const globalIssues: PreflightIssue[] = [];

  const [srcPing, tgtPing] = await Promise.all([ping(source), ping(target)]);

  const tables: PreflightTableCheck[] = [];
  let totalRows = 0;

  for (const tm of included) {
    const issues: PreflightIssue[] = [];
    const tableSource: MigConn = tm.sourceDatabase && tm.sourceDatabase !== source.database
      ? { ...source, database: tm.sourceDatabase }
      : source;

    let sourceRows: number | null = null;
    if (srcPing.reachable) {
      try {
        const { where, params } = buildCountWhere(tableSource.type, tm, job);
        sourceRows = await countRows(tableSource, tm.source.schema, tm.source.table, where, params);
        totalRows += sourceRows;
      } catch (err) {
        issues.push({ level: 'error', code: 'binding_missing', message: `Source unreadable: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    let targetExists = false;
    if (tgtPing.reachable) {
      try {
        targetExists = await tableExists(target, tm.target.schema, targetTableName(tm));
        const targetMode = tm.targetMode ?? (tm.target.table === tm.source.table ? 'source_clone' : 'existing');
        if (!targetExists && targetMode === 'existing') {
          issues.push({
            level: 'error',
            code: 'binding_missing',
            message: `Existing target ${target.database}.${tm.target.schema}.${targetTableName(tm)} no longer exists. Rebind the saved job before scheduling.`,
          });
        }
        if (targetExists && targetMode === 'existing') {
          const actualColumns = await columnNames(target, tm.target.schema, targetTableName(tm));
          const expectedColumns = tm.columns.filter(column => column.include).flatMap(column => [
            (column.targetName?.trim() || column.targetCol).toLowerCase(),
            ...(column.keepLegacyAs ? [column.keepLegacyAs.toLowerCase()] : []),
          ]);
          const missing = expectedColumns.filter(column => !actualColumns.has(column));
          if (missing.length) {
            issues.push({
              level: 'warning',
              code: 'target_schema_compatibility',
              message: `Target schema compatibility: ${missing.length} mapped column${missing.length !== 1 ? 's are' : ' is'} missing (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}). The existing target schema is authoritative; update the mapping in Migration before scheduling.`,
            });
          }
        }
      } catch (err) {
        issues.push({ level: 'error', code: 'binding_missing', message: `Target binding could not be verified: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    tables.push({
      tableId: tm.id,
      sourceKey: `${tm.source.schema}.${tm.source.table}`,
      targetKey: `${tm.target.schema}.${targetTableName(tm)}`,
      sourceRows,
      targetExists,
      issues,
    });
  }

  if (!srcPing.reachable) globalIssues.push({ level: 'error', message: `Source unreachable: ${srcPing.error ?? 'unknown error'}` });
  if (!tgtPing.reachable) globalIssues.push({ level: 'error', message: `Target unreachable: ${tgtPing.error ?? 'unknown error'}` });

  const hasError = globalIssues.some(i => i.level === 'error') || tables.some(t => t.issues.some(i => i.level === 'error'));
  const capabilities = await inspectServerCapabilities(job, source, target);
  if (capabilities.source.error) globalIssues.push({ level: 'warning', message: `Source capability check incomplete: ${capabilities.source.error}` });
  if (capabilities.target.error) globalIssues.push({ level: 'warning', message: `Target capability check incomplete: ${capabilities.target.error}` });

  const targetSeconds = capabilities.performanceTargetSeconds;
  const requiredRowsPerSecond = targetSeconds > 0 ? totalRows / targetSeconds : 0;
  const planningRowsPerSecond = capabilities.targetRowsPerSecond;
  const performanceReasons: string[] = [];
  if (target.type !== 'postgresql') performanceReasons.push('COPY staging is available only for PostgreSQL targets.');
  if (requiredRowsPerSecond > planningRowsPerSecond) performanceReasons.push(`Workload needs ${Math.ceil(requiredRowsPerSecond).toLocaleString()} rows/s, above the ${planningRowsPerSecond.toLocaleString()} rows/s planning baseline.`);
  if (capabilities.estimatedWorkingRowBytes > 5 * 1024) performanceReasons.push('Estimated working row width exceeds 5 KB; large JSON, text or binary values can reduce throughput.');
  if (capabilities.recommendedConcurrentTables < Math.min(5, included.length)) performanceReasons.push(`Application capacity recommends ${capabilities.recommendedConcurrentTables} concurrent table worker${capabilities.recommendedConcurrentTables === 1 ? '' : 's'}, below the requested five.`);
  const projectedSeconds = totalRows ? Math.ceil(totalRows / Math.max(1, planningRowsPerSecond)) : 0;

  return {
    ok: !hasError,
    generatedAt: new Date().toISOString(),
    tableCount: included.length,
    totalRows,
    estimatedSeconds: projectedSeconds || Math.ceil(totalRows / ASSUMED_ROWS_PER_SEC),
    source: srcPing,
    target: tgtPing,
    capabilities,
    performanceTarget: {
      targetSeconds, requiredRowsPerSecond: Number(requiredRowsPerSecond.toFixed(1)),
      planningRowsPerSecond, projectedSeconds,
      status: performanceReasons.length ? 'at_risk' : 'expected',
      reasons: performanceReasons,
    },
    globalIssues,
    tables,
  };
}
