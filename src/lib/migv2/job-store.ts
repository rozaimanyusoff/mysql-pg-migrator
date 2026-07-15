import fs from 'fs';
import path from 'path';
import type { MigJob, MigJobSummary, SchedulerJobSummary } from './types';
import { assessMigrationTables } from './recurring-validation.ts';
import { deleteJobRuntime, hydrateJobRuntime, reconcileJobRuntime, saveJobRuntimeCursors } from './job-runtime-store.ts';

const JOB_DIR = path.join(process.cwd(), 'data', 'migv2', 'jobs');

function normalizeJob(job: MigJob): MigJob {
  return {
    ...job,
    tables: job.tables.map(table => ({
      ...table,
      targetMode: table.targetMode ?? (table.target.table === table.source.table ? 'source_clone' : 'existing'),
      columns: table.columns.map(column => ({
        ...column,
        sourceNullable: column.sourceNullable ?? column.nullable,
        targetNullable: column.targetNullable ?? column.nullable,
        targetDefaultValue: column.targetDefaultValue ?? column.defaultValue,
        nullPolicy: column.nullPolicy ?? 'fail',
        emptyPolicy: column.emptyPolicy ?? 'keep',
        nullFallback: column.nullFallback ?? null,
        targetFkRef: column.targetFkRef ?? null,
      })),
    })),
  };
}

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
        const config = normalizeJob(JSON.parse(fs.readFileSync(path.join(JOB_DIR, f), 'utf8')) as MigJob);
        const j = hydrateJobRuntime(config);
        const scheduleIssues = assessMigrationTables(j.tables).recurringIssues;
        return {
          id: j.id, name: j.name, description: j.description,
          version: j.version, createdAt: j.createdAt, updatedAt: j.updatedAt,
          tableCount: j.tables.length,
          tables: j.tables.map(t => ({ id: t.id, include: t.include, source: t.source, sourceDatabase: t.sourceDatabase, target: t.target, targetAlias: t.targetAlias, syncMode: t.syncMode, fullSyncStrategy: t.fullSyncStrategy, incrementalCol: t.incrementalCol, lastSyncedValue: t.lastSyncedValue, truncateBeforeMigrate: t.truncateBeforeMigrate })),
          scheduleReady: scheduleIssues.length === 0,
          scheduleIssues: scheduleIssues.length,
        };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b!.updatedAt.localeCompare(a!.updatedAt)) as MigJobSummary[];
}

export function listSchedulerJobs(): SchedulerJobSummary[] {
  return listJobs().map(job => ({
    id: job.id,
    name: job.name,
    description: job.description,
    version: job.version,
    updatedAt: job.updatedAt,
    tableCount: job.tableCount,
    scheduleReady: job.scheduleReady,
    scheduleIssues: job.scheduleIssues,
    executionTables: job.tables.filter(table => table.include).map(table => ({
      id: table.id,
      sourceKey: `${table.source.schema}.${table.source.table}`,
      targetKey: `${table.target.schema}.${table.targetAlias?.trim() || table.target.table}`,
    })),
  }));
}

export function loadJob(id: string): MigJob | null {
  ensureDir();
  try {
    return hydrateJobRuntime(normalizeJob(JSON.parse(fs.readFileSync(jobPath(id), 'utf8')) as MigJob));
  } catch { return null; }
}

function loadJobConfig(id: string): MigJob | null {
  ensureDir();
  try {
    return normalizeJob(JSON.parse(fs.readFileSync(jobPath(id), 'utf8')) as MigJob);
  } catch { return null; }
}

export function saveJob(job: MigJob): MigJob {
  ensureDir();
  job = normalizeJob(job);
  const existing = loadJobConfig(job.id);
  const now = new Date().toISOString();
  // Destructive/bypass switches are per-run controls. They must never become
  // persistent job policy or flow into unattended Scheduler executions.
  if (job.tables.some(table => table.lastSyncedValue != null || table.lastSyncedPk != null)) {
    saveJobRuntimeCursors(job);
  }
  const tables = job.tables.map(t => {
    const config = { ...t };
    delete config.lastSyncedValue;
    delete config.lastSyncedPk;
    return {
      ...config,
      truncateBeforeMigrate: false,
      skipConstraints: false,
      skipNullViolations: false,
    };
  });
  const saved: MigJob = {
    ...job,
    tables,
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  reconcileJobRuntime(existing, saved);
  fs.writeFileSync(jobPath(saved.id), JSON.stringify(saved, null, 2));
  return hydrateJobRuntime(saved);
}

// Runtime cursor persistence must not invalidate a Pre-flight approval. Only
// user-edited mapping/configuration changes go through saveJob(), which bumps
// version and updatedAt.
export function saveJobRuntimeState(job: MigJob): MigJob {
  return saveJobRuntimeCursors(job);
}

export function deleteJob(id: string): boolean {
  ensureDir();
  const p = jobPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  deleteJobRuntime(id);
  return true;
}
