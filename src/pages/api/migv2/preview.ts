import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { withPg, withMysql, type ExplorerConn } from '../../../lib/explorer-db';

export interface PreviewResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization ?? '').replace('Bearer ', '');
  if (!verifyAccessToken(token)) return res.status(401).json({ error: 'Unauthorized' });

  const { conn, tableKey, limit = 50 } = req.body as {
    conn: ExplorerConn;
    tableKey: string;
    limit?: number;
  };
  if (!conn || !tableKey) return res.status(400).json({ error: 'conn and tableKey required' });

  const parts = tableKey.split('.');
  const [schema, table] = parts.length === 2 ? parts : ['public', parts[0]];
  const cap = Math.min(Number(limit) || 50, 200);

  // Proper PG identifier quoting: escape embedded double-quotes by doubling them
  const pgIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

  // Sanitize rows: convert BigInt → string so JSON.stringify doesn't throw
  const sanitize = (rows: Record<string, unknown>[]): Record<string, unknown>[] =>
    rows.map(row => Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v])
    ));

  try {
    if (conn.type === 'postgresql') {
      const result = await withPg(conn, async c => {
        const { rows, fields } = await c.query(
          `SELECT * FROM ${pgIdent(schema)}.${pgIdent(table)} LIMIT $1`,
          [cap]
        );
        return { columns: fields.map(f => f.name), rows: sanitize(rows) };
      });
      return res.status(200).json(result);
    } else {
      const result = await withMysql(conn, async c => {
        const [rows, fields] = await c.query(
          `SELECT * FROM \`${schema}\`.\`${table}\` LIMIT ?`,
          [cap]
        ) as [Record<string, unknown>[], { name: string }[]];
        return { columns: fields.map(f => f.name), rows: sanitize(rows) };
      });
      return res.status(200).json(result);
    }
  } catch (err: unknown) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
