import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.body as { token?: string };
  if (!token) return res.status(200).json({ valid: false });

  const username = verifyAccessToken(token);
  return res.status(200).json({ valid: Boolean(username), username: username ?? null });
}
