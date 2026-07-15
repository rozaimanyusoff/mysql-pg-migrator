import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../../lib/db';
import { loadJob } from '../../../../lib/migv2/job-store';
import type { ColumnMap, TableMap } from '../../../../lib/migv2/types';
import { withPg } from '../../../../lib/explorer-db';

interface TargetSchema {
  tables: Set<string>;                    // "schema.table"
  columns: Map<string, Set<string>>;      // "schema.table" → Set<colName>
}

async function fetchTargetSchema(
  host: string, port: number, database: string, username: string, password: string
): Promise<TargetSchema | null> {
  try {
    const tables = new Set<string>();
    const columns = new Map<string, Set<string>>();
    await withPg({ type: 'postgresql', host, port, database, username, password }, async client => {
      const tRes = await client.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')`
      );
      for (const row of tRes.rows) {
        tables.add(`${row.table_schema}.${row.table_name}`);
      }
      const cRes = await client.query<{ table_schema: string; table_name: string; column_name: string }>(
        `SELECT table_schema, table_name, column_name FROM information_schema.columns
         WHERE table_schema NOT IN ('pg_catalog','information_schema')`
      );
      for (const row of cRes.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        if (!columns.has(key)) columns.set(key, new Set());
        columns.get(key)!.add(row.column_name);
      }
    });
    return { tables, columns };
  } catch {
    return null;
  }
}

function convLabel(col: ColumnMap): string {
  if (col.conversion === 'keep') return 'keep';
  if (col.conversion === 'serial_to_uuid') return '→UUID';
  return col.conversion.replace(/^to_/, '→');
}

function keepDefault(col: ColumnMap): string {
  if (col.conversion === 'serial_to_uuid' && col.keepLegacyAs) return `legacy: \`${col.keepLegacyAs}\``;
  if (col.sourceCol === null && col.defaultValue) return `default: \`${col.defaultValue}\``;
  return '—';
}

