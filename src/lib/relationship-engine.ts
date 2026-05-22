// Infers likely relationships between candidate entities.
// Purely rule-based: scans FK fields and naming conventions.

import type { FtdEntity, FtdRelationship, RelationshipType, Cardinality } from './flow-types';

let _relId = 0;
function tempId(): number { return --_relId; } // negative temp IDs, replaced on save

// Given a field name ending in _id/_by, guess the target table name
function fkTargetTable(fieldName: string, entityNames: Set<string>): string | null {
  // e.g. "user_id" → "users", "supplier_id" → "suppliers", "created_by" → "users"
  const n = fieldName.replace(/_id$|_by$/, '').toLowerCase();
  if (n === 'created' || n === 'updated' || n === 'approved' ||
      n === 'rejected' || n === 'verified' || n === 'action' ||
      n === 'cancelled' || n === 'archived' || n === 'requested' ||
      n === 'assigned' || n === 'submitted') {
    return entityNames.has('users') ? 'users' : null;
  }
  // Try plural then singular
  if (entityNames.has(n + 's')) return n + 's';
  if (entityNames.has(n))        return n;
  // Remove trailing 'e' for words like "purchase" → "purchases"
  if (entityNames.has(n + 'es')) return n + 'es';
  return null;
}

// Determine cardinality for a relationship
function cardinalityFor(
  sourceEntity: string,
  targetEntity: string,
  fieldName: string,
): Cardinality {
  // FK columns ending in _by are optional (action may not have happened yet)
  if (fieldName.endsWith('_by')) return 'optional';
  // FK to users is typically optional (nullable)
  if (targetEntity === 'users') return 'optional';
  return 'optional';
}

export function suggestRelationships(entities: FtdEntity[]): FtdRelationship[] {
  const relationships: FtdRelationship[] = [];
  const entityNames = new Set(entities.map(e => e.tableName));
  const seen = new Set<string>(); // dedup key

  for (const entity of entities) {
    for (const field of entity.fields) {
      if (!field.isFk && !field.name.endsWith('_id') && !field.name.endsWith('_by')) continue;
      if (field.isPk) continue;

      const target = fkTargetTable(field.name, entityNames);
      if (!target || target === entity.tableName) continue;

      const dedup = `${target}→${entity.tableName}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      const relType: RelationshipType = 'one_to_many';
      const cardinality = cardinalityFor(entity.tableName, target, field.name);

      const label = `One ${target.replace(/_/g, ' ')} has many ${entity.tableName.replace(/_/g, ' ')}`;

      relationships.push({
        id:               tempId(),
        sourceEntity:     target,
        targetEntity:     entity.tableName,
        relationshipType: relType,
        cardinality,
        label,
        foreignKeyColumn: field.name,
        confirmed:        false,
        rejected:         false,
      });
    }
  }

  // Detect potential many-to-many: if an entity has exactly 2 FK fields pointing to other entities
  // and little else (junction pattern), suggest an explicit M:N
  for (const entity of entities) {
    const fkFields = entity.fields.filter(f => (f.isFk || f.name.endsWith('_id')) && !f.isPk);
    if (fkFields.length < 2) continue;

    const targets = fkFields
      .map(f => fkTargetTable(f.name, entityNames))
      .filter(Boolean) as string[];

    const uniqueTargets = [...new Set(targets)];
    const nonFkNonAudit = entity.fields.filter(
      f => !f.isPk && !f.isFk && !f.name.endsWith('_at') && !f.name.endsWith('_id')
    );

    if (uniqueTargets.length >= 2 && nonFkNonAudit.length <= 3) {
      // Likely a junction — add M:N suggestion between the two main targets
      const [a, b] = uniqueTargets;
      const dedup  = `${a}↔${b}`;
      if (!seen.has(dedup)) {
        seen.add(dedup);
        relationships.push({
          id:               tempId(),
          sourceEntity:     a,
          targetEntity:     b,
          relationshipType: 'many_to_many',
          cardinality:      'optional',
          label:            `Many ${a.replace(/_/g, ' ')} ↔ many ${b.replace(/_/g, ' ')} via ${entity.tableName}`,
          foreignKeyColumn: entity.tableName,
          confirmed:        false,
          rejected:         false,
        });
      }
    }
  }

  return relationships;
}
