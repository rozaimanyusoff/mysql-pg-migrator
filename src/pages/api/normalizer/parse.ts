import type { NextApiRequest, NextApiResponse } from 'next';
import ExcelJS from 'exceljs';
import { verifyAccessToken } from '../../../lib/auth-store';
import { parseCsv } from '../../../lib/normalizer/csv-parser';
import { buildSheetResult, type SheetResult } from '../../../lib/normalizer/profiler';

function cellToStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in (value as object)) return (value as { richText: { text: string }[] }).richText.map(r => r.text).join('');
    if ('result' in (value as object)) return String((value as { result: unknown }).result ?? '');
    if ('text' in (value as object)) return String((value as { text: unknown }).text);
  }
  return String(value);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseXlsx(buffer: any): Promise<SheetResult[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const results: SheetResult[] = [];

  for (const ws of wb.worksheets) {
    const raw: string[][] = [];
    let maxCols = 0;
    ws.eachRow(row => {
      const vals = (row.values as unknown[]).slice(1).map(cellToStr);
      maxCols = Math.max(maxCols, vals.length);
      raw.push(vals);
    });
    for (const row of raw) while (row.length < maxCols) row.push('');
    if (raw.length < 2) continue;

    const headers = raw[0].map(String);
    const dataRows = raw.slice(1).filter(r => r.some(c => c.trim() !== ''));
    if (!headers.length || !dataRows.length) continue;

    results.push(buildSheetResult(ws.name, headers, dataRows));
  }
  return results;
}

function parseCsvContent(text: string): SheetResult[] {
  const raw = parseCsv(text);
  if (raw.length < 2) return [];
  const headers = raw[0].map(String);
  const dataRows = raw.slice(1).filter(r => r.some(c => c.trim() !== ''));
  if (!headers.length || !dataRows.length) return [];
  // Pad rows to same width
  const w = headers.length;
  const padded = dataRows.map(r => { const out = [...r]; while (out.length < w) out.push(''); return out.slice(0, w); });
  return [buildSheetResult('Sheet1', headers, padded)];
}

function parseJsonContent(text: string): SheetResult[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }

  // Array of objects
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'object' && parsed[0] !== null) {
    const headers = Object.keys(parsed[0] as object);
    const dataRows = (parsed as Record<string, unknown>[]).map(obj =>
      headers.map(h => { const v = obj[h]; return v === null || v === undefined ? '' : String(v); })
    );
    return [buildSheetResult('Sheet1', headers, dataRows)];
  }

  // 2D array
  if (Array.isArray(parsed) && parsed.length >= 2 && Array.isArray(parsed[0])) {
    const raw = (parsed as unknown[][]).map(r => r.map(v => v === null || v === undefined ? '' : String(v)));
    const headers = raw[0].map(String);
    const dataRows = raw.slice(1);
    return [buildSheetResult('Sheet1', headers, dataRows)];
  }

  return [];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { filename, content } = req.body as { filename?: string; content?: string };
  if (!filename || typeof content !== 'string')
    return res.status(400).json({ error: 'filename and content required' });

  const ext = filename.split('.').pop()?.toLowerCase() ?? '';

  try {
    let sheets: SheetResult[];

    if (ext === 'xlsx' || ext === 'xls') {
      const buf = Buffer.from(content, 'base64');
      sheets = await parseXlsx(buf);
    } else if (ext === 'csv') {
      sheets = parseCsvContent(content);
    } else if (ext === 'json') {
      sheets = parseJsonContent(content);
    } else {
      return res.status(400).json({ error: `Unsupported format: .${ext}` });
    }

    if (!sheets.length)
      return res.status(422).json({ error: 'No parseable data found in file.' });

    return res.status(200).json({ sheets });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
