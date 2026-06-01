import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob } from '../../../../lib/migv2/job-store';
import { buildCreateTableSQL } from '../../../../lib/migv2/runner';
import type { MigJob } from '../../../../lib/migv2/types';

function buildJobDDL(job: MigJob): string {
  const targetType = job.targetMeta.type;
  const lines: string[] = [
    `-- Migration Job: ${job.name}`,
    job.description ? `-- ${job.description}` : null,
    `-- Generated: ${new Date().toISOString()}`,
    `-- Version: ${job.version}`,
    `--`,
    `-- Source: ${job.sourceMeta.type}://${job.sourceMeta.host}:${job.sourceMeta.port}/${job.sourceMeta.database}`,
    `-- Target: ${job.targetMeta.type}://${job.targetMeta.host}:${job.targetMeta.port}/${job.targetMeta.database}`,
    `--`,
    `-- Tables: ${job.tables.filter(t => t.include).length} included / ${job.tables.length} total`,
    '',
  ].filter((l): l is string => l !== null);

  const included = job.tables.filter(t => t.include && t.columns.length > 0);
  const excluded = job.tables.filter(t => !t.include);

  for (const table of included) {
    lines.push(
      `-- ── ${table.source.schema}.${table.source.table} → ${table.target.schema}.${table.target.table} ──`,
    );
    if (table.truncateBeforeMigrate) {
      if (targetType === 'postgresql') {
        lines.push(`TRUNCATE TABLE "${table.target.schema}"."${table.target.table}" CASCADE;`);
      } else {
        lines.push(`TRUNCATE TABLE \`${table.target.schema}\`.\`${table.target.table}\`;`);
      }
    }
    lines.push(buildCreateTableSQL(table, targetType));
    lines.push('');
  }

  if (excluded.length > 0) {
    lines.push(`-- ── Excluded tables (${excluded.length}) ──`);
    for (const table of excluded) {
      lines.push(`-- ${table.source.schema}.${table.source.table} → ${table.target.schema}.${table.target.table}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const { id } = req.query as { id?: string };
  if (!id) return res.status(400).json({ error: 'id required' });

  const job = loadJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const sql = buildJobDDL(job);
  const filename = `${job.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.sql`;

  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(sql);
}
