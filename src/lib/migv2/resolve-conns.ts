import { getPool } from '../db';
import type { MigConn, MigJob } from './types';

interface ConnectionRow {
  id: number;
  db_type: 'mysql' | 'postgres';
  host: string;
  port: number;
  username: string;
  password_enc: string | null;
  database_name: string;
}

function normType(t: string): 'postgresql' | 'mysql' {
  return t === 'postgres' ? 'postgresql' : (t as 'postgresql' | 'mysql');
}

function matchConn(rows: ConnectionRow[], meta: { type: string; host: string; port: number; username: string }): ConnectionRow | null {
  return rows.find(c =>
    c.host === meta.host &&
    c.port === meta.port &&
    c.username === meta.username &&
    (c.db_type === meta.type ||
      c.db_type === (meta.type === 'postgresql' ? 'postgres' : 'postgresql') ||
      normType(c.db_type) === normType(meta.type))
  ) ?? null;
}

export interface ResolvedConns {
  source: MigConn;
  target: MigConn;
}

/**
 * Resolve a job's source/target connections (including passwords) from the
 * dbt_connections table. Jobs never store passwords — they are looked up at
 * run time by host/port/username/type. Throws with a clear message if missing.
 */
export async function resolveJobConns(job: MigJob): Promise<ResolvedConns> {
  const { rows: connRows } = await getPool().query<ConnectionRow>(
    `SELECT id, db_type, host, port, username, password_enc, database_name FROM dbt_connections`
  );

  const srcRow = matchConn(connRows, job.sourceMeta);
  const tgtRow = matchConn(connRows, job.targetMeta);
  if (!srcRow) throw new Error('Source connection not found in saved connections');
  if (!tgtRow) throw new Error('Target connection not found in saved connections');

  return {
    source: {
      type: normType(srcRow.db_type),
      host: srcRow.host, port: srcRow.port,
      database: job.sourceMeta.database,
      username: srcRow.username,
      password: srcRow.password_enc ?? '',
    },
    target: {
      type: normType(tgtRow.db_type),
      host: tgtRow.host, port: tgtRow.port,
      database: job.targetMeta.database,
      username: tgtRow.username,
      password: tgtRow.password_enc ?? '',
    },
  };
}
