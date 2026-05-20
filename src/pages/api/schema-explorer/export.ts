import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';
import * as XLSX from 'xlsx';

// ── XLSX style helpers ────────────────────────────────────────────────────────
const THIN = (rgb = 'D1D5DB') => ({ style: 'thin' as const, color: { rgb } });
const MEDIUM = (rgb = '2563EB') => ({ style: 'medium' as const, color: { rgb } });

const border = (rgb = 'D1D5DB') => ({ top: THIN(rgb), bottom: THIN(rgb), left: THIN(rgb), right: THIN(rgb) });
const outerBorder = (innerRgb = 'D1D5DB', outerRgb = '2563EB') => ({
  top: MEDIUM(outerRgb), bottom: MEDIUM(outerRgb),
  left: MEDIUM(outerRgb), right: MEDIUM(outerRgb),
  ...{ inner: THIN(innerRgb) }
});

function makeCell(value: string | number | boolean, s: object): XLSX.CellObject {
  const t = typeof value === 'number' ? 'n' : typeof value === 'boolean' ? 'b' : 's';
  return { v: value, t, s } as XLSX.CellObject;
}

function setRange(ws: XLSX.WorkSheet, rows: (string | number | boolean | null)[][], startRow = 0) {
  rows.forEach((row, ri) => {
    row.forEach((val, ci) => {
      if (val === null) return;
      const addr = XLSX.utils.encode_cell({ r: startRow + ri, c: ci });
      if (!ws[addr]) ws[addr] = { v: val, t: typeof val === 'number' ? 'n' : 's' } as XLSX.CellObject;
    });
  });
}

