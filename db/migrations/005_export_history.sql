-- ============================================================
-- DB Maintenance Tools — Export History
-- Migration: 005_export_history
-- ============================================================

CREATE TABLE IF NOT EXISTS dbt_export_history (
  id           SERIAL PRIMARY KEY,
  username     TEXT NOT NULL,
  operation    TEXT NOT NULL CHECK (operation IN ('export', 'import', 'sync')),
  source_label TEXT,
  source_db    TEXT,
  target_label TEXT,
  target_db    TEXT,
  tables_list  JSONB,
  tables_count INTEGER DEFAULT 0,
  include      TEXT,
  conflict     TEXT,
  format       TEXT DEFAULT 'sql',
  where_clause TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('success', 'failed', 'pending')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_history_user
  ON dbt_export_history (username, created_at DESC);

INSERT INTO dbt_migrations (name) VALUES ('005_export_history')
  ON CONFLICT (name) DO NOTHING;
