import fs from 'fs/promises';
import path from 'path';
import { MigrationConfig, MigrationTemplate, MigrationTemplateSummary } from './types';

const TEMPLATE_DIR = path.join(process.cwd(), 'data', 'migration', 'templates');

function cleanId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'template';
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(TEMPLATE_DIR, { recursive: true });
}

function templatePath(id: string): string {
  return path.join(TEMPLATE_DIR, `${cleanId(id)}.json`);
}

export async function listTemplates(): Promise<MigrationTemplateSummary[]> {
  await ensureDir();
  const files = (await fs.readdir(TEMPLATE_DIR)).filter((f) => f.endsWith('.json'));
  const items: MigrationTemplateSummary[] = [];

  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(TEMPLATE_DIR, file), 'utf8');
      const t = JSON.parse(raw) as MigrationTemplate;
      items.push({
        id: t.id,
        name: t.name,
        description: t.description,
        version: t.version,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        tablesIncluded: t.config.tables.filter((x) => x.include).length,
      });
    } catch {
      // ignore bad template file
    }
  }

  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function loadTemplate(id: string): Promise<MigrationTemplate | null> {
  await ensureDir();
  try {
    const raw = await fs.readFile(templatePath(id), 'utf8');
    return JSON.parse(raw) as MigrationTemplate;
  } catch {
    return null;
  }
}

export async function saveTemplate(input: {
  id?: string;
  name: string;
  description?: string;
  config: MigrationConfig;
}): Promise<MigrationTemplate> {
  await ensureDir();

  const now = new Date().toISOString();
  const baseId = input.id ? cleanId(input.id) : cleanId(`${input.name}-${Date.now()}`);
  const existing = await loadTemplate(baseId);

  const template: MigrationTemplate = {
    id: baseId,
    name: input.name.trim() || 'Untitled Template',
    description: input.description?.trim() || '',
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    config: {
      ...input.config,
      updatedAt: now,
    },
  };

  await fs.writeFile(templatePath(baseId), JSON.stringify(template, null, 2), 'utf8');
  return template;
}
