// ── Connection ────────────────────────────────────────────────────────────────

export type DbType = 'postgresql' | 'mysql';

export interface MigConn {
  type: DbType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

// ── Column / Table mapping ────────────────────────────────────────────────────

export type IdConversion =
  | 'keep'
  | 'serial_to_uuid'
  | 'to_text'
  | 'to_integer'
  | 'to_bigint'
  | 'to_numeric'
  | 'to_boolean'
  | 'to_timestamptz'
  | 'to_date'
  | 'to_jsonb';

export type TargetMode = 'existing' | 'source_clone';
export type NullPolicy = 'fail' | 'target_default' | 'fallback' | 'skip_row';
export type EmptyPolicy = 'keep' | 'as_null';

export interface ColumnMap {
  sourceCol: string | null;  // null = target-only (new column not in source)
  /** Physical source type captured during inspection; used for conversion-aware Pre-flight. */
  sourceType?: string | null;
  targetCol: string;
  targetName: string | null; // null = keep targetCol name; string = rename in output
  targetType: string;        // target DB type string
  nullable: boolean;
  defaultValue: string | null;
  /** Source/target nullability are kept separately for existing-target mappings. */
  sourceNullable?: boolean;
  targetNullable?: boolean;
  targetDefaultValue?: string | null;
  /** Durable row handling used by both Run Once and recurring execution. */
  nullPolicy?: NullPolicy;
  emptyPolicy?: EmptyPolicy;
  nullFallback?: string | null;
  include: boolean;
  conversion: IdConversion;
  // For FK columns that point to a UUID-converted PK:
  // e.g. "public.users" means "look up seqToUUID('public.users', fk_value)"
  fkRef: string | null;
  /** Physical target FK discovered from the existing target schema. */
  targetFkRef?: string | null;
  // When conversion is serial_to_uuid: also write the original integer into this extra
  // BIGINT column (e.g. "legacy_id"). Useful when other tables still FK via the old serial.
  keepLegacyAs?: string | null;
}

export interface TableMap {
  id: string;           // stable local id (uuid)
  include: boolean;
  source: { schema: string; table: string };
  sourceDatabase?: string; // which source DB this table was added from (multi-DB support)
  target: { schema: string; table: string };
  /** Existing app schema is authoritative; source_clone creates a translated source table. */
  targetMode?: TargetMode;
  columns: ColumnMap[];
  truncateBeforeMigrate: boolean;
  skipConstraints?: boolean;     // transaction-scoped PG constraint bypass during insert
  skipNullViolations?: boolean;  // DROP NOT NULL on target columns before insert, restore after
  targetAlias?: string | null;               // overrides target.table as the physical table name in SQL
  isSet?: boolean;             // user confirmed mapping is ready to run
  // Incremental sync
  syncMode?: 'full' | 'incremental';
  fullSyncStrategy?: 'insert_missing' | 'upsert'; // full scan: keep existing rows or update them by target key
  incrementalCol?: string | null;            // source column used as high-water mark
  incrementalStrategy?: 'id' | 'timestamp'; // id = append-only insert; timestamp = upsert
  incrementalTieCol?: string | null;         // unique source key for equal timestamp watermarks
  // Runtime-only cursor fields hydrated from data/migv2/runtime; never persisted
  // as editable saved-job configuration.
  lastSyncedValue?: string | null;
  lastSyncedPk?: string | null;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export interface CronSchedule {
  id: string;
  jobId: string;
  jobName: string;          // denormalised for display
  cronExpr: string;         // standard 5-field: "0 2 * * *"
  /** Recurring cron or a cron-backed one-shot trigger that disables itself. */
  scheduleMode?: 'once' | 'recurring';
  /** Exact requested wall-clock instant for one-shot schedules. */
  runAt?: string | null;
  /** IANA timezone used when evaluating recurring cron expressions. */
  timezone?: string | null;
  /** Set atomically when a one-shot trigger is accepted. */
  triggeredAt?: string | null;
  /** Set when the requested one-shot instant passed without an accepted run. */
  missedAt?: string | null;
  /** Last occurrence accepted by the server-managed scheduler. */
  lastTriggeredAt?: string | null;
  /** Recurring occurrence queued while capacity or another run is active. */
  pendingRunAt?: string | null;
  /** Automatic checkpoint recovery attempts for the current scheduled run. */
  recoveryAttempts?: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: 'completed' | 'completed_with_issues' | 'failed' | 'running' | 'paused' | null;
  lastRunId: string | null;
  notifyEmail?: string | null;   // normalized comma-separated recipients (optional)
  chunkMode?: 'auto' | 'fixed';
  chunkRows?: number | null;     // requested rows; manual runtime policy clamps to the single-run ceiling
}

// ── Job ───────────────────────────────────────────────────────────────────────

export interface MigJob {
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  // passwords excluded from job storage
  sourceMeta: Omit<MigConn, 'password'>;
  targetMeta: Omit<MigConn, 'password'>;
  /** Copy Source is a job-wide 1:1 contract; per-table remains the legacy/custom path. */
  mappingMode?: 'copy_source' | 'existing_target';
  /** Job-wide default projected onto every table for Copy Source jobs. */
  syncStrategy?: 'incremental' | 'full_upsert' | 'full_insert';
  /** Saved for the operator-triggered initial run only; Scheduler never consumes it. */
  initialRunOptions?: { skipConstraints?: boolean };
  tables: TableMap[];
  // Global row-range filter applied to every table in this job
  filterCol?: string | null;    // timestamp/date column name (must exist in all source tables)
  filterFrom?: string | null;   // inclusive lower bound  e.g. "2024-01-01"
  filterTo?: string | null;     // inclusive upper bound  e.g. "2024-03-31"
}

export interface MigJobTableSummary {
  id: string;
  include: boolean;
  source: { schema: string; table: string };
  sourceDatabase?: string;
  target: { schema: string; table: string };
  targetAlias?: string | null;
  syncMode?: 'full' | 'incremental';
  fullSyncStrategy?: 'insert_missing' | 'upsert';
  incrementalCol?: string | null;
  lastSyncedValue?: string | null;
  truncateBeforeMigrate?: boolean;
}

export interface MigrationAdvisory {
  tableId: string;
  sourceKey: string;
  level: 'warning' | 'info';
  message: string;
  reason: string;
  impact: string;
  action: string;
}

export interface MigJobSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  tableCount: number;
  mappingMode?: 'copy_source' | 'existing_target';
  syncStrategy?: 'incremental' | 'full_upsert' | 'full_insert';
  tables: MigJobTableSummary[];
  scheduleReady: boolean;
  scheduleIssues: number;
  advisories: MigrationAdvisory[];
}

export interface SchedulerJobSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  updatedAt: string;
  tableCount: number;
  scheduleReady: boolean;
  scheduleIssues: number;
  executionTables: Array<{
    id: string;
    sourceKey: string;
    targetKey: string;
  }>;
}

