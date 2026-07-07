import type { NextApiRequest, NextApiResponse } from 'next';
import { loadJob } from '../../../lib/migv2/job-store';
import { resolveJobConns } from '../../../lib/migv2/resolve-conns';
import { withMysql, withPg } from '../../../lib/explorer-db';

interface SchemaColumn {
  schema: string;
  table: string;
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
  unique: boolean;
  fkSchema: string | null;
  fkTable: string | null;
  fkColumn: string | null;
}

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'migrated-schema';
}

function md(value: unknown): string {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mermaidName(schema: string, table: string): string {
  return `${schema}_${table}`.replace(/[^a-zA-Z0-9_]/g, '_');
}

function mermaidType(type: string): string {
  return type.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_()[\],]/g, '');
}

async function inspectTarget(job: NonNullable<ReturnType<typeof loadJob>>): Promise<{ columns: SchemaColumn[]; missing: string[] }> {
  const { target } = await resolveJobConns(job);
  const requested = Array.from(new Map(
    job.tables.filter(t => t.include).map(t => {
      const item = { schema: t.target.schema, table: t.targetAlias?.trim() || t.target.table };
      return [`${item.schema}.${item.table}`, item] as const;
    })
  ).values());
  const columns: SchemaColumn[] = [];
  const found = new Set<string>();

  if (target.type === 'postgresql') {
    await withPg(target, async client => {
      for (const item of requested) {
        const { rows } = await client.query<any>(`
          SELECT c.table_schema, c.table_name, c.column_name,
            format_type(a.atttypid, a.atttypmod) AS full_type,
            c.is_nullable, c.column_default,
            EXISTS (
              SELECT 1 FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
              WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema
                AND tc.table_name = c.table_name AND kcu.column_name = c.column_name
            ) AS is_pk,
            EXISTS (
              SELECT 1 FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
              WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = c.table_schema
                AND tc.table_name = c.table_name AND kcu.column_name = c.column_name
            ) AS is_unique,
            fk.foreign_table_schema, fk.foreign_table_name, fk.foreign_column_name
          FROM information_schema.columns c
          JOIN pg_catalog.pg_class cls ON cls.relname = c.table_name
          JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace AND ns.nspname = c.table_schema
          JOIN pg_catalog.pg_attribute a ON a.attrelid = cls.oid AND a.attname = c.column_name
          LEFT JOIN LATERAL (
            SELECT ccu.table_schema AS foreign_table_schema, ccu.table_name AS foreign_table_name,
              ccu.column_name AS foreign_column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name AND kcu.constraint_schema = tc.constraint_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name = tc.constraint_name AND ccu.constraint_schema = tc.constraint_schema
            WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = c.table_schema
              AND tc.table_name = c.table_name AND kcu.column_name = c.column_name
            LIMIT 1
          ) fk ON true
          WHERE c.table_schema = $1 AND c.table_name = $2
          ORDER BY c.ordinal_position`, [item.schema, item.table]);
        if (rows.length > 0) found.add(`${item.schema}.${item.table}`);
        for (const row of rows) columns.push({
          schema: row.table_schema, table: row.table_name, name: row.column_name,
          type: row.full_type, nullable: row.is_nullable === 'YES', defaultValue: row.column_default,
          primaryKey: row.is_pk, unique: row.is_unique,
          fkSchema: row.foreign_table_schema, fkTable: row.foreign_table_name, fkColumn: row.foreign_column_name,
        });
      }
    });
  } else {
    await withMysql(target, async client => {
      for (const item of requested) {
        const [rows] = await client.query<any[]>(`
          SELECT c.TABLE_SCHEMA, c.TABLE_NAME, c.COLUMN_NAME, c.COLUMN_TYPE,
            c.IS_NULLABLE, c.COLUMN_DEFAULT, c.COLUMN_KEY,
            k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME
          FROM information_schema.COLUMNS c
          LEFT JOIN information_schema.KEY_COLUMN_USAGE k
            ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
            AND k.COLUMN_NAME = c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL
          WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ?
          ORDER BY c.ORDINAL_POSITION`, [item.schema, item.table]);
        if (rows.length > 0) found.add(`${item.schema}.${item.table}`);
        for (const row of rows) columns.push({
          schema: row.TABLE_SCHEMA, table: row.TABLE_NAME, name: row.COLUMN_NAME,
          type: row.COLUMN_TYPE, nullable: row.IS_NULLABLE === 'YES', defaultValue: row.COLUMN_DEFAULT,
          primaryKey: row.COLUMN_KEY === 'PRI', unique: row.COLUMN_KEY === 'UNI',
          fkSchema: row.REFERENCED_TABLE_SCHEMA, fkTable: row.REFERENCED_TABLE_NAME, fkColumn: row.REFERENCED_COLUMN_NAME,
        });
      }
    });
  }

  return { columns, missing: requested.map(t => `${t.schema}.${t.table}`).filter(key => !found.has(key)) };
}

