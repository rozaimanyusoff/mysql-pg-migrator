import type { NextApiRequest, NextApiResponse } from 'next';
import { inspectMySQL } from '../../lib/mysql-inspector';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_inspect_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { host, port, user, password, database } = req.body as {
    host?: string; port?: number; user?: string; password?: string; database?: string;
  };

  if (!host || !user || !database) {
    await logApiActivity(req, 'api_inspect_bad_request', 'warn');
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
    await logApiActivity(req, 'api_inspect_success', 'info', { database, tables: result.tables.length });
    return res.status(200).json({ success: true, result });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_inspect_error', 'error', { database, message });
    return res.status(500).json({ success: false, error: message });
  }
}
