import { timingSafeEqual } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isSchedulerRequestAuthorized(
  headers: Record<string, string | string[] | undefined>,
  configuredToken = process.env.SCHEDULER_API_TOKEN,
  production = process.env.NODE_ENV === 'production',
): boolean {
  const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (configuredToken && bearer && equalSecret(bearer, configuredToken)) return true;

  // Browser UI mutations are allowed only when the browser proves the request
  // came from this exact origin. External/headless callers must use the token.
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  const forwardedHost = Array.isArray(headers['x-forwarded-host']) ? headers['x-forwarded-host'][0] : headers['x-forwarded-host'];
  const host = forwardedHost || (Array.isArray(headers.host) ? headers.host[0] : headers.host);
  const fetchSite = Array.isArray(headers['sec-fetch-site']) ? headers['sec-fetch-site'][0] : headers['sec-fetch-site'];
  if (origin && host) {
    try {
      if (new URL(origin).host === host && (!fetchSite || fetchSite === 'same-origin')) return true;
    } catch { /* malformed origin */ }
  }

  // Keep local development/test tooling usable; production fails closed.
  return !production && !configuredToken;
}

export function requireSchedulerMutationAuth(req: NextApiRequest, res: NextApiResponse): boolean {
  if (isSchedulerRequestAuthorized(req.headers)) return true;
  res.status(401).json({ error: 'Unauthorized scheduler request' });
  return false;
}
