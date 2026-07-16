import type { NextApiRequest, NextApiResponse } from 'next';
import { activeRunCount, MAX_CONCURRENT_MIGRATIONS, saveRun } from '../../../../lib/migv2/run-store';
import type { MigConn, MigRun, MigRunTableState, TableMap } from '../../../../lib/migv2/types';
import { randomUUID } from 'crypto';
import { assessMigrationTables } from '../../../../lib/migv2/recurring-validation';
import { createRunExecutionPolicy } from '../../../../lib/migv2/execution-policy';
import { driveRun } from '../../../../lib/migv2/run-driver';
import { validateMigrationBindings } from '../../../../lib/migv2/preflight';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { source, target, tables, jobId, jobName, filterCol, filterFrom, filterTo } = req.body as {
    source: MigConn;
    target: MigConn;
    tables: TableMap[];
    jobId?: string;
    jobName: string;
    filterCol?: string | null;
    filterFrom?: string | null;
    filterTo?: string | null;
  };

  if (!source || !target || !tables?.length) {
    return res.status(400).json({ error: 'source, target, tables required' });
  }
  const assessment = assessMigrationTables(tables);
  if (!assessment.oneOffReady) {
    return res.status(422).json({
      error: `Migration setup has ${assessment.oneOffIssues.length} blocking issue${assessment.oneOffIssues.length !== 1 ? 's' : ''}.`,
      setupIssues: assessment.oneOffIssues,
    });
  }
  const bindingIssues = await validateMigrationBindings(tables, source, target);
  if (bindingIssues.length) {
    return res.status(422).json({
      error: `Migration has ${bindingIssues.length} missing or unverifiable physical binding${bindingIssues.length !== 1 ? 's' : ''}. Rebind the saved job before running.`,
      bindingIssues,
    });
  }
  if (activeRunCount() >= MAX_CONCURRENT_MIGRATIONS) {
    return res.status(409).json({ error: `Maximum ${MAX_CONCURRENT_MIGRATIONS} concurrent migrations reached.` });
  }

  const run: MigRun = {
    id: randomUUID(),
    jobId: jobId ?? null,
    jobName: jobName ?? 'Unnamed',
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    constraintBypassMode: 'transaction',
    executionPolicy: createRunExecutionPolicy(),
    sourceMeta: { type: source.type, host: source.host, port: source.port, database: source.database, username: source.username },
    targetMeta: { type: target.type, host: target.host, port: target.port, database: target.database, username: target.username },
    tables: tables.filter(t => t.include),
    tableStates: tables.filter(t => t.include).map((t): MigRunTableState => ({
      id: t.id,
      sourceKey: `${t.source.schema}.${t.source.table}`,
      targetKey: `${t.target.schema}.${t.target.table}`,
      status: 'pending',
      rowsSource: 0,
      rowsMigrated: 0,
      rowsSkipped: 0,
      rowsErrored: 0,
      offset: 0,
      hasMore: true,
      error: null,
      insertedPks: [],
      pkOverflow: false,
      targetPkCol: null,
    })),
    logs: [],
    totalRows: 0,
    migratedRows: 0,
    errors: [],
    filterCol: filterCol ?? null,
    filterFrom: filterFrom ?? null,
    filterTo: filterTo ?? null,
  };

  // Persist first, then let the server own execution. The browser only polls
  // status, so closing the tab or the user's laptop does not abandon Run Once.
  saveRun(run);
  void driveRun(run, source, target, null);
  return res.status(200).json({ run });
}
