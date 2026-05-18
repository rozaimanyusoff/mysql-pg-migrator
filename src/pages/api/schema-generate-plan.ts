import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { logApiActivity } from '../../lib/audit-api';
import {
  buildSchemaGenerationPlan,
  SchemaConfigRuntimePayload,
  SchemaGenerationPlan,
} from '../../lib/schema-config-generator';

interface PgConfigInput {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: boolean;
}

interface PlanValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  tableRowCounts: Array<{ tableKey: string; rowCount: number }>;
  orphanChecks: Array<{ relationshipKey: string; orphanRows: number }>;
}

async function runPreflight(plan: SchemaGenerationPlan, pgConfig: PgConfigInput): Promise<PlanValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tableRowCounts: Array<{ tableKey: string; rowCount: number }> = [];
  const orphanChecks: Array<{ relationshipKey: string; orphanRows: number }> = [];

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
  try {
    for (const table of plan.tables) {
      const idx = table.tableKey.indexOf('.');
      const schema = idx > 0 ? table.tableKey.slice(0, idx) : 'public';
      const tbl = idx > 0 ? table.tableKey.slice(idx + 1) : table.tableKey;
      try {
        const r = await client.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM "${schema.replace(/"/g, '""')}"."${tbl.replace(/"/g, '""')}"`
        );
        tableRowCounts.push({ tableKey: table.tableKey, rowCount: Number(r.rows[0]?.cnt ?? 0) });

        if (table.reassignPrimaryKey) {
          const pkCol = table.selectedPkColumn.replace(/"/g, '""');
          const refCount = await client.query<{ cnt: string }>(`
            SELECT COUNT(*)::text AS cnt
            FROM pg_constraint con
            JOIN unnest(con.confkey) AS confk(attnum) ON true
            JOIN pg_attribute parent_att ON parent_att.attrelid = con.confrelid AND parent_att.attnum = confk.attnum
            WHERE con.contype='f'
              AND con.confrelid = format('%I.%I', '${schema.replace(/'/g, "''")}', '${tbl.replace(/'/g, "''")}')::regclass
              AND parent_att.attname='${table.selectedPkColumn.replace(/'/g, "''")}'
          `);
          const hasDependentLegacyFk = Number(refCount.rows[0]?.cnt ?? 0) > 0;
          if (hasDependentLegacyFk) {
            const dup = await client.query<{ has_dup: boolean }>(`
              SELECT EXISTS (
                SELECT 1
                FROM "${schema.replace(/"/g, '""')}"."${tbl.replace(/"/g, '""')}"
                WHERE "${pkCol}" IS NOT NULL
                GROUP BY "${pkCol}"
                HAVING COUNT(*) > 1
              ) AS has_dup
            `);
            if (dup.rows[0]?.has_dup) {
              errors.push(`Legacy referenced column must be unique: ${table.tableKey}.${table.selectedPkColumn}`);
            }
          }
        }
      } catch (err: unknown) {
        errors.push(`Table not accessible: ${table.tableKey} (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    for (const rel of plan.relationships) {
      const cIdx = rel.childTableKey.indexOf('.');
      const pIdx = rel.parentTableKey.indexOf('.');
      const cSchema = cIdx > 0 ? rel.childTableKey.slice(0, cIdx) : 'public';
      const cTable = cIdx > 0 ? rel.childTableKey.slice(cIdx + 1) : rel.childTableKey;
      const pSchema = pIdx > 0 ? rel.parentTableKey.slice(0, pIdx) : 'public';
      const pTable = pIdx > 0 ? rel.parentTableKey.slice(pIdx + 1) : rel.parentTableKey;
      try {
        const q = `
          SELECT COUNT(*)::text AS cnt
          FROM "${cSchema.replace(/"/g, '""')}"."${cTable.replace(/"/g, '""')}" c
          LEFT JOIN "${pSchema.replace(/"/g, '""')}"."${pTable.replace(/"/g, '""')}" p
            ON c."${rel.childColumn.replace(/"/g, '""')}" = p."${rel.parentOldColumn.replace(/"/g, '""')}"
          WHERE c."${rel.childColumn.replace(/"/g, '""')}" IS NOT NULL
            AND p."${rel.parentOldColumn.replace(/"/g, '""')}" IS NULL
        `;
        const r = await client.query<{ cnt: string }>(q);
        const orphanRows = Number(r.rows[0]?.cnt ?? 0);
        orphanChecks.push({ relationshipKey: rel.relationshipKey, orphanRows });
        if (orphanRows > 0) warnings.push(`Orphan rows detected: ${rel.relationshipKey} = ${orphanRows}`);
      } catch (err: unknown) {
        warnings.push(`Relationship check skipped: ${rel.relationshipKey} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    tableRowCounts,
    orphanChecks,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_schema_generate_plan_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { runtime, pgConfig } = req.body as {
    runtime?: SchemaConfigRuntimePayload;
    pgConfig?: PgConfigInput;
  };

  if (!runtime || !pgConfig?.host || !pgConfig?.user || !pgConfig?.database) {
    await logApiActivity(req, 'api_schema_generate_plan_bad_request', 'warn');
    return res.status(400).json({ error: 'runtime and pgConfig(host,user,database) are required' });
  }

  try {
    const plan = buildSchemaGenerationPlan(runtime);
    const preflight = await runPreflight(plan, pgConfig);
    await logApiActivity(req, 'api_schema_generate_plan_success', 'info', {
      db: pgConfig.database,
      tables: plan.summary.selectedTables,
      relationships: plan.summary.selectedRelationships,
      errors: preflight.errors.length,
      warnings: preflight.warnings.length,
    });
    return res.status(200).json({ success: true, plan, preflight });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_schema_generate_plan_error', 'error', { message });
    return res.status(500).json({ success: false, error: message });
  }
}
