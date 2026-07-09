import fs from 'fs';
import path from 'path';
import type { MigRun } from './types';

const RUN_DIR = path.join(process.cwd(), 'data', 'migv2', 'runs');
export const MAX_CONCURRENT_MIGRATIONS = 5;
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

// A server-driven run stamps heartbeatAt every advance loop (~8s). If a run is
// still 'running' but its heartbeat is older than this, the driving process died
// (deploy, crash, OOM) and the run is orphaned. Reconcile marks it failed +
// interrupted so the UI can offer "Resume" (which continues from saved offsets).
const HEARTBEAT_STALE_MS = 90_000;

export function reconcileStaleRuns(): MigRun[] {
  ensureDir();
  const now = Date.now();
  const reconciled: MigRun[] = [];
  for (const f of runFiles()) {
    const run = readRunFile(path.join(RUN_DIR, f));
    if (!run || run.status !== 'running') continue;
    const beat = run.heartbeatAt ?? run.startedAt ?? run.createdAt;
    if (now - new Date(beat).getTime() < HEARTBEAT_STALE_MS) continue;
    run.status = 'failed';
    run.interrupted = true;
    run.completedAt = new Date().toISOString();
    run.errors.push('Run interrupted (server process restarted mid-run). Resume to continue from the last saved offset.');
    run.logs.push(`[${new Date().toISOString()}] Run reconciled as interrupted — heartbeat stale.`);
    saveRun(run);
    reconciled.push(run);
  }
  return reconciled;
}

export function listRunsForJob(jobId: string): MigRun[] {
  return runFiles()
    .map(f => readRunFile(path.join(RUN_DIR, f)))
    .filter((r): r is MigRun => !!r && r.jobId === jobId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
