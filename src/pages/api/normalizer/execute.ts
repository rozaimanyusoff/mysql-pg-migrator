import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { withPg, type ExplorerConn } from '../../../lib/explorer-db';
import { sanitizeName } from '../../../lib/normalizer/profiler';
import { logApiActivity } from '../../../lib/audit-api';

interface ConfirmedLookup {
  colName: string;
  colIndex: number;
  lookupTable: string;
  distinctValues: string[];
}

interface ExecSheet {
  tableName: string;
  headers: string[];
  allRows: string[][];
}

interface ExecBody {
  conn: ExplorerConn;
  sheet: ExecSheet;
  confirmedLookups: ConfirmedLookup[];
}

export interface ExecLogLine {
  sql: string;
  ok: boolean;
  text: string;
}

function inferColType(vals: string[]): string {
  const ne = vals.filter(v => v.trim() !== '');
  if (!ne.length) return 'TEXT';
  if (ne.every(v => /^-?\d+$/.test(v.trim()))) return ne.some(v => Math.abs(Number(v)) > 2147483647) ? 'BIGINT' : 'INTEGER';
  if (ne.every(v => /^-?\d+(\.\d+)?$/.test(v.trim()))) return 'NUMERIC';
  const boolSet = new Set(['true', 'false', 'yes', 'no', '1', '0']);
  if (ne.every(v => boolSet.has(v.toLowerCase()))) return 'BOOLEAN';
  if (ne.every(v => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v))) return 'TIMESTAMP';
  if (ne.every(v => /^\d{4}-\d{2}-\d{2}$/.test(v))) return 'DATE';
  return 'TEXT';
}

function buildDdlStatements(sheet: ExecSheet, lookups: ConfirmedLookup[]): string[] {
  const stmts: string[] = [];
  const lookupMap = new Map(lookups.map(l => [l.colIndex, l]));

  for (const lk of lookups) {
    stmts.push(
      `CREATE TABLE IF NOT EXISTS ${lk.lookupTable} (\n  id SERIAL PRIMARY KEY,\n  value TEXT NOT NULL UNIQUE\n)`
    );
  }

  const colDefs: string[] = ['  id SERIAL PRIMARY KEY'];
  for (let i = 0; i < sheet.headers.length; i++) {
    const colName = sanitizeName(sheet.headers[i]);
    const lk = lookupMap.get(i);
    if (lk) {
      colDefs.push(`  ${colName}_id INTEGER REFERENCES ${lk.lookupTable}(id)`);
    } else {
      const t = inferColType(sheet.allRows.map(r => r[i] ?? ''));
      colDefs.push(`  ${colName} ${t}`);
    }
  }
  stmts.push(`CREATE TABLE IF NOT EXISTS ${sheet.tableName} (\n${colDefs.join(',\n')}\n)`);

  return stmts;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { conn, sheet, confirmedLookups } = req.body as ExecBody;
  if (!conn || !sheet) return res.status(400).json({ error: 'conn and sheet required' });

  const statements = buildDdlStatements(sheet, confirmedLookups ?? []);
  const log: ExecLogLine[] = [];

  try {
    await withPg(conn, async (client) => {
      for (const sql of statements) {
        try {
          await client.query(sql);
          const tableLine = sql.match(/CREATE TABLE IF NOT EXISTS (\S+)/)?.[1] ?? sql.slice(0, 40);
          log.push({ sql, ok: true, text: `[OK] ${tableLine}` });
        } catch (err) {
          log.push({ sql, ok: false, text: `[ERROR] ${err instanceof Error ? err.message : String(err)}` });
        }
      }
    });
  } catch (err) {
    log.push({ sql: '', ok: false, text: `[FATAL] ${err instanceof Error ? err.message : String(err)}` });
  }

  await logApiActivity(req, 'normalizer_execute', 'info', { table: sheet.tableName, stmtCount: statements.length });
  return res.status(200).json({ log });
}
