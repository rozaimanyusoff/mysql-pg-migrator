#!/usr/bin/env node
// Applies pending SQL migrations in db/migrations/ against the target PostgreSQL database.
// Tracks applied migrations in dbt_migrations — already-applied files are skipped.
// Connection order: DATABASE_URL env var → data/settings.json postgres config.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

function getPoolConfig() {
  if (process.env.DATABASE_URL) {
    console.log('Using DATABASE_URL');
    return { connectionString: process.env.DATABASE_URL };
  }
  const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const pg = settings.postgres;
    if (!pg?.host || !pg?.user || !pg?.database) throw new Error('incomplete');
    console.log(`Using settings.json → ${pg.user}@${pg.host}:${pg.port ?? 5432}/${pg.database}`);
    return {
      host: pg.host,
      port: Number(pg.port) || 5432,
      user: pg.user,
      password: pg.password ?? '',
      database: pg.database,
      ssl: pg.ssl ? { rejectUnauthorized: false } : false,
    };
  } catch {
    console.error('\nERROR: No database connection found.');
    console.error('  Option 1 — set DATABASE_URL=postgresql://user:pass@host:5432/dbname');
    console.error('  Option 2 — configure PostgreSQL in Settings page first.\n');
    process.exit(1);
  }
}

async function run() {
  const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('No migration files found in db/migrations/');
    return;
  }

  const pool = new Pool(getPoolConfig());
  const client = await pool.connect();

  try {
    // Ensure dbt_migrations table exists before checking it
    await client.query(`
      CREATE TABLE IF NOT EXISTS dbt_migrations (
        id         SERIAL PRIMARY KEY,
        name       VARCHAR(255) UNIQUE NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Fetch already-applied migration names
    const { rows } = await client.query('SELECT name FROM dbt_migrations');
    const applied = new Set(rows.map((r) => r.name));

    let skipped = 0;
    let ran = 0;

    for (const file of files) {
      const migrationName = path.basename(file, '.sql');

      if (applied.has(migrationName)) {
        console.log(`  Skipping ${file} (already applied)`);
        skipped++;
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      process.stdout.write(`  Applying ${file} ... `);

      await client.query('BEGIN');
      try {
        await client.query(sql);
        // Record as applied if the migration didn't already do it
        await client.query(
          `INSERT INTO dbt_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
          [migrationName]
        );
        await client.query('COMMIT');
        console.log('OK');
        ran++;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log(`\n✓ ${ran} migration(s) applied, ${skipped} skipped.`);
  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
