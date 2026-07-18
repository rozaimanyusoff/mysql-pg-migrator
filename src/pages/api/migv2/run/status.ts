import type { NextApiRequest, NextApiResponse } from 'next';
import { loadRun, listRunsForStatus } from '../../../../lib/migv2/run-store';
import type { MigRun, MigRunTableState } from '../../../../lib/migv2/types';

function compactTableState(table: MigRunTableState): MigRunTableState {
  // insertedPks is rollback evidence and can contain 5,000 values per table.
  // Status consumers only need counters/checkpoints; the full run remains
  // available to rollback and export endpoints through loadRun().
  return { ...table, insertedPks: [] };
}

function compactRun(run: MigRun, tableStates = run.tableStates): MigRun {
  return {
    ...run,
    tables: [],
    tableStates: tableStates.map(compactTableState),
    sourceMeta: undefined as unknown as MigRun['sourceMeta'],
    targetMeta: undefined as unknown as MigRun['targetMeta'],
    logs: [],
    errors: [],
    rejects: undefined,
    integrityIssues: undefined,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const { id, jobId, compact } = req.query as { id?: string; jobId?: string; compact?: string };
  if (id) {
    const run = loadRun(id);
    if (!run) return res.status(404).json({ error: 'Not found' });
    const tableLogId = String(req.query.tableLogId ?? '');
    if (tableLogId) {
      const table = run.tableStates.find(state => state.id === tableLogId);
      if (!table) return res.status(404).json({ error: 'Table run not found' });
      const tableKeys = [table.sourceKey, table.targetKey];
      return res.status(200).json({
        logs: run.logs.filter(line => tableKeys.some(key => line.includes(`[${key}]`))),
        errors: run.errors.filter(error => tableKeys.some(key => error.includes(key))),
      });
    }
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
        run: compact === '1'
          ? compactRun(run, filtered.slice(offset, offset + limit))
          : { ...run, tableStates: filtered.slice(offset, offset + limit) },
        tablePage: { offset, limit, total: filtered.length, hasMore: offset + limit < filtered.length },
      });
    }
    return res.status(200).json({ run: compact === '1' ? compactRun(run) : run });
  }
  const rawLimit = Number(req.query.limit ?? 20);
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 20;
  const runs = listRunsForStatus(jobId, limit);
  if (compact === '1') {
    return res.status(200).json({ runs: runs.map(run => compactRun(run)) });
  }
  return res.status(200).json({ runs });
}