function buildJobMd(job: ReturnType<typeof loadJob>, schema: TargetSchema | null): string {
  if (!job) return '';
  const lines: string[] = [];

  lines.push(`# ${job.name}`);
  if (job.description) lines.push('', job.description);
  lines.push('', `_Generated: ${new Date().toISOString()}_`, '');

  // Source section
  if (job.sourceMeta) {
    const srcTables = job.tables.filter(m => m.include);
    lines.push('## Source', '');
    lines.push(`- **Type**: ${job.sourceMeta.type}`);
    lines.push(`- **Host**: ${job.sourceMeta.host}:${job.sourceMeta.port}`);
    lines.push(`- **Database**: ${job.sourceMeta.database}`);
    lines.push(`- **Username**: ${job.sourceMeta.username}`);
    if (srcTables.length) {
      lines.push('', '**Tables migrated from this source:**', '');
      for (const m of srcTables) {
        const db = m.sourceDatabase ?? job.sourceMeta.database;
        lines.push(`- \`${db}.${m.source.schema}.${m.source.table}\``);
      }
    }
    lines.push('');
  }

  // Target section
  if (job.targetMeta) {
    const tgtTables = job.tables.filter(m => m.include);
    lines.push('## Target', '');
    lines.push(`- **Type**: ${job.targetMeta.type}`);
    lines.push(`- **Host**: ${job.targetMeta.host}:${job.targetMeta.port}`);
    lines.push(`- **Database**: ${job.targetMeta.database}`);
    lines.push(`- **Username**: ${job.targetMeta.username}`);
    if (tgtTables.length) {
      lines.push('', '**Tables migrated into this target:**', '');
      for (const m of tgtTables) {
        const resolvedTable = m.targetAlias?.trim() || m.target.table;
        const tgtKey = `${m.target.schema}.${resolvedTable}`;
        const exists = schema ? schema.tables.has(tgtKey) : null;
        const status = exists === true ? '✓ existing' : exists === false ? '⚡ auto-create on first run' : '';
        lines.push(`- \`${tgtKey}\`${status ? `  _(${status})_` : ''}`);
      }
    }
    lines.push('');
  }

  // Row filter
  if (job.filterCol) {
    lines.push('## Row Filter', '');
    lines.push(`- **Column**: \`${job.filterCol}\``);
    lines.push(`- **From**: ${job.filterFrom ?? '—'}`);
    lines.push(`- **To**: ${job.filterTo ?? '—'}`);
    lines.push('');
  }

  // Table mappings summary
  const included = job.tables.filter(m => m.include);
  const excluded = job.tables.filter(m => !m.include);
  lines.push(`## Table Mappings`, '');
  lines.push(`**${included.length} of ${job.tables.length} tables included** in migration.`);
  if (excluded.length) {
    lines.push(`${excluded.length} table${excluded.length > 1 ? 's are' : ' is'} excluded (unchecked) and will be skipped:`);
    for (const m of excluded) {
      lines.push(`  - \`${m.source.schema}.${m.source.table}\``);
    }
  }
  lines.push('');

  // Per-table detail
  job.tables.forEach((map, i) => {
    const resolvedTable = map.targetAlias?.trim() || map.target.table;
    const tgtKey = resolvedTable ? `${map.target.schema}.${resolvedTable}` : '';
    const status = map.include ? '✓' : '✗ excluded';
    const tableExists = schema && tgtKey ? schema.tables.has(tgtKey) : null;
    const tableStatus = tableExists === true
      ? 'existing target table'
      : tableExists === false
      ? 'auto-created on first run'
      : 'status unknown';

    lines.push(`### ${i + 1}. \`${map.source.schema}.${map.source.table}\` → \`${tgtKey || '(unassigned)'}\` [${status}]`);
    lines.push('');
    lines.push(`**Target table**: ${tableStatus}`);

    const flags: string[] = [];
    if (map.truncateBeforeMigrate) flags.push('Truncate before migrate');
    if (map.skipConstraints) flags.push('Skip constraints (transaction-scoped)');
    if (map.skipNullViolations) flags.push('Skip NULL violations (DROP NOT NULL → restore)');
    if (flags.length) lines.push(`> ⚠ ${flags.join(' · ')}`);
    if (map.syncMode === 'incremental') {
      lines.push(`> ⟳ Incremental — ${map.incrementalStrategy ?? 'id'} using \`${map.incrementalCol ?? '—'}\`${map.lastSyncedValue ? ` · data last synced through: \`${map.lastSyncedValue}\`` : ''}`);
    }
    lines.push('');

    const includedCols = map.columns.filter(c => c.include);
    const excludedCols = map.columns.filter(c => !c.include);
    const tgtCols = schema && tgtKey ? schema.columns.get(tgtKey) : null;

    if (includedCols.length > 0) {
      lines.push('| # | Source Column | Src Type | → | Target Column | Mapping | Tgt Type | Conv | Keep / Default | FK Ref |');
      lines.push('|--:|---|---|:---:|---|---|---|---|---|---|');
      // We need source type — it's not in ColumnMap, but we can note it's not stored
      includedCols.forEach((col, ci) => {
        const srcCol = col.sourceCol ?? '*(new)*';
        const tgtColName = (col.targetName ?? col.targetCol) || '—';
        const renamed = col.targetName && col.targetName !== col.targetCol
          ? ` _(was \`${col.targetCol}\`)_` : '';
        const colExists = tgtCols ? tgtCols.has(col.targetName ?? col.targetCol) : null;
        const mapping = colExists === true ? 'existing' : colExists === false ? 'new' : col.sourceCol === null ? 'target-only' : 'mapped';
        const fkRef = col.fkRef ?? '—';
        lines.push(`| ${ci + 1} | \`${srcCol}\` | — | → | \`${tgtColName}\`${renamed} | ${mapping} | ${col.targetType || '—'} | ${convLabel(col)} | ${keepDefault(col)} | ${fkRef} |`);
      });
      lines.push('');
    } else if (!map.include) {
      lines.push('_Table excluded — columns not migrated._', '');
    } else {
      lines.push('_No column mapping — table will be auto-created from source schema._', '');
    }

    if (excludedCols.length > 0) {
      lines.push(`<details><summary>Excluded columns (${excludedCols.length})</summary>`, '');
      lines.push('| Source Column | Target Column | Tgt Type |');
      lines.push('|---|---|---|');
      excludedCols.forEach(col => {
        lines.push(`| \`${col.sourceCol ?? '*(new)*'}\` | \`${(col.targetName ?? col.targetCol) || '—'}\` | ${col.targetType || '—'} |`);
      });
      lines.push('', '</details>', '');
    }
  });

  lines.push('---');
  lines.push(`_Exported from DB Maintenance Tools · Job ID: \`${job.id}\` · v${job.version}_`);

  return lines.join('\n');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();

  const { id } = req.query as { id?: string };
  if (!id) return res.status(400).json({ error: 'id required' });

  const job = loadJob(id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  // Try to resolve target connection password from saved connections
  let schema: TargetSchema | null = null;
  if (job.targetMeta) {
    try {
      const pool = getPool();
      const { rows } = await pool.query<{ password_enc: string | null }>(
        `SELECT password_enc FROM dbt_connections
         WHERE host = $1 AND port = $2 AND username = $3 AND db_type = 'postgres'
         LIMIT 1`,
        [job.targetMeta.host, job.targetMeta.port, job.targetMeta.username]
      );
      const password = rows[0]?.password_enc ?? '';
      schema = await fetchTargetSchema(
        job.targetMeta.host, job.targetMeta.port, job.targetMeta.database,
        job.targetMeta.username, password
      );
    } catch { /* schema stays null — export proceeds without live check */ }
  }

  const md = buildJobMd(job, schema);
  const filename = `${job.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
  res.setHeader('Content-Type', 'text/markdown');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.status(200).send(md);
}
