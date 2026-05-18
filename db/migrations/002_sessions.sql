-- ============================================================
-- DB Maintenance Tools — Sessions Table
-- Migration: 002_sessions
-- ============================================================

CREATE TABLE IF NOT EXISTS dbt_sessions (
    id         SERIAL      PRIMARY KEY,
    token      CHAR(64)    UNIQUE NOT NULL,
    username   VARCHAR(100) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_dbt_sessions_token
    ON dbt_sessions (token);

CREATE INDEX IF NOT EXISTS idx_dbt_sessions_expires
    ON dbt_sessions (expires_at);

INSERT INTO dbt_migrations (name) VALUES ('002_sessions')
    ON CONFLICT (name) DO NOTHING;
