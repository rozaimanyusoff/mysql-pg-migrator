-- ============================================================
-- DB Maintenance Tools — Schema Generator Jobs
-- Migration: 004_schema_jobs
-- ============================================================

CREATE TABLE IF NOT EXISTS dbt_schema_jobs (
    id               SERIAL        PRIMARY KEY,
    username         VARCHAR(100)  NOT NULL,
    job_name         VARCHAR(200)  NOT NULL,
    description      TEXT,
    connection_label VARCHAR(200),
    target_database  VARCHAR(200),
    schema_file_path TEXT,
    seed_file_path   TEXT,
    schema_sql       TEXT,
    seed_sql         TEXT,
    status           VARCHAR(20)   NOT NULL DEFAULT 'pending',
    log              JSONB,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dbt_schema_jobs_user
    ON dbt_schema_jobs (username, created_at DESC);

INSERT INTO dbt_migrations (name) VALUES ('004_schema_jobs')
    ON CONFLICT (name) DO NOTHING;
