import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSchedulerRequestAuthorized } from '../src/lib/scheduler-security.ts';
import { acquireRunLock, activeRunForJob, getRunActivitySnapshot, listRunsForStatus, loadRun, saveRun } from '../src/lib/migv2/run-store.ts';
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
import type { PreflightReport } from '../src/lib/migv2/preflight.ts';
import type { MigJob, MigRun, TableMap } from '../src/lib/migv2/types.ts';

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
    total: 3, finished: 2, remaining: 1, completed: 1, empty: 1, failed: 0,
  });
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
    filterCol: 'created_at', filterFrom: '2025-01-01', filterTo: null,
  };
  const payload = JSON.parse(JSON.stringify(createPortableJob(job))) as {
    job: { sourceMeta: Record<string, unknown>; targetMeta: Record<string, unknown> };
  };
  payload.job.sourceMeta.password = 'must-not-be-imported';
  payload.job.targetMeta.password = 'must-not-be-imported';

  const imported = parsePortableJob(payload);
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
  assert.equal(fixed.chunkRows, 900);
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
  assert.equal(policy.chunkRows, capability.concurrencyAdjustedMaxChunkRows);
  assert.equal(policy.singleRunCeilingRows, capability.singleRunMaxChunkRows);
  assert.equal(policy.assumedConcurrentRuns, 5);
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
  assert.ok(assessment.notices.some(notice => /ordered later/.test(notice.message)));
  assert.ok(assessment.notices.some(notice => /does not copy updates/.test(notice.message)));
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
