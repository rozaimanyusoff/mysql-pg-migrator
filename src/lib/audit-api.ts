import type { NextApiRequest } from 'next';
import { appendAuditLog } from './audit-logger';

export async function logApiActivity(
  req: NextApiRequest,
  action: string,
  level: 'info' | 'warn' | 'error' = 'info',
  details: Record<string, unknown> = {}
) {
  try {
    await appendAuditLog({
      timestamp: new Date().toISOString(),
      source: 'server',
      module: 'migration',
      action,
      level,
      details: {
        method: req.method ?? '',
        path: req.url ?? '',
        ...details,
      },
    });
  } catch {
    // never break request flow due to logging issue
  }
}