// ── Run ───────────────────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'completed_with_issues' | 'failed' | 'rolled_back' | 'aborted';
export type TableRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'completed_with_issues' | 'failed' | 'rolled_back' | 'aborted';

export interface RunExecutionPolicy {
  mode: 'auto' | 'fixed';
  chunkRows: number;
  recommendedChunkRows: number;
  /** Ceiling used by Auto after accounting for other simultaneous runs. */
  concurrentCeilingRows?: number;
  /** Effective ceiling for this run; fixed overrides may use the single-run ceiling. */
  safeCeilingRows: number;
  /** Audit context captured from Pre-flight; absent on legacy run files. */
  singleRunCeilingRows?: number;
  assumedConcurrentRuns?: number;
  maxConcurrentTables?: number;
  writerMethod?: 'copy-staging' | 'multi-row' | 'row-by-row';
  performanceTargetSeconds?: number;
  source: 'preflight' | 'system_default';
  capturedAt: string;
}

export interface MigRunTableState {
  id: string;           // = tableMap.id
  /** Client-side Pending Save identity. Legacy run files may omit these fields. */
  pendingId?: string;
  originRunId?: string;
  sourceKey: string;    // "schema.table"
  targetKey: string;
  status: TableRunStatus;
  rowsSource: number;
  rowsMigrated: number;  // rows actually written to target
  rowsSkipped: number;   // rows skipped by ON CONFLICT DO NOTHING (already exist)
  rowsErrored: number;   // rows that failed with a DB error (type mismatch, FK violation, etc.)
  rowsRejected?: number; // rows rejected by an explicit per-column data policy
  offset: number;
  hasMore: boolean;
  error: string | null;
  // rollback support
  insertedPks: string[];    // first N inserted target PKs
  pkOverflow: boolean;      // true if > 5000 rows were inserted (list is partial)
  targetPkCol: string | null;
  // incremental sync
  newWatermark?: string | null; // max value of incrementalCol seen after this run
  newWatermarkPk?: string | null;
  /** In-run source pagination checkpoint; separate from the saved recurring watermark. */
  sourceCursorValue?: string | null;
  sourceCursorPk?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  readDurationMs?: number;
  writeDurationMs?: number;
  writerMethod?: 'copy-staging' | 'multi-row' | 'row-by-row';
  rowsPerSecond?: number | null;
  /** Consecutive transient infrastructure failures for bounded automatic retry. */
  transientRetryCount?: number;
  lastTransientErrorAt?: string | null;
}

