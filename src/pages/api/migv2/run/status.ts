import type { NextApiRequest, NextApiResponse } from 'next';
import { loadRun, listRunsForStatus } from '../../../../lib/migv2/run-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const { id, jobId, compact } = req.query as { id?: string; jobId?: string; compact?: string };
  if (id) {
    const run = loadRun(id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    const tableLimitRaw = req.query.tableLimit;
    if (tableLimitRaw != null) {
      const offset = Math.max(0, Number(req.query.tableOffset ?? 0) || 0);
      const limit = Math.min(500, Math.max(1, Number(tableLimitRaw) || 100));
      const search = String(req.query.search ?? '').trim().toLowerCase();
      const status = String(req.query.tableStatus ?? 'all');
      const filtered = run.tableStates.filter(table =>
        (!search || table.sourceKey.toLowerCase().includes(search) || table.targetKey.toLowerCase().includes(search)) &&
        (status === 'all' || table.status === status)
      );
      return res.status(200).json({
        run: { ...run, tables: compact === '1' ? [] : run.tables, tableStates: filtered.slice(offset, offset + limit) },
        tablePage: { offset, limit, total: filtered.length, hasMore: offset + limit < filtered.length },
      });
    }
    return res.status(200).json({ run: compact === '1' ? { ...run, tables: [], sourceMeta: undefined, targetMeta: undefined, logs: [] } : run });
  }
  const rawLimit = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
  const runs = listRunsForStatus(jobId, limit);
  if (compact === '1') {
    return res.status(200).json({ runs: runs.map(run => ({ ...run, tables: [], sourceMeta: undefined, targetMeta: undefined })) });
  }
  return res.status(200).json({ runs });
}
