import fs from 'fs';
import path from 'path';
import type { MigJob, TableMap } from './types';

export interface TableCursorState {
  lastSyncedValue: string | null;
  lastSyncedPk: string | null;
}

interface JobRuntimeState {
  jobId: string;
  updatedAt: string;
  cursors: Record<string, TableCursorState>;
}

const RUNTIME_DIR = path.join(process.cwd(), 'data', 'migv2', 'runtime');

function ensureDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

function runtimePath(jobId: string): string {
  return path.join(RUNTIME_DIR, `${jobId.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

function loadState(jobId: string): JobRuntimeState {
  ensureDir();
  try {
    const value = JSON.parse(fs.readFileSync(runtimePath(jobId), 'utf8')) as JobRuntimeState;
    return value && value.jobId === jobId && value.cursors && typeof value.cursors === 'object'
      ? value
      : { jobId, updatedAt: new Date(0).toISOString(), cursors: {} };
  } catch {
    return { jobId, updatedAt: new Date(0).toISOString(), cursors: {} };
  }
}

function saveState(state: JobRuntimeState) {
  ensureDir();
  const file = runtimePath(state.jobId);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(temp, file);
}

function cursorFromTable(table: TableMap): TableCursorState | null {
  if (table.lastSyncedValue == null && table.lastSyncedPk == null) return null;
  return {
    lastSyncedValue: table.lastSyncedValue ?? null,
    lastSyncedPk: table.lastSyncedPk ?? null,
  };
}

export function hydrateJobRuntime(job: MigJob): MigJob {
  const runtimeAlreadyInitialized = fs.existsSync(runtimePath(job.id));
  const state = loadState(job.id);
  let migratedLegacyCursor = false;
  const cursors = { ...state.cursors };

  if (!runtimeAlreadyInitialized) {
    for (const table of job.tables) {
      const legacy = cursorFromTable(table);
      if (!legacy) continue;
      cursors[table.id] = legacy;
      migratedLegacyCursor = true;
    }
  }
  if (migratedLegacyCursor) saveState({ ...state, cursors });

  return {
    ...job,
    tables: job.tables.map(table => {
      const cursor = cursors[table.id];
      return cursor ? { ...table, ...cursor } : { ...table, lastSyncedValue: null, lastSyncedPk: null };
    }),
  };
}

export function saveJobRuntimeCursors(job: MigJob): MigJob {
  const state = loadState(job.id);
  const cursors = { ...state.cursors };
  for (const table of job.tables) {
    const cursor = cursorFromTable(table);
    if (cursor) cursors[table.id] = cursor;
  }
  saveState({ ...state, cursors });
  return hydrateJobRuntime(job);
}

export function reconcileJobRuntime(previous: MigJob | null, next: MigJob) {
  const state = loadState(next.id);
  const nextIds = new Set(next.tables.map(table => table.id));
  const cursors = Object.fromEntries(Object.entries(state.cursors).filter(([tableId]) => nextIds.has(tableId)));
  let changed = Object.keys(cursors).length !== Object.keys(state.cursors).length;

  if (previous) {
    for (const table of next.tables) {
      const before = previous.tables.find(item => item.id === table.id);
      if (!before || !cursors[table.id]) continue;
      const cursorDefinitionChanged = before.syncMode !== table.syncMode
        || before.incrementalCol !== table.incrementalCol
        || before.incrementalStrategy !== table.incrementalStrategy
        || before.incrementalTieCol !== table.incrementalTieCol;
      if (cursorDefinitionChanged) {
        delete cursors[table.id];
        changed = true;
      }
    }
  }
  if (changed) saveState({ ...state, cursors });
}

export function resetJobRuntimeCursor(jobId: string, tableId?: string) {
  const state = loadState(jobId);
  if (tableId) delete state.cursors[tableId];
  else state.cursors = {};
  saveState(state);
}

export function deleteJobRuntime(jobId: string) {
  const file = runtimePath(jobId);
  try { fs.unlinkSync(file); } catch { /* absent runtime is already deleted */ }
}

export function runtimeFilePathForTests(jobId: string): string {
  return runtimePath(jobId);
}
