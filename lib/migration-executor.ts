import { Pool as PgPool, PoolClient } from 'pg';
import mysql from 'mysql2/promise';
import {
  MigrationConfig,
  PgConnectionConfig,
  MigrationExecutionResult,
  TableMigrationResult,
  TableMapping,
} from './types';
import {
  generateCreateSchemasSQL,
  generateCreateTableSQL,
  generateIndexesSQL,
} from './postgres-migrator';

export async function executeMigration(
  config: MigrationConfig,
  pgConfig: PgConnectionConfig,
  mysqlConfig: { host: string; port: number; user: string; password: string; database: string },
  onLog?: (msg: string) => void
): Promise<MigrationExecutionResult> {
  const log: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const schemasCreated: string[] = [];
  const tablesCreated: string[] = [];
  const tableResults: TableMigrationResult[] = [];
  let indexesCreated = 0;
  let totalRowsMigrated = 0;

  const addLog = (msg: string) => {
    log.push(msg);
    onLog?.(msg);
  };

  const startedAt = new Date().toISOString();
  addLog(`[${startedAt}] Migration started: ${config.name}`);

  // ── Connect to PostgreSQL ──────────────────────────────────────────────────
  const pgPool = new PgPool({
    host: pgConfig.host,
    port: pgConfig.port,
    user: pgConfig.user,
    password: pgConfig.password,
    database: pgConfig.database,
    ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false,
    max: 5,
  });

  // ── Connect to MySQL ───────────────────────────────────────────────────────
  const mysqlConn = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
  });

  const pgClient = await pgPool.connect();

  try {
    // ── Step 1: Create Schemas ─────────────────────────────────────────────
    addLog('Creating PostgreSQL schemas...');
    const schemas = new Set<string>();
    for (const t of config.tables) {
      if (t.include && t.pgSchema !== 'public') schemas.add(t.pgSchema);
    }
    for (const schema of schemas) {
      await pgClient.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
      schemasCreated.push(schema);
      addLog(`  ✓ Schema created: ${schema}`);
    }

    // ── Step 2: Create Tables ──────────────────────────────────────────────
    addLog('Creating PostgreSQL tables...');
    for (const table of config.tables.filter((t) => t.include)) {
      const ddl = generateCreateTableSQL(table);
      if (!ddl) {
        warnings.push(`Table "${table.pgName}" skipped — no included columns`);
        continue;
      }
      try {
        await pgClient.query(ddl);
        tablesCreated.push(`${table.pgSchema}.${table.pgName}`);
        addLog(`  ✓ Table created: "${table.pgSchema}"."${table.pgName}"`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to create table "${table.pgName}": ${msg}`);
        addLog(`  ✗ Failed: "${table.pgName}" — ${msg}`);
      }
    }

    // ── Step 3: Migrate Data ───────────────────────────────────────────────
    addLog('Migrating data...');
    for (const table of config.tables.filter((t) => t.include)) {
      const result = await migrateTableData(table, mysqlConn, pgClient, addLog);
      tableResults.push(result);
      if (result.success) {
        totalRowsMigrated += result.rowsMigrated;
        addLog(`  ✓ ${table.mysqlName} → ${table.pgSchema}.${table.pgName}: ${result.rowsMigrated} rows`);
      } else {
        errors.push(`Data migration failed for "${table.mysqlName}": ${result.error}`);
        addLog(`  ✗ ${table.mysqlName}: ${result.error}`);
      }
    }

    // ── Step 4: Create Indexes ─────────────────────────────────────────────
    addLog('Creating indexes...');
    for (const table of config.tables.filter((t) => t.include)) {
      const idxSQLs = generateIndexesSQL(table);
      for (const sql of idxSQLs) {
        try {
          await pgClient.query(sql);
          indexesCreated++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          warnings.push(`Index creation warning for "${table.pgName}": ${msg}`);
        }
      }
    }
    addLog(`  ✓ ${indexesCreated} index(es) created`);

    // ── Step 5: Verify Row Counts ──────────────────────────────────────────
    addLog('Verifying row counts...');
    for (const result of tableResults) {
      if (!result.success) continue;
      const [rows] = await mysqlConn.execute<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) as cnt FROM \`${result.tableName}\``
      );
      const sourceCount = Number((rows[0] as { cnt: number }).cnt);
      const pgRes = await pgClient.query(
        `SELECT COUNT(*) as cnt FROM "${result.pgSchema}"."${result.pgTable}"`
      );
      const pgCount = Number(pgRes.rows[0].cnt);
      if (sourceCount !== pgCount) {
        warnings.push(
          `Row count mismatch for "${result.tableName}": MySQL=${sourceCount}, PG=${pgCount}`
        );
        addLog(`  ⚠ Row count mismatch: ${result.tableName} (${sourceCount} vs ${pgCount})`);
      } else {
        addLog(`  ✓ Row count verified: ${result.tableName} (${pgCount} rows)`);
      }
    }
  } finally {
    pgClient.release();
    await pgPool.end();
    await mysqlConn.end();
  }

  const finishedAt = new Date().toISOString();
  const success = errors.length === 0;
  addLog(`[${finishedAt}] Migration ${success ? 'completed' : 'finished with errors'}`);

  return {
    success,
    schemasCreated,
    tablesCreated,
    tableResults,
    indexesCreated,
    totalRowsMigrated,
    errors,
    warnings,
    log,
    startedAt,
    finishedAt,
  };
}

