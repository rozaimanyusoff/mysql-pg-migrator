import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';
import { logApiActivity } from '../../../lib/audit-api';

export interface ExecLogLine {
  sql: string;
  ok: boolean;
  text: string;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();


  const { conn, statements } = req.body as { conn: ExplorerConn; statements: string[] };
  if (!conn || !Array.isArray(statements)) return res.status(400).json({ error: 'conn and statements required' });

  const log: ExecLogLine[] = [];

  try {
    if (conn.type === 'postgresql') {
      await withPg(conn, async (client) => {
        for (const sql of statements) {
          const s = sql.trim();
          if (!s) continue;
          try {
            await client.query(s);
            log.push({ sql: s, ok: true, text: '[OK]' });
          } catch (err) {
            log.push({ sql: s, ok: false, text: `[ERROR] ${err instanceof Error ? err.message : String(err)}` });
          }
        }
      });
    } else {
      await withMysql(conn, async (c) => {
        for (const sql of statements) {
          const s = sql.trim();
          if (!s) continue;
          try {
            await c.query(s);
            log.push({ sql: s, ok: true, text: '[OK]' });
          } catch (err) {
            log.push({ sql: s, ok: false, text: `[ERROR] ${err instanceof Error ? err.message : String(err)}` });
          }
        }
      });
    }
  } catch (err) {
    log.push({ sql: '', ok: false, text: `[FATAL] ${err instanceof Error ? err.message : String(err)}` });
  }

  await logApiActivity(req, 'schema_designer_execute', 'info', { stmtCount: statements.length, db: conn.database });
  return res.status(200).json({ log });
}
