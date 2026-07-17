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
  code?: 'target_schema_compatibility' | 'binding_missing' | 'data_conversion';
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

interface TargetColumnDefinition { name: string; nullable: boolean; defaultValue: string | null }

async function targetColumnDefinitions(conn: MigConn, schema: string, table: string): Promise<TargetColumnDefinition[]> {
  if (conn.type === 'postgresql') {
    return withPg(conn, async c => {
      const { rows } = await c.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
        'SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
        [schema, table]
      );
      return rows.map(row => ({ name: row.column_name, nullable: row.is_nullable === 'YES', defaultValue: row.column_default }));
    });
  }
  return withMysql(conn, async c => {
    const [rows] = await c.query<any[]>(
      'SELECT column_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema = ? AND table_name = ?',
      [schema, table]
    );
    return (rows as Array<{ column_name: string; is_nullable: string; column_default: string | null }>).map(row => ({
      name: row.column_name, nullable: row.is_nullable === 'YES', defaultValue: row.column_default,
    }));
  });
}

function quoteIdentifier(value: string, type: MigConn['type']): string {
  return type === 'postgresql' ? `"${value.replace(/"/g, '""')}"` : `\`${value.replace(/`/g, '``')}\``;
}

async function sampleColumnValues(conn: MigConn, schema: string, table: string, column: string): Promise<unknown[]> {
  const qualified = `${quoteIdentifier(schema, conn.type)}.${quoteIdentifier(table, conn.type)}`;
  const identifier = quoteIdentifier(column, conn.type);
  if (conn.type === 'postgresql') {
    return withPg(conn, async client => (await client.query(`SELECT ${identifier} AS value FROM ${qualified} WHERE ${identifier} IS NOT NULL LIMIT 100`)).rows.map(row => row.value));
  }
  return withMysql(conn, async client => {
    const [rows] = await client.query<any[]>(`SELECT ${identifier} AS value FROM ${qualified} WHERE ${identifier} IS NOT NULL LIMIT 100`);
    return rows.map(row => row.value);
  });
}

function temporalKind(targetType: string): 'date' | 'time' | 'timestamp' | null {
  const normalized = targetType.trim().toLowerCase();
  if (normalized === 'date') return 'date';
  if (normalized === 'time' || normalized.startsWith('time(') || normalized.startsWith('time without') || normalized.startsWith('time with')) return 'time';
  if (normalized === 'datetime' || normalized.includes('timestamp')) return 'timestamp';
  return null;
}

function temporalValueIsParseable(value: unknown, kind: 'date' | 'time' | 'timestamp'): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  const raw = String(value).trim();
  if (!raw || /^0{4}-0{2}-0{2}/.test(raw)) return false;
  if (kind === 'time') {
    const match = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    return !!match && Number(match[1]) < 24 && Number(match[2]) < 60 && Number(match[3] ?? 0) < 60;
  }
  const normalized = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/)
    ? raw.replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/, '$3-$2-$1')
    : raw;
  const parsed = Date.parse(kind === 'date' ? `${normalized.slice(0, 10)}T00:00:00Z` : normalized.replace(' ', 'T'));
  return Number.isFinite(parsed);
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
      const exists = await tableExists(target, tm.target.schema, targetTableName(tm));
      if (!exists) {
        issues.push({
          tableId: tm.id,
          side: 'target',
          message: `Existing target ${target.database}.${tm.target.schema}.${targetTableName(tm)} no longer exists. Rebind the saved job before running.`,
        });
        continue;
      }
      const definitions = await targetColumnDefinitions(target, tm.target.schema, targetTableName(tm));
      const actualColumns = new Set(definitions.map(column => column.name.toLowerCase()));
      const mappedColumns = new Set(tm.columns.filter(column => column.include).map(column => (column.targetName?.trim() || column.targetCol).toLowerCase()).filter(Boolean));
      const missingMappings = [...mappedColumns].filter(column => !actualColumns.has(column));
      if (missingMappings.length) {
        issues.push({
          tableId: tm.id,
          side: 'target',
          message: `Existing target mapping refers to missing column${missingMappings.length !== 1 ? 's' : ''}: ${missingMappings.slice(0, 5).join(', ')}.`,
        });
      }
      const requiredUnmapped = definitions.filter(column => !column.nullable && column.defaultValue == null && !mappedColumns.has(column.name.toLowerCase()));
      if (requiredUnmapped.length) {
        issues.push({
          tableId: tm.id,
          side: 'target',
          message: `Existing target requires source mappings for: ${requiredUnmapped.slice(0, 5).map(column => column.name).join(', ')}.`,
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
      for (const column of tm.columns.filter(column => column.include && column.sourceCol && temporalKind(column.targetType))) {
        try {
          const kind = temporalKind(column.targetType)!;
          const samples = await sampleColumnValues(tableSource, tm.source.schema, tm.source.table, column.sourceCol!);
          const invalid = samples.filter(value => !temporalValueIsParseable(value, kind)).length;
          if (invalid > 0) {
            const blocksRequiredTarget = (column.targetNullable ?? column.nullable) === false && (column.nullPolicy ?? 'fail') === 'fail';
            issues.push({
              level: blocksRequiredTarget ? 'error' : 'warning',
              code: 'data_conversion',
              message: `${column.sourceCol} → ${column.targetName?.trim() || column.targetCol} (${column.targetType}): ${invalid} of ${samples.length} sampled non-NULL value${samples.length !== 1 ? 's' : ''} cannot be parsed. Invalid values become NULL; configure a fallback/reject policy or clean the source data.`,
            });
          } else if (samples.length > 0) {
            issues.push({
              level: 'info',
              code: 'data_conversion',
              message: `${column.sourceCol} → ${column.targetName?.trim() || column.targetCol}: ${samples.length} sampled value${samples.length !== 1 ? 's' : ''} can be converted to ${column.targetType}.`,
            });
          }
        } catch (err) {
          issues.push({ level: 'warning', code: 'data_conversion', message: `Could not sample ${column.sourceCol} for ${column.targetType} conversion: ${err instanceof Error ? err.message : String(err)}` });
        }
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
          const definitions = await targetColumnDefinitions(target, tm.target.schema, targetTableName(tm));
          const actualColumns = new Set(definitions.map(column => column.name.toLowerCase()));
          const expectedColumns = tm.columns.filter(column => column.include).flatMap(column => [
            (column.targetName?.trim() || column.targetCol).toLowerCase(),
            ...(column.keepLegacyAs ? [column.keepLegacyAs.toLowerCase()] : []),
          ]).filter(Boolean);
          const missing = expectedColumns.filter(column => !actualColumns.has(column));
          if (missing.length) {
            issues.push({
              level: 'error',
              code: 'target_schema_compatibility',
              message: `Existing target: ${missing.length} mapped column${missing.length !== 1 ? 's do' : ' does'} not exist (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}). Map each source column to a physical target column in Migration.`,
            });
          }
          const mappedTargets = new Set(expectedColumns);
          const requiredUnmapped = definitions.filter(column => !column.nullable && column.defaultValue == null && !mappedTargets.has(column.name.toLowerCase()));
          if (requiredUnmapped.length) {
            issues.push({
              level: 'error',
              code: 'target_schema_compatibility',
              message: `Existing target has ${requiredUnmapped.length} required column${requiredUnmapped.length !== 1 ? 's' : ''} without a source mapping or target default (${requiredUnmapped.slice(0, 5).map(column => column.name).join(', ')}${requiredUnmapped.length > 5 ? ', …' : ''}).`,
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
