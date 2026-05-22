// CRUD for project relationships (confirm, reject, edit, add custom)
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';
import type { FtdRelationship } from '../../../lib/flow-types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const pool      = getPool();
  const projectId = Number(req.query.projectId ?? req.body?.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });

  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM dbt_ftd_relationships WHERE project_id=$1 ORDER BY id',
        [projectId]
      );
      return res.status(200).json({ success: true, relationships: rows });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  if (req.method === 'POST') {
    const r = req.body as Partial<FtdRelationship>;
    if (!r.sourceEntity || !r.targetEntity)
      return res.status(400).json({ error: 'sourceEntity and targetEntity are required' });
    try {
      const { rows } = await pool.query(
        `INSERT INTO dbt_ftd_relationships
           (project_id,source_entity,target_entity,relationship_type,cardinality,
            label,foreign_key_column,confirmed,rejected)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [projectId, r.sourceEntity, r.targetEntity,
         r.relationshipType ?? 'one_to_many', r.cardinality ?? 'optional',
         r.label ?? null, r.foreignKeyColumn ?? null,
         r.confirmed ?? false, r.rejected ?? false]
      );
      return res.status(200).json({ success: true, relationship: rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body as Partial<FtdRelationship & { id: number }>;
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      await pool.query(
        `UPDATE dbt_ftd_relationships
         SET source_entity      = COALESCE($1, source_entity),
             target_entity      = COALESCE($2, target_entity),
             relationship_type  = COALESCE($3, relationship_type),
             cardinality        = COALESCE($4, cardinality),
             label              = COALESCE($5, label),
             foreign_key_column = COALESCE($6, foreign_key_column),
             confirmed          = COALESCE($7, confirmed),
             rejected           = COALESCE($8, rejected)
         WHERE id=$9 AND project_id=$10`,
        [updates.sourceEntity ?? null, updates.targetEntity ?? null,
         updates.relationshipType ?? null, updates.cardinality ?? null,
         updates.label ?? null, updates.foreignKeyColumn ?? null,
         updates.confirmed ?? null, updates.rejected ?? null,
         id, projectId]
      );
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  if (req.method === 'DELETE') {
    const id = Number(req.query.id);
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      await pool.query('DELETE FROM dbt_ftd_relationships WHERE id=$1 AND project_id=$2', [id, projectId]);
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
