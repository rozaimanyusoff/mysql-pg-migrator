import type { NextApiRequest, NextApiResponse } from 'next';
import { saveJob } from '../../../lib/migv2/job-store';
import type { MigJob, TableMap, ColumnMap, IdConversion } from '../../../lib/migv2/types';
import { randomUUID } from 'crypto';
import type { ExplorerConn } from '../../../lib/explorer-db';

const VALID_CONVERSIONS = new Set<IdConversion>([
  'keep', 'serial_to_uuid', 'to_text', 'to_integer', 'to_bigint',
  'to_numeric', 'to_boolean', 'to_timestamptz', 'to_date', 'to_jsonb',
]);

interface ProposalColumn {
  sourceCol: string;
  targetCol: string;
  targetPgType: string;
  conversion: string;
  nullable: boolean;
  defaultValue: string | null;
}

interface ProposalTable {
  source: { schema: string; table: string };
  target: { schema: string; table: string };
  order?: number;
  unmatched?: boolean;
  columns?: ProposalColumn[];
}

interface Proposal {
  tables: ProposalTable[];
}

export interface SaveProposalResponse {
  jobId: string;
  jobName: string;
  tableCount: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { sourceConn, targetConn, sourceDb, targetDb, targetPgSchema, jobName, proposal } = req.body as {
    sourceConn: ExplorerConn;
    targetConn: ExplorerConn;
    sourceDb: string;
    targetDb: string;
    targetPgSchema: string;
    jobName: string;
    proposal: Proposal;
  };

  if (!jobName?.trim() || !proposal?.tables?.length) {
    return res.status(400).json({ error: 'jobName and proposal.tables required' });
  }

  try {
    const matched = proposal.tables.filter(t => !t.unmatched);
    const sorted = [...matched].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const tableMaps: TableMap[] = sorted.map((t): TableMap => ({
      id: randomUUID(),
      include: true,
      source: { schema: t.source.schema, table: t.source.table },
      sourceDatabase: sourceDb,
      target: { schema: t.target.schema, table: t.target.table },
      columns: (t.columns ?? []).map((c): ColumnMap => ({
        sourceCol: c.sourceCol ?? null,
        targetCol: c.targetCol ?? c.sourceCol ?? '',
        targetName: null,
        targetType: c.targetPgType ?? 'text',
        nullable: Boolean(c.nullable),
        defaultValue: c.defaultValue ?? null,
        include: true,
        conversion: VALID_CONVERSIONS.has(c.conversion as IdConversion)
          ? (c.conversion as IdConversion)
          : 'keep',
        fkRef: null,
        keepLegacyAs: null,
      })),
      truncateBeforeMigrate: false,
      syncMode: 'full',
      incrementalCol: null,
      incrementalStrategy: 'id',
      lastSyncedValue: null,
    }));

    const now = new Date().toISOString();
    const job: MigJob = {
      id: randomUUID(),
      name: jobName.trim(),
      description: `AI Migrator (Scenario 1) — MySQL ${sourceDb} → PG ${targetDb}.${targetPgSchema} (${tableMaps.length} tables)`,
      version: 0,
      createdAt: now,
      updatedAt: now,
      sourceMeta: {
        type: 'mysql',
        host: sourceConn.host,
        port: sourceConn.port,
        database: sourceDb,
        username: sourceConn.username,
      },
      targetMeta: {
        type: 'postgresql',
        host: targetConn.host,
        port: targetConn.port,
        database: targetDb,
        username: targetConn.username,
      },
      tables: tableMaps,
    };

    const saved = saveJob(job);
    return res.status(200).json({ jobId: saved.id, jobName: saved.name, tableCount: saved.tables.length } satisfies SaveProposalResponse);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
