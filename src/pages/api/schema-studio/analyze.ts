import type { NextApiRequest, NextApiResponse } from 'next';
import { withPg, type ExplorerConn } from '../../../lib/explorer-db';

export type SuggestionKind =
  | 'missing_pk'
  | 'potential_fk'
  | 'suboptimal_type'
  | 'nullable_pk'
  | 'missing_unique'
  | 'wide_varchar';

export interface SchemaSuggestion {
  id: string;
  kind: SuggestionKind;
  table: string;
  column?: string;
  message: string;
  suggestedFix: string; // human-readable
  alterSql?: string;    // ready-to-apply SQL (optional)
}

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

        // ── PK check ─────────────────────────────────────────────────────────
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

        // ── Nullable PK ──────────────────────────────────────────────────────
        for (const col of cols) {
          if (pkCols.has(col.column_name) && col.is_nullable === 'YES') {
            result.push({
              id: sid(), kind: 'nullable_pk', table: tbl, column: col.column_name,
              message: `PK column "${tbl}.${col.column_name}" is nullable.`,
              suggestedFix: 'Set NOT NULL on the primary key column.',
              alterSql: `ALTER TABLE "${sc}"."${tbl}" ALTER COLUMN "${col.column_name}" SET NOT NULL;`,
            });
          }
        }

        // ── Existing FKs (to exclude from potential_fk suggestions) ─────────
        const { rows: existingFks } = await client.query<{ from_col: string }>(
          `SELECT kcu.column_name AS from_col
           FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
           WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
          [sc, tbl]
        );
        const existingFkCols = new Set(existingFks.map(r => r.from_col));

        // ── Potential FK by naming convention ────────────────────────────────
        for (const col of cols) {
          if (existingFkCols.has(col.column_name)) continue;
          // Pattern: column ends in _id or _uuid and is NOT the table's own PK
          const fkMatch = col.column_name.match(/^(.+?)_id$/i) ?? col.column_name.match(/^(.+?)_uuid$/i);
          if (!fkMatch || pkCols.has(col.column_name)) continue;
          const candidateTable = fkMatch[1];
          // Check if that table exists in the same schema
          const { rows: cand } = await client.query<{ exists: boolean }>(
            `SELECT EXISTS(
               SELECT 1 FROM information_schema.tables
               WHERE table_schema = $1 AND table_name = $2
             ) AS exists`,
            [sc, candidateTable]
          );
          if (!cand[0]?.exists) continue;
          // Check if the candidate table has a matching PK column
          const { rows: candPk } = await client.query<{ column_name: string }>(
            `SELECT kcu.column_name FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 AND tc.table_name = $2
             LIMIT 1`,
            [sc, candidateTable]
          );
          if (!candPk.length) continue;
          const refCol = candPk[0].column_name;
          result.push({
            id: sid(), kind: 'potential_fk', table: tbl, column: col.column_name,
            message: `"${tbl}.${col.column_name}" looks like a FK to "${candidateTable}.${refCol}".`,
            suggestedFix: `Add FOREIGN KEY (${col.column_name}) REFERENCES ${candidateTable}(${refCol}).`,
            alterSql: `ALTER TABLE "${sc}"."${tbl}" ADD CONSTRAINT "fk_${tbl}_${col.column_name}" FOREIGN KEY ("${col.column_name}") REFERENCES "${sc}"."${candidateTable}"("${refCol}");`,
          });
        }

        // ── Suboptimal type suggestions ──────────────────────────────────────
        for (const col of cols) {
          // character varying with large/unlimited max → TEXT is simpler
          if (col.data_type === 'character varying' &&
              (col.character_maximum_length === null || col.character_maximum_length > 1024)) {
            result.push({
              id: sid(), kind: 'wide_varchar', table: tbl, column: col.column_name,
              message: `"${tbl}.${col.column_name}" is VARCHAR(${col.character_maximum_length ?? 'unlimited'}) — consider TEXT.`,
              suggestedFix: 'Replace with TEXT for unbounded string columns.',
              alterSql: `ALTER TABLE "${sc}"."${tbl}" ALTER COLUMN "${col.column_name}" TYPE TEXT;`,
            });
          }
          // timestamp without timezone → timestamptz is safer
          if (col.data_type === 'timestamp without time zone') {
            result.push({
              id: sid(), kind: 'suboptimal_type', table: tbl, column: col.column_name,
              message: `"${tbl}.${col.column_name}" is TIMESTAMP without timezone — TIMESTAMPTZ is safer.`,
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