function buildSchemaMarkdown(job: NonNullable<ReturnType<typeof loadJob>>, columns: SchemaColumn[], missing: string[]): string {
  const grouped = new Map<string, SchemaColumn[]>();
  for (const column of columns) {
    const key = `${column.schema}.${column.table}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(column);
  }

  const lines: string[] = [
    `# Migrated Schema — ${job.name}`,
    '',
    `Generated from the live **${job.targetMeta.type}** target database on ${new Date().toISOString()}.`,
    '',
    '## ORM Context',
    '',
    `- Database: \`${job.targetMeta.database}\``,
    `- Dialect: \`${job.targetMeta.type}\``,
    `- Migration job ID: \`${job.id}\``,
    `- Job version: \`${job.version}\``,
    `- Migrated tables found: **${grouped.size}**`,
    '- Use schema-qualified table names. Preserve database column names explicitly in ORM mappings.',
    '- Treat database defaults as authoritative; do not duplicate generated/default expressions in application code unless required.',
    '',
    '## Entity Relationship Diagram',
    '',
    '```mermaid',
    'erDiagram',
  ];

  for (const [key, tableColumns] of grouped) {
    const [schema, ...tableParts] = key.split('.');
    const table = tableParts.join('.');
    lines.push(`  ${mermaidName(schema, table)} {`);
    for (const column of tableColumns) {
      const flags = [column.primaryKey ? 'PK' : '', column.fkTable ? 'FK' : '', column.unique ? 'UK' : ''].filter(Boolean).join(',');
      lines.push(`    ${mermaidType(column.type)} ${mermaidName('', column.name).replace(/^_/, '')}${flags ? ` ${flags}` : ''}`);
    }
    lines.push('  }');
  }
  const relations = columns.filter(c => c.fkTable && c.fkColumn);
  for (const relation of relations) {
    lines.push(`  ${mermaidName(relation.fkSchema ?? relation.schema, relation.fkTable!)} ||--o{ ${mermaidName(relation.schema, relation.table)} : "${relation.name}"`);
  }
  lines.push('```', '');

  lines.push('## Tables', '');
  for (const [key, tableColumns] of grouped) {
    lines.push(`### \`${key}\``, '');
    lines.push('| Column | Database Type | Nullable | Default | Key | References |');
    lines.push('|---|---|:---:|---|---|---|');
    for (const column of tableColumns) {
      const keys = [column.primaryKey ? 'PK' : '', column.unique ? 'UNIQUE' : '', column.fkTable ? 'FK' : ''].filter(Boolean).join(', ') || '—';
      const reference = column.fkTable ? `\`${column.fkSchema}.${column.fkTable}.${column.fkColumn}\`` : '—';
      lines.push(`| \`${md(column.name)}\` | \`${md(column.type)}\` | ${column.nullable ? 'YES' : 'NO'} | ${column.defaultValue == null ? '—' : `\`${md(column.defaultValue)}\``} | ${keys} | ${reference} |`);
    }
    lines.push('');
  }

  if (missing.length > 0) {
    lines.push('## Planned Tables Not Found in Target', '');
    lines.push('These tables are included in the job but were not present when this document was generated:', '');
    for (const key of missing) lines.push(`- \`${key}\``);
    lines.push('');
  }

  lines.push('## ORM Implementation Checklist', '');
  lines.push('- [ ] Map every model to its schema-qualified table name.');
  lines.push('- [ ] Preserve primary keys, UUID generation strategy, unique constraints, and nullability.');
  lines.push('- [ ] Define relations from the foreign-key references above.');
  lines.push('- [ ] Review database defaults before adding application-side defaults.');
  lines.push('- [ ] Generate and review ORM migrations; do not apply them blindly to this existing schema.');
  lines.push('');
  lines.push(`_Generated by DB Maintenance Tools from scheduler job \`${job.id}\`._`);
  return lines.join('\n');
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  const { jobId } = req.query as { jobId?: string };
  if (!jobId) return res.status(400).json({ error: 'jobId required' });
  const job = loadJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  try {
    const { columns, missing } = await inspectTarget(job);
    const markdown = buildSchemaMarkdown(job, columns, missing);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(job.name)}-migrated-schema.md"`);
    return res.status(200).send(markdown);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
