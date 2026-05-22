// Data dictionary builder and validation engine.

import type { FtdEntity, FtdRelationship, DictionaryEntry, ValidationIssue } from './flow-types';

// ─── Data Dictionary ──────────────────────────────────────────────────────────

export function buildDictionary(
  entities:      FtdEntity[],
  relationships: FtdRelationship[],
): DictionaryEntry[] {
  const confirmed = entities.filter(e => e.confirmed && !e.rejected);
  const entries: DictionaryEntry[] = [];

  for (const entity of confirmed) {
    for (const field of entity.fields) {
      // Find FK reference info
      const rel = relationships
        .filter(r => r.confirmed && !r.rejected)
        .find(r => r.targetEntity === entity.tableName && r.foreignKeyColumn === field.name);

      entries.push({
        tableName:         entity.tableName,
        tableCategory:     entity.category,
        tableDescription:  entity.description,
        columnName:        field.name,
        columnDescription: field.description ?? '',
        dataType:          field.pgType,
        nullable:          field.nullable,
        defaultValue:      field.defaultValue ?? '',
        isPk:              field.isPk,
        isFk:              field.isFk || !!rel,
        fkRef:             field.fkRef ?? (rel ? `${rel.sourceEntity}(id)` : ''),
        isUnique:          field.isUnique,
        checkConstraint:   field.checkConstraint ?? '',
        enumValues:        field.enumValues?.join(', ') ?? '',
        example:           field.example ?? '',
        businessMeaning:   field.businessMeaning ?? '',
      });
    }
  }

  return entries;
}

// ─── Validation Engine ────────────────────────────────────────────────────────

export function validateDesign(
  entities:      FtdEntity[],
  relationships: FtdRelationship[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const confirmed  = entities.filter(e => e.confirmed && !e.rejected);
  const confirmedR = relationships.filter(r => r.confirmed && !r.rejected);
  const entityNames = new Set(confirmed.map(e => e.tableName));

  for (const entity of confirmed) {
    // Missing PK
    if (!entity.fields.some(f => f.isPk)) {
      issues.push({
        severity: 'error',
        category: 'missing_pk',
        message:  `Table "${entity.tableName}" has no primary key defined.`,
        entityName: entity.tableName,
        resolved: false,
      });
    }

    // Missing audit fields on transaction/detail entities
    if (['transaction', 'detail'].includes(entity.category)) {
      if (!entity.fields.some(f => f.name === 'created_at')) {
        issues.push({
          severity: 'warning',
          category: 'missing_audit',
          message:  `Table "${entity.tableName}" is a ${entity.category} entity but has no created_at field.`,
          entityName: entity.tableName,
          resolved: false,
        });
      }
    }

    // Vague column names
    const vagueNames = ['data', 'info', 'detail', 'value', 'thing', 'item', 'entry', 'record'];
    for (const field of entity.fields) {
      if (vagueNames.includes(field.name)) {
        issues.push({
          severity: 'warning',
          category: 'vague_column',
          message:  `Column "${field.name}" in "${entity.tableName}" is too generic. Consider a more descriptive name.`,
          entityName: entity.tableName,
          fieldName:  field.name,
          resolved: false,
        });
      }
    }

    // Status field without default / check constraint
    const statusFields = entity.fields.filter(f => f.name === 'status' || f.name.endsWith('_status'));
    for (const sf of statusFields) {
      if (!sf.defaultValue && !sf.checkConstraint && (!sf.enumValues || !sf.enumValues.length)) {
        issues.push({
          severity: 'info',
          category: 'status_unconstrained',
          message:  `Status field "${sf.name}" in "${entity.tableName}" has no default value, CHECK constraint, or enum values defined.`,
          entityName: entity.tableName,
          fieldName:  sf.name,
          resolved: false,
        });
      }
    }

    // FK fields that don't point to any confirmed entity
    for (const field of entity.fields) {
      if (!field.isFk || field.isPk) continue;
      const hasRel = confirmedR.some(
        r => r.targetEntity === entity.tableName && r.foreignKeyColumn === field.name
      );
      if (!hasRel && !field.fkRef) {
        issues.push({
          severity: 'warning',
          category: 'unresolved_fk',
          message:  `Column "${field.name}" in "${entity.tableName}" looks like a foreign key but has no confirmed relationship.`,
          entityName: entity.tableName,
          fieldName:  field.name,
          resolved: false,
        });
      }
    }
  }

  // Isolated tables (no relationships)
  if (confirmed.length > 1) {
    for (const entity of confirmed) {
      const connected = confirmedR.some(
        r => r.sourceEntity === entity.tableName || r.targetEntity === entity.tableName
      );
      if (!connected) {
        issues.push({
          severity: 'warning',
          category: 'isolated_table',
          message:  `Table "${entity.tableName}" has no confirmed relationships with other tables.`,
          entityName: entity.tableName,
          resolved: false,
        });
      }
    }
  }

  // Many-to-many without junction table
  for (const rel of confirmedR) {
    if (rel.relationshipType !== 'many_to_many') continue;
    const junctionName = rel.foreignKeyColumn; // reused to store junction table name
    if (!junctionName || !entityNames.has(junctionName)) {
      issues.push({
        severity: 'warning',
        category: 'missing_junction',
        message:  `Many-to-many relationship between "${rel.sourceEntity}" and "${rel.targetEntity}" has no junction table confirmed.`,
        resolved: false,
      });
    }
  }

  // Duplicate entity names
  const seen = new Set<string>();
  for (const entity of confirmed) {
    if (seen.has(entity.tableName)) {
      issues.push({
        severity: 'error',
        category: 'duplicate_entity',
        message:  `Duplicate table name "${entity.tableName}" detected.`,
        entityName: entity.tableName,
        resolved: false,
      });
    }
    seen.add(entity.tableName);
  }

  return issues;
}
