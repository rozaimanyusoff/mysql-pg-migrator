// Extracts candidate FtdEntity objects from analyzed DataFlow records.
// Rules are domain-agnostic — applies to any business process.

import type { DataFlow, FtdEntity, EntityField, EntityCategory } from './flow-types';

let _fieldId = 0;
function fid(): string { return `f${++_fieldId}`; }

// ─── Type inference from column name patterns ─────────────────────────────────

function inferPgType(name: string): string {
  const n = name.toLowerCase();
  if (n === 'id')                                      return 'BIGSERIAL';
  if (n.endsWith('_id') || n.endsWith('_by'))         return 'BIGINT';
  if (n.endsWith('_at') || n.endsWith('_date') || n.endsWith('_time')) return 'TIMESTAMP';
  if (n.endsWith('_ref_no') || n.endsWith('_no') || n.endsWith('_code') || n.endsWith('_ref'))
                                                        return 'VARCHAR(50)';
  if (n === 'name' || n.endsWith('_name') || n === 'title' || n.endsWith('_title') || n === 'label')
                                                        return 'VARCHAR(255)';
  if (n === 'description' || n === 'remarks' || n === 'notes' || n === 'comment' || n.endsWith('_reason'))
                                                        return 'TEXT';
  if (n === 'status' || n.endsWith('_status'))         return 'VARCHAR(30)';
  if (n === 'quantity' || n === 'qty' || n === 'count' || n === 'total_items')
                                                        return 'INTEGER';
  if (n === 'amount' || n === 'price' || n === 'cost' || n === 'value' || n === 'rate' || n === 'total')
                                                        return 'NUMERIC(15,2)';
  if (n === 'email' || n.endsWith('_email'))            return 'VARCHAR(255)';
  if (n === 'phone' || n.endsWith('_phone'))            return 'VARCHAR(20)';
  if (n === 'url'  || n.endsWith('_url'))               return 'TEXT';
  if (n.startsWith('is_') || n.startsWith('has_') || n === 'active' || n === 'enabled')
                                                        return 'BOOLEAN';
  if (n === 'metadata' || n === 'config' || n === 'data' || n === 'payload' || n === 'extra')
                                                        return 'JSONB';
  return 'VARCHAR(255)';
}

function isNullableByDefault(name: string, pgType: string): boolean {
  const n = name.toLowerCase();
  if (n === 'id')                   return false;
  if (n.endsWith('_at') && (n.startsWith('created') || n.startsWith('updated'))) return false;
  if (pgType === 'BIGSERIAL')       return false;
  // approval/rejection fields are optional by default (filled in later)
  if (n.startsWith('approved_') || n.startsWith('rejected_') || n.startsWith('verified_') ||
      n.startsWith('cancelled_') || n.startsWith('archived_'))
    return true;
  return true; // safe default — user can tighten
}

function defaultValueFor(name: string, pgType: string): string | undefined {
  const n = name.toLowerCase();
  if (n === 'created_at' || n === 'updated_at') return 'CURRENT_TIMESTAMP';
  if (n === 'status' || n.endsWith('_status'))  return "'pending'";
  if (pgType === 'BOOLEAN')                     return 'false';
  return undefined;
}

function buildField(rawName: string, extra?: Partial<EntityField>): EntityField {
  const name    = rawName.trim().replace(/\s+/g, '_').toLowerCase();
  const pgType  = inferPgType(name);
  const nullable = isNullableByDefault(name, pgType);
  const defVal   = defaultValueFor(name, pgType);

  return {
    id:           fid(),
    name,
    pgType,
    nullable,
    isPk:         name === 'id',
    isFk:         name.endsWith('_id') || name.endsWith('_by'),
    isUnique:     name.endsWith('_ref_no') || name.endsWith('_no') || name.endsWith('_code') || name === 'email',
    defaultValue: defVal,
    description:  '',
    ...extra,
  };
}

// ─── Standard field sets ───────────────────────────────────────────────────────

function pkField(): EntityField {
  return buildField('id', { isPk: true, isFk: false, nullable: false, pgType: 'BIGSERIAL' });
}

function auditFields(): EntityField[] {
  return [
    buildField('created_at', { nullable: false, pgType: 'TIMESTAMP', defaultValue: 'CURRENT_TIMESTAMP' }),
    buildField('updated_at', { nullable: false, pgType: 'TIMESTAMP', defaultValue: 'CURRENT_TIMESTAMP' }),
  ];
}

// ─── Classify entity category ─────────────────────────────────────────────────

function classifyCategory(
  tableName:  string,
  operations: Set<string>,
  isChild:    boolean,
  isLog:      boolean,
): EntityCategory {
  if (isLog)    return 'log';
  if (isChild)  return 'detail';
  const hasCreate = operations.has('CREATE') || operations.has('RECEIVE') || operations.has('ISSUE');
  const hasUpdate = operations.has('UPDATE') || operations.has('APPROVE') ||
                    operations.has('VERIFY') || operations.has('REJECT');
  if (hasCreate && hasUpdate) return 'transaction';
  if (hasCreate)              return 'transaction';
  if (tableName.endsWith('_types') || tableName.endsWith('_categories') ||
      tableName.endsWith('_statuses') || tableName.endsWith('_roles'))
    return 'master';
  return 'master';
}

