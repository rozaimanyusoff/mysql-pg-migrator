// Load persisted data flows for a project (read-only for the review step)
import type { NextApiRequest, NextApiResponse } from 'next';
import { getPool } from '../../../lib/db';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const projectId = Number(req.query.projectId);
  if (!projectId) return res.status(400).json({ error: 'projectId is required' });

  try {
    const { rows } = await getPool().query(
      'SELECT * FROM dbt_ftd_data_flows WHERE project_id=$1 ORDER BY sort_order',
      [projectId]
    );
    return res.status(200).json({ success: true, dataFlows: rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err) });
  }
}
