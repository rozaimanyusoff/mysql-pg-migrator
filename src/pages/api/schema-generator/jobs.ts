import type { NextApiRequest, NextApiResponse } from 'next';
import { verifyAccessToken } from '../../../lib/auth-store';
import { getPool } from '../../../lib/db';
import { logApiActivity } from '../../../lib/audit-api';

export interface SchemaJob {
  id: number;
  username: string;
  job_name: string;
  description: string | null;
  connection_label: string | null;
  target_database: string | null;
  schema_file_path: string | null;
  seed_file_path: string | null;
  schema_sql: string | null;
  seed_sql: string | null;
  status: 'pending' | 'success' | 'failed';
  log: { step: string; ok: boolean; text: string }[] | null;
  created_at: string;
}

function getUsername(req: NextApiRequest): string | null {
  const token = (req.headers.authorization ?? '').replace('Bearer ', '').trim();
  return token ? verifyAccessToken(token) : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const username = getUsername(req);
  if (!username) return res.status(401).json({ error: 'Unauthorized' });

  const pool = getPool();

  // ── GET: list jobs for current user ──────────────────────────────────────
  if (req.method === 'GET') {
    const { rows } = await pool.query<SchemaJob>(
      `SELECT id, username, job_name, description, connection_label, target_database,
              schema_file_path, seed_file_path, schema_sql, seed_sql, status, log, created_at
       FROM dbt_schema_jobs
       WHERE username = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [username]
    );
    return res.status(200).json({ jobs: rows });
  }

  // ── POST: create a new job record ─────────────────────────────────────────
  if (req.method === 'POST') {
    const {
      job_name, description, connection_label, target_database,
      schema_file_path, seed_file_path, schema_sql, seed_sql, status, log,
    } = req.body as {
      job_name?: string; description?: string; connection_label?: string;
      target_database?: string; schema_file_path?: string; seed_file_path?: string;
      schema_sql?: string; seed_sql?: string;
      status?: string; log?: SchemaJob['log'];
    };

    if (!job_name?.trim()) return res.status(400).json({ error: 'job_name is required' });

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO dbt_schema_jobs
         (username, job_name, description, connection_label, target_database,
          schema_file_path, seed_file_path, schema_sql, seed_sql, status, log)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        username, job_name.trim(), description ?? null, connection_label ?? null,
        target_database ?? null, schema_file_path ?? null, seed_file_path ?? null,
        schema_sql ?? null, seed_sql ?? null,
        status ?? 'pending', log ? JSON.stringify(log) : null,
      ]
    );

    await logApiActivity(req, 'schema_generator_job_saved', 'info', {
      username, jobId: rows[0].id, status,
    });
    return res.status(201).json({ id: rows[0].id });
  }

  // ── DELETE: remove all runs under a job_name ─────────────────────────────
  if (req.method === 'DELETE') {
    const jobName = req.query.jobName as string;
    if (!jobName) return res.status(400).json({ error: 'jobName is required' });
    await pool.query(`DELETE FROM dbt_schema_jobs WHERE job_name=$1 AND username=$2`, [jobName, username]);
    return res.status(200).json({ success: true });
  }

  // ── PATCH: rename all runs under a job_name ──────────────────────────────
  if (req.method === 'PATCH') {
    const { oldName, newName } = req.body as { oldName?: string; newName?: string };
    if (!oldName || !newName?.trim()) return res.status(400).json({ error: 'oldName and newName are required' });
    await pool.query(
      `UPDATE dbt_schema_jobs SET job_name=$1 WHERE job_name=$2 AND username=$3`,
      [newName.trim(), oldName, username]
    );
    return res.status(200).json({ success: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
