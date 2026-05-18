-- ============================================================
-- DB Maintenance Tools — Seed Data
-- Seed: 001_seed
-- ============================================================
-- Default admin account
-- username : admin
-- password : admin   (SHA-256: 8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918)
-- ============================================================

INSERT INTO dbt_users (username, password_hash, role)
VALUES (
    'admin',
    '8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918',
    'admin'
)
ON CONFLICT (username) DO NOTHING;
