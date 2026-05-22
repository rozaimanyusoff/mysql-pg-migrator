// Generate DDL, Drizzle schema, data dictionary, and run validation.
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';
import { generateDDL } from '../../../lib/flow-ddl-generator';
import { generateDrizzle } from '../../../lib/flow-drizzle-generator';
import { buildDictionary, validateDesign } from '../../../lib/flow-dict-validator';
import type { FtdEntity, FtdRelationship } from '../../../lib/flow-types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { projectId } = req.body as { projectId?: number };
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });

  const pool = getPool();

  try {
    const [entRes, relRes] = await Promise.all([
      pool.query('SELECT * FROM dbt_ftd_entities WHERE project_id=$1 ORDER BY sort_order', [projectId]),
      pool.query('SELECT * FROM dbt_ftd_relationships WHERE project_id=$1', [projectId]),
    ]);

    const entities: FtdEntity[] = entRes.rows.map(r => ({
      id:          r.id,
      tableName:   r.table_name,
      displayName: r.display_name,
      category:    r.category,
      description: r.description,
      schemaName:  r.schema_name,
      confirmed:   r.confirmed,
      rejected:    r.rejected,
      fields:      r.fields ?? [],
      sourceNodes: r.source_nodes ?? [],
      sortOrder:   r.sort_order,
    }));

    const relationships: FtdRelationship[] = relRes.rows.map(r => ({
      id:               r.id,
      sourceEntity:     r.source_entity,
      targetEntity:     r.target_entity,
      relationshipType: r.relationship_type,
      cardinality:      r.cardinality,
      label:            r.label,
      foreignKeyColumn: r.foreign_key_column,
      confirmed:        r.confirmed,
      rejected:         r.rejected,
    }));

    const ddl         = generateDDL(entities, relationships);
    const drizzle     = generateDrizzle(entities, relationships);
    const dictionary  = buildDictionary(entities, relationships);
    const validations = validateDesign(entities, relationships);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Save outputs (versioned — increment version per type)
      for (const [outputType, content] of [
        ['ddl',             ddl],
        ['drizzle',         drizzle],
        ['dictionary_json', JSON.stringify(dictionary)],
      ] as [string, string][]) {
        const vRes = await client.query(
          `SELECT COALESCE(MAX(version),0)+1 AS next_v
           FROM dbt_ftd_outputs WHERE project_id=$1 AND output_type=$2`,
          [projectId, outputType]
        );
        const nextV = vRes.rows[0].next_v;
        await client.query(
          'INSERT INTO dbt_ftd_outputs (project_id,output_type,content,version) VALUES ($1,$2,$3,$4)',
          [projectId, outputType, content, nextV]
        );
      }

      // Save validation issues (replace previous run)
      await client.query('DELETE FROM dbt_ftd_validations WHERE project_id=$1', [projectId]);
      for (const v of validations) {
        await client.query(
          `INSERT INTO dbt_ftd_validations
             (project_id,severity,category,message,entity_name,field_name,resolved)
           VALUES ($1,$2,$3,$4,$5,$6,false)`,
          [projectId, v.severity, v.category, v.message, v.entityName ?? null, v.fieldName ?? null]
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return res.status(200).json({
      success: true,
      ddl,
      drizzle,
      dictionary,
      validations,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
}
