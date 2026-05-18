-- ============================================================
-- DB Maintenance Tools — Initial Schema
-- Migration: 001_init
-- ============================================================

-- ── Users (authentication) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS dbt_users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(64)  NOT NULL,   -- SHA-256 hex
    role          VARCHAR(20)  NOT NULL DEFAULT 'admin',
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Stored DB connections (Settings) ─────────────────────────
CREATE TABLE IF NOT EXISTS dbt_connections (
    id            SERIAL PRIMARY KEY,
    db_type       VARCHAR(20)  NOT NULL CHECK (db_type IN ('mysql', 'postgres')),
    label         VARCHAR(100) NOT NULL DEFAULT 'default',
    host          VARCHAR(255) NOT NULL,
    port          INTEGER      NOT NULL,
    username      VARCHAR(100) NOT NULL,
    password_enc  TEXT,
    database_name VARCHAR(100) NOT NULL,
    ssl_enabled   BOOLEAN      NOT NULL DEFAULT FALSE,
    is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (db_type, label)
);

CREATE INDEX IF NOT EXISTS idx_dbt_connections_type
    ON dbt_connections (db_type);

-- ── Migration log (tracks applied migrations) ─────────────────
CREATE TABLE IF NOT EXISTS dbt_migrations (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(255) UNIQUE NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Auto-update trigger ───────────────────────────────────────
CREATE OR REPLACE FUNCTION dbt_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_dbt_users_updated ON dbt_users;
CREATE TRIGGER trg_dbt_users_updated
    BEFORE UPDATE ON dbt_users
    FOR EACH ROW EXECUTE FUNCTION dbt_set_updated_at();

DROP TRIGGER IF EXISTS trg_dbt_connections_updated ON dbt_connections;
CREATE TRIGGER trg_dbt_connections_updated
    BEFORE UPDATE ON dbt_connections
    FOR EACH ROW EXECUTE FUNCTION dbt_set_updated_at();

-- ── Record this migration ─────────────────────────────────────
INSERT INTO dbt_migrations (name) VALUES ('001_init')
    ON CONFLICT (name) DO NOTHING;
