import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSchedulerRequestAuthorized } from '../src/lib/scheduler-security.ts';
import { acquireRunLock, activeRunForJob, claimRunExecution, getRunActivitySnapshot, listRunsForStatus, loadRun, reconcileStaleRuns, refreshRunLease, releaseRunExecution, saveRun } from '../src/lib/migv2/run-store.ts';
import { buildWhere } from '../src/lib/migv2/cursor-query.ts';
import { prepareRunTables } from '../src/lib/migv2/run-tables.ts';
import { runSequentially } from '../src/lib/migv2/sequential-executor.ts';
import { listSchedulerJobs, loadJob, saveJob, saveJobRuntimeState } from '../src/lib/migv2/job-store.ts';
import { resetJobRuntimeCursor, runtimeFilePathForTests } from '../src/lib/migv2/job-runtime-store.ts';
import { createPortableJob, parsePortableJob } from '../src/lib/migv2/job-portability.ts';
import { getPreflightResult, getPreflightStatus, savePreflightRecord } from '../src/lib/migv2/preflight-store.ts';
import { describePreflightFailure } from '../src/lib/migv2/preflight-client-error.ts';
import { usesUpsertStrategy } from '../src/lib/migv2/sync-strategy.ts';
import { assessMigrationTables, validateRecurringTables } from '../src/lib/migv2/recurring-validation.ts';
import { createRunExecutionPolicy, runChunkRows } from '../src/lib/migv2/execution-policy.ts';
import { calculateChunkCapability } from '../src/lib/migv2/server-capabilities.ts';
import { runWithTableWorkerLimit } from '../src/lib/migv2/table-worker-pool.ts';
import { displayTableStatus, isMigratedTableResult, summarizeRunTableProgress } from '../src/lib/migv2/run-progress.ts';
import { pendingResultId, pendingState, pendingTablesToAdd, tableBindingSignature } from '../src/lib/migv2/pending-result.ts';
import { canPersistWatermark, completedTableStatus, rollbackAvailability } from '../src/lib/migv2/run-outcome.ts';
import { acceptedScheduleRun, markMissedOneShot } from '../src/lib/migv2/schedule-store.ts';
import { cronMatches, normalizeScheduleTimezone, scheduleIsDue, validateCronExpression } from '../src/lib/migv2/cron-schedule.ts';
import { isTransientMigrationError, MAX_TRANSIENT_RETRIES, transientRetryDelayMs } from '../src/lib/migv2/transient-error.ts';
import type { PreflightReport } from '../src/lib/migv2/preflight.ts';
import type { MigJob, MigRun, TableMap } from '../src/lib/migv2/types.ts';
import columnsBulkHandler, { MAX_TABLES_PER_REQUEST } from '../src/pages/api/migv2/columns-bulk.ts';
import { MAX_NOTIFICATION_RECIPIENTS, normalizeNotificationRecipients } from '../src/lib/migv2/notification-recipients.ts';

const runFiles: string[] = [];
const jobFiles: string[] = [];
const preflightFiles: string[] = [];
const runtimeFiles: string[] = [];

function makeRun(id: string, jobId: string): MigRun {
  return {
    id, jobId, jobName: 'integration-test', status: 'running',
    createdAt: new Date().toISOString(), startedAt: null, completedAt: null,
    sourceMeta: { type: 'mysql', host: 'localhost', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'localhost', port: 5432, database: 'target', username: 'test' },
    tables: [], tableStates: [], logs: [], totalRows: 0, migratedRows: 0, errors: [],
  };
}

test.after(() => {
  for (const file of runFiles) {
    try { fs.unlinkSync(file); } catch { /* cleaned */ }
    try { fs.unlinkSync(`${file}.lock`); } catch { /* cleaned */ }
    try { fs.unlinkSync(`${file}.lease`); } catch { /* cleaned */ }
  }
  for (const file of jobFiles) {
    try { fs.unlinkSync(file); } catch { /* cleaned */ }
  }
  for (const file of preflightFiles) {
    try { fs.unlinkSync(file); } catch { /* cleaned */ }
  }
  for (const file of runtimeFiles) {
    try { fs.unlinkSync(file); } catch { /* cleaned */ }
  }
});

test('scheduler security accepts a valid bearer token and rejects invalid external requests', () => {
  assert.equal(isSchedulerRequestAuthorized({ authorization: 'Bearer correct' }, 'correct', true), true);
  assert.equal(isSchedulerRequestAuthorized({ authorization: 'Bearer wrong' }, 'correct', true), false);
  assert.equal(isSchedulerRequestAuthorized({}, 'correct', true), false);
});

test('scheduler security permits exact same-origin browser mutations', () => {
  assert.equal(isSchedulerRequestAuthorized({
    origin: 'https://db.example.test', host: 'db.example.test', 'sec-fetch-site': 'same-origin',
  }, 'secret', true), true);
  assert.equal(isSchedulerRequestAuthorized({
    origin: 'https://evil.example.test', host: 'db.example.test', 'sec-fetch-site': 'cross-site',
  }, 'secret', true), false);
});

test('run writes are atomic and remain valid JSON', () => {
  const id = `test-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'runs', `${id}.json`);
  runFiles.push(file);
  const run = makeRun(id, `job-${id}`);
  saveRun(run);
  run.logs.push('second write');
  saveRun(run);
  assert.equal(loadRun(id)?.logs.at(-1), 'second write');
  assert.equal(fs.readdirSync(path.dirname(file)).some(name => name.startsWith(`${id}.json.`) && name.endsWith('.tmp')), false);
});

test('per-run advisory lock serializes competing writers', async () => {
  const id = `test-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'runs', `${id}.json`);
  runFiles.push(file);
  const releaseFirst = await acquireRunLock(id);
  let acquiredSecond = false;
  const second = acquireRunLock(id).then(release => { acquiredSecond = true; return release; });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(acquiredSecond, false);
  releaseFirst();
  const releaseSecond = await second;
  assert.equal(acquiredSecond, true);
  releaseSecond();
});

