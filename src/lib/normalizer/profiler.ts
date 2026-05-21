export interface ColProfile {
  name: string;
  index: number;
  total: number;
  nullCount: number;
  distinctCount: number;
  topValues: { value: string; count: number }[];
  inferredType: string;
  fkCandidate: boolean;
}

export interface FkSuggestion {
  colName: string;
  colIndex: number;
  distinctValues: string[];
  suggestedLookupTable: string;
}

export interface SheetResult {
  sheetName: string;
  tableName: string;
  headers: string[];
  previewRows: string[][];
  allRows: string[][];
  rowCount: number;
  columns: ColProfile[];
  fkSuggestions: FkSuggestion[];
}

export function sanitizeName(s: string): string {
  const clean = String(s).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return /^\d/.test(clean) ? `_${clean}` : clean || 'column';
}

function inferType(vals: string[]): string {
  if (vals.length === 0) return 'TEXT';
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (vals.every(v => uuidRe.test(v))) return 'UUID';
  const boolSet = new Set(['true', 'false', 'yes', 'no', '1', '0']);
  if (vals.every(v => boolSet.has(v.toLowerCase()))) return 'BOOLEAN';
  if (vals.every(v => /^-?\d+$/.test(v.trim()))) return vals.some(v => Math.abs(Number(v)) > 2147483647) ? 'BIGINT' : 'INTEGER';
  if (vals.every(v => /^-?\d+(\.\d+)?$/.test(v.trim()))) return 'NUMERIC';
  if (vals.every(v => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) return 'TIMESTAMP';
  if (vals.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'DATE';
  return 'TEXT';
}

export function profileColumns(headers: string[], rows: string[][]): ColProfile[] {
  return headers.map((name, i) => {
    const vals = rows.map(r => r[i] ?? '');
    const nonEmpty = vals.filter(v => v.trim() !== '');
    const nullCount = vals.length - nonEmpty.length;
    const freq = new Map<string, number>();
    for (const v of nonEmpty) freq.set(v, (freq.get(v) ?? 0) + 1);
    const distinctCount = freq.size;
    const topValues = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([value, count]) => ({ value, count }));
    const inferredType = inferType(nonEmpty);
    const threshold = Math.min(50, Math.max(5, Math.floor(nonEmpty.length * 0.2)));
    const fkCandidate = inferredType === 'TEXT' && nonEmpty.length > 0 && distinctCount > 1 && distinctCount <= threshold;
    return { name, index: i, total: vals.length, nullCount, distinctCount, topValues, inferredType, fkCandidate };
  });
}

export function buildFkSuggestions(columns: ColProfile[], allRows: string[][]): FkSuggestion[] {
  return columns
    .filter(c => c.fkCandidate)
    .map(c => {
      const distinct = [...new Set(allRows.map(r => r[c.index] ?? '').filter(v => v.trim() !== ''))].sort();
      return {
        colName: c.name,
        colIndex: c.index,
        distinctValues: distinct,
        suggestedLookupTable: sanitizeName(c.name) + 's',
      };
    });
}

export function buildSheetResult(
  sheetName: string,
  headers: string[],
  dataRows: string[][],
): SheetResult {
  const columns = profileColumns(headers, dataRows);
  const fkSuggestions = buildFkSuggestions(columns, dataRows);
  return {
    sheetName,
    tableName: sanitizeName(sheetName),
    headers,
    previewRows: dataRows.slice(0, 10),
    allRows: dataRows,
    rowCount: dataRows.length,
    columns,
    fkSuggestions,
  };
}
