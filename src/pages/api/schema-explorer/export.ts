import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';
import ExcelJS from 'exceljs';
import { generateOrm, type OrmTableDef, type OrmColDef, type OrmTarget } from '../../../lib/orm-generator';

const argb = (rgb: string) => `FF${rgb}`;

type BorderStyle = ExcelJS.Border;
const thinBorder = (rgb = 'D1D5DB'): BorderStyle => ({ style: 'thin', color: { argb: argb(rgb) } });

const allThin = (rgb = 'D1D5DB') => ({ top: thinBorder(rgb), bottom: thinBorder(rgb), left: thinBorder(rgb), right: thinBorder(rgb) });

type CellStyle = {
  font?: Partial<ExcelJS.Font>;
  fill?: ExcelJS.Fill;
  border?: Partial<ExcelJS.Borders>;
  alignment?: Partial<ExcelJS.Alignment>;
};

const TITLE_STYLE: CellStyle = {
  font: { bold: true, size: 14, color: { argb: argb('FFFFFF') } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('1D4ED8') } },
  alignment: { horizontal: 'center' },
};
const GEN_STYLE: CellStyle = {
  font: { italic: true, size: 9, color: { argb: argb('6B7280') } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('F8FAFC') } },
};
const COL_STYLE: CellStyle = {
  font: { bold: true, color: { argb: argb('FFFFFF') } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('2563EB') } },
  border: allThin('93C5FD'),
  alignment: { horizontal: 'center' },
};
const TBL_STYLE: CellStyle = {
  font: { bold: true, color: { argb: argb('1E3A5F') } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('DBEAFE') } },
  border: allThin('93C5FD'),
};
const DATA_STYLE: CellStyle = { border: allThin(), alignment: { wrapText: false } };
const DATA_ALT_STYLE: CellStyle = {
  border: allThin(),
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: argb('F8FAFC') } },
};

function styleCell(cell: ExcelJS.Cell, style: CellStyle, value?: string | number | boolean) {
  if (value !== undefined) cell.value = value;
  if (style.font) cell.font = style.font as ExcelJS.Font;
  if (style.fill) cell.fill = style.fill;
  if (style.border) cell.border = style.border as ExcelJS.Borders;
  if (style.alignment) cell.alignment = style.alignment as ExcelJS.Alignment;
}

