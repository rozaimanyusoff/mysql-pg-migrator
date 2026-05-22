// CRUD for project entities (confirm, reject, update fields, etc.)
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';
import type { FtdEntity } from '../../../lib/flow-types';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const pool      = getPool();
  const projectId = Number(req.query.projectId ?? req.body?.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });

  if (req.method === 'GET') {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM dbt_ftd_entities WHERE project_id=$1 ORDER BY sort_order',
        [projectId]
      );
      return res.status(200).json({ success: true, entities: rows });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  // PUT: update one entity (partial update — pass only what changed)
  if (req.method === 'PUT') {
    const { id, tableName, displayName, category, description, confirmed, rejected, fields } =
      req.body as Partial<FtdEntity & { id: number }>;
    if (!id) return res.status(400).json({ error: 'entity id is required' });
    try {
      await pool.query(
        `UPDATE dbt_ftd_entities
         SET table_name   = COALESCE($1, table_name),
             display_name = COALESCE($2, display_name),
             category     = COALESCE($3, category),
             description  = COALESCE($4, description),
             confirmed    = COALESCE($5, confirmed),
             rejected     = COALESCE($6, rejected),
             fields       = COALESCE($7, fields),
             updated_at   = NOW()
         WHERE id=$8 AND project_id=$9`,
        [tableName ?? null, displayName ?? null, category ?? null,
         description ?? null, confirmed ?? null, rejected ?? null,
         fields != null ? JSON.stringify(fields) : null,
         id, projectId]
      );
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  // PATCH: bulk confirm/reject
  if (req.method === 'PATCH') {
    const { action, ids } = req.body as { action: 'confirm_all' | 'reject_all'; ids?: number[] };
    try {
      if (action === 'confirm_all') {
        await pool.query(
          `UPDATE dbt_ftd_entities SET confirmed=true, rejected=false, updated_at=NOW()
           WHERE project_id=$1 AND NOT rejected`,
          [projectId]
        );
      } else if (action === 'reject_all' && ids?.length) {
        await pool.query(
          `UPDATE dbt_ftd_entities SET rejected=true, confirmed=false, updated_at=NOW()
           WHERE project_id=$1 AND id=ANY($2::bigint[])`,
          [projectId, ids]
        );
      }
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: String(err) });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
