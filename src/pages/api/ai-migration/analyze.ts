import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MIGRATION_MODEL } from '../../../lib/ai-migration/model';
import { withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export const config = {
  api: { responseLimit: false },
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { conn, tables } = req.body as {
    conn: ExplorerConn;
    tables: Array<{ schema: string; name: string; rowCount?: number }>;
  };

  if (!conn || !tables?.length) {
    return res.status(400).json({ error: 'conn and tables required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    (res as unknown as { flush?: () => void }).flush?.(); // push immediately if compression middleware is active
  };

  try {
    send('status', { message: `Loading schema for ${tables.length} table(s)...` });

    const tableSchemas: string[] = [];

    for (const t of tables) {
      const dbConn = { ...conn, database: t.schema };
      const colLines = await withMysql(dbConn, async c => {
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
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
            AND kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
        `, [t.schema, t.name]);

        const fkMap = new Map((fkRows as any[]).map(r => [r.col, `${r.refSchema}.${r.refTable}.${r.refCol}`]));

        return (rows as any[]).map(c => {
          const flags: string[] = [];
          if (c.colKey === 'PRI') flags.push('PK');
          if (c.colKey === 'UNI') flags.push('UNIQUE');
          if ((c.extra ?? '').includes('auto_increment')) flags.push('AUTO_INCREMENT');
          if (c.nullable === 'YES') flags.push('NULL');
          if (fkMap.has(c.col)) flags.push(`FK→${fkMap.get(c.col)}`);
          const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
          const defStr = c.defaultVal != null ? ` DEFAULT ${c.defaultVal}` : '';
          return `  ${c.col}: ${c.type}${flagStr}${defStr}`;
        });
      });

      const rowInfo = t.rowCount != null ? ` (~${t.rowCount.toLocaleString()} rows)` : '';
      tableSchemas.push(`TABLE: ${t.schema}.${t.name}${rowInfo}\n${colLines.join('\n')}`);
      send('status', { message: `Loaded: ${t.schema}.${t.name}` });
    }

    send('status', { message: 'Analyzing with AI — this may take a moment...' });

    const client = new Anthropic();
    const stream = client.messages.stream({
      model: AI_MIGRATION_MODEL,
      max_tokens: 4096,
      // Static instructions in a cached system block; only the (dynamic) schema
      // varies per request, so it stays in the user turn.
      system: [{
        type: 'text',
        cache_control: { type: 'ephemeral' },
        text: `You are an expert MySQL→PostgreSQL migration engineer. Analyze the MySQL schema the user provides and produce a thorough pre-flight migration report.

Write the report in this exact format:

## Executive Summary
2-3 sentences covering overall migration complexity and primary concerns.

## CRITICAL Issues
Issues that WILL cause migration failure or data loss if not addressed.
Format each as: \`table.column\` — **Issue** → Fix

## WARNINGS
Issues that may cause data inconsistency or unexpected behavior.
Format each as: \`table.column\` — **Issue** → Recommendation

## Informational Notes
Best-practice observations for this schema.

## Recommended Migration Order
List tables in the order they must be migrated to satisfy FK dependencies. Number each.

---
Key things to check for each column type:
- ENUM → requires CREATE TYPE or CHECK constraint in PG
- UNSIGNED INT/BIGINT → no unsigned in PG; overflow risk for large values
- AUTO_INCREMENT → use SERIAL/BIGSERIAL or GENERATED ALWAYS AS IDENTITY
- DATETIME → no timezone; use TIMESTAMP WITH TIME ZONE in PG and clarify app behavior
- TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP → no PG equivalent; needs trigger
- TINYINT(1) → typically boolean in MySQL; use BOOLEAN in PG
- BIT(1) → use BOOLEAN in PG
- SET → no PG equivalent; use TEXT[] or normalize
- JSON/LONGTEXT storing JSON → use JSONB in PG
- Tables with no primary key → add surrogate PK before migration
- Collation/charset → UTF8MB4 maps to UTF8 in PG
- FK dependency order → parent tables must be created/migrated before child tables`,
      }],
      messages: [{
        role: 'user',
        content: `MySQL schema to analyze:\n\n${tableSchemas.join('\n\n')}`,
      }],
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        send('text', { text: event.delta.text });
      }
    }

    send('done', { message: 'Analysis complete' });
    res.end();
  } catch (err) {
    send('error', { message: err instanceof Error ? err.message : String(err) });
    res.end();
  }
}
