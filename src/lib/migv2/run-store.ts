import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { MigRun } from './types';

const RUN_DIR = path.join(process.cwd(), 'data', 'migv2', 'runs');
export const MAX_CONCURRENT_MIGRATIONS = 5;
/** One lock namespace shared by every endpoint that can create a run. */
export const RUN_START_LOCK = 'migration-global-start';
const LOCK_STALE_MS = 120_000;

function ensureDir() { fs.mkdirSync(RUN_DIR, { recursive: true }); }
function runPath(id: string) { return path.join(RUN_DIR, `${id}.json`); }

function readRunFile(filePath: string): MigRun | null {
  try {
    // Avoid Node 25's native ReadFileUtf8 path, which can assert-crash under
    // Next dev/Turbopack when many run JSON files are read during polling.
    return JSON.parse(fs.readFileSync(filePath).toString('utf8')) as MigRun;
  } catch {
    return null;
  }
}

function runFiles(): string[] {
  ensureDir();
  return fs.readdirSync(RUN_DIR).filter(f => f.endsWith('.json'));
}

export async function acquireRunLock(id: string, timeoutMs = 5_000): Promise<() => void> {
  ensureDir();
  const lockPath = `${runPath(id)}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.closeSync(fd); } catch { /* already closed */ }
        try { fs.unlinkSync(lockPath); } catch { /* already released */ }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring run lock for ${id}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export function saveRun(run: MigRun): void {
  ensureDir();
  // Keep only last 2000 log lines in the persisted state
  const toSave = { ...run, logs: run.logs.slice(-2000) };
  const destination = runPath(run.id);
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(toSave, null, 2));
  fs.renameSync(temp, destination);
}

export function loadRun(id: string): MigRun | null {
  ensureDir();
  return readRunFile(runPath(id));
}

export function listRuns(): MigRun[] {
  return runFiles()
    .map(f => readRunFile(path.join(RUN_DIR, f)))
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.localeCompare(a!.createdAt))
    .slice(0, 20) as MigRun[];
}

export function activeRunCount(excludeRunId?: string): number {
  reconcileStaleRuns();
  return listAllRuns().filter(r => r.id !== excludeRunId && (r.status === 'running' || r.status === 'pending')).length;
}

export function activeRunForJob(jobId: string): MigRun | null {
  reconcileStaleRuns();
  return listAllRuns().find(r => r.jobId === jobId && (r.status === 'running' || r.status === 'pending' || r.status === 'paused')) ?? null;
}

function listAllRuns(): MigRun[] {
  return runFiles()
    .map(f => readRunFile(path.join(RUN_DIR, f)))
    .filter((r): r is MigRun => !!r);
}

// Lease liveness is renewed independently from database chunks. A long query
// must not look like a dead process, while a crashed process is reclaimed soon.
// Keep enough margin for a production process to be briefly paused or busy
// serializing a large run snapshot. The heartbeat renews this every 10s.
export const RUN_LEASE_MS = 120_000;

export async function claimRunExecution(runId: string, executionId: string = randomUUID()): Promise<MigRun | null> {
  const release = await acquireRunLock(runId);
  try {
    const run = loadRun(runId);
    if (!run || !['pending', 'running'].includes(run.status)) return null;
    const leaseUntil = run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : 0;
    if (run.executionId && run.executionId !== executionId && leaseUntil > Date.now()) return null;
    const now = Date.now();
    run.executionId = executionId;
    run.heartbeatAt = new Date(now).toISOString();
    run.leaseExpiresAt = new Date(now + RUN_LEASE_MS).toISOString();
    saveRun(run);
    return run;
  } finally { release(); }
}

export async function refreshRunLease(runId: string, executionId: string): Promise<boolean> {
  const release = await acquireRunLock(runId);
  try {
    const run = loadRun(runId);
    if (!run || run.executionId !== executionId || !['pending', 'running'].includes(run.status)) return false;
    const now = Date.now();
    run.heartbeatAt = new Date(now).toISOString();
    run.leaseExpiresAt = new Date(now + RUN_LEASE_MS).toISOString();
    saveRun(run);
    return true;
  } finally { release(); }
}

export async function releaseRunExecution(runId: string, executionId: string): Promise<void> {
  const release = await acquireRunLock(runId);
  try {
    const run = loadRun(runId);
    if (!run || run.executionId !== executionId) return;
    run.executionId = null;
    run.leaseExpiresAt = null;
    saveRun(run);
  } finally { release(); }
}

function reconcileRuns(runs: MigRun[]): MigRun[] {
  const now = Date.now();
  const reconciled: MigRun[] = [];
  for (const run of runs) {
    if (!['running', 'pending'].includes(run.status)) continue;
    const beat = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
    const leaseUntil = run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : 0;
    if (leaseUntil > now || (leaseUntil === 0 && now - new Date(beat).getTime() < RUN_LEASE_MS * 2)) continue;
    run.status = 'interrupted';
    run.interrupted = true;
    run.completedAt = new Date().toISOString();
    run.executionId = null;
    run.leaseExpiresAt = null;
    for (const table of run.tableStates) {
      if (table.status === 'running') table.status = 'interrupted';
    }
    run.errors.push('Run interrupted because its execution lease expired. Resume to continue from the last saved offset.');
    run.logs.push(`[${new Date().toISOString()}] Run reconciled as interrupted — heartbeat stale.`);
    saveRun(run);
    reconciled.push(run);
  }
  return reconciled;
}

export function reconcileStaleRuns(): MigRun[] {
  ensureDir();
  return reconcileRuns(listAllRuns());
}

export function getRunActivitySnapshot(): { reconciledRuns: MigRun[]; activeRunJobIds: string[] } {
  const runs = listAllRuns();
  const reconciledRuns = reconcileRuns(runs);
  const activeRunJobIds = [...new Set(runs
    .filter(run => (run.status === 'running' || run.status === 'pending') && run.jobId)
    .map(run => run.jobId as string))];
  return { reconciledRuns, activeRunJobIds };
}

// Status polling used to reconcile stale runs and then read every run file a
// second time. Keep one in-memory snapshot for both operations instead.
export function listRunsForStatus(jobId?: string, limit = 20): MigRun[] {
  const runs = listAllRuns();
  reconcileRuns(runs);
  return runs
    .filter(run => !jobId || run.jobId === jobId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}

export function listRunsForJob(jobId: string): MigRun[] {
  return runFiles()
    .map(f => readRunFile(path.join(RUN_DIR, f)))
    .filter((r): r is MigRun => !!r && r.jobId === jobId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
