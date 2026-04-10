import type { NextApiRequest, NextApiResponse } from 'next';
import { MigrationConfig } from '../../lib/types';
import { generateMarkdownDocumentation, generateSQLDocumentation } from '../../lib/documentation-generator';
import { generateExcelCSV } from '../../lib/excel-generator';
import { buildSummary } from '../../lib/postgres-migrator';

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { config, format } = req.body as { config: MigrationConfig; format: string };
  if (!config) return res.status(400).json({ error: 'config is required' });

  try {
    let content = '';
    if (format === 'markdown') content = generateMarkdownDocumentation(config);
    else if (format === 'csv') content = generateExcelCSV(config);
    else if (format === 'sql') content = generateSQLDocumentation(config);
    else return res.status(400).json({ error: 'Unknown format. Use markdown, csv, or sql.' });

    return res.status(200).json({ success: true, format, content, summary: buildSummary(config) });
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
