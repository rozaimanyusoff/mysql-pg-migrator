import mysql from 'mysql2/promise';
import { Pool as PgPool } from 'pg';
import {
  MigrationConfig,
  MigrationRunOptions,
  MigrationRunState,
  MigrationRunTableState,
  PgConnectionConfig,
  SourceConnectionConfig,
  TableMapping,
} from './types';
import { createRun, loadRun, saveRun } from './migration-run-store';
import { generateCommentsSQL, generateCreateTableSQL, generateIndexesSQL } from './postgres-migrator';

function tableKey(t: TableMapping): string {
  return `${t.sourceDatabase || 'default'}::${t.mysqlName}`;
}

function mysqlIdent(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

function pgIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function detectKeyType(mysqlType: string | undefined): 'number' | 'string' | 'unknown' {
  if (!mysqlType) return 'unknown';
  const t = mysqlType.toLowerCase();
  if (/(int|decimal|numeric|float|double|real|bit|serial)/.test(t)) return 'number';
  if (/(char|text|date|time|uuid|json|enum|set|binary|blob)/.test(t)) return 'string';
  return 'unknown';
}

function pickKeyColumn(table: TableMapping): { keyColumn: string | null; keyColumnType: 'number' | 'string' | 'unknown' } {
  const primary = table.columns.find((c) => c.isPrimaryKey);
  if (primary) {
    return { keyColumn: primary.mysqlName, keyColumnType: detectKeyType(primary.mysqlType) };
  }
  const included = table.columns.find((c) => c.include && !c.isTargetOnly);
  if (included) {
    return { keyColumn: included.mysqlName, keyColumnType: detectKeyType(included.mysqlType) };
  }
  return { keyColumn: null, keyColumnType: 'unknown' };
}

function addLog(run: MigrationRunState, message: string): void {
  run.logs.push(`[${nowIso()}] ${message}`);
  if (run.logs.length > 2000) {
    run.logs = run.logs.slice(run.logs.length - 2000);
  }
}

function createInsertSQL(schema: string, table: string, columns: string[], rows: number): string {
  const oneRow = `(${columns.map((_, i) => `$${i + 1}`).join(', ')})`;
  const valueGroups: string[] = [];
  for (let r = 0; r < rows; r++) {
    valueGroups.push(
      `(${columns.map((_, c) => `$${r * columns.length + c + 1}`).join(', ')})`
    );
  }
  const targetCols = columns.map((c) => pgIdent(c)).join(', ');
  return `INSERT INTO ${pgIdent(schema)}.${pgIdent(table)} (${targetCols}) VALUES ${rows === 1 ? oneRow : valueGroups.join(', ')} ON CONFLICT DO NOTHING`;
}

async function ensureTablePrepared(
  run: MigrationRunState,
  tableState: MigrationRunTableState,
  mapping: TableMapping,
  mysqlConn: mysql.Connection,
  pgClient: PgPool
): Promise<void> {
  if (!tableState.tableCreated) {
    if (mapping.pgSchema !== 'public') {
      await pgClient.query(`CREATE SCHEMA IF NOT EXISTS ${pgIdent(mapping.pgSchema)}`);
    }
    const ddl = generateCreateTableSQL(mapping);
    if (!ddl) {
      throw new Error(`No included columns for ${mapping.mysqlName}`);
    }
    try {
      await pgClient.query(ddl);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/already exists/i.test(msg)) {
        throw err;
      }
    }
    tableState.tableCreated = true;
    addLog(run, `Prepared table ${mapping.mysqlName} -> ${mapping.pgSchema}.${mapping.pgName}`);
  }

  if (!tableState.commentsCreated) {
    const commentSQLs = generateCommentsSQL(mapping);
    for (const sql of commentSQLs) {
      try {
        await pgClient.query(sql);
      } catch {
        // non-blocking
      }
    }
    tableState.commentsCreated = true;
  }

  if (tableState.rowsSource === null) {
    const db = mapping.sourceDatabase || run.source.database;
    const [rows] = await mysqlConn.query<mysql.RowDataPacket[]>(
      `SELECT COUNT(*) AS cnt FROM ${mysqlIdent(db)}.${mysqlIdent(mapping.mysqlName)}`
    );
    tableState.rowsSource = Number((rows[0] as { cnt: number }).cnt || 0);
  }
}

