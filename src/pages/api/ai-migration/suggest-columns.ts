import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import { withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface ColumnSuggestion {
  sourceCol: string;
  sourceMysqlType: string;
  suggestedPgType: string;
  conversion: string;
  notes: string;
  warnings: string | null;
}

export interface SuggestColumnsResponse {
  suggestions: ColumnSuggestion[];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { conn, schema, table } = req.body as {
    conn: ExplorerConn;
    schema: string;
    table: string;
  };

  if (!conn || !schema || !table) {
    return res.status(400).json({ error: 'conn, schema, and table are required' });
  }

  try {
    const dbConn = { ...conn, database: schema };
    const colLines = await withMysql(dbConn, async c => {
      const [rows] = await c.query<any[]>(`
        SELECT COLUMN_NAME AS col, COLUMN_TYPE AS type,
          IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultVal,
          COLUMN_KEY AS colKey, EXTRA AS extra
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
      `, [schema, table]);

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
      `, [schema, table]);

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
        return `${c.col}: ${c.type}${flagStr}${defStr}`;
      });
    });

    const client = new Anthropic();
    const message = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: `You are a MySQL→PostgreSQL migration expert. Suggest the optimal PostgreSQL column type for each MySQL column in this table.

Table: ${schema}.${table}
Columns:
${colLines.join('\n')}

Valid conversion values (pick the most appropriate):
- keep — type converts directly with no special logic
- serial_to_uuid — AUTO_INCREMENT PK that should become UUID
- to_text — convert to PostgreSQL TEXT
- to_integer — convert to INTEGER
- to_bigint — convert to BIGINT
- to_numeric — convert to NUMERIC
- to_boolean — convert to BOOLEAN
- to_timestamptz — convert to TIMESTAMP WITH TIME ZONE
- to_date — convert to DATE
- to_jsonb — convert to JSONB

Return ONLY valid JSON (no markdown fences, no explanation outside JSON):
{
  "suggestions": [
    {
      "sourceCol": "col_name",
      "sourceMysqlType": "exact mysql type",
      "suggestedPgType": "recommended pg type string",
      "conversion": "one_of_the_valid_values",
      "notes": "brief reason for this choice",
      "warnings": "concern or caveat, or null"
    }
  ]
}`,
      }],
    });

    const textBlock = message.content.find(b => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
      return res.status(500).json({ error: 'No text response from AI' });
    }

    let parsed: SuggestColumnsResponse;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch {
      const match = textBlock.text.match(/\{[\s\S]*\}/);
      if (!match) return res.status(500).json({ error: 'Could not parse AI response', raw: textBlock.text });
      parsed = JSON.parse(match[0]);
    }

    return res.status(200).json(parsed);
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
