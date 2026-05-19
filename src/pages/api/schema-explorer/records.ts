import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface RecordsResult {
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { conn, tableKey, limit = 50, offset = 0 } = req.body as {
    conn: ExplorerConn; tableKey: string; limit?: number; offset?: number;
  };
  if (!conn || !tableKey) return res.status(400).json({ error: 'conn and tableKey required' });

  const parts = tableKey.split('.');
  const [schema, table] = parts.length === 2 ? parts : ['public', parts[0]];

  // Sanitize identifiers — names come from the DB's own metadata
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '');
  const safeSchema = safe(schema);
  const safeTable  = safe(table);
  const lim = Math.min(Math.max(Number(limit)  || 50,  1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  try {
    if (conn.type === 'postgresql') {
      const result = await withPg(conn, async (client) => {
        const { rows: countRows } = await client.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM "${safeSchema}"."${safeTable}"`
        );
        const total = parseInt(countRows[0]?.count ?? '0', 10);
        const { rows, fields } = await client.query(
          `SELECT * FROM "${safeSchema}"."${safeTable}" LIMIT $1 OFFSET $2`,
          [lim, off]
        );
        return {
          columns: fields.map(f => f.name),
          rows: rows.map(r => Object.fromEntries(
            Object.entries(r).map(([k, v]) => [k, v === null ? null : String(v)])
          )),
          total, limit: lim, offset: off,
        };
      });
      return res.status(200).json(result);
    } else {
      const result = await withMysql(conn, async (c) => {
        const [[countRow]] = await c.query<any[]>(
          `SELECT COUNT(*) AS count FROM \`${safeSchema}\`.\`${safeTable}\``
        );
        const total = parseInt((countRow as any).count ?? '0', 10);
        const [rows, fields] = await c.query<any[]>(
          `SELECT * FROM \`${safeSchema}\`.\`${safeTable}\` LIMIT ? OFFSET ?`,
          [lim, off]
        );
        const columns = (fields as any[]).map((f: any) => f.name as string);
        return {
          columns,
          rows: (rows as any[]).map(r =>
            Object.fromEntries(columns.map(col => [col, r[col] === null ? null : String(r[col])]))
          ),
          total, limit: lim, offset: off,
        };
      });
      return res.status(200).json(result);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
