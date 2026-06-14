import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { listSchedules, saveSchedule } from '../../../lib/migv2/schedule-store';
import type { CronSchedule } from '../../../lib/migv2/types';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    return res.status(200).json({ schedules: listSchedules() });
  }

  if (req.method === 'POST') {
    const { jobId, jobName, cronExpr, notifyEmail } = req.body as Partial<CronSchedule>;
    if (!jobId || !jobName || !cronExpr) {
      return res.status(400).json({ error: 'jobId, jobName, cronExpr required' });
    }
    const now = new Date().toISOString();
    const schedule: CronSchedule = {
      id: randomUUID(),
      jobId, jobName, cronExpr,
      enabled: true,
      createdAt: now, updatedAt: now,
      lastRunAt: null, lastRunStatus: null, lastRunId: null,
      notifyEmail: notifyEmail ?? null,
    };
    saveSchedule(schedule);
    return res.status(201).json({ schedule });
  }

  return res.status(405).end();
}
