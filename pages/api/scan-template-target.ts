import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool as PgPool } from 'pg';
import { MigrationConfig, PgConnectionConfig } from '../../lib/types';
import { logApiActivity } from '../../lib/audit-api';

type TableScanResult = {
  key: string;
  source: string;
  target: string;
  exists: boolean;
  valid: boolean;
  errors: string[];
  warnings: string[];
};

function normalizeType(input: string): string {
  const v = input.trim().toUpperCase();
  if (v === 'CHARACTER VARYING') return 'VARCHAR';
  if (v === 'CHARACTER') return 'CHAR';
  if (v === 'TIMESTAMP WITHOUT TIME ZONE') return 'TIMESTAMP WITHOUT TIME ZONE';
  if (v === 'TIMESTAMP WITH TIME ZONE') return 'TIMESTAMPTZ';
  if (v === 'DOUBLE PRECISION') return 'DOUBLE PRECISION';
  return v;
}

function actualTypeToComparable(dataType: string, udtName: string): string {
  const dt = normalizeType(dataType);
  const udt = normalizeType(udtName);
  if (dt === 'ARRAY') return `${udt}[]`;
  if (dt === 'USER-DEFINED') return udt;
  if (dt === 'INTEGER' || udt === 'INT4') return 'INTEGER';
  if (dt === 'BIGINT' || udt === 'INT8') return 'BIGINT';
  if (dt === 'SMALLINT' || udt === 'INT2') return 'SMALLINT';
  if (dt === 'BOOLEAN' || udt === 'BOOL') return 'BOOLEAN';
  if (dt === 'UUID') return 'UUID';
  if (dt === 'JSON' || udt === 'JSON') return 'JSON';
  if (dt === 'JSONB' || udt === 'JSONB') return 'JSONB';
  if (dt === 'BYTEA') return 'BYTEA';
  if (dt === 'DATE') return 'DATE';
  if (dt === 'TIME WITHOUT TIME ZONE') return 'TIME WITHOUT TIME ZONE';
  if (dt === 'TIMESTAMP WITHOUT TIME ZONE') return 'TIMESTAMP WITHOUT TIME ZONE';
  if (dt === 'TIMESTAMPTZ' || dt === 'TIMESTAMP WITH TIME ZONE') return 'TIMESTAMPTZ';
  if (dt === 'TEXT') return 'TEXT';
  if (dt === 'VARCHAR') return 'VARCHAR';
  if (dt === 'CHAR') return 'CHAR';
  if (dt === 'NUMERIC') return 'NUMERIC';
  if (dt === 'REAL') return 'REAL';
  if (dt === 'DOUBLE PRECISION') return 'DOUBLE PRECISION';
  return dt || udt;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_scan_template_target_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { config, pgConfig } = req.body as {
    config?: MigrationConfig;
    pgConfig?: PgConnectionConfig;
  };
  if (!config || !pgConfig) {
    await logApiActivity(req, 'api_scan_template_target_bad_request', 'warn');
    return res.status(400).json({ error: 'config and pgConfig are required' });
  }

  const included = config.tables.filter((t) => t.include);
  const results: TableScanResult[] = [];

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
    for (const table of included) {
      const key = `${table.sourceDatabase}::${table.mysqlName}`;
      const target = `${table.pgSchema}.${table.pgName}`;
      const source = `${table.sourceDatabase}.${table.mysqlName}`;
      const item: TableScanResult = {
        key,
        source,
        target,
        exists: false,
        valid: true,
        errors: [],
        warnings: [],
      };

      const tableExists = await client.query(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = $2
        ) AS exists`,
        [table.pgSchema, table.pgName]
      );
      item.exists = Boolean(tableExists.rows[0]?.exists);
      if (!item.exists) {
        item.valid = false;
        item.errors.push(`Missing table "${target}" on target PostgreSQL.`);
        results.push(item);
        continue;
      }

      const rows = await client.query<{
        column_name: string;
        is_nullable: 'YES' | 'NO';
        data_type: string;
        udt_name: string;
      }>(
        `SELECT column_name, is_nullable, data_type, udt_name
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [table.pgSchema, table.pgName]
      );

      const actualMap = new Map(
        rows.rows.map((r) => [
          r.column_name.toLowerCase(),
          {
            nullable: r.is_nullable === 'YES',
            type: actualTypeToComparable(r.data_type, r.udt_name),
          },
        ])
      );

      for (const col of table.columns.filter((c) => c.include)) {
        const actual = actualMap.get(col.pgName.toLowerCase());
        if (!actual) {
          item.valid = false;
          item.errors.push(`Missing column "${col.pgName}".`);
          continue;
        }
        const expectedType = normalizeType(col.pgType);
        if (actual.type !== expectedType) {
          item.warnings.push(`Type mismatch "${col.pgName}": expected ${expectedType}, found ${actual.type}.`);
        }
        if (actual.nullable !== col.nullable) {
          item.warnings.push(
            `Nullable mismatch "${col.pgName}": expected ${col.nullable ? 'YES' : 'NO'}, found ${actual.nullable ? 'YES' : 'NO'}.`
          );
        }
      }

      item.valid = item.errors.length === 0;
      results.push(item);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_scan_template_target_error', 'error', { message });
    return res.status(500).json({ error: message });
  } finally {
    client.release();
    await pool.end();
  }

  const failed = results.filter((r) => !r.valid).length;
  await logApiActivity(req, failed === 0 ? 'api_scan_template_target_success' : 'api_scan_template_target_failed', failed === 0 ? 'info' : 'warn', {
    scanned: results.length,
    failed,
  });

  return res.status(200).json({
    success: failed === 0,
    scanned: results.length,
    failed,
    results,
  });
}

