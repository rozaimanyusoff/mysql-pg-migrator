import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { acquireRunLock, activeRunCount, activeRunForJob, loadRun, MAX_CONCURRENT_MIGRATIONS, RUN_START_LOCK, saveRun } from '../../../../lib/migv2/run-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { listSchedules } from '../../../../lib/migv2/schedule-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import { prepareRunTables } from '../../../../lib/migv2/run-tables';
import type { MigRun, MigRunTableState } from '../../../../lib/migv2/types';
import { requireSchedulerMutationAuth } from '../../../../lib/scheduler-security';
import { getPreflightStatus, preflightRequiredMessage } from '../../../../lib/migv2/preflight-store';
import { createRunExecutionPolicy } from '../../../../lib/migv2/execution-policy';

// POST { runId, truncate? } — restart a run from offset 0 for all tables.
// Creates a new run ID (original run is preserved for audit).
// When truncate=true, sets truncateBeforeMigrate on every table so the runner
// clears target data before the first chunk of each table.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!requireSchedulerMutationAuth(req, res)) return;

  const { runId, truncate = false } = req.body as { runId?: string; truncate?: boolean };
  if (!runId) return res.status(400).json({ error: 'runId is required' });

  const sourceRun = loadRun(runId);
  if (!sourceRun) return res.status(404).json({ error: 'Run not found' });
  if (sourceRun.status === 'running') return res.status(400).json({ error: 'Run is already in progress' });
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  if (!sourceRun.jobId) return res.status(400).json({ error: 'Run has no job to resolve connections from' });
  const existingRun = activeRunForJob(sourceRun.jobId);
  if (existingRun) return res.status(409).json({ error: `This job still has an active ${existingRun.status} run. Stop it before restarting from the first row.`, activeRunId: existingRun.id });

  const job = loadJob(sourceRun.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found — cannot resolve connections' });
  const preflightStatus = getPreflightStatus(job);
  if (!preflightStatus.ready) return res.status(428).json({ error: preflightRequiredMessage(preflightStatus), preflightRequired: true });

  let conns;
  try {
    conns = await resolveJobConns(job);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const releaseStartLock = await acquireRunLock(RUN_START_LOCK);
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
    releaseStartLock();
    return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  }
  const lockedExistingRun = activeRunForJob(sourceRun.jobId);
  if (lockedExistingRun) {
    releaseStartLock();
    return res.status(409).json({ error: `This job still has an active ${lockedExistingRun.status} run. Stop it before restarting from the first row.`, activeRunId: lockedExistingRun.id });
  }

  const now = new Date().toISOString();

  const tables = prepareRunTables(sourceRun.tables, { truncate }).map(table => ({
    ...table,
    // Restart is a new migration attempt from the first source row. Resume is
    // the operation that continues from a paused/failed run cursor.
    lastSyncedValue: null,
    lastSyncedPk: null,
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
    executionPolicy: sourceRun.executionPolicy ?? createRunExecutionPolicy(),
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

  try { saveRun(newRun); } finally { releaseStartLock(); }

  const schedule = listSchedules().find(s => s.jobId === newRun.jobId) ?? null;
  void driveRun(newRun, conns.source, conns.target, schedule?.id ?? null);

  return res.status(200).json({ runId: newRun.id });
}
