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

export interface ColumnMap {
  sourceCol: string | null;  // null = target-only (new column not in source)
  targetCol: string;
  targetName: string | null; // null = keep targetCol name; string = rename in output
  targetType: string;        // target DB type string
  nullable: boolean;
  defaultValue: string | null;
  include: boolean;
  conversion: IdConversion;
  // For FK columns that point to a UUID-converted PK:
  // e.g. "public.users" means "look up seqToUUID('public.users', fk_value)"
  fkRef: string | null;
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
  columns: ColumnMap[];
  truncateBeforeMigrate: boolean;
  skipConstraints?: boolean;     // transaction-scoped PG constraint bypass during insert
  skipNullViolations?: boolean;  // DROP NOT NULL on target columns before insert, restore after
  targetAlias?: string | null;               // overrides target.table as the physical table name in SQL
  isSet?: boolean;             // user confirmed mapping is ready to run
  // Incremental sync
  syncMode?: 'full' | 'incremental';
  incrementalCol?: string | null;            // source column used as high-water mark
  incrementalStrategy?: 'id' | 'timestamp'; // id = append-only insert; timestamp = upsert
  incrementalTieCol?: string | null;         // unique source key for equal timestamp watermarks
  lastSyncedValue?: string | null;          // high-water mark from last completed run
  lastSyncedPk?: string | null;             // tie-breaker for equal timestamp watermarks
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export interface CronSchedule {
  id: string;
  jobId: string;
  jobName: string;          // denormalised for display
  cronExpr: string;         // standard 5-field: "0 2 * * *"
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  lastRunStatus: 'completed' | 'failed' | 'running' | 'paused' | null;
  lastRunId: string | null;
  notifyEmail?: string | null;   // email to notify on completion/failure (optional)
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
  incrementalCol?: string | null;
  lastSyncedValue?: string | null;
}

export interface MigJobSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  tableCount: number;
  tables: MigJobTableSummary[];
}

// ── Run ───────────────────────────────────────────────────────────────────────

export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'rolled_back' | 'aborted';
export type TableRunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'rolled_back' | 'aborted';

export interface MigRunTableState {
  id: string;           // = tableMap.id
  sourceKey: string;    // "schema.table"
  targetKey: string;
  status: TableRunStatus;
  rowsSource: number;
  rowsMigrated: number;  // rows actually written to target
  rowsSkipped: number;   // rows skipped by ON CONFLICT DO NOTHING (already exist)
  rowsErrored: number;   // rows that failed with a DB error (type mismatch, FK violation, etc.)
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
}
