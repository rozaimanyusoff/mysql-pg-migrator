import type { NextApiRequest, NextApiResponse } from 'next';
import { readAuditLogFile, readAuditLogsByDateRange } from '../../lib/audit-logger';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { file, start, end } = req.query as {
    file?: string;
    start?: string;
    end?: string;
  };

  try {
    if (file) {
      const normalized = String(file).replace(/\.log$/i, '');
      const entries = await readAuditLogFile(normalized);
      return res.status(200).json({ success: true, mode: 'file', entries });
    }

    if (start && end) {
      const entries = await readAuditLogsByDateRange(start, end);
      return res.status(200).json({ success: true, mode: 'range', entries });
    }

    return res.status(400).json({ error: 'Provide either file or start/end query' });
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
