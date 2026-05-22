// Save and load the business flow canvas (nodes + edges) for a project.
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';
import type { CanvasNode, CanvasEdge } from '../../../lib/flow-types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const pool      = getPool();
  const projectId = Number(req.query.projectId ?? req.body?.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });

  if (req.method === 'GET') {
    try {
      const [nodeRes, edgeRes] = await Promise.all([
        pool.query(
          `SELECT id, node_type, label, position_x, position_y, metadata
           FROM dbt_ftd_nodes WHERE project_id=$1 ORDER BY created_at`,
          [projectId]
        ),
        pool.query(
          `SELECT id, source_id, target_id, label
           FROM dbt_ftd_edges WHERE project_id=$1 ORDER BY created_at`,
          [projectId]
        ),
      ]);

      const nodes: CanvasNode[] = nodeRes.rows.map(r => ({
        id:       r.id,
        type:     r.node_type,
        position: { x: r.position_x, y: r.position_y },
        data:     { label: r.label, metadata: r.metadata ?? {} },
      }));

      const edges: CanvasEdge[] = edgeRes.rows.map(r => ({
        id:     r.id,
        source: r.source_id,
        target: r.target_id,
        label:  r.label ?? undefined,
      }));

      return res.status(200).json({ success: true, nodes, edges });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  if (req.method === 'POST') {
    const { nodes, edges } = req.body as { nodes?: CanvasNode[]; edges?: CanvasEdge[] };
    if (!Array.isArray(nodes) || !Array.isArray(edges))
      return res.status(400).json({ error: 'nodes and edges are required arrays' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Replace all nodes + edges for this project
      await client.query('DELETE FROM dbt_ftd_edges WHERE project_id=$1', [projectId]);
      await client.query('DELETE FROM dbt_ftd_nodes WHERE project_id=$1', [projectId]);

      for (const node of nodes) {
        await client.query(
          `INSERT INTO dbt_ftd_nodes (id, project_id, node_type, label, position_x, position_y, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [node.id, projectId, node.type, node.data.label, node.position.x, node.position.y,
           JSON.stringify(node.data.metadata ?? {})]
        );
      }

      for (const edge of edges) {
        await client.query(
          `INSERT INTO dbt_ftd_edges (id, project_id, source_id, target_id, label)
           VALUES ($1,$2,$3,$4,$5)`,
          [edge.id, projectId, edge.source, edge.target, edge.label ?? null]
        );
      }

      await client.query('COMMIT');
      return res.status(200).json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ success: false, error: String(err) });
    } finally {
      client.release();
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
