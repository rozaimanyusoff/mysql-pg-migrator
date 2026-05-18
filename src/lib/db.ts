import { Pool } from 'pg';

// Use a global to survive Next.js hot-reload in dev
declare global {
  // eslint-disable-next-line no-var
  var _dbtPool: Pool | undefined;
}

export function getPool(): Pool {
  if (global._dbtPool) return global._dbtPool;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set. Add it to your .env file.');

  global._dbtPool = new Pool({ connectionString: url });
  return global._dbtPool;
}
