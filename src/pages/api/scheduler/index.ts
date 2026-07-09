import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { listSchedules, saveSchedule } from '../../../lib/migv2/schedule-store';
import { loadRun, reconcileStaleRuns } from '../../../lib/migv2/run-store';
import type { CronSchedule } from '../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../lib/scheduler-security';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const reconciledRuns = reconcileStaleRuns();
    const schedules = listSchedules().map(schedule => {
      const reconciled = reconciledRuns.find(run => run.jobId === schedule.jobId || run.id === schedule.lastRunId);
      const lastRun = schedule.lastRunId ? loadRun(schedule.lastRunId) : null;
      const staleRunningSchedule = schedule.lastRunStatus === 'running' && lastRun && !['running', 'pending'].includes(lastRun.status);
      if (!reconciled && !staleRunningSchedule) return schedule;
      const updated: CronSchedule = {
        ...schedule,
        lastRunAt: lastRun?.completedAt ?? reconciled?.completedAt ?? schedule.lastRunAt,
        lastRunStatus: lastRun?.status === 'completed' ? 'completed' : 'failed',
        updatedAt: new Date().toISOString(),
      };
      saveSchedule(updated);
      return updated;
    });
    return res.status(200).json({ schedules });
  }

  if (req.method === 'POST') {
    if (!requireSchedulerMutationAuth(req, res)) return;
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
