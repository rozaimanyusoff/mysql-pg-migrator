import type { NextApiRequest, NextApiResponse } from 'next';
import { refreshAccessToken } from '../../../lib/auth-store';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { refreshToken } = req.body as { refreshToken?: string };
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required' });

  const result = await refreshAccessToken(refreshToken);
  if (!result) return res.status(401).json({ error: 'Invalid or expired refresh token' });

  return res.status(200).json({ accessToken: result.accessToken, username: result.username });
}
