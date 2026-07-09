import fs from 'fs';
import path from 'path';
import type { ConnCfg } from './sql-exporter';

export type MaintenanceObjectScope = 'db' | 'schema';
export type MaintenanceObjectAction = 'imported' | 'renamed' | 'moved' | 'copied' | 'created';

export interface MaintenanceObjectMeta {
  key: string;
  scope: MaintenanceObjectScope;
  database: string;
  schema?: string;
  updatedAt: string;
  action: MaintenanceObjectAction;
}

const META_PATH = path.join(process.cwd(), 'data', 'export-import-object-meta.json');

function ensureDir() {
  fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
}

function connectionKey(cfg: Pick<ConnCfg, 'db_type' | 'host' | 'port' | 'user'>): string {
  const port = cfg.port ?? (cfg.db_type === 'postgres' ? 5432 : 3306);
  return `${cfg.db_type}:${cfg.host}:${port}:${cfg.user}`;
}

export function maintenanceMetaKey(
  cfg: Pick<ConnCfg, 'db_type' | 'host' | 'port' | 'user'>,
  scope: MaintenanceObjectScope,
  database: string,
  schema?: string,
): string {
  const base = connectionKey(cfg);
  return scope === 'db'
    ? `${base}:db:${database}`
    : `${base}:schema:${database}:${schema ?? ''}`;
}

function readAll(): Record<string, MaintenanceObjectMeta> {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8')) as Record<string, MaintenanceObjectMeta>;
  } catch {
    return {};
  }
}

function writeAll(meta: Record<string, MaintenanceObjectMeta>) {
  ensureDir();
  const tmp = `${META_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, META_PATH);
}

export function markDbUpdated(cfg: ConnCfg, database: string, action: MaintenanceObjectAction) {
  const all = readAll();
  const key = maintenanceMetaKey(cfg, 'db', database);
  all[key] = { key, scope: 'db', database, updatedAt: new Date().toISOString(), action };
  writeAll(all);
}

export function markSchemaUpdated(cfg: ConnCfg, database: string, schema: string, action: MaintenanceObjectAction) {
  const all = readAll();
  const key = maintenanceMetaKey(cfg, 'schema', database, schema);
  all[key] = { key, scope: 'schema', database, schema, updatedAt: new Date().toISOString(), action };
  writeAll(all);
}

export function listMaintenanceMetadata(cfg: ConnCfg): Record<string, MaintenanceObjectMeta> {
  const prefix = connectionKey(cfg);
  const all = readAll();
  return Object.fromEntries(
    Object.entries(all).filter(([key]) => key.startsWith(`${prefix}:`)),
  );
}