async function migrateTableData(
  table: TableMapping,
  mysqlConn: mysql.Connection,
  pgClient: PoolClient,
  addLog: (msg: string) => void
): Promise<TableMigrationResult> {
  const includedCols = table.columns.filter((c) => c.include);
  const mysqlCols = includedCols.map((c) => `\`${c.mysqlName}\``).join(', ');
  const pgCols = includedCols.map((c) => `"${c.pgName}"`).join(', ');
  const placeholders = includedCols.map((_, i) => `$${i + 1}`).join(', ');

  try {
    const [rows] = await mysqlConn.execute<mysql.RowDataPacket[]>(
      `SELECT ${mysqlCols} FROM \`${table.mysqlName}\``
    );

    if (rows.length === 0) {
      return {
        tableName: table.mysqlName,
        pgTable: table.pgName,
        pgSchema: table.pgSchema,
        rowsMigrated: 0,
        rowsInSource: 0,
        success: true,
      };
    }

    const insertSQL = `INSERT INTO "${table.pgSchema}"."${table.pgName}" (${pgCols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    // Batch inserts in chunks of 500
    const BATCH = 500;
    let migrated = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      for (const row of chunk) {
        const values = includedCols.map((c) => {
          const val = (row as Record<string, unknown>)[c.mysqlName];
          if (val instanceof Date) return val.toISOString();
          if (Buffer.isBuffer(val)) return val;
          return val ?? null;
        });
        await pgClient.query(insertSQL, values);
        migrated++;
      }
      addLog(`    Inserted ${Math.min(i + BATCH, rows.length)}/${rows.length} rows into ${table.pgName}`);
    }

    return {
      tableName: table.mysqlName,
      pgTable: table.pgName,
      pgSchema: table.pgSchema,
      rowsMigrated: migrated,
      rowsInSource: rows.length,
      success: true,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      tableName: table.mysqlName,
      pgTable: table.pgName,
      pgSchema: table.pgSchema,
      rowsMigrated: 0,
      rowsInSource: 0,
      success: false,
      error: msg,
    };
  }
}

export async function testPgConnection(pgConfig: PgConnectionConfig): Promise<{ ok: boolean; error?: string }> {
  try {
    const pool = new PgPool({
      host: pgConfig.host,
      port: pgConfig.port,
      user: pgConfig.user,
      password: pgConfig.password,
      database: pgConfig.database,
      ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 5000,
      max: 1,
    });
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    await pool.end();
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