test('same-job active-run lookup blocks overlapping runs', () => {
  const id = `test-${randomUUID()}`;
  const jobId = `job-${id}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'runs', `${id}.json`);
  runFiles.push(file);
  saveRun(makeRun(id, jobId));
  assert.equal(activeRunForJob(jobId)?.id, id);
});

test('expired execution lease interrupts the run and all in-flight tables consistently', async () => {
  const id = `lease-${randomUUID()}`;
  const jobId = `job-${id}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'runs', `${id}.json`);
  runFiles.push(file);
  const run = makeRun(id, jobId);
  run.heartbeatAt = new Date(Date.now() - 120_000).toISOString();
  run.leaseExpiresAt = new Date(Date.now() - 60_000).toISOString();
  run.executionId = 'dead-process';
  run.tableStates = [{
    id: 'table-1', sourceKey: 'source.table_1', targetKey: 'target.table_1', status: 'running',
    rowsSource: 10, rowsMigrated: 5, rowsSkipped: 0, rowsErrored: 0, offset: 5, hasMore: true,
    error: null, insertedPks: [], pkOverflow: false, targetPkCol: null,
  }];
  saveRun(run);
  reconcileStaleRuns();
  const reconciled = loadRun(id);
  assert.equal(reconciled?.status, 'interrupted');
  assert.equal(reconciled?.tableStates[0]?.status, 'interrupted');
  assert.match(reconciled?.errors[0] ?? '', /execution lease expired/i);
  const claimed = await claimRunExecution(id, 'new-process');
  assert.equal(claimed, null);
  // Resume endpoints reopen the run explicitly; a dead lease cannot be claimed
  // as a fresh execution while its status is interrupted.
  await releaseRunExecution(id, 'new-process');
});

test('active execution lease prevents reconciliation while work is in flight', async () => {
  const id = `live-lease-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'runs', `${id}.json`);
  runFiles.push(file);
  const run = makeRun(id, `job-${id}`);
  run.status = 'running';
  saveRun(run);
  const claimed = await claimRunExecution(id, 'live-process');
  assert.equal(claimed?.executionId, 'live-process');
  assert.equal(await refreshRunLease(id, 'live-process'), true);
  reconcileStaleRuns();
  assert.equal(loadRun(id)?.status, 'running');
  await releaseRunExecution(id, 'live-process');
});

test('sidecar heartbeat survives a stale full run checkpoint write', async () => {
  const id = `sidecar-lease-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'runs', `${id}.json`);
  runFiles.push(file);
  const run = makeRun(id, `job-${id}`);
  saveRun(run);
  const claimed = await claimRunExecution(id, 'sidecar-process');
  assert.equal(claimed?.executionId, 'sidecar-process');
  assert.equal(await refreshRunLease(id, 'sidecar-process'), true);

  // Simulate an in-flight worker persisting an old, large checkpoint after the
  // heartbeat. The sidecar remains authoritative and must keep the run alive.
  const stale = loadRun(id)!;
  stale.executionId = null;
  stale.heartbeatAt = new Date(Date.now() - 300_000).toISOString();
  stale.leaseExpiresAt = new Date(Date.now() - 180_000).toISOString();
  saveRun(stale);
  reconcileStaleRuns();
  assert.equal(loadRun(id)?.status, 'running');
  await releaseRunExecution(id, 'sidecar-process');
  assert.equal(fs.existsSync(`${file}.lease`), false);
});

test('run-once cron is consumed while recurring cron stays enabled', () => {
  const base = {
    id: 'schedule', jobId: 'job', jobName: 'Job', cronExpr: '30 10 17 7 *', enabled: true,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    lastRunAt: null, lastRunStatus: null, lastRunId: null,
  } as const;
  const missed = markMissedOneShot({ ...base, scheduleMode: 'once', runAt: '2026-07-17T10:30:00.000Z' }, '2026-07-17T10:31:00.000Z');
  assert.equal(missed.missedAt, '2026-07-17T10:31:00.000Z');
  const once = acceptedScheduleRun(missed, 'run-1', '2026-07-17T10:32:00.000Z');
  assert.equal(once.enabled, false);
  assert.equal(once.triggeredAt, '2026-07-17T10:32:00.000Z');
  assert.equal(once.missedAt, null);
  assert.equal(once.lastTriggeredAt, '2026-07-17T10:32:00.000Z');
  assert.equal(once.pendingRunAt, null);
  const recurring = acceptedScheduleRun({ ...base, scheduleMode: 'recurring' }, 'run-2', '2026-07-17T10:30:00.000Z');
  assert.equal(recurring.enabled, true);
  assert.equal(recurring.triggeredAt, undefined);
});

test('server scheduler evaluates recurring cron in its persisted timezone', () => {
  const instant = new Date('2026-07-17T10:00:00.000Z');
  assert.equal(cronMatches('0 18 17 7 *', instant, 'Asia/Kuala_Lumpur'), true);
  assert.equal(cronMatches('0 18 17 7 *', instant, 'UTC'), false);
  assert.equal(cronMatches('0 0 * * 5-7', new Date('2026-07-19T00:00:00.000Z'), 'UTC'), true);
  assert.equal(normalizeScheduleTimezone('Asia/Kuala_Lumpur'), 'Asia/Kuala_Lumpur');
  assert.throws(() => normalizeScheduleTimezone('Not/A_Timezone'), /invalid schedule timezone/i);
});

