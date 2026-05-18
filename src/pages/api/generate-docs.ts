import type { NextApiRequest, NextApiResponse } from 'next';
import { MigrationConfig, ExportViewOptions } from '../../lib/types';
import {
  generateMarkdownDocumentation,
  generateSQLDocumentation,
  generateSVGDocumentation,
  generateCanvasDocumentation,
} from '../../lib/documentation-generator';
import { generateExcelCSV } from '../../lib/excel-generator';
import { buildSummary } from '../../lib/postgres-migrator';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_generate_docs_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { config, format, viewOptions } = req.body as {
    config: MigrationConfig;
    format: string;
    viewOptions?: ExportViewOptions;
  };
  if (!config) {
    await logApiActivity(req, 'api_generate_docs_bad_request', 'warn');
    return res.status(400).json({ error: 'config is required' });
  }
  const view: ExportViewOptions = {
    includeSource: viewOptions?.includeSource ?? true,
    includeTarget: viewOptions?.includeTarget ?? true,
  };
  if (!view.includeSource && !view.includeTarget) {
    await logApiActivity(req, 'api_generate_docs_view_invalid', 'warn');
    return res.status(400).json({ error: 'Select at least one view option: source or target.' });
  }

  try {
    let content = '';
    if (format === 'markdown') content = generateMarkdownDocumentation(config, view);
    else if (format === 'csv') content = generateExcelCSV(config, view);
    else if (format === 'sql') content = generateSQLDocumentation(config, view);
    else if (format === 'svg') content = generateSVGDocumentation(config, view);
    else if (format === 'canvas') content = generateCanvasDocumentation(config, view);
    else return res.status(400).json({ error: 'Unknown format. Use markdown, csv, sql, svg, or canvas.' });

    await logApiActivity(req, 'api_generate_docs_success', 'info', { format, tables: config.tables.length });
    return res.status(200).json({ success: true, format, content, summary: buildSummary(config) });
  } catch (err: unknown) {
    await logApiActivity(req, 'api_generate_docs_error', 'error', { message: err instanceof Error ? err.message : String(err) });
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
