import fs from 'fs';
import path from 'path';
import type { CronSchedule } from './types';

const SCHEDULE_DIR = path.join(process.cwd(), 'data', 'migv2', 'schedules');

function ensureDir() { fs.mkdirSync(SCHEDULE_DIR, { recursive: true }); }
function schedulePath(id: string) { return path.join(SCHEDULE_DIR, `${id.replace(/[^a-z0-9_-]/gi, '_')}.json`); }

export function listSchedules(): CronSchedule[] {
  ensureDir();
  return fs.readdirSync(SCHEDULE_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(SCHEDULE_DIR, f), 'utf8')) as CronSchedule; }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a!.createdAt.localeCompare(b!.createdAt)) as CronSchedule[];
}

export function loadSchedule(id: string): CronSchedule | null {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(schedulePath(id), 'utf8')) as CronSchedule; }
  catch { return null; }
}

export function saveSchedule(s: CronSchedule): void {
  ensureDir();
  fs.writeFileSync(schedulePath(s.id), JSON.stringify(s, null, 2));
}

export function acceptedScheduleRun(schedule: CronSchedule, runId: string, now: string): CronSchedule {
  return {
    ...schedule,
    ...(schedule.scheduleMode === 'once' ? { enabled: false, triggeredAt: now, missedAt: null } : {}),
    lastTriggeredAt: now,
    pendingRunAt: null,
    recoveryAttempts: 0,
    lastRunStatus: 'running',
    lastRunId: runId,
    updatedAt: now,
  };
}

export function markMissedOneShot(schedule: CronSchedule, now: string): CronSchedule {
  const runAt = schedule.runAt ? Date.parse(schedule.runAt) : Number.NaN;
  if (schedule.scheduleMode !== 'once' || !schedule.enabled || schedule.triggeredAt || schedule.missedAt || !Number.isFinite(runAt) || runAt >= Date.parse(now)) {
    return schedule;
  }
  return { ...schedule, missedAt: now, updatedAt: now };
}

export function deleteSchedule(id: string): void {
  try { fs.unlinkSync(schedulePath(id)); } catch { /* ignore */ }
}
