// Analyze business flow → generate DataFlows, extract entities, suggest relationships.
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';
import { analyzeFlow } from '../../../lib/flow-analyzer';
import { extractEntities } from '../../../lib/entity-extractor';
import { suggestRelationships } from '../../../lib/relationship-engine';
import type { CanvasNode } from '../../../lib/flow-types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { projectId, nodes } = req.body as { projectId?: number; nodes?: CanvasNode[] };
  if (!projectId || !Array.isArray(nodes))
    return res.status(400).json({ error: 'projectId and nodes are required' });

  const pool   = getPool();
  const client = await pool.connect();

  try {
    // Fetch project schema name
    const projRes = await client.query(
      'SELECT schema_name FROM dbt_ftd_projects WHERE id=$1', [projectId]
    );
    if (!projRes.rows.length) return res.status(404).json({ error: 'Project not found' });
    const schemaName: string = projRes.rows[0].schema_name ?? 'app';

    const dataFlows  = analyzeFlow(nodes);
    const entities   = extractEntities(dataFlows, schemaName);
    const rels       = suggestRelationships(entities);

    await client.query('BEGIN');

    // Persist data flows
    await client.query('DELETE FROM dbt_ftd_data_flows WHERE project_id=$1', [projectId]);
    for (const df of dataFlows) {
      await client.query(
        `INSERT INTO dbt_ftd_data_flows
           (project_id,node_id,node_label,business_object,operation,
            data_created,data_updated,data_referenced,data_deleted,
            status_before,status_after,actor,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [projectId, df.nodeId, df.nodeLabel, df.businessObject, df.operation,
         JSON.stringify(df.dataCreated), JSON.stringify(df.dataUpdated),
         JSON.stringify(df.dataReferenced), JSON.stringify(df.dataDeleted),
         df.statusBefore ?? null, df.statusAfter ?? null, df.actor ?? null, df.sortOrder]
      );
    }

    // Persist entities (upsert by project_id + table_name)
    await client.query('DELETE FROM dbt_ftd_entities WHERE project_id=$1', [projectId]);
    for (const e of entities) {
      await client.query(
        `INSERT INTO dbt_ftd_entities
           (project_id,table_name,display_name,category,description,schema_name,
            confirmed,rejected,fields,source_nodes,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [projectId, e.tableName, e.displayName, e.category, e.description,
         e.schemaName, e.confirmed, e.rejected,
         JSON.stringify(e.fields), JSON.stringify(e.sourceNodes), e.sortOrder]
      );
    }

    // Persist relationships
    await client.query('DELETE FROM dbt_ftd_relationships WHERE project_id=$1', [projectId]);
    for (const r of rels) {
      await client.query(
        `INSERT INTO dbt_ftd_relationships
           (project_id,source_entity,target_entity,relationship_type,cardinality,
            label,foreign_key_column,confirmed,rejected)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [projectId, r.sourceEntity, r.targetEntity, r.relationshipType,
         r.cardinality, r.label ?? null, r.foreignKeyColumn ?? null,
         r.confirmed, r.rejected]
      );
    }

    await client.query('COMMIT');

    // Load persisted records back with DB-assigned IDs
    const [dfRes, entRes, relRes] = await Promise.all([
      client.query('SELECT * FROM dbt_ftd_data_flows WHERE project_id=$1 ORDER BY sort_order', [projectId]),
      client.query('SELECT * FROM dbt_ftd_entities WHERE project_id=$1 ORDER BY sort_order', [projectId]),
      client.query('SELECT * FROM dbt_ftd_relationships WHERE project_id=$1', [projectId]),
    ]);

    return res.status(200).json({
      success: true,
      dataFlows:     dfRes.rows,
      entities:      entRes.rows,
      relationships: relRes.rows,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ success: false, error: String(err) });
  } finally {
    client.release();
  }
}
