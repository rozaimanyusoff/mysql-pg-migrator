import fs from 'fs';
import path from 'path';
import type { MigJob, MigJobSummary } from './types';

const JOB_DIR = path.join(process.cwd(), 'data', 'migv2', 'jobs');

function ensureDir() {
  fs.mkdirSync(JOB_DIR, { recursive: true });
}

function jobPath(id: string): string {
  return path.join(JOB_DIR, `${id.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

export function listJobs(): MigJobSummary[] {
  ensureDir();
  return fs.readdirSync(JOB_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(JOB_DIR, f), 'utf8')) as MigJob;
        return {
          id: j.id, name: j.name, description: j.description,
          version: j.version, createdAt: j.createdAt, updatedAt: j.updatedAt,
          tableCount: j.tables.length,
          tables: j.tables.map(t => ({ id: t.id, include: t.include, source: t.source, sourceDatabase: t.sourceDatabase, target: t.target })),
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b!.updatedAt.localeCompare(a!.updatedAt)) as MigJobSummary[];
}

export function loadJob(id: string): MigJob | null {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8')) as MigJob;
  } catch { return null; }
}

export function saveJob(job: MigJob): MigJob {
  ensureDir();
  const existing = loadJob(job.id);
  const now = new Date().toISOString();
  const saved: MigJob = {
    ...job,
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  fs.writeFileSync(jobPath(saved.id), JSON.stringify(saved, null, 2));
  return saved;
}

export function deleteJob(id: string): boolean {
  ensureDir();
  const p = jobPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}
