import fs from 'fs';
import path from 'path';
import type { MigRun } from './types';

const RUN_DIR = path.join(process.cwd(), 'data', 'migv2', 'runs');
export const MAX_CONCURRENT_MIGRATIONS = 5;

function ensureDir() { fs.mkdirSync(RUN_DIR, { recursive: true }); }
function runPath(id: string) { return path.join(RUN_DIR, `${id}.json`); }

export function saveRun(run: MigRun): void {
  ensureDir();
  // Keep only last 2000 log lines in the persisted state
  const toSave = { ...run, logs: run.logs.slice(-2000) };
  fs.writeFileSync(runPath(run.id), JSON.stringify(toSave, null, 2));
}

export function loadRun(id: string): MigRun | null {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(runPath(id), 'utf8')) as MigRun; }
  catch { return null; }
}

export function listRuns(): MigRun[] {
  ensureDir();
  return fs.readdirSync(RUN_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(RUN_DIR, f), 'utf8')) as MigRun; }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b!.createdAt.localeCompare(a!.createdAt))
    .slice(0, 20) as MigRun[];
}

export function activeRunCount(excludeRunId?: string): number {
  reconcileStaleRuns();
  return listAllRuns().filter(r => r.id !== excludeRunId && (r.status === 'running' || r.status === 'pending')).length;
}

function listAllRuns(): MigRun[] {
  ensureDir();
  return fs.readdirSync(RUN_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(RUN_DIR, f), 'utf8')) as MigRun; }
      catch { return null; }
    })
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
  for (const f of fs.readdirSync(RUN_DIR).filter(f => f.endsWith('.json'))) {
    let run: MigRun | null = null;
    try { run = JSON.parse(fs.readFileSync(path.join(RUN_DIR, f), 'utf8')) as MigRun; }
    catch { continue; }
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
  ensureDir();
  return fs.readdirSync(RUN_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(RUN_DIR, f), 'utf8')) as MigRun; }
      catch { return null; }
    })
    .filter((r): r is MigRun => !!r && r.jobId === jobId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