export interface MigRunReject {
  tableId: string;
  sourceKey: string;
  targetKey: string;
  sourcePk: string | null;
  column: string | null;
  reason: 'null_not_allowed' | 'fallback_invalid' | 'row_skipped' | 'db_error';
  message: string;
  valuePreview: string | null;
  createdAt: string;
}

export interface MigRunIntegrityIssue {
  tableId: string;
  targetKey: string;
  kind: 'rejected_rows' | 'database_errors' | 'logical_fk_not_enforced';
  level: 'warning' | 'error';
  message: string;
}

export interface MigRun {
  id: string;
  jobId: string | null;
  jobName: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  restartedFromRunId?: string | null;
  // Version marker: absent runs may have used persistent ALTER TABLE trigger
  // changes and need legacy cleanup before resume.
  constraintBypassMode?: 'transaction';
  // Liveness: server-driven runs stamp this each advance loop. Used to detect
  // orphaned runs (process restart mid-run) so they can be resumed.
  heartbeatAt?: string | null;
  // true when a 'running' run was reconciled as orphaned (stale heartbeat).
  // Such runs are marked 'failed' but remain resumable from saved offsets.
  interrupted?: boolean;
  // Immutable execution controls captured when the run is created. Optional
  // only for backward compatibility with run files created before this field.
  executionPolicy?: RunExecutionPolicy;
  // store source/target meta (no passwords) for display
  sourceMeta: Omit<MigConn, 'password'>;
  targetMeta: Omit<MigConn, 'password'>;
  tables: TableMap[];          // mapping config snapshot
  tableStates: MigRunTableState[];
  logs: string[];
  totalRows: number;
  migratedRows: number;
  // Row-range filter snapshot (copied from job at run time)
  filterCol?: string | null;
  filterFrom?: string | null;
  filterTo?: string | null;
  errors: string[];
  /** Capped evidence, suitable for UI/export without persisting full source rows. */
  rejects?: MigRunReject[];
  integrityIssues?: MigRunIntegrityIssue[];
  performance?: {
    targetSeconds: number;
    requiredRowsPerSecond: number;
    actualRowsPerSecond: number | null;
    elapsedSeconds: number | null;
    meetsTarget: boolean | null;
  };
}