test('server scheduler validates cron and recovers overdue or queued occurrences', () => {
  assert.equal(validateCronExpression('*/5 * * * *'), true);
  assert.equal(validateCronExpression('60 * * * *'), false);
  assert.equal(validateCronExpression('not cron'), false);
  const base = {
    id: 'schedule', jobId: 'job', jobName: 'Job', cronExpr: '0 18 * * *', timezone: 'Asia/Kuala_Lumpur', enabled: true,
    createdAt: '2026-07-17T00:00:00.000Z', updatedAt: '2026-07-17T00:00:00.000Z',
    lastRunAt: null, lastRunStatus: null, lastRunId: null,
  } as const;
  assert.equal(scheduleIsDue({ ...base, scheduleMode: 'once', runAt: '2026-07-17T09:00:00.000Z', missedAt: '2026-07-17T09:01:00.000Z' }, new Date('2026-07-17T10:00:00.000Z')), true);
  assert.equal(scheduleIsDue({ ...base, scheduleMode: 'recurring', pendingRunAt: '2026-07-17T09:00:00.000Z' }, new Date('2026-07-17T10:03:00.000Z')), true);
  assert.equal(scheduleIsDue({ ...base, scheduleMode: 'recurring', lastTriggeredAt: '2026-07-17T10:00:10.000Z' }, new Date('2026-07-17T10:00:30.000Z')), false);
});

test('transient database failures use bounded exponential retry classification', () => {
  assert.equal(isTransientMigrationError(Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })), true);
  assert.equal(isTransientMigrationError(new Error('deadlock detected while updating target')), true);
  assert.equal(isTransientMigrationError(Object.assign(new Error('database unavailable'), { code: '57P01' })), true);
  assert.equal(isTransientMigrationError(new Error('invalid input syntax for type uuid')), false);
  assert.equal(MAX_TRANSIENT_RETRIES, 3);
  assert.deepEqual([1, 2, 3, 99].map(transientRetryDelayMs), [1000, 2000, 4000, 4000]);
});

test('bulk column inspection enforces a bounded request batch before opening a database connection', async () => {
  let statusCode = 0;
  let payload: any = null;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { payload = body; return this; },
    end() { return this; },
  };
  await columnsBulkHandler({
    method: 'POST',
    body: {
      conn: { type: 'mysql', host: 'localhost', port: 3306, database: 'source', username: 'test', password: '' },
      tables: Array.from({ length: MAX_TABLES_PER_REQUEST + 1 }, (_, index) => ({ schema: 'source', table: `table_${index}` })),
    },
  } as any, response as any);
  assert.equal(statusCode, 400);
  assert.match(payload.error, /maximum of 250 tables/i);
});

