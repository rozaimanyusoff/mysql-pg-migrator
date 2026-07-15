import type { NextApiRequest, NextApiResponse } from 'next';
import { loadSchedule, saveSchedule, deleteSchedule } from '../../../lib/migv2/schedule-store';
import type { CronSchedule } from '../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../lib/scheduler-security';
import { loadJob } from '../../../lib/migv2/job-store';
import { getPreflightStatus, preflightRequiredMessage } from '../../../lib/migv2/preflight-store';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const { id } = req.query as { id: string };

  if (req.method === 'GET') {
    const s = loadSchedule(id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ schedule: s });
  }

  if (req.method === 'PATCH') {
    if (!requireSchedulerMutationAuth(req, res)) return;
    const s = loadSchedule(id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    const patch = req.body as Partial<CronSchedule>;
    const nextJobId = patch.jobId ?? s.jobId;
    const nextJob = loadJob(nextJobId);
    if (!nextJob) return res.status(404).json({ error: 'Job not found' });
    const preflightStatus = getPreflightStatus(nextJob);
    if (patch.enabled === true && !preflightStatus.ready) {
      return res.status(428).json({ error: preflightRequiredMessage(preflightStatus), preflightRequired: true });
    }
    const jobChangedWithoutPreflight = nextJobId !== s.jobId && !preflightStatus.ready;
    const updated: CronSchedule = {
      ...s,
      ...(patch.jobId !== undefined && { jobId: patch.jobId }),
      ...(patch.jobName !== undefined && { jobName: patch.jobName }),
      ...(patch.cronExpr !== undefined && { cronExpr: patch.cronExpr }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(jobChangedWithoutPreflight && { enabled: false }),
      ...(patch.lastRunAt !== undefined && { lastRunAt: patch.lastRunAt }),
      ...(patch.lastRunStatus !== undefined && { lastRunStatus: patch.lastRunStatus }),
      ...(patch.lastRunId !== undefined && { lastRunId: patch.lastRunId }),
      ...(patch.notifyEmail !== undefined && { notifyEmail: patch.notifyEmail }),
      updatedAt: new Date().toISOString(),
    };
    saveSchedule(updated);
    return res.status(200).json({ schedule: updated });
  }

  if (req.method === 'DELETE') {
    if (!requireSchedulerMutationAuth(req, res)) return;
    deleteSchedule(id);
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
