// Generates PostgreSQL DDL from confirmed entities + relationships.

import type { FtdEntity, FtdRelationship } from './flow-types';

function colLine(
  name: string,
  pgType: string,
  nullable: boolean,
  isPk: boolean,
  isUnique: boolean,
  defaultValue?: string,
  checkConstraint?: string,
): string {
  const parts: string[] = [`  ${name}`, pgType];
  if (isPk) {
    parts.push('PRIMARY KEY');
  } else {
    if (!nullable) parts.push('NOT NULL');
    if (isUnique)  parts.push('UNIQUE');
    if (defaultValue) parts.push(`DEFAULT ${defaultValue}`);
    if (checkConstraint) parts.push(`CHECK (${checkConstraint})`);
  }
  return parts.join(' ');
}

// Build FK constraint lines from relationship data
function fkConstraints(entity: FtdEntity, relationships: FtdRelationship[], schemaName: string): string[] {
  const confirmed = relationships.filter(r => r.confirmed && !r.rejected);
  const lines: string[] = [];

  for (const rel of confirmed) {
    if (rel.targetEntity !== entity.tableName) continue;
    if (!rel.foreignKeyColumn) continue;
    const fkCol    = rel.foreignKeyColumn;
    const refTable = `${schemaName}.${rel.sourceEntity}`;
    lines.push(`  CONSTRAINT fk_${entity.tableName}_${fkCol} FOREIGN KEY (${fkCol}) REFERENCES ${refTable}(id)`);
  }

  // Also handle FK fields in the entity itself that aren't covered by relationships
  for (const field of entity.fields) {
    if (!field.isFk || field.isPk) continue;
    if (field.fkRef) {
      // explicit fkRef set by user
      lines.push(`  CONSTRAINT fk_${entity.tableName}_${field.name} FOREIGN KEY (${field.name}) REFERENCES ${field.fkRef}`);
    }
  }

  return lines;
}

export function generateDDL(
  entities:      FtdEntity[],
  relationships: FtdRelationship[],
): string {
  const schemaNames = [...new Set(entities.map(e => e.schemaName))];
  const lines: string[] = [];

  // Schema declarations
  for (const schema of schemaNames) {
    lines.push(`CREATE SCHEMA IF NOT EXISTS ${schema};`, '');
  }

  const confirmedEntities = entities.filter(e => e.confirmed && !e.rejected);

  for (const entity of confirmedEntities) {
    const schema    = entity.schemaName;
    const tablePath = `${schema}.${entity.tableName}`;

    if (entity.description) {
      lines.push(`-- ${entity.description}`);
    }
    lines.push(`CREATE TABLE IF NOT EXISTS ${tablePath} (`);

    const colLines: string[] = [];
    for (const field of entity.fields) {
      colLines.push(colLine(
        field.name,
        field.pgType,
        field.nullable,
        field.isPk,
        field.isUnique,
        field.defaultValue,
        field.checkConstraint,
      ));
    }

    const fkLines = fkConstraints(entity, relationships, schema);
    const allLines = [...colLines, ...fkLines];

    lines.push(allLines.map((l, i) => l + (i < allLines.length - 1 ? ',' : '')).join('\n'));
    lines.push(');', '');

    // Indexes on FK columns (not handled by constraints above)
    for (const field of entity.fields) {
      if ((field.isFk || field.name.endsWith('_id') || field.name.endsWith('_by')) && !field.isPk) {
        lines.push(
          `CREATE INDEX IF NOT EXISTS idx_${entity.tableName}_${field.name}` +
          ` ON ${tablePath} (${field.name});`
        );
      }
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
