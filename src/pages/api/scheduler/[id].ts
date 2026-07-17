import type { NextApiRequest, NextApiResponse } from 'next';
import { loadSchedule, saveSchedule, deleteSchedule } from '../../../lib/migv2/schedule-store';
import type { CronSchedule } from '../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../lib/scheduler-security';
import { loadJob } from '../../../lib/migv2/job-store';
import { getPreflightStatus, preflightRequiredMessage } from '../../../lib/migv2/preflight-store';
import { MAX_CHUNK_ROWS } from '../../../lib/migv2/execution-policy';
import { MAX_NOTIFICATION_RECIPIENTS, normalizeNotificationRecipients } from '../../../lib/migv2/notification-recipients';
import { normalizeScheduleTimezone, validateCronExpression } from '../../../lib/migv2/cron-schedule';

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
    const nextChunkMode = patch.chunkMode ?? s.chunkMode ?? 'auto';
    const nextChunkRows = patch.chunkRows !== undefined ? patch.chunkRows : s.chunkRows;
    if (nextChunkMode === 'fixed' && (nextChunkRows == null || !Number.isFinite(nextChunkRows) || nextChunkRows < 100 || nextChunkRows > MAX_CHUNK_ROWS)) {
      return res.status(400).json({ error: `Manual chunk must be between 100 and ${MAX_CHUNK_ROWS.toLocaleString()} rows` });
    }
    const recipients = normalizeNotificationRecipients(patch.notifyEmail !== undefined ? patch.notifyEmail : s.notifyEmail);
    if (recipients.invalid.length) return res.status(400).json({ error: `Invalid notification email${recipients.invalid.length === 1 ? '' : 's'}: ${recipients.invalid.join(', ')}` });
    if (recipients.tooMany) return res.status(400).json({ error: `A maximum of ${MAX_NOTIFICATION_RECIPIENTS} notification recipients is allowed` });
    const jobChangedWithoutPreflight = nextJobId !== s.jobId && !preflightStatus.ready;
    const nextScheduleMode = patch.scheduleMode ?? s.scheduleMode ?? 'recurring';
    const nextRunAt = patch.runAt !== undefined ? patch.runAt : s.runAt;
    const nextCronExpr = patch.cronExpr ?? s.cronExpr;
    if (!validateCronExpression(nextCronExpr)) return res.status(400).json({ error: 'A valid five-field cron expression is required' });
    let nextTimezone: string;
    try { nextTimezone = normalizeScheduleTimezone(patch.timezone !== undefined ? patch.timezone : s.timezone); }
    catch (err) { return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid schedule timezone' }); }
    if (nextScheduleMode === 'once' && (!nextRunAt || !Number.isFinite(Date.parse(nextRunAt)))) {
      return res.status(400).json({ error: 'A valid runAt date and time is required for a run-once schedule' });
    }
    if (patch.enabled === true && nextScheduleMode === 'once' && Date.parse(nextRunAt!) <= Date.now()) {
      return res.status(400).json({ error: 'Choose a new future date and time before enabling this run-once schedule' });
    }
    if (patch.enabled === true && nextScheduleMode === 'once' && s.triggeredAt && patch.runAt === undefined) {
      return res.status(409).json({ error: 'This run-once trigger was already consumed. Edit it with a new future date and time.' });
    }
    const updated: CronSchedule = {
      ...s,
      ...(patch.jobId !== undefined && { jobId: patch.jobId }),
      ...(patch.jobName !== undefined && { jobName: patch.jobName }),
      ...(patch.cronExpr !== undefined && { cronExpr: patch.cronExpr }),
      timezone: nextTimezone,
      ...(patch.scheduleMode !== undefined && { scheduleMode: patch.scheduleMode }),
      ...(patch.runAt !== undefined && { runAt: patch.runAt }),
      ...(nextScheduleMode === 'once' && patch.runAt !== undefined && { triggeredAt: null, missedAt: null, pendingRunAt: null, lastTriggeredAt: null }),
      ...(patch.scheduleMode === 'recurring' && { runAt: null, triggeredAt: null, missedAt: null, pendingRunAt: null, lastTriggeredAt: null }),
      ...((patch.cronExpr !== undefined || patch.timezone !== undefined) && { pendingRunAt: null, lastTriggeredAt: null }),
      ...(patch.enabled !== undefined && { enabled: patch.enabled }),
      ...(jobChangedWithoutPreflight && { enabled: false }),
      ...(patch.lastRunAt !== undefined && { lastRunAt: patch.lastRunAt }),
      ...(patch.lastRunStatus !== undefined && { lastRunStatus: patch.lastRunStatus }),
      ...(patch.lastRunId !== undefined && { lastRunId: patch.lastRunId }),
      ...(patch.notifyEmail !== undefined && { notifyEmail: recipients.value }),
      ...((patch.chunkMode !== undefined || patch.chunkRows !== undefined) && {
        chunkMode: nextChunkMode,
        chunkRows: nextChunkMode === 'fixed' ? nextChunkRows : null,
      }),
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
