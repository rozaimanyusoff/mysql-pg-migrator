import fs from 'fs';
import path from 'path';
import type { MigRun } from './types';

const RUN_DIR = path.join(process.cwd(), 'data', 'migv2', 'runs');

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
