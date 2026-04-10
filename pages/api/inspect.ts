import type { NextApiRequest, NextApiResponse } from 'next';
import { inspectMySQL } from '../../lib/mysql-inspector';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { host, port, user, password, database } = req.body as {
    host?: string; port?: number; user?: string; password?: string; database?: string;
  };

  if (!host || !user || !database) {
    return res.status(400).json({ error: 'host, user, and database are required' });
  }

  try {
    const result = await inspectMySQL(
      host,
      Number(port) || 3306,
      user,
      password ?? '',
      database
    );
    return res.status(200).json({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: message });
  }
}
