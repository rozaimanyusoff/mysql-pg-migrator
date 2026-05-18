import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { getPool } from './db';

// Fallback when DB is unreachable (sha256 of 'admin')
const FALLBACK_USER = 'admin';
const FALLBACK_HASH = '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918';

const getSecret = (): string => {
  const s = process.env.JWT_SECRET_KEY;
  if (!s) throw new Error('JWT_SECRET_KEY is not set in environment');
  return s;
};

const ACCESS_TTL_S  = Number(process.env.JWT_EXPIRATION_TIME)          || 3600;
const REFRESH_TTL_S = Number(process.env.REFRESH_TOKEN_EXPIRATION_TIME) || 86400;

export function sha256(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex');
}

export async function validateCredentials(username: string, password: string): Promise<boolean> {
  const hash = sha256(password);
  try {
    const { rows } = await getPool().query(
      `SELECT id FROM dbt_users WHERE username = $1 AND password_hash = $2 AND is_active = TRUE`,
      [username, hash]
    );
    return rows.length > 0;
  } catch {
    return username === FALLBACK_USER && hash === FALLBACK_HASH;
  }
}

// ── JWT access token (short-lived, stateless) ─────────────────────────────────

export function createAccessToken(username: string): string {
  return jwt.sign({ sub: username }, getSecret(), { expiresIn: ACCESS_TTL_S });
}

export function verifyAccessToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, getSecret()) as jwt.JwtPayload;
    return (payload.sub as string) ?? null;
  } catch {
    return null;
  }
}

// ── Refresh token (opaque hex, stored in dbt_sessions) ───────────────────────

export async function createTokens(
  username: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = createAccessToken(username);
  const refreshToken = crypto.randomBytes(32).toString('hex'); // 64-char hex
  const expiresAt = new Date(Date.now() + REFRESH_TTL_S * 1000);
  await getPool().query(
    `INSERT INTO dbt_sessions (token, username, expires_at) VALUES ($1, $2, $3)`,
    [refreshToken, username, expiresAt]
  );
  return { accessToken, refreshToken };
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<{ accessToken: string; username: string } | null> {
  if (!refreshToken || refreshToken.length !== 64) return null;
  try {
    const { rows } = await getPool().query<{ username: string }>(
      `SELECT username FROM dbt_sessions WHERE token = $1 AND expires_at > NOW()`,
      [refreshToken]
    );
    if (!rows[0]) return null;
    return { accessToken: createAccessToken(rows[0].username), username: rows[0].username };
  } catch {
    return null;
  }
}

export async function destroySession(refreshToken: string): Promise<void> {
  if (!refreshToken) return;
  try {
    await getPool().query(`DELETE FROM dbt_sessions WHERE token = $1`, [refreshToken]);
  } catch { /* ignore */ }
}

export async function pruneExpiredSessions(): Promise<void> {
  try {
    await getPool().query(`DELETE FROM dbt_sessions WHERE expires_at <= NOW()`);
  } catch { /* ignore */ }
}
