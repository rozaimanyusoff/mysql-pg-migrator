// ─── MySQL Inspection Types ───────────────────────────────────────────────────

export interface MySQLColumn {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  isPrimaryKey: boolean;
  isUnique: boolean;
  comment: string;
  characterSet: string | null;
  collation: string | null;
}

export interface MySQLIndex {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

export interface MySQLForeignKey {
  name: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  onUpdate: string;
  onDelete: string;
}

export interface MySQLTable {
  name: string;
  columns: MySQLColumn[];
  indexes: MySQLIndex[];
  foreignKeys: MySQLForeignKey[];
  rowCount: number;
  sizeMB: number;
  engine: string;
  collation: string;
  comment: string;
}

export interface InspectionResult {
  database: string;
  tables: MySQLTable[];
  inspectedAt: string;
}

// ─── Mapping Types ────────────────────────────────────────────────────────────

export type IndexStrategy = 'sequential' | 'uuid' | 'none';

export interface ColumnMapping {
  mysqlName: string;
  pgName: string;
  mysqlType: string;
  pgType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isUnique: boolean;
  indexStrategy: IndexStrategy;
  description: string;
  include: boolean;
}

export interface TableMapping {
  mysqlName: string;
  pgName: string;
  pgSchema: string;
  columns: ColumnMapping[];
  include: boolean;
  description: string;
}

export interface MigrationConfig {
  id: string;
  name: string;
  sourceDatabase: string;
  targetDatabase: string;
  status: 'draft' | 'ready' | 'migrating' | 'complete' | 'failed';
  createdAt: string;
  updatedAt: string;
  tables: TableMapping[];
}

// ─── Documentation & Dry Run Types ────────────────────────────────────────────

export interface MigrationSummary {
  totalTables: number;
  includedTables: number;
  totalColumns: number;
  totalIndexes: number;
  schemasToCreate: string[];
  estimatedStatements: number;
}

export interface DryRunResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  summary: MigrationSummary;
  sqlScript: string;
}

// ─── Phase 4: Migration Execution Types ──────────────────────────────────────

export interface PgConnectionConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

export type MigrationStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface MigrationStep {
  id: string;
  label: string;
  status: MigrationStepStatus;
  detail?: string;
  rowsMigrated?: number;
  rowsTotal?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface MigrationProgress {
  sessionId: string;
  status: 'idle' | 'running' | 'complete' | 'failed';
  steps: MigrationStep[];
  startedAt?: string;
  finishedAt?: string;
  log: string[];
}

export interface TableMigrationResult {
  tableName: string;
  pgTable: string;
  pgSchema: string;
  rowsMigrated: number;
  rowsInSource: number;
  success: boolean;
  error?: string;
}

export interface MigrationExecutionResult {
  success: boolean;
  schemasCreated: string[];
  tablesCreated: string[];
  tableResults: TableMigrationResult[];
  indexesCreated: number;
  totalRowsMigrated: number;
  errors: string[];
  warnings: string[];
  log: string[];
  startedAt: string;
  finishedAt: string;
}
