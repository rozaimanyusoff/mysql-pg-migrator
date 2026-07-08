import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isSchedulerRequestAuthorized } from '../src/lib/scheduler-security.ts';
import { acquireRunLock, activeRunForJob, loadRun, saveRun } from '../src/lib/migv2/run-store.ts';
import { buildWhere } from '../src/lib/migv2/cursor-query.ts';
import type { MigRun } from '../src/lib/migv2/types.ts';

const runFiles: string[] = [];

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
