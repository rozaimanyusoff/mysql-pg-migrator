import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob, saveJob, deleteJob } from '../../../../lib/migv2/job-store';
import type { MigJob } from '../../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { activeRunForJob } from '../../../../lib/migv2/run-store';
import { dropTargetTables } from '../../../../lib/migv2/runner';

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' }, responseLimit: '50mb' },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {

  const { id } = req.query as { id: string };

  if (req.method === 'GET') {
    const job = loadJob(id);
    if (!job) return res.status(404).json({ error: 'Not found' });
    return res.status(200).json({ job });
  }

  if (req.method === 'PUT') {
    const existing = loadJob(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const updated = saveJob({ ...existing, ...(req.body as Partial<MigJob>), id });
    return res.status(200).json({ job: updated });
  }

  if (req.method === 'DELETE') {
    if (!requireSchedulerMutationAuth(req, res)) return;
    const job = loadJob(id);
    if (!job) return res.status(404).json({ ok: false, error: 'Not found' });
    const dropTargets = String(req.query.dropTargets ?? '') === '1' || req.body?.dropTargets === true;
    const active = activeRunForJob(id);
    if (active) return res.status(409).json({ ok: false, error: `Job has an active ${active.status} run. Stop it before deleting.` });
    try {
      let dropped: string[] = [];
      if (dropTargets) {
        const { target } = await resolveJobConns(job);
        dropped = await dropTargetTables(target, job.tables.filter(table => table.include).map(table => ({
          schema: table.target.schema,
          table: table.targetAlias?.trim() || table.target.table,
        })));
      }
      const ok = deleteJob(id);
      return res.status(ok ? 200 : 404).json({ ok, droppedTables: dropped });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return res.status(405).end();
}
