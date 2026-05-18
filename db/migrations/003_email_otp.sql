-- ============================================================
-- DB Maintenance Tools — Email Config & OTP
-- Migration: 003_email_otp
-- ============================================================

-- Add email field to users
ALTER TABLE dbt_users
    ADD COLUMN IF NOT EXISTS email VARCHAR(255);

-- ── Email / SMTP configuration ────────────────────────────────
CREATE TABLE IF NOT EXISTS dbt_email_config (
    id           SERIAL PRIMARY KEY,
    host         VARCHAR(255) NOT NULL DEFAULT '',
    port         INTEGER      NOT NULL DEFAULT 587,
    username     VARCHAR(255) NOT NULL DEFAULT '',
    password_enc TEXT,
    from_email   VARCHAR(255) NOT NULL DEFAULT '',
    from_name    VARCHAR(100) NOT NULL DEFAULT 'DB Maintenance Tools',
    secure       BOOLEAN      NOT NULL DEFAULT FALSE,
    enable_2fa   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_dbt_email_config_updated ON dbt_email_config;
CREATE TRIGGER trg_dbt_email_config_updated
    BEFORE UPDATE ON dbt_email_config
    FOR EACH ROW EXECUTE FUNCTION dbt_set_updated_at();

-- ── OTP codes for 2FA ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dbt_otp_codes (
    id         SERIAL      PRIMARY KEY,
    username   VARCHAR(100) NOT NULL,
    code       CHAR(6)     NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dbt_otp_username
    ON dbt_otp_codes (username, used, expires_at);

INSERT INTO dbt_migrations (name) VALUES ('003_email_otp')
    ON CONFLICT (name) DO NOTHING;
