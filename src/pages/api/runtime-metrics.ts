import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import os from 'os';

function cpuSnapshot() {
  return os.cpus().reduce((total, cpu) => {
    const times = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    return { idle: total.idle + cpu.times.idle, total: total.total + times };
  }, { idle: 0, total: 0 });
}

function utcOffset(date: Date): string {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  const before = cpuSnapshot();
  await new Promise(resolve => setTimeout(resolve, 120));
  const after = cpuSnapshot();
  const totalDelta = Math.max(1, after.total - before.total);
  const cpuPercent = Math.max(0, Math.min(100, ((totalDelta - (after.idle - before.idle)) / totalDelta) * 100));
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  let workspaceFreeBytes: number | null = null;
  try {
    const stats = fs.statfsSync(process.cwd());
    workspaceFreeBytes = Number(stats.bavail) * Number(stats.bsize);
  } catch { /* unavailable on some runtimes */ }
  const now = new Date();
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    serverTime: now.toISOString(),
    timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'System timezone',
    utcOffset: utcOffset(now),
    hostname: os.hostname(),
    cpuPercent: Number(cpuPercent.toFixed(1)),
    cpuCores: os.cpus().length,
    loadAverage1m: Number(os.loadavg()[0].toFixed(2)),
    totalMemoryBytes,
    usedMemoryBytes: totalMemoryBytes - freeMemoryBytes,
    workspaceFreeBytes,
  });
}
