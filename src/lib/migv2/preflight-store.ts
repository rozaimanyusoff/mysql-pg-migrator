import fs from 'fs';
import path from 'path';
import type { MigJob } from './types';
import type { PreflightReport } from './preflight';

const PREFLIGHT_DIR = path.join(process.cwd(), 'data', 'migv2', 'preflight');
export const PREFLIGHT_VALID_MS = 24 * 60 * 60 * 1000;

export interface PreflightRecord {
  jobId: string;
  jobVersion: number;
  jobUpdatedAt: string;
  completedAt: string;
  expiresAt: string;
  ok: boolean;
  report: PreflightReport;
}

export interface PreflightStatus {
  ready: boolean;
  reason: 'ready' | 'missing' | 'failed' | 'expired' | 'job_changed';
  completedAt: string | null;
  expiresAt: string | null;
}

function ensureDir(): void { fs.mkdirSync(PREFLIGHT_DIR, { recursive: true }); }
function recordPath(jobId: string): string {
  return path.join(PREFLIGHT_DIR, `${jobId.replace(/[^a-z0-9_-]/gi, '_')}.json`);
}

export function savePreflightRecord(job: MigJob, report: PreflightReport): PreflightRecord {
  ensureDir();
  const completedAt = new Date().toISOString();
  const record: PreflightRecord = {
    jobId: job.id,
    jobVersion: job.version,
    jobUpdatedAt: job.updatedAt,
    completedAt,
    expiresAt: new Date(Date.now() + PREFLIGHT_VALID_MS).toISOString(),
    ok: report.ok,
    report,
  };
  fs.writeFileSync(recordPath(job.id), JSON.stringify(record, null, 2));
  return record;
}

export function loadPreflightRecord(jobId: string): PreflightRecord | null {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(recordPath(jobId), 'utf8')) as PreflightRecord; }
  catch { return null; }
}

export function getPreflightStatus(job: MigJob): PreflightStatus {
  const record = loadPreflightRecord(job.id);
  if (!record) return { ready: false, reason: 'missing', completedAt: null, expiresAt: null };
  if (record.jobVersion !== job.version || record.jobUpdatedAt !== job.updatedAt) {
    return { ready: false, reason: 'job_changed', completedAt: record.completedAt, expiresAt: record.expiresAt };
  }
  if (!record.ok) return { ready: false, reason: 'failed', completedAt: record.completedAt, expiresAt: record.expiresAt };
  if (Date.now() >= new Date(record.expiresAt).getTime()) {
    return { ready: false, reason: 'expired', completedAt: record.completedAt, expiresAt: record.expiresAt };
  }
  return { ready: true, reason: 'ready', completedAt: record.completedAt, expiresAt: record.expiresAt };
}

export function preflightRequiredMessage(status: PreflightStatus): string {
  if (status.reason === 'failed') return 'Pre-flight found blocking issues. Fix them and run Pre-flight again.';
  if (status.reason === 'expired') return 'Pre-flight has expired. Run Pre-flight again before starting migration.';
  if (status.reason === 'job_changed') return 'The saved job changed after its last Pre-flight. Run Pre-flight again.';
  return 'Pre-flight is required before enabling or starting this migration.';
}
