import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, type ExplorerConn } from '../../../lib/explorer-db';

export type SuggestionKind =
  | 'missing_pk'
  | 'nullable_pk'
  | 'potential_fk'
  | 'missing_index'
  | 'orphan_fk_data'
  | 'missing_unique'
  | 'wide_varchar'
  | 'suboptimal_type';

export interface SchemaSuggestion {
  id: string;
  kind: SuggestionKind;
  table: string;
  column?: string;
  message: string;
  suggestedFix: string;
  alterSql?: string;
}

// Semantic column names that should carry a UNIQUE constraint
const UNIQUE_CANDIDATES = new Set([
  'email', 'email_address', 'username', 'user_name', 'slug', 'phone',
  'phone_number', 'mobile', 'code', 'token', 'access_token', 'refresh_token',
  'api_key', 'external_id', 'uuid', 'ref', 'reference',
]);

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).end();

  const { conn, schema } = req.body as { conn: ExplorerConn; schema: string };
  if (!conn || !schema) return res.status(400).json({ error: 'conn and schema required' });

  try {
    const suggestions = await withPg(conn, async (client) => {
      const sc = schema;
      const result: SchemaSuggestion[] = [];
      let idxCounter = 0;
      const sid = () => `s${++idxCounter}`;

      // ── Fetch all tables ──────────────────────────────────────────────────
      const { rows: tables } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = $1 AND table_type = 'BASE TABLE'
         ORDER BY table_name`,
        [sc]
      );

      for (const { table_name: tbl } of tables) {

        // ── Columns ─────────────────────────────────────────────────────────
        const { rows: cols } = await client.query<{
          column_name: string; data_type: string; udt_name: string;
          is_nullable: string; column_default: string | null;
          character_maximum_length: number | null;
        }>(
          `SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
           FROM information_schema.columns
           WHERE table_schema = $1 AND table_name = $2
           ORDER BY ordinal_position`,
          [sc, tbl]
        );

        // ── PK ───────────────────────────────────────────────────────────────
        const { rows: pks } = await client.query<{ column_name: string }>(
          `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
          [sc, tbl]
        );
        const pkCols = new Set(pks.map(r => r.column_name));

        if (pkCols.size === 0) {
          result.push({
            id: sid(), kind: 'missing_pk', table: tbl,
            message: `"${tbl}" has no PRIMARY KEY.`,
            suggestedFix: 'Add a BIGSERIAL or UUID primary key column.',
            alterSql: `ALTER TABLE "${sc}"."${tbl}" ADD COLUMN id BIGSERIAL PRIMARY KEY;`,
          });
        }

        // Nullable PK
        for (const col of cols) {
          if (pkCols.has(col.column_name) && col.is_nullable === 'YES') {
            result.push({
              id: sid(), kind: 'nullable_pk', table: tbl, column: col.column_name,
              message: `PK column "${col.column_name}" is nullable.`,
              suggestedFix: 'Set NOT NULL on the primary key column.',
              alterSql: `ALTER TABLE "${sc}"."${tbl}" ALTER COLUMN "${col.column_name}" SET NOT NULL;`,
            });
          }
        }

        // ── Existing constraints (FK + UNIQUE) for exclusion checks ─────────
        const { rows: existingFkRows } = await client.query<{ from_col: string; to_schema: string; to_table: string; to_col: string }>(
          `SELECT kcu.column_name AS from_col,
                  ccu.table_schema AS to_schema, ccu.table_name AS to_table, ccu.column_name AS to_col
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           JOIN information_schema.referential_constraints rc
             ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
           JOIN information_schema.key_column_usage ccu
             ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = rc.unique_constraint_schema
           WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
          [sc, tbl]
        );
        const existingFkCols = new Set(existingFkRows.map(r => r.from_col));
        const fkTargets = new Map(existingFkRows.map(r => [r.from_col, { schema: r.to_schema, table: r.to_table, col: r.to_col }]));

        const { rows: uniqueCols } = await client.query<{ column_name: string }>(
          `SELECT kcu.column_name
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1 AND tc.table_name = $2`,
          [sc, tbl]
        );
        const uniqueColSet = new Set(uniqueCols.map(r => r.column_name));

        // ── Potential FK by naming convention ────────────────────────────────
        for (const col of cols) {
          if (existingFkCols.has(col.column_name)) continue;
          const fkMatch = col.column_name.match(/^(.+?)_id$/i) ?? col.column_name.match(/^(.+?)_uuid$/i);
          if (!fkMatch || pkCols.has(col.column_name)) continue;
          const candidateTable = fkMatch[1];
          const { rows: cand } = await client.query<{ exists: boolean }>(
            `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) AS exists`,
            [sc, candidateTable]
          );
          if (!cand[0]?.exists) continue;
          const { rows: candPk } = await client.query<{ column_name: string }>(
            `SELECT kcu.column_name FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2 LIMIT 1`,
            [sc, candidateTable]
          );
          if (!candPk.length) continue;
          const refCol = candPk[0].column_name;
          result.push({
            id: sid(), kind: 'potential_fk', table: tbl, column: col.column_name,
            message: `"${col.column_name}" looks like a FK to "${candidateTable}.${refCol}".`,
            suggestedFix: `Add FOREIGN KEY (${col.column_name}) REFERENCES ${candidateTable}(${refCol}).`,
            alterSql: `ALTER TABLE "${sc}"."${tbl}" ADD CONSTRAINT "fk_${tbl}_${col.column_name}" FOREIGN KEY ("${col.column_name}") REFERENCES "${sc}"."${candidateTable}"("${refCol}");`,
          });
        }

        // ── Missing index on FK columns ──────────────────────────────────────
        // PostgreSQL does NOT auto-create indexes on FK columns — a common performance oversight
        for (const [fkCol] of fkTargets) {
          const { rows: idxCheck } = await client.query<{ has_index: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM pg_index i
               JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
               WHERE i.indrelid = ($1 || '.' || $2)::regclass
               AND a.attname = $3
             ) AS has_index`,
            [sc, tbl, fkCol]
          );
          if (!idxCheck[0]?.has_index) {
            result.push({
              id: sid(), kind: 'missing_index', table: tbl, column: fkCol,
              message: `FK column "${fkCol}" has no index — queries joining "${tbl}" will be slow.`,
              suggestedFix: 'Add an index on the FK column to speed up JOINs and deletes.',
              alterSql: `CREATE INDEX IF NOT EXISTS "idx_${tbl}_${fkCol}" ON "${sc}"."${tbl}" ("${fkCol}");`,
            });
          }
        }

        // ── Orphan FK data — FK values that don't exist in referenced table ──
        for (const [fkCol, target] of fkTargets) {
          try {
            const { rows: orphan } = await client.query<{ orphan_count: string }>(
              `SELECT COUNT(*) AS orphan_count
               FROM "${sc}"."${tbl}" t
               WHERE t."${fkCol}" IS NOT NULL
               AND NOT EXISTS (
                 SELECT 1 FROM "${target.schema}"."${target.table}" r WHERE r."${target.col}" = t."${fkCol}"
               )
               LIMIT 1`,
              []
            );
            const count = Number(orphan[0]?.orphan_count ?? 0);
            if (count > 0) {
              result.push({
                id: sid(), kind: 'orphan_fk_data', table: tbl, column: fkCol,
                message: `"${fkCol}" has ${count} value${count !== 1 ? 's' : ''} with no matching row in "${target.table}.${target.col}".`,
                suggestedFix: `Clean orphan rows or add ON DELETE SET NULL/CASCADE to the FK constraint.`,
              });
            }
          } catch { /* skip if permission denied */ }
        }

        // ── Missing UNIQUE on semantic columns ───────────────────────────────
        for (const col of cols) {
          if (uniqueColSet.has(col.column_name) || pkCols.has(col.column_name)) continue;
          if (UNIQUE_CANDIDATES.has(col.column_name.toLowerCase())) {
            result.push({
              id: sid(), kind: 'missing_unique', table: tbl, column: col.column_name,
              message: `"${col.column_name}" looks like it should be unique but has no UNIQUE constraint.`,
              suggestedFix: 'Add a UNIQUE constraint to enforce data integrity.',
              alterSql: `ALTER TABLE "${sc}"."${tbl}" ADD CONSTRAINT "uq_${tbl}_${col.column_name}" UNIQUE ("${col.column_name}");`,
            });
          }
        }

        // ── Suboptimal types ─────────────────────────────────────────────────
        for (const col of cols) {
          if (col.data_type === 'character varying' &&
              (col.character_maximum_length === null || col.character_maximum_length > 1024)) {
            result.push({
              id: sid(), kind: 'wide_varchar', table: tbl, column: col.column_name,
              message: `"${col.column_name}" is VARCHAR(${col.character_maximum_length ?? 'unlimited'}) — consider TEXT.`,
              suggestedFix: 'Use TEXT for unbounded string columns.',
              alterSql: `ALTER TABLE "${sc}"."${tbl}" ALTER COLUMN "${col.column_name}" TYPE TEXT;`,
            });
          }
          if (col.data_type === 'timestamp without time zone') {
            result.push({
              id: sid(), kind: 'suboptimal_type', table: tbl, column: col.column_name,
              message: `"${col.column_name}" is TIMESTAMP without timezone — TIMESTAMPTZ is safer.`,
              suggestedFix: 'Use TIMESTAMPTZ to avoid timezone ambiguity.',
              alterSql: `ALTER TABLE "${sc}"."${tbl}" ALTER COLUMN "${col.column_name}" TYPE TIMESTAMPTZ USING "${col.column_name}" AT TIME ZONE 'UTC';`,
            });
          }
        }
      }

      return result;
    });

    return res.status(200).json({ suggestions });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