type ExportFormat = 'sql' | 'xlsx';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { conn, tableKeys, format } = req.body as {
    conn: ExplorerConn;
    tableKeys: string[];
    format: ExportFormat;
  };

  if (!conn || !tableKeys?.length) {
    return res.status(400).json({ error: 'conn and tableKeys required' });
  }

  try {
    if (format === 'xlsx') {
      // Collect all column info grouped by table key
      const tableData = new Map<string, (string | number | boolean)[][]>();
      for (const key of tableKeys) tableData.set(key, []);

      if (conn.type === 'postgresql') {
        const schemas = [...new Set(tableKeys.map(k => (k.includes('.') ? k.split('.')[0] : 'public')))];
        const tableNames = tableKeys.map(k => (k.includes('.') ? k.split('.')[1] : k));

        await withPg(conn, async (client) => {
          const keySet = new Set(tableKeys);
          const schemas = [...new Set(tableKeys.map(k => k.split('.')[0]))];
          const tableNames = tableKeys.map(k => k.split('.')[1] ?? k);
          const { rows: cols } = await client.query<any>(`
            SELECT c.table_schema AS schema, c.table_name,
              c.column_name, c.udt_name, c.character_maximum_length,
              c.is_nullable, c.column_default,
              EXISTS(SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
                WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema
                  AND tc.table_name=c.table_name AND kcu.column_name=c.column_name) AS is_pk,
              EXISTS(SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
                WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=c.table_schema
                  AND tc.table_name=c.table_name AND kcu.column_name=c.column_name) AS is_fk,
              pgd.description AS comment
            FROM information_schema.columns c
            LEFT JOIN pg_catalog.pg_statio_all_tables st
              ON st.schemaname=c.table_schema AND st.relname=c.table_name
            LEFT JOIN pg_catalog.pg_description pgd
              ON pgd.objoid=st.relid AND pgd.objsubid=c.ordinal_position
            WHERE c.table_schema=ANY($1) AND c.table_name=ANY($2)
            ORDER BY c.table_schema, c.table_name, c.ordinal_position
          `, [schemas, tableNames]);
          for (const r of cols) {
            const key = `${r.schema}.${r.table_name}`;
            if (!keySet.has(key)) continue;
            const type = r.character_maximum_length ? `${r.udt_name}(${r.character_maximum_length})` : r.udt_name;
            tableData.get(key)!.push([
              r.schema, r.table_name, r.column_name, type,
              r.is_nullable === 'YES' ? 'YES' : 'NO',
              r.column_default ?? '', r.is_pk ? 'PK' : '', r.is_fk ? 'FK' : '', r.comment ?? '',
            ]);
          }
        });
      } else {
        const dbSchemas = [...new Set(tableKeys.map(k => k.includes('.') ? k.split('.')[0] : conn.database))];
        const tableNames = tableKeys.map(k => k.includes('.') ? k.split('.')[1] : k);
        await withMysql(conn, async (c) => {
          const ph = dbSchemas.map(() => '?').join(','), tp = tableNames.map(() => '?').join(',');
          const [cols] = await c.query<any[]>(`
            SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS table_name,
              COLUMN_NAME AS column_name, COLUMN_TYPE AS type,
              IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
              IF(COLUMN_KEY='PRI','PK','') AS is_pk, IF(COLUMN_KEY='MUL','FK','') AS is_fk,
              COLUMN_COMMENT AS comment
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA IN (${ph}) AND TABLE_NAME IN (${tp})
            ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
          `, [...dbSchemas, ...tableNames]);
          const keySet = new Set(tableKeys);
          for (const r of cols as any[]) {
            const key = `${r.schema}.${r.table_name}`;
            if (!keySet.has(key)) continue;
            tableData.get(key)!.push([r.schema, r.table_name, r.column_name, r.type,
              r.is_nullable === 'YES' ? 'YES' : 'NO', r.column_default ?? '', r.is_pk, r.is_fk, r.comment ?? '']);
          }
        });
      }

      // ── Build styled workbook ──────────────────────────────────────────────
      const COLS = ['Schema','Table','Column','Type','Nullable','Default','PK','FK','Comment'];
      const N = COLS.length; // 9

      const TITLE_S = { font: { bold: true, sz: 14, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '1D4ED8' }, patternType: 'solid' }, alignment: { horizontal: 'center' } };
      const GEN_S   = { font: { italic: true, sz: 9, color: { rgb: '6B7280' } }, fill: { fgColor: { rgb: 'F8FAFC' }, patternType: 'solid' } };
      const COL_S   = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '2563EB' }, patternType: 'solid' }, border: border('93C5FD'), alignment: { horizontal: 'center' } };
      const TBL_S   = { font: { bold: true, color: { rgb: '1E3A5F' } }, fill: { fgColor: { rgb: 'DBEAFE' }, patternType: 'solid' }, border: border('93C5FD') };
      const DATA_S  = { border: border(), alignment: { wrapText: false } };
      const DATA_ALT= { border: border(), fill: { fgColor: { rgb: 'F8FAFC' }, patternType: 'solid' } };

      const ws: XLSX.WorkSheet = {};
      let row = 0;

      // Title row
      ws[XLSX.utils.encode_cell({ r: row, c: 0 })] = makeCell('Schema Overview', TITLE_S);
      for (let c = 1; c < N; c++) ws[XLSX.utils.encode_cell({ r: row, c })] = makeCell('', TITLE_S);
      row++;

      // Generated row
      ws[XLSX.utils.encode_cell({ r: row, c: 0 })] = makeCell(`Generated: ${new Date().toISOString().slice(0,19).replace('T',' ')}  |  Tables: ${tableKeys.length}`, GEN_S);
      for (let c = 1; c < N; c++) ws[XLSX.utils.encode_cell({ r: row, c })] = makeCell('', GEN_S);
      row++;
      row++; // blank row

      const colHeaderRow = row;

      // Column headers
      COLS.forEach((label, c) => { ws[XLSX.utils.encode_cell({ r: row, c })] = makeCell(label, COL_S); });
      row++;

      // Per-table groups
      for (const key of tableKeys) {
        const rows = tableData.get(key) ?? [];
        // Table separator header
        const tblLabel = `  ${key}  (${rows.length} columns)`;
        for (let c = 0; c < N; c++) ws[XLSX.utils.encode_cell({ r: row, c })] = makeCell(c === 0 ? tblLabel : '', TBL_S);
        row++;
        // Data rows
        rows.forEach((dataRow, ri) => {
          const s = ri % 2 === 0 ? DATA_S : DATA_ALT;
          dataRow.forEach((val, c) => { ws[XLSX.utils.encode_cell({ r: row, c })] = makeCell(String(val ?? ''), s); });
          row++;
        });
      }

      ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: row - 1, c: N - 1 } });
      ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: N - 1 } },
        { s: { r: 1, c: 0 }, e: { r: 1, c: N - 1 } },
      ];
      ws['!cols'] = [16, 22, 24, 22, 10, 18, 5, 5, 32].map(wch => ({ wch }));
      ws['!freeze'] = { xSplit: 0, ySplit: colHeaderRow + 1 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Schema Overview');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="schema-overview.xlsx"');
      return res.status(200).send(buf);
    }

    // SQL migration export
    const lines: string[] = [`-- Generated by Schema Explorer\n-- ${new Date().toISOString()}\n`];

    for (const key of tableKeys) {
      const parts = key.split('.');
      const [schema, table] = parts.length === 2 ? parts : ['public', parts[0]];

      if (conn.type === 'postgresql') {
        await withPg(conn, async (client) => {
          const { rows: cols } = await client.query<any>(`
            SELECT c.column_name, c.udt_name, c.character_maximum_length,
              c.numeric_precision, c.numeric_scale, c.is_nullable, c.column_default
            FROM information_schema.columns c
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position
          `, [schema, table]);

          const { rows: pkRows } = await client.query<{ col: string }>(`
            SELECT kcu.column_name AS col
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
              AND tc.table_schema = $1 AND tc.table_name = $2
            ORDER BY kcu.ordinal_position
          `, [schema, table]);
          const pks = new Set(pkRows.map(r => r.col));

          const { rows: fkRows } = await client.query<any>(`
            SELECT kcu.column_name AS from_col,
              ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_col,
              tc.constraint_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
            JOIN information_schema.referential_constraints rc
              ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
            JOIN information_schema.key_column_usage ccu
              ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = rc.unique_constraint_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
              AND tc.table_schema = $1 AND tc.table_name = $2
          `, [schema, table]);

          const colDefs = cols.map(c => {
            let typeDef = c.udt_name;
            if (c.character_maximum_length) typeDef += `(${c.character_maximum_length})`;
            else if (c.numeric_precision && ['numeric', 'decimal'].includes(c.udt_name))
              typeDef += `(${c.numeric_precision},${c.numeric_scale ?? 0})`;
            const notNull = c.is_nullable === 'NO' ? ' NOT NULL' : '';
            const def = c.column_default ? ` DEFAULT ${c.column_default}` : '';
            return `  ${c.column_name} ${typeDef}${notNull}${def}`;
          });

          if (pks.size)
            colDefs.push(`  PRIMARY KEY (${[...pks].join(', ')})`);

          fkRows.forEach(fk => {
            colDefs.push(
              `  CONSTRAINT ${fk.constraint_name} FOREIGN KEY (${fk.from_col}) REFERENCES ${fk.ref_schema}.${fk.ref_table}(${fk.ref_col})`
            );
          });

          lines.push(`CREATE TABLE IF NOT EXISTS ${schema}.${table} (\n${colDefs.join(',\n')}\n);\n`);
        });
      } else {
        await withMysql(conn, async (c) => {
          const [cols] = await c.query<any[]>(`
            SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
          `, [schema, table]);

          const [fkRows] = await c.query<any[]>(`
            SELECT kcu.COLUMN_NAME AS from_col,
              kcu.REFERENCED_TABLE_SCHEMA AS ref_schema,
              kcu.REFERENCED_TABLE_NAME AS ref_table,
              kcu.REFERENCED_COLUMN_NAME AS ref_col,
              kcu.CONSTRAINT_NAME
            FROM information_schema.KEY_COLUMN_USAGE kcu
            JOIN information_schema.TABLE_CONSTRAINTS tc
              ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
            WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
              AND kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?
          `, [schema, table]);

          const colDefs = (cols as any[]).map(c => {
            const notNull = c.IS_NULLABLE === 'NO' ? ' NOT NULL' : '';
            const def = c.COLUMN_DEFAULT !== null ? ` DEFAULT ${c.COLUMN_DEFAULT}` : '';
            const pk = c.COLUMN_KEY === 'PRI' ? ' PRIMARY KEY' : '';
            const extra = c.EXTRA ? ` ${c.EXTRA}` : '';
            return `  \`${c.COLUMN_NAME}\` ${c.COLUMN_TYPE}${notNull}${def}${extra}${pk}`;
          });

          (fkRows as any[]).forEach(fk => {
            colDefs.push(
              `  CONSTRAINT \`${fk.CONSTRAINT_NAME}\` FOREIGN KEY (\`${fk.from_col}\`) REFERENCES \`${fk.ref_schema}\`.\`${fk.ref_table}\`(\`${fk.ref_col}\`)`
            );
          });

          lines.push(`CREATE TABLE IF NOT EXISTS \`${schema}\`.\`${table}\` (\n${colDefs.join(',\n')}\n);\n`);
        });
      }
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="migration.sql"');
    return res.status(200).send(lines.join('\n'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
