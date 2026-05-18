import fs from 'fs/promises';
import path from 'path';

export interface MysqlSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface PostgresSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
}

export interface AppSettings {
  mysql: MysqlSettings;
  postgres: PostgresSettings;
  updatedAt: string;
}

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'settings.json');

const DEFAULTS: AppSettings = {
  mysql: { host: 'localhost', port: 3306, user: '', password: '', database: '' },
  postgres: { host: 'localhost', port: 5432, user: '', password: '', database: '', ssl: false },
  updatedAt: '',
};

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      mysql: { ...DEFAULTS.mysql, ...(parsed.mysql ?? {}) },
      postgres: { ...DEFAULTS.postgres, ...(parsed.postgres ?? {}) },
      updatedAt: parsed.updatedAt ?? '',
    };
  } catch {
    return { ...DEFAULTS, mysql: { ...DEFAULTS.mysql }, postgres: { ...DEFAULTS.postgres } };
  }
}

export async function saveSettings(patch: { mysql?: Partial<MysqlSettings>; postgres?: Partial<PostgresSettings> }): Promise<AppSettings> {
  const current = await loadSettings();
  const updated: AppSettings = {
    mysql: { ...current.mysql, ...(patch.mysql ?? {}) },
    postgres: { ...current.postgres, ...(patch.postgres ?? {}) },
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}
