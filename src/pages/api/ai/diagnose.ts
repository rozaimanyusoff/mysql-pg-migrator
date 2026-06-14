import type { NextApiRequest, NextApiResponse } from 'next';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';
import type { ColumnMap } from '../../../lib/migv2/types';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface DiagnoseRequest {
  error: string;
  sourceKey: string;
  targetKey: string;
  columnMappings?: ColumnMap[];
  runId?: string;
  filterCol?: string | null;
  filterFrom?: string | null;
  filterTo?: string | null;
}

export interface ColumnFix {
  col: string;
  issue: string;
  fix: string;
}

export interface DiagnoseResult {
  rootCause: string;
  explanation: string;
  suggestedFix: string;
  columnFixes: ColumnFix[];
  severity: 'critical' | 'warning' | 'info';
}

function loadRun(runId: string) {
  try {
    const file = path.join(process.cwd(), 'data', 'migv2', 'runs', `${runId}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const {
    error, sourceKey, targetKey,
    columnMappings, runId,
    filterCol, filterFrom, filterTo,
  } = req.body as DiagnoseRequest;

  if (!error || !sourceKey) {
    return res.status(400).json({ error: 'error and sourceKey are required' });
  }

  // Enrich with run context when available
  let runContext = '';
  if (runId) {
    const run = loadRun(runId);
    if (run) {
      const ts = (run.tableStates ?? []).find((t: { sourceKey: string }) => t.sourceKey === sourceKey);
      if (ts) {
        runContext = `
Run context:
- Source row count: ${ts.rowsSource?.toLocaleString() ?? 'unknown'}
- Rows migrated before failure: ${ts.rowsMigrated?.toLocaleString() ?? 0}
- Rows with errors: ${ts.rowsErrored?.toLocaleString() ?? 0}
- Chunk offset at failure: ${ts.offset ?? 'unknown'}`;
        if (run.filterCol) {
          runContext += `\n- Active row-range filter: ${run.filterCol} BETWEEN '${run.filterFrom ?? '*'}' AND '${run.filterTo ?? '*'}'`;
        }
      }
    }
  }

  const mappingText = columnMappings?.length
    ? columnMappings
        .filter(cm => cm.include)
        .map(cm => {
          const parts = [`  ${cm.sourceCol ?? '(new)'} → ${cm.targetName ?? cm.targetCol} [${cm.targetType}]`];
          if (cm.conversion !== 'keep') parts.push(`conversion:${cm.conversion}`);
          if (cm.fkRef) parts.push(`FK→${cm.fkRef}`);
          if (!cm.nullable) parts.push('NOT NULL');
          if (cm.defaultValue) parts.push(`default:${cm.defaultValue}`);
          return parts.join(' ');
        })
        .join('\n')
    : '(no mappings provided)';

  const filterText = filterCol
    ? `Row-range filter active: ${filterCol} BETWEEN '${filterFrom ?? '*'}' AND '${filterTo ?? '*'}'`
    : 'No row-range filter';

  const prompt = `You are a database migration expert. A MySQL → PostgreSQL migration failed for one table. Diagnose the root cause and provide specific, actionable fixes.

## Failed table
- Source: ${sourceKey}
- Target: ${targetKey}
- ${filterText}

## Error message
\`\`\`
${error}
\`\`\`
${runContext}

## Column mappings (included columns only)
\`\`\`
${mappingText}
\`\`\`

Common failure causes in MySQL→PostgreSQL migrations:
- Type mismatch (e.g. MySQL TINYINT(1) as boolean, ENUM as text, JSON differences)
- NOT NULL constraint violation (null values in source for a non-nullable target column)
- FK violation (referencing a row that hasn't been migrated yet)
- Encoding issues (utf8mb4 emoji characters in text columns without proper encoding)
- Integer overflow (MySQL INT to PG serial/bigint boundary issues)
- UUID conversion failure (non-UUID string being converted via serial_to_uuid)
- Chunk size timeout (1M+ rows, query timeout on large offset)
- Row-range filter column doesn't exist or has wrong type in some tables

Respond with ONLY a valid JSON object — no markdown fences, no text before or after:
{
  "rootCause": "one concise sentence (under 20 words)",
  "explanation": "2–4 sentences explaining why this happened based on the error and mappings",
  "suggestedFix": "numbered steps or a clear paragraph of what to do to fix this",
  "columnFixes": [
    { "col": "column_name", "issue": "what is wrong with this column mapping", "fix": "exact change to make" }
  ],
  "severity": "critical"
}
severity: "critical" = data loss risk or migration cannot proceed at all; "warning" = some rows failed but other tables can continue; "info" = config/setup issue with a clear workaround.
columnFixes: [] if no specific column mapping changes are needed.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    const result: DiagnoseResult = JSON.parse(raw);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Diagnosis failed',
    });
  }
}
