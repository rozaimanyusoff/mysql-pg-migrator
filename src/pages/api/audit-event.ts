import type { NextApiRequest, NextApiResponse } from 'next';
import { appendAuditLog } from '../../lib/audit-logger';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const body = req.body as {
      module?: string;
      action?: string;
      source?: 'client' | 'server';
      level?: 'info' | 'warn' | 'error';
      details?: Record<string, unknown>;
    };

    if (!body?.action) return res.status(400).json({ error: 'action is required' });

    await appendAuditLog({
      timestamp: new Date().toISOString(),
      source: body.source ?? 'client',
      module: body.module ?? 'migration',
      action: body.action,
      level: body.level ?? 'info',
      details: body.details ?? {},
    });
    return res.status(200).json({ success: true });
  } catch (err: unknown) {
    return res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
