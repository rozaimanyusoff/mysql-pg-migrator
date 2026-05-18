import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { logApiActivity } from '../../lib/audit-api';
import {
  buildSchemaGenerationPlan,
  SchemaConfigRuntimePayload,
} from '../../lib/schema-config-generator';

interface PgConfigInput {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_schema_generate_execute_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { runtime, pgConfig, dryRun } = req.body as {
    runtime?: SchemaConfigRuntimePayload;
    pgConfig?: PgConfigInput;
    dryRun?: boolean;
  };

  if (!runtime || !pgConfig?.host || !pgConfig?.user || !pgConfig?.database) {
    await logApiActivity(req, 'api_schema_generate_execute_bad_request', 'warn');
    return res.status(400).json({ error: 'runtime and pgConfig(host,user,database) are required' });
  }

  try {
    const plan = buildSchemaGenerationPlan(runtime);
    if (dryRun) {
      await logApiActivity(req, 'api_schema_generate_execute_dry_run', 'info', {
        db: pgConfig.database,
        operations: plan.applySql.length,
      });
      return res.status(200).json({
        success: true,
        dryRun: true,
        executed: 0,
        operations: plan.applySql.length,
        log: ['Dry run mode: no SQL executed'],
      });
    }

    const pool = new Pool({
      host: pgConfig.host,
      port: pgConfig.port ?? 5432,
      user: pgConfig.user,
      password: pgConfig.password,
      database: pgConfig.database,
      ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
    });

    const client = await pool.connect();
    const log: string[] = [];
    let executed = 0;
    try {
      await client.query('BEGIN');
      for (const sql of plan.applySql) {
        await client.query(sql);
        executed += 1;
        log.push(`OK ${executed}/${plan.applySql.length}`);
      }
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK');
      const message = err instanceof Error ? err.message : String(err);
      log.push(`FAILED at step ${executed + 1}: ${message}`);
      await logApiActivity(req, 'api_schema_generate_execute_failed', 'error', {
        db: pgConfig.database,
        executed,
        total: plan.applySql.length,
        message,
      });
      return res.status(500).json({
        success: false,
        dryRun: false,
        executed,
        operations: plan.applySql.length,
        log,
        error: message,
      });
    } finally {
      client.release();
      await pool.end();
    }

    await logApiActivity(req, 'api_schema_generate_execute_success', 'info', {
      db: pgConfig.database,
      executed,
      total: plan.applySql.length,
    });
    return res.status(200).json({
      success: true,
      dryRun: false,
      executed,
      operations: plan.applySql.length,
      log,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_schema_generate_execute_error', 'error', { message });
    return res.status(500).json({ success: false, error: message });
  }
}

