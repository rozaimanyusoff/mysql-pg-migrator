import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, type ExplorerConn } from '../../../lib/explorer-db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { conn, database } = req.body as { conn: ExplorerConn; database: string };
  if (!conn || !database) return res.status(400).json({ error: 'conn and database required' });

  try {
    const schemas = await withPg({ ...conn, database }, async c => {
      const { rows } = await c.query<any>(`
        SELECT schema_name AS name
        FROM information_schema.schemata
        WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
          AND schema_name NOT LIKE 'pg_temp_%'
          AND schema_name NOT LIKE 'pg_toast_temp_%'
        ORDER BY schema_name
      `);
      return rows.map((r: any) => r.name as string);
    });
    return res.status(200).json({ schemas });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
