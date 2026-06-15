import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MIGRATION_MODEL } from '../../../lib/ai-migration/model';
import { withMysql, withPg, type ExplorerConn } from '../../../lib/explorer-db';

export const config = { api: { responseLimit: false } };

// ── Shared types (also used by the page) ─────────────────────────────────────

export interface SourceColumn {
  name: string; type: string; nullable: boolean; default: string | null;
  isPk: boolean; isAutoIncrement: boolean; isUnique: boolean; fkRef: string | null;
}
export interface SourceTable { schema: string; name: string; rowCount: number; columns: SourceColumn[]; }
export interface TargetColumn { name: string; type: string; nullable: boolean; default: string | null; isPk: boolean; isUnique: boolean; fkRef: string | null; }
export interface TargetTable { schema: string; name: string; columns: TargetColumn[]; }
export interface ChatSchemas { sourceSchema: SourceTable[]; targetSchema: TargetTable[]; }

// ── Schema readers ────────────────────────────────────────────────────────────

async function readMysqlSchema(
  conn: ExplorerConn,
  tables: Array<{ schema: string; name: string; rowCount: number }>,
): Promise<SourceTable[]> {
  const result: SourceTable[] = [];
  for (const t of tables) {
    const dbConn = { ...conn, database: t.schema };
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
        name: c.col as string, type: c.type as string,
        nullable: c.nullable === 'YES', default: c.defaultVal ?? null,
        isPk: c.colKey === 'PRI', isUnique: c.colKey === 'UNI',
        isAutoIncrement: (c.extra ?? '').includes('auto_increment'),
        fkRef: fkMap.get(c.col) ?? null,
      }));
    });
    result.push({ schema: t.schema, name: t.name, rowCount: t.rowCount, columns: cols });
  }
  return result;
}

