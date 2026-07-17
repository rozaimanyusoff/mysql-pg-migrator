import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { listSchedules, markMissedOneShot, saveSchedule } from '../../../lib/migv2/schedule-store';
import { getRunActivitySnapshot, loadRun } from '../../../lib/migv2/run-store';
import type { CronSchedule } from '../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../lib/scheduler-security';
import { loadJob } from '../../../lib/migv2/job-store';
import { getPreflightStatus } from '../../../lib/migv2/preflight-store';
import { assessMigrationTables } from '../../../lib/migv2/recurring-validation';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { reconciledRuns, activeRunJobIds } = getRunActivitySnapshot();
    const schedules = listSchedules().map(schedule => {
      const normalized = markMissedOneShot(schedule, new Date().toISOString());
      const reconciled = reconciledRuns.find(run => run.jobId === schedule.jobId || run.id === schedule.lastRunId);
      const lastRun = schedule.lastRunId ? loadRun(schedule.lastRunId) : null;
      const staleRunningSchedule = schedule.lastRunStatus === 'running' && lastRun && !['running', 'pending'].includes(lastRun.status);
      if (!reconciled && !staleRunningSchedule) {
        if (normalized !== schedule) saveSchedule(normalized);
        return normalized;
      }
      const updated: CronSchedule = {
        ...normalized,
        lastRunAt: lastRun?.completedAt ?? reconciled?.completedAt ?? schedule.lastRunAt,
        lastRunStatus: lastRun?.status === 'completed' ? 'completed' : lastRun?.status === 'completed_with_issues' ? 'completed_with_issues' : 'failed',
        updatedAt: new Date().toISOString(),
      };
      saveSchedule(updated);
      return updated;
    });
    return res.status(200).json({ schedules, activeRunJobIds });
  }

  if (req.method === 'POST') {
    if (!requireSchedulerMutationAuth(req, res)) return;
    const { jobId, jobName, cronExpr, scheduleMode, runAt, notifyEmail, chunkMode, chunkRows } = req.body as Partial<CronSchedule>;
    if (!jobId || !jobName || !cronExpr) {
      return res.status(400).json({ error: 'jobId, jobName, cronExpr required' });
    }
    if (chunkMode === 'fixed' && (chunkRows == null || !Number.isFinite(chunkRows) || chunkRows <= 0)) {
      return res.status(400).json({ error: 'A positive chunkRows value is required for fixed chunk mode' });
    }
    const job = loadJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const setupIssues = assessMigrationTables(job.tables).recurringIssues;
    if (setupIssues.length) {
      return res.status(422).json({
        error: `This job has ${setupIssues.length} Migration setup issue${setupIssues.length !== 1 ? 's' : ''}. Resolve them before adding a schedule.`,
        setupRequired: true,
      });
    }
    const preflightStatus = getPreflightStatus(job);
    const now = new Date().toISOString();
    const normalizedMode = scheduleMode === 'once' ? 'once' : 'recurring';
    if (normalizedMode === 'once' && (!runAt || !Number.isFinite(Date.parse(runAt)) || Date.parse(runAt) <= Date.now())) {
      return res.status(400).json({ error: 'A future runAt date and time is required for a run-once schedule' });
    }
    const schedule: CronSchedule = {
      id: randomUUID(),
      jobId, jobName, cronExpr,
      scheduleMode: normalizedMode,
      runAt: normalizedMode === 'once' ? runAt : null,
      triggeredAt: null,
      missedAt: null,
      // Schedules may be configured first, but cannot become active until a
      // current Pre-flight has passed for this exact saved-job version.
      enabled: preflightStatus.ready,
      createdAt: now, updatedAt: now,
      lastRunAt: null, lastRunStatus: null, lastRunId: null,
      notifyEmail: notifyEmail ?? null,
      chunkMode: chunkMode === 'fixed' ? 'fixed' : 'auto',
      chunkRows: chunkMode === 'fixed' ? chunkRows : null,
    };
    saveSchedule(schedule);
    return res.status(201).json({ schedule, preflightRequired: !preflightStatus.ready });
  }

  return res.status(405).end();
}
