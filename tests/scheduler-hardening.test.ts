import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSchedulerRequestAuthorized } from '../src/lib/scheduler-security.ts';
import { acquireRunLock, activeRunForJob, loadRun, saveRun } from '../src/lib/migv2/run-store.ts';
import { buildWhere } from '../src/lib/migv2/cursor-query.ts';
import { prepareRunTables } from '../src/lib/migv2/run-tables.ts';
import { runSequentially } from '../src/lib/migv2/sequential-executor.ts';
import { saveJob } from '../src/lib/migv2/job-store.ts';
import { createPortableJob, parsePortableJob } from '../src/lib/migv2/job-portability.ts';
import { getPreflightStatus, savePreflightRecord } from '../src/lib/migv2/preflight-store.ts';
import type { PreflightReport } from '../src/lib/migv2/preflight.ts';
import type { MigJob, MigRun, TableMap } from '../src/lib/migv2/types.ts';

const runFiles: string[] = [];
const jobFiles: string[] = [];
const preflightFiles: string[] = [];

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

test('scheduled/manual runs ignore saved truncate flags unless explicitly requested', () => {
  const table: TableMap = {
    id: 'table-1',
    include: true,
    source: { schema: 'src', table: 'items' },
    target: { schema: 'dst', table: 'items' },
    columns: [],
    truncateBeforeMigrate: true,
  };
  assert.equal(prepareRunTables([table])[0].truncateBeforeMigrate, false);
  assert.equal(prepareRunTables([table], { truncate: true })[0].truncateBeforeMigrate, true);
});

test('saving incremental jobs clears truncate-before-migrate conflicts', () => {
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
  assert.equal(saveJob(job).tables[0].truncateBeforeMigrate, false);
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
  assert.deepEqual(imported.tables, job.tables);
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
