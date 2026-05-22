// Generates Drizzle ORM TypeScript schema from confirmed entities + relationships.

import type { FtdEntity, FtdRelationship, EntityField } from './flow-types';

function toCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
function toPascal(s: string): string {
  const c = toCamel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

// Map pgType → drizzle-orm/pg-core function call + import names
function drizzleCol(field: EntityField): { call: string; imports: string[] } {
  const n   = field.name;
  const t   = field.pgType.toUpperCase();

  if (t === 'BIGSERIAL') return {
    call: `bigserial('${n}', { mode: 'number' }).primaryKey()`,
    imports: ['bigserial'],
  };
  if (t === 'BIGINT') return {
    call: `bigint('${n}', { mode: 'number' })`,
    imports: ['bigint'],
  };
  if (t === 'INTEGER' || t === 'INT') return {
    call: `integer('${n}')`,
    imports: ['integer'],
  };
  if (t === 'BOOLEAN') return {
    call: `boolean('${n}')`,
    imports: ['boolean'],
  };
  if (t === 'TEXT') return {
    call: `text('${n}')`,
    imports: ['text'],
  };
  if (t === 'JSONB') return {
    call: `jsonb('${n}')`,
    imports: ['jsonb'],
  };
  if (t === 'DATE') return {
    call: `date('${n}')`,
    imports: ['date'],
  };
  if (t === 'TIMESTAMP' || t === 'TIMESTAMPTZ') return {
    call: `timestamp('${n}')`,
    imports: ['timestamp'],
  };
  if (t.startsWith('NUMERIC') || t.startsWith('DECIMAL')) {
    const m = t.match(/\((\d+),\s*(\d+)\)/);
    if (m) return {
      call: `numeric('${n}', { precision: ${m[1]}, scale: ${m[2]} })`,
      imports: ['numeric'],
    };
    return { call: `numeric('${n}')`, imports: ['numeric'] };
  }
  // VARCHAR / CHAR
  const vm = t.match(/(?:VARCHAR|CHAR)\((\d+)\)/);
  if (vm) return {
    call: `varchar('${n}', { length: ${vm[1]} })`,
    imports: ['varchar'],
  };
  return { call: `varchar('${n}')`, imports: ['varchar'] };
}

function modifiers(field: EntityField, entities: FtdEntity[]): string {
  const parts: string[] = [];
  if (!field.nullable && !field.isPk) parts.push('.notNull()');
  if (field.isUnique && !field.isPk) parts.push('.unique()');
  if (field.defaultValue) {
    const dv = field.defaultValue;
    if (dv === 'CURRENT_TIMESTAMP') parts.push('.defaultNow()');
    else if (dv === 'true' || dv === 'false') parts.push(`.default(${dv})`);
    else if (dv.startsWith("'")) parts.push(`.default(${dv})`);
    else parts.push(`.default(${dv})`);
  }
  if (field.isFk && field.fkRef && !field.isPk) {
    // fkRef format: "schema.table(col)"
    const m = field.fkRef.match(/\.(\w+)\((\w+)\)/);
    if (m) {
      const refVar = toCamel(m[1]);
      parts.push(`.references(() => ${refVar}.${toCamel(m[2])})`);
    }
  }
  return parts.join('');
}

// Build relations() block for a table
function relationsBlock(
  entity: FtdEntity,
  relationships: FtdRelationship[],
  entities: FtdEntity[],
): string | null {
  const confirmed = relationships.filter(r => r.confirmed && !r.rejected);
  const varName   = toCamel(entity.tableName);
  const lines: string[] = [];

  for (const rel of confirmed) {
    if (rel.sourceEntity === entity.tableName) {
      // one-to-many: this entity has many of target
      const targetVar   = toCamel(rel.targetEntity);
      const targetField = toCamel(rel.targetEntity); // field name in relations
      lines.push(`    ${targetField}: many(${targetVar}),`);
    }
    if (rel.targetEntity === entity.tableName && rel.foreignKeyColumn) {
      // many-to-one: this entity belongs to source
      const srcVar      = toCamel(rel.sourceEntity);
      const fieldCamel  = toCamel(rel.foreignKeyColumn);
      const srcId       = 'id';
      lines.push(
        `    ${srcVar}: one(${srcVar}, {`,
        `      fields: [${varName}.${fieldCamel}],`,
        `      references: [${srcVar}.${srcId}],`,
        `    }),`,
      );
    }
  }

  if (!lines.length) return null;

  const hasMany = confirmed.some(r => r.sourceEntity === entity.tableName);
  const hasOne  = confirmed.some(r => r.targetEntity === entity.tableName);
  const helpers = [hasOne ? 'one' : '', hasMany ? 'many' : ''].filter(Boolean).join(', ');

  return [
    `export const ${varName}Relations = relations(${varName}, ({ ${helpers} }) => ({`,
    ...lines,
    `}));`,
  ].join('\n');
}

export function generateDrizzle(
  entities:      FtdEntity[],
  relationships: FtdRelationship[],
): string {
  const confirmedEntities = entities.filter(e => e.confirmed && !e.rejected);
  if (!confirmedEntities.length) return '// No confirmed entities to generate schema from.';

  const schemaNames = [...new Set(confirmedEntities.map(e => e.schemaName))];
  const allImports  = new Set<string>(['pgSchema']);
  const needRelations = relationships.some(r => r.confirmed && !r.rejected);
  if (needRelations) allImports.add('relations');

  // Collect drizzle column imports
  for (const entity of confirmedEntities) {
    for (const field of entity.fields) {
      const { imports } = drizzleCol(field);
      imports.forEach(i => allImports.add(i));
    }
  }

  const lines: string[] = [];

  // Imports
  const pgCoreImports = [...allImports].filter(i => i !== 'relations').sort();
  lines.push(`import {`);
  lines.push(`  ${pgCoreImports.join(',\n  ')},`);
  lines.push(`} from 'drizzle-orm/pg-core';`);
  if (needRelations) {
    lines.push(`import { relations } from 'drizzle-orm';`);
  }
  lines.push('');

  // Schema declarations
  for (const schema of schemaNames) {
    lines.push(`export const ${toCamel(schema)} = pgSchema('${schema}');`);
  }
  lines.push('');

  // Table definitions
  for (const entity of confirmedEntities) {
    const schemaVar = toCamel(entity.schemaName);
    const tableVar  = toCamel(entity.tableName);
    if (entity.description) lines.push(`// ${entity.description}`);
    lines.push(`export const ${tableVar} = ${schemaVar}.table('${entity.tableName}', {`);
    for (const field of entity.fields) {
      const { call } = drizzleCol(field);
      const mods     = field.isPk ? '' : modifiers(field, confirmedEntities);
      lines.push(`  ${toCamel(field.name)}: ${call}${mods},`);
    }
    lines.push(`});`);
    lines.push('');
  }

  // Relations blocks
  if (needRelations) {
    for (const entity of confirmedEntities) {
      const block = relationsBlock(entity, relationships, confirmedEntities);
      if (block) { lines.push(block); lines.push(''); }
    }
  }

  return lines.join('\n').trim();
}