async function readPgSchema(conn: ExplorerConn, pgSchema: string): Promise<TargetTable[]> {
  return withPg(conn, async c => {
    const { rows: trows } = await c.query<any>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE' ORDER BY table_name`,
      [pgSchema],
    );
    const tables: TargetTable[] = [];
    for (const tr of trows) {
      const tn = tr.table_name as string;
      const { rows: crows } = await c.query<any>(`
        SELECT
          c.column_name AS name,
          c.udt_name AS type,
          (c.is_nullable = 'YES') AS nullable,
          c.column_default AS default_val,
          EXISTS(
            SELECT 1 FROM information_schema.key_column_usage kcu
            JOIN information_schema.table_constraints tc
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND kcu.table_schema = $1 AND kcu.table_name = $2 AND kcu.column_name = c.column_name
          ) AS is_pk,
          EXISTS(
            SELECT 1 FROM information_schema.key_column_usage kcu
            JOIN information_schema.table_constraints tc
              ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'UNIQUE'
              AND kcu.table_schema = $1 AND kcu.table_name = $2 AND kcu.column_name = c.column_name
          ) AS is_unique
        FROM information_schema.columns c
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position
      `, [pgSchema, tn]);
      tables.push({
        schema: pgSchema, name: tn,
        columns: crows.map((r: any) => ({
          name: r.name, type: r.type,
          nullable: r.nullable, default: r.default_val,
          isPk: r.is_pk, isUnique: r.is_unique, fkRef: null,
        })),
      });
    }
    return tables;
  });
}

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(
  src: SourceTable[], tgt: TargetTable[],
  srcDb: string, tgtDb: string, tgtSchema: string,
): string {
  const srcText = src.map(t => {
    const cols = t.columns.map(c => {
      const f: string[] = [];
      if (c.isPk) f.push('PK');
      if (c.isUnique) f.push('UNIQUE');
      if (c.isAutoIncrement) f.push('AUTO_INCREMENT');
      if (c.nullable) f.push('NULL');
      if (c.fkRef) f.push(`FK→${c.fkRef}`);
      return `  ${c.name}: ${c.type}${f.length ? ` [${f.join(', ')}]` : ''}${c.default != null ? ` DEFAULT ${c.default}` : ''}`;
    }).join('\n');
    return `TABLE ${t.schema}.${t.name} (~${t.rowCount.toLocaleString()} rows)\n${cols}`;
  }).join('\n\n');

  const tgtText = tgt.length === 0
    ? `(no existing tables found in schema "${tgtSchema}")`
    : tgt.map(t => {
        const cols = t.columns.map(c => {
          const f: string[] = [];
          if (c.isPk) f.push('PK');
          if (c.isUnique) f.push('UNIQUE');
          if (c.nullable) f.push('NULL');
          if (c.fkRef) f.push(`FK→${c.fkRef}`);
          return `  ${c.name}: ${c.type}${f.length ? ` [${f.join(', ')}]` : ''}${c.default != null ? ` DEFAULT ${c.default}` : ''}`;
        }).join('\n');
        return `TABLE ${t.schema}.${t.name}\n${cols}`;
      }).join('\n\n');

  return `You are an expert MySQL→PostgreSQL migration assistant. Help the user map their MySQL source schema to an existing PostgreSQL target schema interactively.

## SOURCE: MySQL database "${srcDb}"
${srcText}

## TARGET: PostgreSQL database "${tgtDb}", schema "${tgtSchema}"
${tgtText}

## Your role
- Match each source MySQL table to the best-fit EXISTING PostgreSQL target table (by name similarity and column overlap)
- Map each source column to the correct target column with proper type conversion
- Respect FK dependencies when ordering tables
- Warn about potential issues: data loss, type mismatch, missing columns, constraint violations

## When to include a proposal
Include the [MAPPING_PROPOSAL] block ONLY when:
1. Presenting the initial analysis (first response)
2. The user asks you to remap, adjust, or change specific tables/columns
3. The user asks to confirm, review, or save the mapping

For conversational replies — answering questions, explaining choices, acknowledging feedback — respond WITHOUT the [MAPPING_PROPOSAL] block. Keep those turns short and fast.

## Proposal format
When a proposal IS required, use this EXACT format:

[MAPPING_PROPOSAL]
{
  "tables": [
    {
      "source": { "schema": "source_db", "table": "source_table" },
      "target": { "schema": "${tgtSchema}", "table": "target_table" },
      "order": 1,
      "confidence": "high",
      "notes": "Brief explanation of why this match was chosen",
      "unmatched": false,
      "columns": [
        {
          "sourceCol": "col_name",
          "targetCol": "col_name",
          "sourceMysqlType": "int",
          "targetPgType": "integer",
          "conversion": "keep",
          "nullable": false,
          "defaultValue": null,
          "notes": "optional note"
        }
      ]
    }
  ],
  "warnings": ["global warnings about the migration"],
  "unmatched": ["source_table_with_no_match"]
}
[/MAPPING_PROPOSAL]

## Type conversion rules
- VARCHAR/TEXT/CHAR → text, keep
- TINYINT(1) or boolean-named cols (is_, has_, flag, active, enabled, deleted, visible) → boolean, to_boolean
- TINYINT/SMALLINT → smallint, keep
- INT/MEDIUMINT → integer, keep
- INT UNSIGNED → bigint, keep
- BIGINT → bigint, keep
- FLOAT → real, keep
- DOUBLE → double precision, keep
- DECIMAL(p,s)/NUMERIC(p,s) → numeric(p,s), keep
- DATE → date, to_date
- DATETIME → timestamp without time zone, keep
- TIMESTAMP → timestamptz, to_timestamptz
- JSON → jsonb, to_jsonb
- ENUM/SET → text, to_text
- BLOB/BINARY/VARBINARY → bytea, keep

## Valid conversion values
keep, serial_to_uuid, to_text, to_integer, to_bigint, to_numeric, to_boolean, to_timestamptz, to_date, to_jsonb

## Rules
- Match source tables to EXISTING target tables ONLY — never invent new target tables
- Tables with no target match: set "unmatched": true, omit columns array, include in top-level "unmatched" list
- order field must reflect FK dependency order (parent tables have lower order than children)
- For the initial analysis and any mapping changes, include [MAPPING_PROPOSAL]
- For clarifications or questions, reply conversationally WITHOUT [MAPPING_PROPOSAL]
- When user requests changes, regenerate the FULL updated proposal`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const {
    sourceConn, targetConn, sourceDb, targetDb, targetPgSchema,
    sourceTables, messages, schemas,
  } = req.body as {
    sourceConn: ExplorerConn;
    targetConn: ExplorerConn;
    sourceDb: string;
    targetDb: string;
    targetPgSchema: string;
    sourceTables: Array<{ schema: string; name: string; rowCount: number }>;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    schemas?: ChatSchemas;
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    (res as unknown as { flush?: () => void }).flush?.(); // push immediately if compression middleware is active
  };

  const hb = setInterval(() => res.write('event: ping\ndata: {}\n\n'), 10000);

  try {
    let sourceSchema: SourceTable[];
    let targetSchema: TargetTable[];

    if (schemas) {
      sourceSchema = schemas.sourceSchema;
      targetSchema = schemas.targetSchema;
    } else {
      send('status', { message: `Reading source schema for ${sourceTables.length} table(s)…` });
      sourceSchema = await readMysqlSchema(sourceConn, sourceTables);
      for (const t of sourceSchema) {
        send('status', { message: `Read source: ${t.name} (${t.columns.length} columns)` });
      }

      send('status', { message: 'Reading target PostgreSQL schema…' });
      const pgConn = { ...targetConn, database: targetDb };
      targetSchema = await readPgSchema(pgConn, targetPgSchema);
      send('status', { message: `Found ${targetSchema.length} target table(s). Connecting to AI…` });

      const chatSchemas: ChatSchemas = { sourceSchema, targetSchema };
      send('schemas', chatSchemas);
    }

    const systemPrompt = buildSystemPrompt(sourceSchema, targetSchema, sourceDb, targetDb, targetPgSchema);
    const client = new Anthropic();

    const stream = client.messages.stream({
      model: AI_MIGRATION_MODEL,
      max_tokens: 8000,
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    });

    let fullText = '';
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        fullText += chunk.delta.text;
        send('text', { chunk: chunk.delta.text });
      }
    }

    const proposalMatch = fullText.match(/\[MAPPING_PROPOSAL\]([\s\S]*?)\[\/MAPPING_PROPOSAL\]/);
    if (proposalMatch) {
      try {
        const proposal = JSON.parse(proposalMatch[1].trim());
        send('proposal', proposal);
      } catch { /* malformed JSON — ignore */ }
    }

    send('done', {});
    res.end();
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
    res.end();
  } finally {
    clearInterval(hb);
  }
}
