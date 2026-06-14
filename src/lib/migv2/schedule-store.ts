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

export function deleteSchedule(id: string): void {
  try { fs.unlinkSync(schedulePath(id)); } catch { /* ignore */ }
}
