import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../../lib/auth-store';
import { advanceRun } from '../../../../lib/migv2/runner';
import { saveRun } from '../../../../lib/migv2/run-store';
import type { MigConn, MigRun, MigRunTableState, TableMap } from '../../../../lib/migv2/types';
import { randomUUID } from 'crypto';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { source, target, tables, jobId, jobName } = req.body as {
    source: MigConn;
    target: MigConn;
    tables: TableMap[];
    jobId?: string;
    jobName: string;
  };

  if (!source || !target || !tables?.length) {
    return res.status(400).json({ error: 'source, target, tables required' });
  }

  const run: MigRun = {
    id: randomUUID(),
    jobId: jobId ?? null,
    jobName: jobName ?? 'Unnamed',
    status: 'pending',
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
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
  };

  try {
    const advanced = await advanceRun(run, source, target);
    saveRun(advanced);
    return res.status(200).json({ run: advanced });
  } catch (err) {
    run.status = 'failed';
    run.errors.push(err instanceof Error ? err.message : String(err));
    saveRun(run);
    return res.status(200).json({ run });
  }
}
