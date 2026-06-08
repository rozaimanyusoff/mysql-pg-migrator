import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import { withMysql, type ExplorerConn } from '../../../lib/explorer-db';
import { saveJob } from '../../../lib/migv2/job-store';
import type { MigJob, TableMap, ColumnMap, IdConversion } from '../../../lib/migv2/types';
import { randomUUID } from 'crypto';

export const config = { api: { responseLimit: false } };

const VALID_CONVERSIONS = new Set<IdConversion>([
  'keep', 'serial_to_uuid', 'to_text', 'to_integer', 'to_bigint',
  'to_numeric', 'to_boolean', 'to_timestamptz', 'to_date', 'to_jsonb',
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { sourceConn, sourceDb, targetConn, targetDb, targetSchema, jobName, tables } = req.body as {
    sourceConn: ExplorerConn;
    sourceDb: string;
    targetConn: ExplorerConn;
    targetDb: string;
    targetSchema: string;
    jobName: string;
    tables: Array<{ schema: string; name: string; rowCount?: number }>;
  };

  if (!sourceConn || !targetConn || !jobName?.trim() || !tables?.length) {
    return res.status(400).json({ error: 'sourceConn, targetConn, jobName, and tables required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keep connection alive during long AI calls
  const hb = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 10000);

  try {
    send('status', { message: `Loading schema for ${tables.length} table(s)…` });

    // ── 1. Fetch full schema from MySQL ──────────────────────────────────────

    const tableSchemas: Array<{
      schema: string; name: string; rowCount: number;
      columns: Array<{
        name: string; type: string; nullable: boolean; default: string | null;
        isPk: boolean; isAutoIncrement: boolean; fkRef: string | null; isUnique: boolean;
      }>;
    }> = [];

    for (const t of tables) {
      const dbConn = { ...sourceConn, database: t.schema };
      const cols = await withMysql(dbConn, async c => {
        const [rows] = await c.query<any[]>(`
          SELECT COLUMN_NAME AS col, COLUMN_TYPE AS type,
                 IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultVal,
                 COLUMN_KEY AS colKey, EXTRA AS extra
          FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          ORDER BY ORDINAL_POSITION
        `, [t.schema, t.name]);

        const [fkRows] = await c.query<any[]>(`
          SELECT kcu.COLUMN_NAME AS col,
                 kcu.REFERENCED_TABLE_SCHEMA AS refSchema,
                 kcu.REFERENCED_TABLE_NAME AS refTable,
                 kcu.REFERENCED_COLUMN_NAME AS refCol
          FROM information_schema.KEY_COLUMN_USAGE kcu
          JOIN information_schema.TABLE_CONSTRAINTS tc
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
           AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
            AND kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
        `, [t.schema, t.name]);

        const fkMap = new Map((fkRows as any[]).map(r => [r.col, `${r.refSchema}.${r.refTable}.${r.refCol}`]));

        return (rows as any[]).map(c => ({
          name: c.col as string,
          type: c.type as string,
          nullable: c.nullable === 'YES',
          default: c.defaultVal ?? null,
          isPk: c.colKey === 'PRI',
          isUnique: c.colKey === 'UNI',
          isAutoIncrement: (c.extra ?? '').includes('auto_increment'),
          fkRef: fkMap.get(c.col) ?? null,
        }));
      });

      tableSchemas.push({ schema: t.schema, name: t.name, rowCount: t.rowCount ?? 0, columns: cols });
      send('status', { message: `Loaded: ${t.schema}.${t.name} (${cols.length} columns)` });
    }

    // ── 2. Build prompt ───────────────────────────────────────────────────────

    const schemaText = tableSchemas.map(t => {
      const colLines = t.columns.map(c => {
        const flags: string[] = [];
        if (c.isPk) flags.push('PK');
        if (c.isUnique) flags.push('UNIQUE');
        if (c.isAutoIncrement) flags.push('AUTO_INCREMENT');
        if (c.nullable) flags.push('NULL');
        if (c.fkRef) flags.push(`FK→${c.fkRef}`);
        return `  ${c.name}: ${c.type}${flags.length ? ` [${flags.join(', ')}]` : ''}${c.default != null ? ` DEFAULT ${c.default}` : ''}`;
      }).join('\n');
      return `TABLE ${t.schema}.${t.name} (~${t.rowCount.toLocaleString()} rows)\n${colLines}`;
    }).join('\n\n');

    send('status', { message: 'AI is generating job configuration — this may take a moment…' });

    // ── 3. Call Claude ────────────────────────────────────────────────────────

    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: `You are a MySQL→PostgreSQL migration expert. Generate a complete migration job configuration.

Source: MySQL "${sourceDb}"
Target: PostgreSQL database "${targetDb}", schema "${targetSchema}"

MySQL Schema:
${schemaText}

Return ONLY valid JSON (no markdown fences, no explanation):
{
  "tables": [
    {
      "source": { "schema": "${sourceDb}", "table": "table_name" },
      "target": { "schema": "${targetSchema}", "table": "table_name" },
      "order": 1,
      "columns": [
        {
          "sourceCol": "col_name",
          "targetCol": "col_name",
          "targetType": "pg_type",
          "nullable": false,
          "defaultValue": null,
          "conversion": "keep"
        }
      ]
    }
  ]
}

Column type mapping rules:
- VARCHAR/CHAR/TEXT/TINYTEXT/MEDIUMTEXT/LONGTEXT → "text", conversion: "keep"
- TINYINT(1) where name contains is_, has_, can_, flag, active, enabled, deleted, visible, published → "boolean", conversion: "to_boolean"
- TINYINT (other) → "smallint", conversion: "keep"
- SMALLINT → "smallint", conversion: "keep"
- MEDIUMINT → "integer", conversion: "keep"
- INT/INTEGER (not unsigned) → "integer", conversion: "keep"
- INT UNSIGNED → "bigint", conversion: "keep"
- BIGINT → "bigint", conversion: "keep"
- BIGINT UNSIGNED → "numeric(20,0)", conversion: "keep"
- AUTO_INCREMENT PK (any int size) → keep original int type, conversion: "keep", defaultValue: null
- FLOAT → "real", conversion: "keep"
- DOUBLE/DOUBLE PRECISION → "double precision", conversion: "keep"
- DECIMAL(p,s)/NUMERIC(p,s) → "numeric(p,s)", conversion: "keep"
- DATE → "date", conversion: "to_date"
- DATETIME → "timestamp without time zone", conversion: "keep"
- TIMESTAMP → "timestamptz", conversion: "to_timestamptz"
- TIME → "time", conversion: "keep"
- YEAR → "smallint", conversion: "keep"
- JSON → "jsonb", conversion: "to_jsonb"
- ENUM(...) → "text", conversion: "to_text"
- SET(...) → "text", conversion: "to_text"
- BIT(1) → "boolean", conversion: "to_boolean"
- BLOB/MEDIUMBLOB/LONGBLOB/BINARY/VARBINARY → "bytea", conversion: "keep"

Default value rules:
- AUTO_INCREMENT columns → null
- CURRENT_TIMESTAMP → "now()"
- ON UPDATE CURRENT_TIMESTAMP → null (no PG equivalent)
- Other values → keep as string, e.g. "0", "'active'"

Table ordering (order field):
- Tables with no FK references to other tables in this list → order 1
- Tables that FK to order-1 tables → order 2
- Topological sort — parent tables always have lower order than child tables

Conversion must be one of: keep, serial_to_uuid, to_text, to_integer, to_bigint, to_numeric, to_boolean, to_timestamptz, to_date, to_jsonb`,
      }],
    });

    // ── 4. Parse response ─────────────────────────────────────────────────────

    send('status', { message: 'Parsing AI response…' });

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') throw new Error('No text response from AI');

    let aiJson: { tables: any[] };
    try {
      aiJson = JSON.parse(textBlock.text);
    } catch {
      const match = textBlock.text.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('AI response is not valid JSON');
      aiJson = JSON.parse(match[0]);
    }

    if (!Array.isArray(aiJson.tables)) throw new Error('AI response missing tables array');

    // ── 5. Build MigJob ───────────────────────────────────────────────────────

    const sorted = [...aiJson.tables].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const tableMaps: TableMap[] = sorted.map((t): TableMap => ({
      id: randomUUID(),
      include: true,
      source: { schema: t.source?.schema ?? sourceDb, table: t.source?.table ?? '' },
      sourceDatabase: sourceDb,
      target: { schema: t.target?.schema ?? targetSchema, table: t.target?.table ?? t.source?.table ?? '' },
      columns: (t.columns ?? []).map((c: any): ColumnMap => ({
        sourceCol: c.sourceCol ?? null,
        targetCol: c.targetCol ?? c.sourceCol ?? '',
        targetName: null,
        targetType: c.targetType ?? 'text',
        nullable: Boolean(c.nullable),
        defaultValue: c.defaultValue ?? null,
        include: true,
        conversion: VALID_CONVERSIONS.has(c.conversion) ? (c.conversion as IdConversion) : 'keep',
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
      description: `AI-generated — MySQL ${sourceDb} → PostgreSQL ${targetDb}.${targetSchema} (${tableMaps.length} tables)`,
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

    send('status', { message: 'Saving job…' });
    const saved = saveJob(job);

    send('done', {
      jobId: saved.id,
      jobName: saved.name,
      tableCount: saved.tables.length,
    });
    res.end();
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
    res.end();
  } finally {
    clearInterval(hb);
  }
}
