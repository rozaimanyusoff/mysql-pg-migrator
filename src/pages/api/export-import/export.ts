import type { NextApiRequest, NextApiResponse } from 'next';
import { exportDatabase, exportDatabaseCsv, ConnCfg, ExportInclude } from '../../../lib/sql-exporter';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });


  const { cfg, tables, include, format, whereClause, schema } = req.body as {
    cfg?: ConnCfg;
    tables?: string[] | 'all';
    include?: ExportInclude;
    format?: 'sql' | 'csv';
    whereClause?: string;
    schema?: string;
  };

  if (!cfg?.host || !cfg?.user || !cfg?.database || !cfg?.db_type)
    return res.status(400).json({ error: 'cfg (db_type, host, user, database) required' });

  try {
    if (format === 'csv') {
      const result = await exportDatabaseCsv(cfg, tables ?? 'all', whereClause, schema || 'public');
      return res.status(200).json(result);
    }
    const result = await exportDatabase(cfg, tables ?? 'all', include ?? 'both', { whereClause, schema });
    return res.status(200).json(result);
  } catch (err: unknown) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
