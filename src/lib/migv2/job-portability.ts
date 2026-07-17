import type { MigJob, TableMap } from './types';

export const PORTABLE_JOB_FORMAT = 'mysql-pg-migrator.saved-job';
export const PORTABLE_JOB_VERSION = 1;

export interface PortableMigJob {
  format: typeof PORTABLE_JOB_FORMAT;
  formatVersion: typeof PORTABLE_JOB_VERSION;
  exportedAt: string;
  credentialsIncluded: false;
  job: MigJob;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function isConnectionMeta(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (value.type === 'mysql' || value.type === 'postgresql') &&
    typeof value.host === 'string' &&
    typeof value.port === 'number' && Number.isFinite(value.port) &&
    typeof value.database === 'string' &&
    typeof value.username === 'string';
}

function isColumnMap(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isStringOrNull(value.sourceCol) &&
    typeof value.targetCol === 'string' &&
    isStringOrNull(value.targetName) &&
    typeof value.targetType === 'string' &&
    typeof value.nullable === 'boolean' &&
    isStringOrNull(value.defaultValue) &&
    typeof value.include === 'boolean' &&
    typeof value.conversion === 'string' &&
    isStringOrNull(value.fkRef);
}

function isTableMap(value: unknown): value is TableMap {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.target)) return false;
  return typeof value.id === 'string' &&
    typeof value.include === 'boolean' &&
    typeof value.source.schema === 'string' &&
    typeof value.source.table === 'string' &&
    typeof value.target.schema === 'string' &&
    typeof value.target.table === 'string' &&
    Array.isArray(value.columns) && value.columns.every(isColumnMap) &&
    typeof value.truncateBeforeMigrate === 'boolean';
}

export function createPortableJob(job: MigJob): PortableMigJob {
  const tables = job.tables.map(table => {
    const portable = { ...table };
    delete portable.lastSyncedValue;
    delete portable.lastSyncedPk;
    return portable;
  });
  return {
    format: PORTABLE_JOB_FORMAT,
    formatVersion: PORTABLE_JOB_VERSION,
    exportedAt: new Date().toISOString(),
    credentialsIncluded: false,
    job: {
      ...job,
      tables,
      sourceMeta: {
        type: job.sourceMeta.type,
        host: job.sourceMeta.host,
        port: job.sourceMeta.port,
        database: job.sourceMeta.database,
        username: job.sourceMeta.username,
      },
      targetMeta: {
        type: job.targetMeta.type,
        host: job.targetMeta.host,
        port: job.targetMeta.port,
        database: job.targetMeta.database,
        username: job.targetMeta.username,
      },
    },
  };
}

export function parsePortableJob(value: unknown): MigJob {
  if (!isRecord(value) || value.format !== PORTABLE_JOB_FORMAT) {
    throw new Error('This is not a DB Migration saved-job export.');
  }
  if (value.formatVersion !== PORTABLE_JOB_VERSION) {
    throw new Error(`Unsupported saved-job format version: ${String(value.formatVersion)}.`);
  }
  if (!isRecord(value.job)) throw new Error('The exported job payload is missing.');

  const job = value.job;
  if (typeof job.name !== 'string' || !job.name.trim()) throw new Error('The saved job name is missing.');
  if (typeof job.description !== 'string') throw new Error('The saved job description is invalid.');
  if (!isConnectionMeta(job.sourceMeta) || !isConnectionMeta(job.targetMeta)) {
    throw new Error('The saved job connection metadata is invalid.');
  }
  if (!Array.isArray(job.tables) || !job.tables.every(isTableMap)) {
    throw new Error('The saved job contains invalid table or column mappings.');
  }

  // Only copy known fields. Connection passwords or arbitrary properties from a
  // hand-edited file must never enter saved-job storage.
  const sourceMeta = job.sourceMeta as JsonRecord;
  const targetMeta = job.targetMeta as JsonRecord;
  return {
    id: typeof job.id === 'string' ? job.id : '',
    name: job.name.trim(),
    description: job.description,
    version: typeof job.version === 'number' ? job.version : 0,
    createdAt: typeof job.createdAt === 'string' ? job.createdAt : '',
    updatedAt: typeof job.updatedAt === 'string' ? job.updatedAt : '',
    sourceMeta: {
      type: sourceMeta.type as 'mysql' | 'postgresql',
      host: sourceMeta.host as string,
      port: sourceMeta.port as number,
      database: sourceMeta.database as string,
      username: sourceMeta.username as string,
    },
    targetMeta: {
      type: targetMeta.type as 'mysql' | 'postgresql',
      host: targetMeta.host as string,
      port: targetMeta.port as number,
      database: targetMeta.database as string,
      username: targetMeta.username as string,
    },
    ...((job.mappingMode === 'copy_source' || job.mappingMode === 'existing_target' || job.mappingMode === 'per_table') && {
      mappingMode: job.mappingMode === 'per_table' ? 'existing_target' : job.mappingMode,
    }),
    ...((job.syncStrategy === 'incremental' || job.syncStrategy === 'full_upsert' || job.syncStrategy === 'full_insert') && { syncStrategy: job.syncStrategy }),
    ...(isRecord(job.initialRunOptions) && typeof job.initialRunOptions.skipConstraints === 'boolean' && {
      initialRunOptions: { skipConstraints: job.initialRunOptions.skipConstraints },
    }),
    tables: (job.tables as TableMap[]).map(table => {
      const portable = { ...table };
      delete portable.lastSyncedValue;
      delete portable.lastSyncedPk;
      return portable;
    }),
    ...(isStringOrNull(job.filterCol) && { filterCol: job.filterCol }),
    ...(isStringOrNull(job.filterFrom) && { filterFrom: job.filterFrom }),
    ...(isStringOrNull(job.filterTo) && { filterTo: job.filterTo }),
  };
}
