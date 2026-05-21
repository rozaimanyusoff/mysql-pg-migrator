// Browser-only: uses File API + dynamic xlsx import

export const PG_TYPES = ['TEXT', 'VARCHAR', 'INTEGER', 'BIGINT', 'NUMERIC', 'BOOLEAN', 'UUID', 'DATE', 'TIMESTAMP', 'JSONB'] as const;
export type PgColumnType = typeof PG_TYPES[number];

export interface ParsedColumn {
  originalName: string;
  name: string;
  type: PgColumnType;
  nullable: boolean;
}

export interface ParsedTable {
  sheetName: string;
  name: string;
  columns: ParsedColumn[];
  sampleRows: string[][];
  allRows: string[][];
  rowCount: number;
}

export function sanitizePgName(s: string): string {
  const clean = String(s).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return /^\d/.test(clean) ? `_${clean}` : clean || 'column';
}

export function inferPgType(values: string[]): PgColumnType {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v.trim() !== '');
  if (nonEmpty.length === 0) return 'TEXT';

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (nonEmpty.every((v) => uuidRe.test(v))) return 'UUID';

  const boolSet = new Set(['true', 'false', 'yes', 'no', '1', '0']);
  if (nonEmpty.every((v) => boolSet.has(v.toLowerCase()))) return 'BOOLEAN';

  if (nonEmpty.every((v) => /^-?\d+$/.test(v.trim()))) {
    return nonEmpty.some((v) => Math.abs(Number(v)) > 2147483647) ? 'BIGINT' : 'INTEGER';
  }
  if (nonEmpty.every((v) => /^-?\d+(\.\d+)?$/.test(v.trim()))) return 'NUMERIC';

  if (nonEmpty.every((v) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) return 'TIMESTAMP';
  if (nonEmpty.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'DATE';

  return 'TEXT';
}

function cellToStr(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in (value as any)) return (value as any).richText.map((r: any) => r.text).join('');
    if ('result' in (value as any)) return String((value as any).result ?? '');
    if ('text' in (value as any)) return String((value as any).text);
  }
  return String(value);
}

export async function parseExcelFile(file: File): Promise<ParsedTable[]> {
  const ExcelJS = (await import('exceljs')).default;
  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const tables: ParsedTable[] = [];

  for (const worksheet of workbook.worksheets) {
    const sheetName = worksheet.name;
    const raw: string[][] = [];
    let maxCols = 0;

    worksheet.eachRow((row) => {
      // row.values is 1-indexed; index 0 is undefined
      const vals = (row.values as unknown[]).slice(1).map(cellToStr);
      maxCols = Math.max(maxCols, vals.length);
      raw.push(vals);
    });

    // Pad all rows to same width
    for (const row of raw) {
      while (row.length < maxCols) row.push('');
    }

    if (raw.length < 2) continue;

    const headers = raw[0].map(String);
    const dataRows = raw.slice(1).filter((row) => row.some((c) => c.trim() !== ''));
    if (headers.length === 0 || dataRows.length === 0) continue;

    const validColIdx = headers.map((h, i) => ({ h, i })).filter(({ h }) => h.trim() !== '');
    const columns: ParsedColumn[] = validColIdx.map(({ h, i }) => {
      const vals = dataRows.map((row) => String(row[i] ?? ''));
      return {
        originalName: h,
        name: sanitizePgName(h),
        type: inferPgType(vals),
        nullable: vals.some((v) => v.trim() === ''),
      };
    });

    const toRow = (row: string[]) => validColIdx.map(({ i }) => String(row[i] ?? ''));
    tables.push({
      sheetName,
      name: sanitizePgName(sheetName),
      columns,
      sampleRows: dataRows.slice(0, 5).map(toRow),
      allRows: dataRows.map(toRow),
      rowCount: dataRows.length,
    });
  }
  return tables;
}

export function escapeSqlVal(val: string, type: PgColumnType): string {
  if (val === null || val === undefined || val.trim() === '') return 'NULL';
  switch (type) {
    case 'INTEGER': case 'BIGINT': case 'NUMERIC': return val.trim();
    case 'BOOLEAN': return ['true', 'yes', '1'].includes(val.toLowerCase()) ? 'TRUE' : 'FALSE';
    default: return `'${val.replace(/'/g, "''")}'`;
  }
}

export function generateSchemaSqlFromTables(tables: ParsedTable[]): string {
  return tables.map((t) => {
    const cols = t.columns.map((c) => `  ${c.name} ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(',\n');
    return `CREATE TABLE IF NOT EXISTS ${t.name} (\n${cols}\n);`;
  }).join('\n\n');
}

export function generateSeedSqlFromTables(tables: ParsedTable[]): string {
  return tables.map((t) => {
    if (t.allRows.length === 0) return '';
    const colNames = t.columns.map((c) => c.name).join(', ');
    const values = t.allRows.map((row) => {
      const vals = t.columns.map((c, i) => escapeSqlVal(row[i] ?? '', c.type)).join(', ');
      return `  (${vals})`;
    }).join(',\n');
    return `INSERT INTO ${t.name} (${colNames})\nVALUES\n${values};`;
  }).filter(Boolean).join('\n\n');
}