test('polling snapshot exposes active job ids and status filtering respects its limit', () => {
  const id = `test-${randomUUID()}`;
  const jobId = `job-${id}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'runs', `${id}.json`);
  runFiles.push(file);
  const run = makeRun(id, jobId);
  run.logs = Array.from({ length: 100 }, (_, index) => `log-${index}`);
  saveRun(run);

  const activity = getRunActivitySnapshot();
  assert.equal(activity.activeRunJobIds.includes(jobId), true);
  assert.equal(listRunsForStatus(jobId, 1)[0]?.id, id);
});

test('zero-row completion is presented as empty and table progress reports remaining work', () => {
  const base = {
    id: 'table-empty', sourceKey: 'src.empty', targetKey: 'dst.empty', status: 'completed' as const,
    rowsSource: 0, rowsMigrated: 0, rowsSkipped: 0, rowsErrored: 0,
    offset: 0, hasMore: false, error: null, insertedPks: [], pkOverflow: false, targetPkCol: null,
  };
  const migrated = { ...base, id: 'table-done', sourceKey: 'src.done', targetKey: 'dst.done', rowsSource: 10, rowsMigrated: 10 };
  const pending = { ...base, id: 'table-pending', sourceKey: 'src.pending', targetKey: 'dst.pending', status: 'pending' as const };

  assert.equal(displayTableStatus(base), 'empty');
  assert.equal(isMigratedTableResult(base), false);
  assert.equal(isMigratedTableResult(migrated), true);
  assert.deepEqual(summarizeRunTableProgress([base, migrated, pending]), {
    total: 3, finished: 2, remaining: 1, completed: 1, empty: 1, failed: 0, issues: 0,
  });
});

test('row outcomes distinguish clean completion from completed with issues', () => {
  const clean = {
    id: 'table-a', sourceKey: 'src.a', targetKey: 'dst.a', status: 'running' as const,
    rowsSource: 3, rowsMigrated: 3, rowsSkipped: 0, rowsErrored: 0,
    offset: 3, hasMore: false, error: null, insertedPks: ['1', '2', '3'], pkOverflow: false, targetPkCol: 'id',
  };
  assert.equal(completedTableStatus(clean), 'completed');
  assert.equal(completedTableStatus({ ...clean, rowsRejected: 1 }), 'completed_with_issues');
  assert.equal(completedTableStatus({ ...clean, rowsErrored: 1 }), 'completed_with_issues');
});

test('watermark commits only after a terminal table with no unresolved row errors', () => {
  const base = {
    id: 'table-a', sourceKey: 'src.a', targetKey: 'dst.a', status: 'completed_with_issues' as const,
    rowsSource: 3, rowsMigrated: 2, rowsSkipped: 0, rowsErrored: 1,
    offset: 3, hasMore: false, error: null, insertedPks: ['1', '2'], pkOverflow: false, targetPkCol: 'id',
    newWatermark: '2026-07-17T00:00:00Z',
  };
  assert.equal(canPersistWatermark(base), false);
  assert.equal(canPersistWatermark({ ...base, rowsErrored: 0, rowsRejected: 1 }), true);
  assert.equal(canPersistWatermark({ ...base, rowsErrored: 0, status: 'running' }), false);
});

test('rollback is exact-only and rejects incomplete inserted-key evidence', () => {
  const exact = {
    id: 'table-a', sourceKey: 'src.a', targetKey: 'dst.a', status: 'completed' as const,
    rowsSource: 2, rowsMigrated: 2, rowsSkipped: 0, rowsErrored: 0,
    offset: 2, hasMore: false, error: null, insertedPks: ['1', '2'], pkOverflow: false, targetPkCol: 'id',
  };
  assert.equal(rollbackAvailability(exact).available, true);
  assert.equal(rollbackAvailability({ ...exact, insertedPks: [] }).available, false);
  assert.equal(rollbackAvailability({ ...exact, pkOverflow: true }).available, false);
  assert.equal(rollbackAvailability({ ...exact, targetPkCol: null }).available, false);
  assert.equal(rollbackAvailability({ ...exact, rowsMigrated: 0, insertedPks: [], targetPkCol: null }).available, true);
});

test('Pending Save identity survives source and target renames', () => {
  const base = {
    id: 'table-a', sourceKey: 'old.orders', targetKey: 'public.orders', status: 'completed' as const,
    rowsSource: 3, rowsMigrated: 3, rowsSkipped: 0, rowsErrored: 0,
    offset: 3, hasMore: false, error: null, insertedPks: [], pkOverflow: false, targetPkCol: null,
  };
  const snapshot = pendingState('run-a', base);
  assert.equal(pendingResultId(snapshot), 'run-a:table-a');
  assert.equal(pendingResultId({ ...snapshot, sourceKey: 'renamed.orders_v2', targetKey: 'archive.orders_v2' }), 'run-a:table-a');
});

test('physical binding fallback includes database, schemas and target alias', () => {
  const table = {
    id: 'table-a', include: true, sourceDatabase: 'legacy',
    source: { schema: 'sales', table: 'orders' }, target: { schema: 'public', table: 'orders' },
    targetAlias: 'orders_v2', columns: [], truncateBeforeMigrate: false,
  } satisfies TableMap;
  assert.equal(tableBindingSignature(table), ['legacy', 'sales', 'orders', 'public', 'orders_v2'].join('\u0000'));
  assert.notEqual(tableBindingSignature(table), tableBindingSignature({ ...table, source: { ...table.source, table: 'orders_renamed' } }));
});

test('Pending Save links same table ID without restoring its stale binding', () => {
  const current = {
    id: 'table-a', include: true, sourceDatabase: 'renamed_db',
    source: { schema: 'sales', table: 'orders_v2' }, target: { schema: 'public', table: 'orders_v2' },
    columns: [], truncateBeforeMigrate: false,
  } satisfies TableMap;
  const oldSnapshot = {
    ...current, sourceDatabase: 'legacy_db',
    source: { schema: 'sales', table: 'orders' }, target: { schema: 'public', table: 'orders' },
  } satisfies TableMap;
  assert.deepEqual(pendingTablesToAdd([current], [oldSnapshot]), []);

  const unmatched = { ...oldSnapshot, id: 'table-b' } satisfies TableMap;
  assert.deepEqual(pendingTablesToAdd([current], [unmatched]), [unmatched]);
});

test('timestamp cursor uses primary-key tie breaker', () => {
  const pg = buildWhere('postgresql', { col: 'updated_at', gt: '2026-01-01', pkCol: 'id', pkGt: '42' });
  assert.match(pg.where, /"updated_at" > \$1/);
  assert.match(pg.where, /"updated_at" = \$2 AND "id" > \$3/);
  assert.deepEqual(pg.params, ['2026-01-01', '2026-01-01', '42']);
  assert.deepEqual(pg.orderCols, ['updated_at', 'id']);
});

test('scheduler table work stays sequential under multi-table load', async () => {
  let active = 0;
  let maxActive = 0;
  const completed: number[] = [];

  await runSequentially([1, 2, 3, 4, 5], async item => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    completed.push(item);
    active--;
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(completed, [1, 2, 3, 4, 5]);
});

test('bulk writer table workers honour the bounded concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  await runWithTableWorkerLimit([1, 2, 3, 4, 5, 6, 7], 5, async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
  });
  assert.equal(maxActive, 5);
});

test('Scheduler runs ignore saved one-off bypass flags', () => {
  const table: TableMap = {
    id: 'table-1',
    include: true,
    source: { schema: 'src', table: 'items' },
    target: { schema: 'dst', table: 'items' },
    columns: [],
    truncateBeforeMigrate: true,
    skipConstraints: true,
    skipNullViolations: true,
  };
  const scheduled = prepareRunTables([table])[0];
  assert.equal(scheduled.truncateBeforeMigrate, false);
  assert.equal(scheduled.skipConstraints, false);
  assert.equal(scheduled.skipNullViolations, false);
  assert.equal(prepareRunTables([table], { truncate: true })[0].truncateBeforeMigrate, true);
});

test('restart table preparation can clear recurring cursors for a first-row restart', () => {
  const table: TableMap = {
    id: 'restart-table', include: true,
    source: { schema: 'src', table: 'items' }, target: { schema: 'dst', table: 'items' },
    columns: [], truncateBeforeMigrate: false, syncMode: 'incremental', incrementalCol: 'id',
    lastSyncedValue: '500', lastSyncedPk: '500',
  };
  const restarted = prepareRunTables([table]).map(candidate => ({ ...candidate, lastSyncedValue: null, lastSyncedPk: null }))[0];
  assert.equal(restarted.lastSyncedValue, null);
  assert.equal(restarted.lastSyncedPk, null);
});

test('saved jobs never persist one-off bypass options', () => {
  const id = `test-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'jobs', `${id}.json`);
  jobFiles.push(file);
  const table: TableMap = {
    id: 'table-1',
    include: true,
    source: { schema: 'src', table: 'items' },
    target: { schema: 'dst', table: 'items' },
    columns: [],
    truncateBeforeMigrate: true,
    skipConstraints: true,
    skipNullViolations: true,
    syncMode: 'incremental',
  };
  const job: MigJob = {
    id,
    name: 'test job',
    description: '',
    version: 0,
    createdAt: '',
    updatedAt: '',
    sourceMeta: { type: 'mysql', host: 'localhost', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'localhost', port: 5432, database: 'target', username: 'test' },
    tables: [table],
  };
  const savedTable = saveJob(job).tables[0];
  assert.equal(savedTable.truncateBeforeMigrate, false);
  assert.equal(savedTable.skipConstraints, false);
  assert.equal(savedTable.skipNullViolations, false);
});

