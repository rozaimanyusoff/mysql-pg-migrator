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
  target: { schema: string; table: string };
  columns: ColumnMap[];
  truncateBeforeMigrate: boolean;
  // Incremental sync
  syncMode?: 'full' | 'incremental';
  incrementalCol?: string | null;            // source column used as high-water mark
  incrementalStrategy?: 'id' | 'timestamp'; // id = append-only insert; timestamp = upsert
  lastSyncedValue?: string | null;          // high-water mark from last completed run
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
}

export interface MigJobTableSummary {
  id: string;
  include: boolean;
  source: { schema: string; table: string };
  target: { schema: string; table: string };
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

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
export type TableRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';

export interface MigRunTableState {
  id: string;           // = tableMap.id
  sourceKey: string;    // "schema.table"
  targetKey: string;
  status: TableRunStatus;
  rowsSource: number;
  rowsMigrated: number;
  offset: number;
  hasMore: boolean;
  error: string | null;
  // rollback support
  insertedPks: string[];    // first N inserted target PKs
  pkOverflow: boolean;      // true if > 5000 rows were inserted (list is partial)
  targetPkCol: string | null;
  // incremental sync
  newWatermark?: string | null; // max value of incrementalCol seen after this run
}

export interface MigRun {
  id: string;
  jobId: string | null;
  jobName: string;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  // store source/target meta (no passwords) for display
  sourceMeta: Omit<MigConn, 'password'>;
  targetMeta: Omit<MigConn, 'password'>;
  tables: TableMap[];          // mapping config snapshot
  tableStates: MigRunTableState[];
  logs: string[];
  totalRows: number;
  migratedRows: number;
  errors: string[];
}
