import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool as PgPool } from 'pg';
import { MigrationConfig, PgConnectionConfig } from '../../lib/types';
import {
  generateCreateTableSQL,
  generateCommentsSQL,
  generateIndexesSQL,
  validateMigrationConfig,
} from '../../lib/postgres-migrator';
import { logApiActivity } from '../../lib/audit-api';

type GenerateSchemaResult = {
  success: boolean;
  schemasCreated: number;
  tablesCreated: number;
  indexesCreated: number;
  warnings: string[];
  errors: string[];
  log: string[];
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_generate_schema_target_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { config, pgConfig, options } = req.body as {
    config?: MigrationConfig;
    pgConfig?: PgConnectionConfig;
    options?: { dropExisting?: boolean };
  };
  if (!config || !pgConfig) {
    await logApiActivity(req, 'api_generate_schema_target_bad_request', 'warn');
    return res.status(400).json({ error: 'config and pgConfig are required' });
  }
  if (!pgConfig.host || !pgConfig.database || !pgConfig.user) {
    await logApiActivity(req, 'api_generate_schema_target_invalid_pg', 'warn');
    return res.status(400).json({ error: 'pgConfig host, database and user are required' });
  }

  const validation = validateMigrationConfig(config);
  if (!validation.valid) {
    await logApiActivity(req, 'api_generate_schema_target_validation_failed', 'warn', {
      errors: validation.errors.length,
    });
    return res.status(400).json({
      error: 'Invalid migration configuration',
      validationErrors: validation.errors,
      validationWarnings: validation.warnings,
    });
  }

  const result: GenerateSchemaResult = {
    success: true,
    schemasCreated: 0,
    tablesCreated: 0,
    indexesCreated: 0,
    warnings: [],
    errors: [],
    log: [],
  };
  const addLog = (msg: string) => result.log.push(msg);
  const dropExisting = Boolean(options?.dropExisting);

  const pool = new PgPool({
    host: pgConfig.host,
    port: pgConfig.port,
    user: pgConfig.user,
    password: pgConfig.password,
    database: pgConfig.database,
    ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false,
    max: 3,
  });

  const client = await pool.connect();
  try {
    const schemas = new Set<string>();
    for (const t of config.tables) {
      if (t.include && t.pgSchema !== 'public') schemas.add(t.pgSchema);
    }
    for (const schema of schemas) {
      try {
        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        result.schemasCreated += 1;
        addLog(`schema ensured: ${schema}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to create schema "${schema}": ${msg}`);
      }
    }

    for (const table of config.tables.filter((t) => t.include)) {
      const ddl = generateCreateTableSQL(table);
      if (!ddl) continue;

      try {
        if (dropExisting) {
          await client.query(`DROP TABLE IF EXISTS "${table.pgSchema}"."${table.pgName}" CASCADE`);
          addLog(`table dropped (if existed): ${table.pgSchema}.${table.pgName}`);
        }
        await client.query(ddl);
        result.tablesCreated += 1;
        addLog(`table ensured: ${table.pgSchema}.${table.pgName}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to create table "${table.pgSchema}"."${table.pgName}": ${msg}`);
        continue;
      }

      for (const sql of generateCommentsSQL(table)) {
        try {
          await client.query(sql);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.warnings.push(`Comment warning on "${table.pgName}": ${msg}`);
        }
      }

      for (const sql of generateIndexesSQL(table)) {
        try {
          await client.query(sql);
          result.indexesCreated += 1;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result.warnings.push(`Index warning on "${table.pgName}": ${msg}`);
        }
      }
    }
  } catch (err: unknown) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    client.release();
    await pool.end();
  }

  result.success = result.errors.length === 0;
  await logApiActivity(
    req,
    result.success ? 'api_generate_schema_target_success' : 'api_generate_schema_target_failed',
    result.success ? 'info' : 'warn',
    {
      schemasCreated: result.schemasCreated,
      tablesCreated: result.tablesCreated,
      indexesCreated: result.indexesCreated,
      warnings: result.warnings.length,
      errors: result.errors.length,
    }
  );

  if (!result.success) {
    return res.status(500).json({
      error: 'Schema generation completed with errors',
      ...result,
    });
  }
  return res.status(200).json(result);
}