test('saved jobs infer and preserve the global Copy Source contract', () => {
  const id = `test-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'jobs', `${id}.json`);
  jobFiles.push(file);
  const job: MigJob = {
    id, name: 'copy source', description: '', version: 0, createdAt: '', updatedAt: '',
    sourceMeta: { type: 'mysql', host: 'localhost', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'localhost', port: 5432, database: 'target', username: 'test' },
    tables: [{
      id: 'items', include: true,
      source: { schema: 'legacy', table: 'items' },
      target: { schema: 'archive', table: 'items' },
      targetMode: 'source_clone', columns: [], truncateBeforeMigrate: false,
      syncMode: 'full', fullSyncStrategy: 'upsert',
    }],
    initialRunOptions: { skipConstraints: true },
  };
  const saved = saveJob(job);
  assert.equal(saved.mappingMode, 'copy_source');
  assert.equal(saved.syncStrategy, 'full_upsert');
  assert.equal(saved.initialRunOptions?.skipConstraints, true);
  assert.equal(prepareRunTables(saved.tables)[0].skipConstraints, false);
  assert.equal(listSchedulerJobs().find(candidate => candidate.id === id)?.scheduleReady, false);
});

test('portable saved jobs round-trip mappings without carrying credentials', () => {
  const job: MigJob = {
    id: 'portable-job',
    name: 'Portable migration',
    description: 'Move this setup to another computer',
    version: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    sourceMeta: { type: 'mysql', host: 'source.local', port: 3306, database: 'source', username: 'operator' },
    targetMeta: { type: 'postgresql', host: 'target.local', port: 5432, database: 'target', username: 'operator' },
    tables: [{
      id: 'table-1', include: true,
      source: { schema: 'legacy', table: 'items' },
      target: { schema: 'public', table: 'items' },
      columns: [], truncateBeforeMigrate: false,
      syncMode: 'incremental', incrementalCol: 'updated_at', lastSyncedValue: '2026-01-01',
    }],
    mappingMode: 'copy_source',
    syncStrategy: 'incremental',
    filterCol: 'created_at', filterFrom: '2025-01-01', filterTo: null,
  };
  const payload = JSON.parse(JSON.stringify(createPortableJob(job))) as {
    job: { sourceMeta: Record<string, unknown>; targetMeta: Record<string, unknown> };
  };
  payload.job.sourceMeta.password = 'must-not-be-imported';
  payload.job.targetMeta.password = 'must-not-be-imported';

  const imported = parsePortableJob(payload);
  assert.equal(imported.mappingMode, 'copy_source');
  assert.equal(imported.syncStrategy, 'incremental');
  assert.equal(imported.name, job.name);
  assert.equal(imported.tables[0].lastSyncedValue, undefined);
  const expectedPortableTable = { ...job.tables[0] };
  delete expectedPortableTable.lastSyncedValue;
  assert.deepEqual(imported.tables[0], expectedPortableTable);
  assert.equal(imported.filterFrom, '2025-01-01');
  assert.equal('password' in imported.sourceMeta, false);
  assert.equal('password' in imported.targetMeta, false);
});

test('portable saved-job import rejects unrelated JSON', () => {
  assert.throws(
    () => parsePortableJob({ format: 'some-other-app', formatVersion: 1, job: {} }),
    /not a DB Migration saved-job export/,
  );
});

test('pre-flight approval is tied to the exact saved-job version', () => {
  const id = `test-${randomUUID()}`;
  preflightFiles.push(path.join(process.cwd(), 'data', 'migv2', 'preflight', `${id}.json`));
  const job: MigJob = {
    id, name: 'Pre-flight job', description: '', version: 4,
    createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
    sourceMeta: { type: 'mysql', host: 'source', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'target', port: 5432, database: 'target', username: 'test' },
    tables: [],
  };
  savePreflightRecord(job, { ok: true } as PreflightReport);
  assert.equal(getPreflightStatus(job).ready, true);
  assert.deepEqual(getPreflightStatus({ ...job, version: 5 }), {
    ready: false,
    reason: 'job_changed',
    completedAt: getPreflightStatus(job).completedAt,
    expiresAt: getPreflightStatus(job).expiresAt,
  });
});

test('failed pre-flight remains reviewable for the current saved-job version', () => {
  const id = `test-${randomUUID()}`;
  preflightFiles.push(path.join(process.cwd(), 'data', 'migv2', 'preflight', `${id}.json`));
  const job: MigJob = {
    id, name: 'Blocked Pre-flight job', description: '', version: 2,
    createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
    sourceMeta: { type: 'mysql', host: 'source', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'target', port: 5432, database: 'target', username: 'test' },
    tables: [],
  };
  const report = { ok: false, globalIssues: [{ level: 'error', message: 'Blocked' }] } as PreflightReport;
  savePreflightRecord(job, report);
  assert.equal(getPreflightResult(job).status.reason, 'failed');
  assert.deepEqual(getPreflightResult(job).report, report);
  assert.equal(getPreflightResult({ ...job, version: 3 }).report, null);
});

test('runtime watermark persistence does not invalidate Pre-flight approval', () => {
  const id = `test-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'jobs', `${id}.json`);
  jobFiles.push(file);
  runtimeFiles.push(runtimeFilePathForTests(id));
  preflightFiles.push(path.join(process.cwd(), 'data', 'migv2', 'preflight', `${id}.json`));
  const saved = saveJob({
    id, name: 'Recurring job', description: '', version: 0, createdAt: '', updatedAt: '',
    sourceMeta: { type: 'mysql', host: 'source', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'target', port: 5432, database: 'target', username: 'test' },
    tables: [{
      id: 'table-1', include: true, source: { schema: 'src', table: 'items' }, target: { schema: 'dst', table: 'items' },
      columns: [], truncateBeforeMigrate: false, syncMode: 'incremental', incrementalCol: 'updated_at',
    }],
  });
  savePreflightRecord(saved, { ok: true } as PreflightReport);
  saved.tables[0].lastSyncedValue = '2026-07-15T12:00:00.000Z';
  saveJobRuntimeState(saved);
  const storedConfig = JSON.parse(fs.readFileSync(file, 'utf8')) as MigJob;
  assert.equal(storedConfig.tables[0].lastSyncedValue, undefined);
  assert.equal(loadJob(id)?.tables[0].lastSyncedValue, '2026-07-15T12:00:00.000Z');
  assert.equal(getPreflightStatus(saved).ready, true);
  assert.equal(getPreflightStatus(saved).reason, 'ready');
});

