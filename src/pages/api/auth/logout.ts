import type { NextApiRequest, NextApiResponse } from 'next';
import { destroySession } from '../../../lib/auth-store';
import { logApiActivity } from '../../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { refreshToken } = req.body as { refreshToken?: string };
  if (refreshToken) await destroySession(refreshToken);

  await logApiActivity(req, 'api_auth_logout', 'info');
  return res.status(200).json({ success: true });
}
