import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { activeRunCount, loadRun, MAX_CONCURRENT_MIGRATIONS, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { listSchedules } from '../../../../lib/migv2/schedule-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import type { MigRun, MigRunTableState } from '../../../../lib/migv2/types';

// POST { runId, truncate? } — restart a run from offset 0 for all tables.
// Creates a new run ID (original run is preserved for audit).
// When truncate=true, sets truncateBeforeMigrate on every table so the runner
// clears target data before the first chunk of each table.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { runId, truncate = false } = req.body as { runId?: string; truncate?: boolean };
  if (!runId) return res.status(400).json({ error: 'runId is required' });

  const sourceRun = loadRun(runId);
  if (!sourceRun) return res.status(404).json({ error: 'Run not found' });
  if (sourceRun.status === 'running') return res.status(400).json({ error: 'Run is already in progress' });
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  if (!sourceRun.jobId) return res.status(400).json({ error: 'Run has no job to resolve connections from' });

  const job = loadJob(sourceRun.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found — cannot resolve connections' });

  let conns;
  try {
    conns = await resolveJobConns(job);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const now = new Date().toISOString();

  const tables = sourceRun.tables.map(t => ({
    ...t,
    truncateBeforeMigrate: truncate ? true : t.truncateBeforeMigrate,
  }));

  const newRun: MigRun = {
    id: randomUUID(),
    jobId: sourceRun.jobId,
    jobName: sourceRun.jobName,
    status: 'pending',
    createdAt: now,
    startedAt: null,
    completedAt: null,
    constraintBypassMode: 'transaction',
    heartbeatAt: now,
    restartedFromRunId: runId,
    sourceMeta: sourceRun.sourceMeta,
    targetMeta: sourceRun.targetMeta,
    tables,
    tableStates: tables
      .filter(t => t.include)
      .map((t): MigRunTableState => ({
        id: t.id,
        sourceKey: `${t.source.schema}.${t.source.table}`,
        targetKey: `${t.target.schema}.${t.targetAlias?.trim() || t.target.table}`,
        status: 'pending',
        rowsSource: 0, rowsMigrated: 0, rowsSkipped: 0, rowsErrored: 0,
        offset: 0, hasMore: true, error: null,
        insertedPks: [], pkOverflow: false, targetPkCol: null,
      })),
    logs: [`[${now}] Restarted from run ${runId}${truncate ? ' with TRUNCATE' : ''}.`],
    totalRows: 0,
    migratedRows: 0,
    errors: [],
    filterCol: sourceRun.filterCol ?? null,
    filterFrom: sourceRun.filterFrom ?? null,
    filterTo: sourceRun.filterTo ?? null,
  };

  saveRun(newRun);

  const schedule = listSchedules().find(s => s.jobId === newRun.jobId) ?? null;
  void driveRun(newRun, conns.source, conns.target, schedule?.id ?? null);

  return res.status(200).json({ runId: newRun.id });
}
