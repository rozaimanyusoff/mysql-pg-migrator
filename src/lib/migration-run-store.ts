import fs from 'fs/promises';
import path from 'path';
import { MigrationRunState } from './types';

const RUN_DIR = path.join(process.cwd(), 'data', 'migration', 'runs');

function cleanId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'run';
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(RUN_DIR, { recursive: true });
}

function runPath(id: string): string {
  return path.join(RUN_DIR, `${cleanId(id)}.json`);
}

export async function createRun(state: MigrationRunState): Promise<void> {
  await ensureDir();
  await fs.writeFile(runPath(state.id), JSON.stringify(state, null, 2), 'utf8');
}

export async function loadRun(id: string): Promise<MigrationRunState | null> {
  await ensureDir();
  try {
    const raw = await fs.readFile(runPath(id), 'utf8');
    return JSON.parse(raw) as MigrationRunState;
  } catch {
    return null;
  }
}

export async function saveRun(state: MigrationRunState): Promise<void> {
  await ensureDir();
  await fs.writeFile(runPath(state.id), JSON.stringify(state, null, 2), 'utf8');
}

export async function listRuns(limit = 20): Promise<Array<Pick<MigrationRunState, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt' | 'totalRowsCopied'>>> {
  await ensureDir();
  const files = (await fs.readdir(RUN_DIR)).filter((f) => f.endsWith('.json'));
  const runs: Array<Pick<MigrationRunState, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'startedAt' | 'finishedAt' | 'totalRowsCopied'>> = [];

  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(RUN_DIR, file), 'utf8');
      const run = JSON.parse(raw) as MigrationRunState;
      runs.push({
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        totalRowsCopied: run.totalRowsCopied,
      });
    } catch {
      // ignore bad file
    }
  }

  return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
}
