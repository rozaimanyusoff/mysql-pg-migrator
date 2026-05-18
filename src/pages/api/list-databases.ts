import type { NextApiRequest, NextApiResponse } from 'next';
import { listDatabases } from '../../lib/mysql-inspector';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   if (req.method !== 'POST') {
      await logApiActivity(req, 'api_list_databases_method_not_allowed', 'warn');
      return res.status(405).json({ error: 'Method not allowed' });
   }

   const { host, port, user, password } = req.body as {
      host?: string; port?: number; user?: string; password?: string;
   };

   if (!host || !user) {
      await logApiActivity(req, 'api_list_databases_bad_request', 'warn');
      return res.status(400).json({ error: 'host and user are required' });
   }

   try {
      const databases = await listDatabases(host, Number(port) || 3306, user, password ?? '');
      await logApiActivity(req, 'api_list_databases_success', 'info', { count: databases.length });
      return res.status(200).json({ databases });
   } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await logApiActivity(req, 'api_list_databases_error', 'error', { message });
      return res.status(500).json({ error: message });
   }
}