test('changing incremental cursor definition resets separate runtime state', () => {
  const id = `test-${randomUUID()}`;
  jobFiles.push(path.join(process.cwd(), 'data', 'migv2', 'jobs', `${id}.json`));
  runtimeFiles.push(runtimeFilePathForTests(id));
  const saved = saveJob({
    id, name: 'Cursor reset', description: '', version: 0, createdAt: '', updatedAt: '',
    sourceMeta: { type: 'mysql', host: 'source', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'target', port: 5432, database: 'target', username: 'test' },
    tables: [{
      id: 'table-1', include: true, source: { schema: 'src', table: 'items' }, target: { schema: 'dst', table: 'items' },
      columns: [], truncateBeforeMigrate: false, syncMode: 'incremental', incrementalCol: 'updated_at',
    }],
  });
  saved.tables[0].lastSyncedValue = '2026-07-15T12:00:00.000Z';
  saveJobRuntimeState(saved);
  saveJob({ ...saved, tables: [{ ...saved.tables[0], incrementalCol: 'id' }] });
  assert.equal(loadJob(id)?.tables[0].lastSyncedValue, null);
});

test('legacy embedded cursor migrates once and remains reset', () => {
  const id = `test-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'jobs', `${id}.json`);
  jobFiles.push(file);
  runtimeFiles.push(runtimeFilePathForTests(id));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    id, name: 'Legacy cursor', description: '', version: 1,
    createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
    sourceMeta: { type: 'mysql', host: 'source', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'target', port: 5432, database: 'target', username: 'test' },
    tables: [{
      id: 'table-1', include: true, source: { schema: 'src', table: 'items' }, target: { schema: 'dst', table: 'items' },
      columns: [], truncateBeforeMigrate: false, syncMode: 'incremental', incrementalCol: 'updated_at',
      lastSyncedValue: '2026-07-15T12:00:00.000Z',
    }],
  } satisfies MigJob));
  assert.equal(loadJob(id)?.tables[0].lastSyncedValue, '2026-07-15T12:00:00.000Z');
  resetJobRuntimeCursor(id, 'table-1');
  assert.equal(loadJob(id)?.tables[0].lastSyncedValue, null);
});

test('Scheduler job contract exposes execution references without raw mappings', () => {
  const id = `test-${randomUUID()}`;
  jobFiles.push(path.join(process.cwd(), 'data', 'migv2', 'jobs', `${id}.json`));
  runtimeFiles.push(runtimeFilePathForTests(id));
  saveJob({
    id, name: 'Scheduler contract', description: '', version: 0, createdAt: '', updatedAt: '',
    sourceMeta: { type: 'mysql', host: 'source', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'target', port: 5432, database: 'target', username: 'test' },
    tables: [{
      id: 'table-1', include: true, source: { schema: 'src', table: 'items' }, target: { schema: 'dst', table: 'items' },
      columns: [], truncateBeforeMigrate: false,
    }],
  });
  const summary = listSchedulerJobs().find(job => job.id === id)!;
  assert.deepEqual(summary.executionTables, [{ id: 'table-1', sourceKey: 'src.items', targetKey: 'dst.items' }]);
  assert.equal('tables' in summary, false);
});

test('run execution policy snapshots and clamps Pre-flight chunk recommendations', () => {
  const capability = {
    recommendedBatchRows: 750,
    maxSafeBatchRows: 900,
  } as Parameters<typeof createRunExecutionPolicy>[0];
  const automatic = createRunExecutionPolicy(capability);
  assert.equal(automatic.mode, 'auto');
  assert.equal(automatic.source, 'preflight');
  assert.equal(automatic.chunkRows, 750);
  assert.equal(automatic.maxConcurrentTables, 5);
  assert.equal(automatic.writerMethod, 'copy-staging');
  assert.equal(runChunkRows(automatic), 750);

  const fixed = createRunExecutionPolicy(capability, 2_000);
  assert.equal(fixed.mode, 'fixed');
  assert.equal(fixed.concurrentCeilingRows, 900);
  assert.equal(fixed.safeCeilingRows, 5_000);
  assert.equal(fixed.chunkRows, 2_000);
  assert.equal(runChunkRows({ ...fixed, chunkRows: 50 }), 100);
  assert.equal(runChunkRows(undefined), 1_000);
});

test('chunk capability keeps 5,000 as a ceiling and auto-selects at most 1,000', () => {
  const job: MigJob = {
    id: 'chunk-typical', name: 'Typical', description: '', version: 1, createdAt: '', updatedAt: '',
    sourceMeta: { type: 'mysql', host: 'source', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'target', port: 5432, database: 'target', username: 'test' },
    tables: [{
      id: 'table-1', include: true, source: { schema: 'src', table: 'items' }, target: { schema: 'dst', table: 'items' },
      columns: [{ sourceCol: 'id', targetCol: 'id', targetName: null, targetType: 'bigint', nullable: false, defaultValue: null, include: true, conversion: 'keep', fkRef: null }],
      truncateBeforeMigrate: false,
    }],
  };
  const capability = calculateChunkCapability(job, 8_192, 5);
  assert.equal(capability.singleRunMaxChunkRows, 5_000);
  assert.equal(capability.concurrencyAdjustedMaxChunkRows, 5_000);
  assert.equal(capability.recommendedBatchRows, 1_000);
  assert.ok(capability.recommendedBatchRows <= capability.concurrencyAdjustedMaxChunkRows);
});

test('chunk capability lowers the effective ceiling for concurrent wide-row runs', () => {
  const jsonColumns = Array.from({ length: 20 }, (_, index) => ({
    sourceCol: `payload_${index}`, targetCol: `payload_${index}`, targetName: null, targetType: 'jsonb',
    nullable: true, defaultValue: null, include: true, conversion: 'keep' as const, fkRef: null,
  }));
  const job: MigJob = {
    id: 'chunk-wide', name: 'Wide rows', description: '', version: 1, createdAt: '', updatedAt: '',
    sourceMeta: { type: 'mysql', host: 'source', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'target', port: 5432, database: 'target', username: 'test' },
    tables: [{
      id: 'table-1', include: true, source: { schema: 'src', table: 'events' }, target: { schema: 'dst', table: 'events' },
      columns: jsonColumns, truncateBeforeMigrate: false,
    }],
  };
  const capability = calculateChunkCapability(job, 512, 5);
  assert.equal(capability.assumedConcurrentRuns, 5);
  assert.ok(capability.concurrencyAdjustedMaxChunkRows < capability.singleRunMaxChunkRows);
  assert.ok(capability.recommendedBatchRows <= capability.concurrencyAdjustedMaxChunkRows);
  assert.ok(capability.chunkRecommendationReasons.some(reason => reason.includes('Concurrency reduces the ceiling')));

  const policy = createRunExecutionPolicy(capability as Parameters<typeof createRunExecutionPolicy>[0], 5_000);
  assert.equal(policy.concurrentCeilingRows, capability.concurrencyAdjustedMaxChunkRows);
  assert.equal(policy.chunkRows, capability.singleRunMaxChunkRows);
  assert.equal(policy.singleRunCeilingRows, capability.singleRunMaxChunkRows);
  assert.equal(policy.assumedConcurrentRuns, 5);
});

test('notification recipients accept comma-separated addresses, normalize duplicates, and reject invalid input', () => {
  const normalized = normalizeNotificationRecipients('ops@example.com, Owner@example.com, ops@example.com');
  assert.deepEqual(normalized.recipients, ['ops@example.com', 'Owner@example.com']);
  assert.equal(normalized.value, 'ops@example.com, Owner@example.com');
  assert.deepEqual(normalized.invalid, []);
  assert.equal(normalizeNotificationRecipients('valid@example.com, invalid').invalid[0], 'invalid');
  assert.equal(normalizeNotificationRecipients(Array.from({ length: MAX_NOTIFICATION_RECIPIENTS + 1 }, (_, index) => `user${index}@example.com`).join(',')).tooMany, true);
});

test('full scan upsert is available when recurring tables have no tracking column', () => {
  assert.equal(usesUpsertStrategy({ syncMode: 'full', fullSyncStrategy: 'upsert' }), true);
  assert.equal(usesUpsertStrategy({ syncMode: 'full', fullSyncStrategy: 'insert_missing' }), false);
  assert.equal(usesUpsertStrategy({ syncMode: 'incremental', incrementalCol: 'updated_at', incrementalStrategy: 'timestamp' }), true);
});

test('Migration owns schedule-readiness validation', () => {
  const table: TableMap = {
    id: 'table-1', include: true,
    source: { schema: 'assets', table: 'types' }, target: { schema: 'assetmain', table: 'asset_types' },
    columns: [{
      sourceCol: 'id', targetCol: 'id', targetName: null, targetType: 'UUID', nullable: false,
      defaultValue: null, include: true, conversion: 'serial_to_uuid', fkRef: null,
    }],
    truncateBeforeMigrate: false, syncMode: 'incremental', incrementalCol: null,
  };
  assert.match(validateRecurringTables([table])[0]?.message ?? '', /tracking column/);
  assert.deepEqual(validateRecurringTables([{ ...table, syncMode: 'full', fullSyncStrategy: 'upsert' }]), []);
});

test('Migration assessment derives one-off and recurring readiness without Set', () => {
  const autoDiscovered: TableMap = {
    id: 'table-1', include: true,
    source: { schema: 'assets', table: 'types' }, target: { schema: 'assetmain', table: 'asset_types' },
    columns: [], truncateBeforeMigrate: false, isSet: false,
  };
  const draft = assessMigrationTables([autoDiscovered]);
  assert.equal(draft.oneOffReady, true);
  assert.equal(draft.recurringReady, false);
  assert.match(draft.recurringIssues[0]?.message ?? '', /recurring execution/);
  assert.equal(assessMigrationTables([{ ...autoDiscovered, isSet: true }]).oneOffReady, true);

  const invalidTarget = assessMigrationTables([{ ...autoDiscovered, target: { schema: '', table: '' } }]);
  assert.equal(invalidTarget.oneOffReady, false);
  assert.match(invalidTarget.oneOffIssues[0]?.message ?? '', /Target table/);
});

test('required target columns validate explicit NULL handling policies', () => {
  const table: TableMap = {
    id: 'null-policy', include: true,
    source: { schema: 'legacy', table: 'items' }, target: { schema: 'app', table: 'inventory_items' },
    targetMode: 'existing', truncateBeforeMigrate: false,
    columns: [{
      sourceCol: 'description', targetCol: 'description', targetName: null,
      targetType: 'text', nullable: false, sourceNullable: true, targetNullable: false,
      defaultValue: null, targetDefaultValue: null, include: true,
      conversion: 'keep', fkRef: null, nullPolicy: 'fallback', emptyPolicy: 'as_null', nullFallback: null,
    }],
  };
  assert.match(assessMigrationTables([table]).oneOffIssues[0]?.message ?? '', /fallback value/);
  table.columns[0].nullFallback = 'Unknown';
  assert.equal(assessMigrationTables([table]).oneOffReady, true);
  table.columns[0].nullPolicy = 'target_default';
  assert.match(assessMigrationTables([table]).oneOffIssues[0]?.message ?? '', /target has no default/);
});

test('Existing Target blocks unassigned source columns and empty mappings', () => {
  const table: TableMap = {
    id: 'existing-target', include: true,
    source: { schema: 'legacy', table: 'users' }, target: { schema: 'app', table: 'accounts' },
    targetMode: 'existing', truncateBeforeMigrate: false,
    columns: [{
      sourceCol: 'user_name', targetCol: '', targetName: null, targetType: 'TEXT', nullable: true,
      defaultValue: null, include: true, conversion: 'keep', fkRef: null,
    }],
  };
  assert.match(assessMigrationTables([table]).oneOffIssues[0]?.message ?? '', /not been assigned/);
  assert.match(assessMigrationTables([{ ...table, columns: [] }]).oneOffIssues[0]?.message ?? '', /Column mapping/);
});

test('saved legacy mappings normalize target ownership and conservative data policies', () => {
  const id = `test-${randomUUID()}`;
  const file = path.join(process.cwd(), 'data', 'migv2', 'jobs', `${id}.json`);
  jobFiles.push(file);
  const job: MigJob = {
    id, name: 'legacy normalization', description: '', version: 0, createdAt: '', updatedAt: '',
    sourceMeta: { type: 'mysql', host: 'localhost', port: 3306, database: 'source', username: 'test' },
    targetMeta: { type: 'postgresql', host: 'localhost', port: 5432, database: 'target', username: 'test' },
    tables: [{
      id: 'legacy-table', include: true,
      source: { schema: 'legacy', table: 'items' }, target: { schema: 'app', table: 'inventory_items' },
      truncateBeforeMigrate: false,
      columns: [{ sourceCol: 'id', targetCol: 'id', targetName: null, targetType: 'uuid', nullable: false, defaultValue: null, include: true, conversion: 'serial_to_uuid', fkRef: null }],
    }],
  };
  const saved = saveJob(job);
  assert.equal(saved.mappingMode, 'existing_target');
  assert.equal(saved.tables[0].targetMode, 'existing');
  assert.equal(saved.tables[0].columns[0].nullPolicy, 'fail');
  assert.equal(saved.tables[0].columns[0].targetNullable, false);
});

test('Migration assessment owns FK ordering and sync-strategy notices', () => {
  const parent: TableMap = {
    id: 'parent', include: true, source: { schema: 'src', table: 'parents' }, target: { schema: 'dst', table: 'parents' },
    columns: [{ sourceCol: 'id', targetCol: 'id', targetName: null, targetType: 'BIGINT', nullable: false, defaultValue: null, include: true, conversion: 'keep', fkRef: null }],
    truncateBeforeMigrate: false, syncMode: 'full', fullSyncStrategy: 'insert_missing',
  };
  const child: TableMap = {
    id: 'child', include: true, source: { schema: 'src', table: 'children' }, target: { schema: 'dst', table: 'children' },
    columns: [{ sourceCol: 'parent_id', targetCol: 'parent_id', targetName: null, targetType: 'BIGINT', nullable: false, defaultValue: null, include: true, conversion: 'keep', fkRef: 'src.parents' }],
    truncateBeforeMigrate: false, syncMode: 'full', fullSyncStrategy: 'insert_missing',
  };
  const assessment = assessMigrationTables([child, parent]);
  assert.equal(assessment.recurringReady, true);
  const orderingAdvisory = assessment.notices.find(notice => /ordered later/.test(notice.message));
  const insertAdvisory = assessment.notices.find(notice => /does not copy updates/.test(notice.message));
  assert.ok(orderingAdvisory);
  assert.match(orderingAdvisory.reason, /parent is ordered later/);
  assert.match(orderingAdvisory.impact, /foreign-key violation/);
  assert.match(orderingAdvisory.action, /Move the referenced parent table earlier/);
  assert.ok(insertAdvisory);
  assert.match(insertAdvisory.action, /Full scan · Insert & update/);
});

test('pre-flight UI preserves structured server diagnostics', () => {
  const failure = describePreflightFailure({
    isAxiosError: true,
    message: 'Request failed with status code 500',
    response: {
      status: 500,
      data: {
        error: 'Pre-flight failed while resolving saved connections.',
        detail: 'Source connection not found in saved connections',
        stage: 'resolve_connections',
        requestId: 'diagnostic-123',
      },
    },
  });
  assert.deepEqual(failure, {
    message: 'Pre-flight failed while resolving saved connections.',
    detail: 'Source connection not found in saved connections',
    stage: 'resolve_connections',
    requestId: 'diagnostic-123',
  });
});

test('pre-flight UI explains failures with no server response', () => {
  const failure = describePreflightFailure({
    isAxiosError: true,
    message: 'Network Error',
    code: 'ERR_NETWORK',
  });
  assert.equal(failure.message, 'Pre-flight server did not return a response.');
  assert.match(failure.detail ?? '', /Network Error.*ERR_NETWORK/);
});