type ExportFormat = 'sql' | 'xlsx' | 'drizzle' | 'prisma' | 'typeorm';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();


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
      const tableData = new Map<string, (string | number | boolean)[][]>();
      for (const key of tableKeys) tableData.set(key, []);

      if (conn.type === 'postgresql') {
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
      const COLS = ['Schema', 'Table', 'Column', 'Type', 'Nullable', 'Default', 'PK', 'FK', 'Comment'];
      const N = COLS.length;

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Schema Overview');

      let row = 1; // exceljs is 1-indexed

      // Title row
      for (let c = 1; c <= N; c++) styleCell(ws.getCell(row, c), TITLE_STYLE, c === 1 ? 'Schema Overview' : '');
      ws.mergeCells(row, 1, row, N);
      row++;

      // Generated row
      const genText = `Generated: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}  |  Tables: ${tableKeys.length}`;
      for (let c = 1; c <= N; c++) styleCell(ws.getCell(row, c), GEN_STYLE, c === 1 ? genText : '');
      ws.mergeCells(row, 1, row, N);
      row++;

      row++; // blank row

      const colHeaderRow = row;

      // Column headers
      COLS.forEach((label, i) => styleCell(ws.getCell(row, i + 1), COL_STYLE, label));
      row++;

      // Per-table groups
      for (const key of tableKeys) {
        const rows = tableData.get(key) ?? [];
        const tblLabel = `  ${key}  (${rows.length} columns)`;
        for (let c = 1; c <= N; c++) styleCell(ws.getCell(row, c), TBL_STYLE, c === 1 ? tblLabel : '');
        row++;
        rows.forEach((dataRow, ri) => {
          const s = ri % 2 === 0 ? DATA_STYLE : DATA_ALT_STYLE;
          dataRow.forEach((val, ci) => styleCell(ws.getCell(row, ci + 1), s, String(val ?? '')));
          row++;
        });
      }

      [16, 22, 24, 22, 10, 18, 5, 5, 32].forEach((width, i) => { ws.getColumn(i + 1).width = width; });
      ws.views = [{ state: 'frozen', xSplit: 0, ySplit: colHeaderRow }];

      const buf = await wb.xlsx.writeBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="schema-overview.xlsx"');
      return res.status(200).send(Buffer.from(buf));
    }

    // ORM export (drizzle | prisma | typeorm)
    if (format === 'drizzle' || format === 'prisma' || format === 'typeorm') {
      const ormTables: OrmTableDef[] = [];

      for (const key of tableKeys) {
        const parts = key.split('.');
        const [schema, table] = parts.length === 2 ? parts : ['public', parts[0]];

        if (conn.type === 'postgresql') {
          await withPg(conn, async (client) => {
            const { rows: cols } = await client.query<any>(`
              SELECT c.column_name, c.udt_name, c.character_maximum_length,
                c.numeric_precision, c.numeric_scale, c.is_nullable, c.column_default,
                EXISTS(
                  SELECT 1 FROM information_schema.table_constraints tc
                  JOIN information_schema.key_column_usage kcu
                    ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
                  WHERE tc.constraint_type='PRIMARY KEY'
                    AND tc.table_schema=$1 AND tc.table_name=$2
                    AND kcu.column_name=c.column_name
                ) AS is_pk,
                EXISTS(
                  SELECT 1 FROM information_schema.table_constraints tc
                  JOIN information_schema.key_column_usage kcu
                    ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
                  WHERE tc.constraint_type='UNIQUE'
                    AND tc.table_schema=$1 AND tc.table_name=$2
                    AND kcu.column_name=c.column_name
                ) AS is_unique,
                pgd.description AS comment
              FROM information_schema.columns c
              LEFT JOIN pg_catalog.pg_statio_all_tables st
                ON st.schemaname=c.table_schema AND st.relname=c.table_name
              LEFT JOIN pg_catalog.pg_description pgd
                ON pgd.objoid=st.relid AND pgd.objsubid=c.ordinal_position
              WHERE c.table_schema=$1 AND c.table_name=$2
              ORDER BY c.ordinal_position
            `, [schema, table]);

            const { rows: fkRows } = await client.query<any>(`
              SELECT kcu.column_name AS from_col,
                ccu.table_name AS ref_table, ccu.column_name AS ref_col
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu
                ON kcu.constraint_name=tc.constraint_name AND kcu.table_schema=tc.table_schema
              JOIN information_schema.referential_constraints rc
                ON rc.constraint_name=tc.constraint_name AND rc.constraint_schema=tc.table_schema
              JOIN information_schema.key_column_usage ccu
                ON ccu.constraint_name=rc.unique_constraint_name AND ccu.table_schema=rc.unique_constraint_schema
              WHERE tc.constraint_type='FOREIGN KEY'
                AND tc.table_schema=$1 AND tc.table_name=$2
            `, [schema, table]);

            const fkMap = new Map<string, { toTable: string; toCol: string }>();
            fkRows.forEach((r: any) => fkMap.set(r.from_col, { toTable: r.ref_table, toCol: r.ref_col }));

            const columns: OrmColDef[] = cols.map((c: any) => ({
              name: c.column_name,
              rawType: c.udt_name,
              maxLength: c.character_maximum_length ? Number(c.character_maximum_length) : null,
              numericPrecision: c.numeric_precision ? Number(c.numeric_precision) : null,
              numericScale: c.numeric_scale ? Number(c.numeric_scale) : null,
              fullType: c.character_maximum_length ? `${c.udt_name}(${c.character_maximum_length})` : c.udt_name,
              nullable: c.is_nullable === 'YES',
              defaultValue: c.column_default ?? null,
              isPk: c.is_pk === true,
              isUnique: c.is_unique === true,
              isAutoIncrement: ['serial', 'bigserial', 'smallserial'].includes(c.udt_name),
              comment: c.comment ?? null,
              fkToTable: fkMap.get(c.column_name)?.toTable ?? null,
              fkToCol: fkMap.get(c.column_name)?.toCol ?? null,
            }));

            ormTables.push({ schema, table, columns });
          });
        } else {
          await withMysql(conn, async (c) => {
            const [cols] = await c.query<any[]>(`
              SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE,
                COLUMN_DEFAULT, COLUMN_KEY, CHARACTER_MAXIMUM_LENGTH,
                NUMERIC_PRECISION, NUMERIC_SCALE, EXTRA, COLUMN_COMMENT
              FROM information_schema.COLUMNS
              WHERE TABLE_SCHEMA=? AND TABLE_NAME=?
              ORDER BY ORDINAL_POSITION
            `, [schema, table]);

            const [fkRows] = await c.query<any[]>(`
              SELECT kcu.COLUMN_NAME AS from_col,
                kcu.REFERENCED_TABLE_NAME AS ref_table,
                kcu.REFERENCED_COLUMN_NAME AS ref_col
              FROM information_schema.KEY_COLUMN_USAGE kcu
              JOIN information_schema.TABLE_CONSTRAINTS tc
                ON tc.CONSTRAINT_NAME=kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA=kcu.TABLE_SCHEMA
              WHERE tc.CONSTRAINT_TYPE='FOREIGN KEY'
                AND kcu.TABLE_SCHEMA=? AND kcu.TABLE_NAME=?
            `, [schema, table]);

            const fkMap = new Map<string, { toTable: string; toCol: string }>();
            (fkRows as any[]).forEach(r => fkMap.set(r.from_col, { toTable: r.ref_table, toCol: r.ref_col }));

            const columns: OrmColDef[] = (cols as any[]).map(c => ({
              name: c.COLUMN_NAME,
              rawType: c.DATA_TYPE,
              maxLength: c.CHARACTER_MAXIMUM_LENGTH ? Number(c.CHARACTER_MAXIMUM_LENGTH) : null,
              numericPrecision: c.NUMERIC_PRECISION ? Number(c.NUMERIC_PRECISION) : null,
              numericScale: c.NUMERIC_SCALE ? Number(c.NUMERIC_SCALE) : null,
              fullType: c.COLUMN_TYPE,
              nullable: c.IS_NULLABLE === 'YES',
              defaultValue: c.COLUMN_DEFAULT ?? null,
              isPk: c.COLUMN_KEY === 'PRI',
              isUnique: c.COLUMN_KEY === 'UNI',
              isAutoIncrement: String(c.EXTRA).toLowerCase().includes('auto_increment'),
              comment: c.COLUMN_COMMENT || null,
              fkToTable: fkMap.get(c.COLUMN_NAME)?.toTable ?? null,
              fkToCol: fkMap.get(c.COLUMN_NAME)?.toCol ?? null,
            }));

            ormTables.push({ schema, table, columns });
          });
        }
      }

      const code = generateOrm(ormTables, conn.type, format as OrmTarget);
      const filename = format === 'prisma' ? 'schema.prisma' : `${format}-schema.ts`;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.status(200).send(code);
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

          if (pks.size) colDefs.push(`  PRIMARY KEY (${[...pks].join(', ')})`);
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
