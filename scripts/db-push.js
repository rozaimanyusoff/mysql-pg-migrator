#!/usr/bin/env node
// Applies all SQL files in db/migrations/ against the target PostgreSQL database.
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
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      process.stdout.write(`  Applying ${file} ... `);
      await client.query(sql);
      console.log('OK');
    }
    console.log(`\n✓ ${files.length} migration(s) applied successfully.`);
  } catch (err) {
    console.error('\nFAILED:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();
