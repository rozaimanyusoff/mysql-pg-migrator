import type { NextApiRequest, NextApiResponse } from 'next';
import { listAuditLogFiles } from '../../lib/audit-logger';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const files = await listAuditLogFiles();
    return res.status(200).json({ success: true, files });
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
