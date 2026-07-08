import type { NextApiRequest, NextApiResponse } from 'next';
import { randomUUID } from 'crypto';
import { loadSchedule, saveSchedule } from '../../../../lib/migv2/schedule-store';
import { loadJob } from '../../../../lib/migv2/job-store';
import { activeRunCount, MAX_CONCURRENT_MIGRATIONS, saveRun } from '../../../../lib/migv2/run-store';
import { resolveJobConns } from '../../../../lib/migv2/resolve-conns';
import { driveRun } from '../../../../lib/migv2/run-driver';
import type { MigRun, MigRunTableState } from '../../../../lib/migv2/types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { id } = req.query as { id: string };
  const schedule = loadSchedule(id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });
  if (!schedule.enabled) return res.status(400).json({ error: 'Schedule is disabled' });
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
    return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached. Stop or wait for an active run.` });
  }

  const job = loadJob(schedule.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Look up full connection credentials from dbt_connections (jobs never store passwords)
  let source, target;
  try {
    ({ source, target } = await resolveJobConns(job));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }

  const includedTables = job.tables.filter(t => t.include);
  const now = new Date().toISOString();
  const run: MigRun = {
    id: randomUUID(),
    jobId: job.id,
    jobName: job.name,
    status: 'pending',
    createdAt: now,
    startedAt: null,
    completedAt: null,
    constraintBypassMode: 'transaction',
    heartbeatAt: now,
    sourceMeta: job.sourceMeta,
    targetMeta: job.targetMeta,
    tables: includedTables,
    tableStates: includedTables.map((t): MigRunTableState => ({
      id: t.id,
      sourceKey: `${t.source.schema}.${t.source.table}`,
      targetKey: `${t.target.schema}.${t.targetAlias?.trim() || t.target.table}`,
      status: 'pending',
      rowsSource: 0, rowsMigrated: 0, rowsSkipped: 0, rowsErrored: 0,
      offset: 0, hasMore: true, error: null,
      insertedPks: [], pkOverflow: false, targetPkCol: null,
    })),
    logs: [],
    totalRows: 0, migratedRows: 0, errors: [],
    filterCol: job.filterCol ?? null,
    filterFrom: job.filterFrom ?? null,
    filterTo: job.filterTo ?? null,
  };

  saveRun(run);

  // Mark schedule as running
  saveSchedule({
    ...schedule,
    lastRunStatus: 'running',
    lastRunId: run.id,
    updatedAt: now,
  });

  // Run in background — response returns immediately with the run ID
  void driveRun(run, source, target, id);

  return res.status(200).json({ runId: run.id });
}