async function migrateChunk(
  run: MigrationRunState,
  tableState: MigrationRunTableState,
  mapping: TableMapping,
  mysqlConn: mysql.Connection,
  pgClient: PgPool
): Promise<number> {
  const included = mapping.columns.filter((c) => c.include);
  const sourceCols = included.filter((c) => !c.isTargetOnly);
  if (sourceCols.length === 0) {
    throw new Error('No source-mapped columns left. Keep at least one MySQL source column included.');
  }
  if (included.length === 0) {
    tableState.hasMore = false;
    return 0;
  }

  const mysqlSelectCols = new Set(sourceCols.map((c) => c.mysqlName));
  if (tableState.keyColumn) mysqlSelectCols.add(tableState.keyColumn);
  const selectedColNames = [...mysqlSelectCols];

  const db = mapping.sourceDatabase || run.source.database;
  let sql = `SELECT ${selectedColNames.map(mysqlIdent).join(', ')} FROM ${mysqlIdent(db)}.${mysqlIdent(mapping.mysqlName)}`;
  const params: Array<string | number> = [];

  if (tableState.keyColumn) {
    if (tableState.lastKeyValue !== null) {
      sql += ` WHERE ${mysqlIdent(tableState.keyColumn)} > ?`;
      params.push(tableState.lastKeyValue);
    }
    sql += ` ORDER BY ${mysqlIdent(tableState.keyColumn)} ASC LIMIT ?`;
    params.push(run.options.chunkSize);
  } else {
    sql += ' LIMIT ? OFFSET ?';
    params.push(run.options.chunkSize, tableState.offset);
  }

  const [rows] = await mysqlConn.query<mysql.RowDataPacket[]>(sql, params);
  if (rows.length === 0) {
    tableState.hasMore = false;
    return 0;
  }

  const pgCols = sourceCols.map((c) => c.pgName);
  const insertSQL = createInsertSQL(mapping.pgSchema, mapping.pgName, pgCols, rows.length);
  const insertParams: unknown[] = [];

  for (const row of rows) {
    for (const col of sourceCols) {
      const val = (row as Record<string, unknown>)[col.mysqlName];
      if (val instanceof Date) insertParams.push(val.toISOString());
      else insertParams.push(val ?? null);
    }
  }

  await pgClient.query(insertSQL, insertParams);

  const copied = rows.length;
  tableState.rowsCopied += copied;
  run.totalRowsCopied += copied;

  if (tableState.keyColumn) {
    const last = rows[rows.length - 1] as Record<string, unknown>;
    const raw = last[tableState.keyColumn];
    if (typeof raw === 'number') tableState.lastKeyValue = raw;
    else if (typeof raw === 'string') tableState.lastKeyValue = raw;
    else if (raw instanceof Date) tableState.lastKeyValue = raw.toISOString();
    else if (raw != null) tableState.lastKeyValue = String(raw);
  } else {
    tableState.offset += copied;
  }

  return copied;
}

async function finalizeTable(
  run: MigrationRunState,
  tableState: MigrationRunTableState,
  mapping: TableMapping,
  pgClient: PgPool
): Promise<void> {
  if (!tableState.indexesCreated) {
    const idxSQLs = generateIndexesSQL(mapping);
    for (const sql of idxSQLs) {
      try {
        await pgClient.query(sql);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        run.warnings.push(`Index warning ${mapping.mysqlName}: ${msg}`);
      }
    }
    tableState.indexesCreated = true;
  }

  tableState.status = 'completed';
  tableState.finishedAt = nowIso();
  addLog(run, `Completed ${mapping.mysqlName}: ${tableState.rowsCopied} rows copied`);
}

