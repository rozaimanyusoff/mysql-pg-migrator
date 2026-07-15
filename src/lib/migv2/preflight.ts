import { Client as PgClient } from 'pg';
import mysql from 'mysql2/promise';
import type { MigConn, MigJob, TableMap, ColumnMap } from './types';
import { inspectServerCapabilities, type TransferCapabilityReport } from './server-capabilities';

// Conservative throughput assumption for ETA (rows/sec written, single-threaded).
// Temporary fallback until capability-based write benchmarking is available.
const ASSUMED_ROWS_PER_SEC = 2000;

export interface PreflightIssue {
  level: 'error' | 'warning' | 'info';
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

async function ping(conn: MigConn): Promise<{ reachable: boolean; error?: string }> {
  try {
    if (conn.type === 'postgresql') await withPg(conn, c => c.query('SELECT 1'));
    else await withMysql(conn, c => c.query('SELECT 1'));
    return { reachable: true };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── static per-table sanity checks (no DB round-trip) ─────────────────────────

function targetTableName(tm: TableMap): string {
  return tm.targetAlias?.trim() || tm.target.table;
}

function staticColumnIssues(tm: TableMap): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const included = tm.columns.filter(c => c.include);

  if (!included.length) {
    issues.push({ level: 'error', message: 'No columns included — nothing to migrate.' });
  }

  for (const c of included) {
    // serial_to_uuid must target a uuid column
    if (c.conversion === 'serial_to_uuid' && c.targetType.toLowerCase() !== 'uuid') {
      issues.push({ level: 'warning', message: `Column "${c.targetCol}" uses serial→uuid but target type is "${c.targetType}", not uuid.` });
    }
    // target-only NOT NULL column with no default → every insert fails
    if (c.sourceCol === null && !c.nullable && (c.defaultValue == null || c.defaultValue === '')) {
      issues.push({ level: 'error', message: `Target-only column "${c.targetCol}" is NOT NULL with no default — inserts will fail.` });
    }
  }

  // FK columns referencing tables: handled at job level (ordering); here flag fkRef without conversion
  return issues;
}

// FK-ordering: a column with fkRef points at a parent table. If the parent is in
// the job but ordered AFTER this table, the deterministic UUID still resolves, but
// the parent rows won't exist yet if a real FK constraint is enforced at the target.
function fkOrderingIssues(job: MigJob): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const included = job.tables.filter(t => t.include);
  const indexByKey = new Map<string, number>();
  included.forEach((t, i) => {
    indexByKey.set(`${t.source.schema}.${t.source.table}`.toLowerCase(), i);
    indexByKey.set(`${t.target.schema}.${targetTableName(t)}`.toLowerCase(), i);
  });

  included.forEach((t, childIdx) => {
    const refs = new Set<string>();
    for (const c of t.columns.filter(c => c.include && c.fkRef)) {
      refs.add(c.fkRef!.split('.').slice(-2).join('.').toLowerCase());
    }
    for (const ref of refs) {
      const parentIdx = indexByKey.get(ref);
      if (parentIdx === undefined) continue; // parent not in job — deterministic UUID still resolves
      if (parentIdx > childIdx) {
        issues.push({
          level: 'warning',
          message: `"${t.source.schema}.${t.source.table}" references "${ref}" which migrates later — reorder parent first if the target enforces FK constraints.`,
        });
      }
    }
  });
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
    const issues = staticColumnIssues(tm);
    if (tm.syncMode === 'incremental' && !tm.incrementalCol) {
      issues.push({ level: 'error', message: 'Incremental sync requires a tracking column to identify new data.' });
    }
    if (tm.syncMode === 'incremental' && tm.truncateBeforeMigrate) {
      issues.push({ level: 'warning', message: 'Incremental sync conflicts with truncate-before-migrate. Truncate is ignored for scheduled/manual sync runs and should be disabled in the mapping.' });
    }
    if (tm.syncMode === 'incremental' && tm.incrementalStrategy === 'timestamp') {
      const inferredTie = tm.columns.find(c => c.include && c.sourceCol && (c.conversion === 'serial_to_uuid' || c.sourceCol.toLowerCase() === 'id' || c.targetCol.toLowerCase() === 'id'))?.sourceCol;
      if (!tm.incrementalTieCol && !inferredTie) {
        issues.push({ level: 'error', message: 'Timestamp incremental sync requires a unique tie-breaker column to prevent equal-timestamp rows being skipped.' });
      }
    }
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
        issues.push({ level: 'error', message: `Source unreadable: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    let targetExists = false;
    if (tgtPing.reachable) {
      try {
        targetExists = await tableExists(target, tm.target.schema, targetTableName(tm));
        if (targetExists && tm.syncMode !== 'incremental' && !tm.truncateBeforeMigrate) {
          issues.push({ level: 'warning', message: 'Target table already exists and truncate is off — existing rows kept; PK conflicts will be skipped.' });
        }
      } catch {
        // information_schema query failure is non-fatal
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

  globalIssues.push(...fkOrderingIssues(job));
  if (!included.length) globalIssues.push({ level: 'error', message: 'No tables included in this job.' });
  if (!srcPing.reachable) globalIssues.push({ level: 'error', message: `Source unreachable: ${srcPing.error ?? 'unknown error'}` });
  if (!tgtPing.reachable) globalIssues.push({ level: 'error', message: `Target unreachable: ${tgtPing.error ?? 'unknown error'}` });

  const hasError = globalIssues.some(i => i.level === 'error') || tables.some(t => t.issues.some(i => i.level === 'error'));
  const capabilities = await inspectServerCapabilities(job, source, target);
  if (capabilities.source.error) globalIssues.push({ level: 'warning', message: `Source capability check incomplete: ${capabilities.source.error}` });
  if (capabilities.target.error) globalIssues.push({ level: 'warning', message: `Target capability check incomplete: ${capabilities.target.error}` });

  return {
    ok: !hasError,
    generatedAt: new Date().toISOString(),
    tableCount: included.length,
    totalRows,
    estimatedSeconds: Math.ceil(totalRows / ASSUMED_ROWS_PER_SEC),
    source: srcPing,
    target: tgtPing,
    capabilities,
    globalIssues,
    tables,
  };
}
