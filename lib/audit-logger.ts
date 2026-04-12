import fs from 'fs/promises';
import path from 'path';

export interface AuditLogEntry {
  timestamp: string;
  source: 'client' | 'server';
  module: string;
  action: string;
  level?: 'info' | 'warn' | 'error';
  details?: Record<string, unknown>;
}

const LOG_DIR = path.join(process.cwd(), 'public', 'uploads', 'logs');

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function localDateStamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function normalizeFileName(fileName: string): string {
  return fileName.replace(/[^0-9\-]/g, '');
}

async function ensureLogDir() {
  await fs.mkdir(LOG_DIR, { recursive: true });
}

export async function appendAuditLog(entry: AuditLogEntry): Promise<void> {
  await ensureLogDir();
  const stamp = localDateStamp();
  const filePath = path.join(LOG_DIR, `${stamp}.log`);
  await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function listAuditLogFiles(): Promise<string[]> {
  await ensureLogDir();
  const files = await fs.readdir(LOG_DIR);
  return files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
    .sort((a, b) => b.localeCompare(a));
}

export async function readAuditLogFile(fileName: string): Promise<AuditLogEntry[]> {
  await ensureLogDir();
  const safe = normalizeFileName(fileName);
  const full = path.join(LOG_DIR, `${safe}.log`);
  const raw = await fs.readFile(full, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as AuditLogEntry;
      } catch {
        return {
          timestamp: new Date().toISOString(),
          source: 'server',
          module: 'migration',
          action: 'parse_error',
          level: 'warn',
          details: { raw: line },
        } as AuditLogEntry;
      }
    });
}

function dateToStamp(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export async function readAuditLogsByDateRange(start: string, end: string): Promise<AuditLogEntry[]> {
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || startDate > endDate) {
    return [];
  }

  const out: AuditLogEntry[] = [];
  const day = new Date(startDate);
  while (day <= endDate) {
    const stamp = dateToStamp(day);
    try {
      const rows = await readAuditLogFile(stamp);
      out.push(...rows);
    } catch {
      // ignore missing daily file
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}