// ─── Main extraction logic ────────────────────────────────────────────────────

export function extractEntities(flows: DataFlow[], schemaName: string): FtdEntity[] {
  // Group flows by businessObject
  const byObject = new Map<string, DataFlow[]>();
  for (const f of flows) {
    const key = f.businessObject.toLowerCase().replace(/\s+/g, '_');
    if (!byObject.has(key)) byObject.set(key, []);
    byObject.get(key)!.push(f);
  }

  const entities: FtdEntity[] = [];
  const entityNames = new Set<string>();
  let sortOrder = 0;

  // Always inject a `users` entity if actors are found
  const hasActors = flows.some(f => f.actor || f.dataCreated.some(d => d.endsWith('_by')) ||
                                     f.dataUpdated.some(d => d.endsWith('_by')));
  if (hasActors) {
    entityNames.add('users');
    entities.push({
      tableName:   'users',
      displayName: 'Users',
      category:    'master',
      description: 'System users — actors performing actions in the business process.',
      schemaName,
      confirmed:   false,
      rejected:    false,
      fields: [
        pkField(),
        buildField('name',       { nullable: false }),
        buildField('email',      { nullable: true, isUnique: true }),
        buildField('role',       { nullable: true, pgType: 'VARCHAR(50)' }),
        buildField('department', { nullable: true, pgType: 'VARCHAR(100)' }),
        buildField('is_active',  { nullable: false, pgType: 'BOOLEAN', defaultValue: 'true' }),
        ...auditFields(),
      ],
      sourceNodes: [],
      sortOrder: sortOrder++,
    });
  }

  // Check if any flows have approval/verify/reject steps → suggest status_logs
  const needsLog = flows.some(f =>
    ['APPROVE', 'REJECT', 'VERIFY', 'CANCEL', 'ARCHIVE'].includes(f.operation)
  );

  // Build one entity per unique businessObject
  for (const [objKey, objFlows] of byObject.entries()) {
    if (entityNames.has(objKey)) continue;
    entityNames.add(objKey);

    const operations  = new Set(objFlows.map(f => f.operation));
    const sourceNodes = objFlows.map(f => f.nodeId);

    // Collect all field names mentioned across all operations on this object
    const allFieldNames = new Set<string>();
    for (const f of objFlows) {
      [...f.dataCreated, ...f.dataUpdated].forEach(n => allFieldNames.add(n));
    }

    // Build fields — start with PK, then inferred columns, then audit
    const fieldMap = new Map<string, EntityField>();
    fieldMap.set('id', pkField());

    for (const fname of allFieldNames) {
      const normalized = fname.trim().toLowerCase().replace(/\s+/g, '_');
      if (!normalized || normalized === 'id') continue;
      if (!fieldMap.has(normalized)) {
        fieldMap.set(normalized, buildField(normalized));
      }
    }

    // Ensure audit fields exist
    if (!fieldMap.has('created_at')) fieldMap.set('created_at', auditFields()[0]);
    if (!fieldMap.has('updated_at')) fieldMap.set('updated_at', auditFields()[1]);

    const displayName = objKey
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const isChild = objFlows.some(f =>
      f.dataReferenced.length > 0 || f.dataCreated.some(d => d.endsWith('_id') && d !== 'id')
    );

    entities.push({
      tableName:   objKey,
      displayName,
      category:    classifyCategory(objKey, operations, isChild, false),
      description: `Stores ${displayName.toLowerCase()} records generated by the business process.`,
      schemaName,
      confirmed:   false,
      rejected:    false,
      fields:      [...fieldMap.values()],
      sourceNodes,
      sortOrder:   sortOrder++,
    });
  }

  // Inject status_logs entity if needed
  if (needsLog) {
    entities.push({
      tableName:   'status_logs',
      displayName: 'Status Logs',
      category:    'log',
      description: 'Tracks all status transitions and approval actions across business entities.',
      schemaName,
      confirmed:   false,
      rejected:    false,
      fields: [
        pkField(),
        buildField('entity_name', { nullable: false, pgType: 'VARCHAR(100)', description: 'Table name of the target entity' }),
        buildField('entity_id',   { nullable: false, pgType: 'BIGINT',       description: 'ID of the target record' }),
        buildField('old_status',  { nullable: true,  pgType: 'VARCHAR(30)',  defaultValue: undefined }),
        buildField('new_status',  { nullable: false, pgType: 'VARCHAR(30)' }),
        buildField('action',      { nullable: false, pgType: 'VARCHAR(50)',  description: 'e.g. APPROVE, REJECT, VERIFY' }),
        buildField('action_by',   { nullable: true,  pgType: 'BIGINT',       isFk: true }),
        buildField('action_at',   { nullable: false, pgType: 'TIMESTAMP',    defaultValue: 'CURRENT_TIMESTAMP' }),
        buildField('remarks',     { nullable: true,  pgType: 'TEXT' }),
      ],
      sourceNodes: [],
      sortOrder:   sortOrder++,
    });
  }

  return entities;
}