export async function initializeMigrationRun(args: {
  config: MigrationConfig;
  source: SourceConnectionConfig;
  target: PgConnectionConfig;
  templateId?: string | null;
  templateVersion?: number | null;
  options?: Partial<MigrationRunOptions>;
  completedSnapshotByKey?: Record<string, { rowsCopied?: number; rowsSource?: number | null; finishedAt?: string }>;
}): Promise<MigrationRunState> {
  const id = `run_${Date.now()}`;
  const now = nowIso();
  const includedTables = args.config.tables.filter((t) => t.include);

  const tables: MigrationRunTableState[] = includedTables.map((t) => {
    const keyId = tableKey(t);
    const key = pickKeyColumn(t);
    const completedSnapshot = args.completedSnapshotByKey?.[keyId];
    const isCompletedFromSnapshot = Boolean(completedSnapshot);
    return {
      key: keyId,
      sourceDatabase: t.sourceDatabase || args.source.database,
      mysqlTable: t.mysqlName,
      pgSchema: t.pgSchema,
      pgTable: t.pgName,
      status: isCompletedFromSnapshot ? 'completed' : 'pending',
      rowsCopied: Number(completedSnapshot?.rowsCopied ?? 0),
      rowsSource: completedSnapshot?.rowsSource ?? null,
      lastKeyValue: null,
      keyColumn: key.keyColumn,
      keyColumnType: key.keyColumnType,
      offset: 0,
      hasMore: !isCompletedFromSnapshot,
      tableCreated: isCompletedFromSnapshot,
      commentsCreated: isCompletedFromSnapshot,
      indexesCreated: isCompletedFromSnapshot,
      startedAt: isCompletedFromSnapshot ? now : undefined,
      finishedAt: isCompletedFromSnapshot ? (completedSnapshot?.finishedAt || now) : undefined,
    };
  });

  const run: MigrationRunState = {
    id,
    templateId: args.templateId ?? null,
    templateVersion: args.templateVersion ?? null,
    config: args.config,
    source: args.source,
    target: args.target,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    currentTableIndex: tables.findIndex((t) => t.status !== 'completed' && t.status !== 'failed'),
    totalRowsCopied: tables.reduce((sum, t) => sum + t.rowsCopied, 0),
    options: {
      chunkSize: Math.max(100, Math.min(5000, Number(args.options?.chunkSize || 1000))),
      maxSecondsPerAdvance: Math.max(3, Math.min(45, Number(args.options?.maxSecondsPerAdvance || 10))),
    },
    tables,
    logs: [],
    errors: [],
    warnings: [],
  };

  if (run.currentTableIndex < 0) {
    run.currentTableIndex = tables.length;
  }

  const skippedCompleted = tables.filter((t) => t.status === 'completed').length;
  addLog(
    run,
    `Run initialized with ${tables.length} table(s)` +
      (skippedCompleted > 0 ? `, skipped ${skippedCompleted} previously completed table(s)` : '')
  );
  await createRun(run);
  return run;
}

export async function advanceMigrationRun(runId: string): Promise<MigrationRunState> {
  const run = await loadRun(runId);
  if (!run) {
    throw new Error('Run not found');
  }

  if (run.status === 'completed' || run.status === 'failed') {
    return run;
  }

  const started = Date.now();
  const budgetMs = run.options.maxSecondsPerAdvance * 1000;
  run.status = 'running';
  run.startedAt = run.startedAt || nowIso();
  run.updatedAt = nowIso();

  const mysqlConn = await mysql.createConnection({
    host: run.source.host,
    port: run.source.port,
    user: run.source.user,
    password: run.source.password,
    database: run.source.database,
  });

  const pgPool = new PgPool({
    host: run.target.host,
    port: run.target.port,
    user: run.target.user,
    password: run.target.password,
    database: run.target.database,
    ssl: run.target.ssl ? { rejectUnauthorized: false } : false,
    max: 2,
  });

  try {
    while (Date.now() - started < budgetMs && run.currentTableIndex < run.tables.length) {
      const tableState = run.tables[run.currentTableIndex];
      const mapping = run.config.tables.find((t) => tableKey(t) === tableState.key);
      if (!mapping) {
        tableState.status = 'failed';
        tableState.error = `Mapping not found for ${tableState.key}`;
        run.errors.push(tableState.error);
        run.currentTableIndex += 1;
        continue;
      }

      if (tableState.status === 'pending') {
        tableState.status = 'running';
        tableState.startedAt = nowIso();
      }

      try {
        await ensureTablePrepared(run, tableState, mapping, mysqlConn, pgPool);
        const copied = await migrateChunk(run, tableState, mapping, mysqlConn, pgPool);
        addLog(run, `Chunk ${mapping.mysqlName}: +${copied} rows (total ${tableState.rowsCopied})`);

        if (!tableState.hasMore || copied < run.options.chunkSize) {
          tableState.hasMore = false;
          await finalizeTable(run, tableState, mapping, pgPool);
          run.currentTableIndex += 1;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        tableState.status = 'failed';
        tableState.error = msg;
        tableState.finishedAt = nowIso();
        run.errors.push(`${mapping.mysqlName}: ${msg}`);
        addLog(run, `Failed ${mapping.mysqlName}: ${msg}`);
        run.currentTableIndex += 1;
      }
    }

    const hasFailed = run.tables.some((t) => t.status === 'failed');
    const allDone = run.tables.every((t) => t.status === 'completed' || t.status === 'failed');

    if (allDone) {
      run.status = hasFailed ? 'failed' : 'completed';
      run.finishedAt = nowIso();
      addLog(run, `Run finished with status=${run.status}`);
    }

    run.updatedAt = nowIso();
    await saveRun(run);
    return run;
  } finally {
    await mysqlConn.end();
    await pgPool.end();
  }
}
