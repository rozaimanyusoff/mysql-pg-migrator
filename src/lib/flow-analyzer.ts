// Converts business flow nodes into DataFlow objects.
// Pure rule-based — no AI required; quality scales with node metadata richness.

import type { CanvasNode, DataFlow, OperationType } from './flow-types';

const CREATE_OPS  = new Set<OperationType>(['CREATE', 'RECEIVE', 'ISSUE', 'ASSIGN']);
const UPDATE_OPS  = new Set<OperationType>(['UPDATE', 'APPROVE', 'REJECT', 'VERIFY', 'CANCEL', 'ARCHIVE', 'TRANSFER']);
const READ_OPS    = new Set<OperationType>(['READ']);
const DELETE_OPS  = new Set<OperationType>(['DELETE']);

// Infer operation from node label keywords when metadata.operationType is absent
function inferOperation(label: string, nodeType: string): OperationType {
  const l = label.toLowerCase();
  if (nodeType === 'approval') return 'APPROVE';
  if (/\b(creat|add|new|register|submit|open|initiat|start|generat|issu)\b/.test(l)) return 'CREATE';
  if (/\b(approv)\b/.test(l)) return 'APPROVE';
  if (/\b(reject|declin)\b/.test(l)) return 'REJECT';
  if (/\b(verif|check|review|inspect|audit)\b/.test(l)) return 'VERIFY';
  if (/\b(updat|edit|modif|chang|revise)\b/.test(l)) return 'UPDATE';
  if (/\b(delet|remov|purge)\b/.test(l)) return 'DELETE';
  if (/\b(cancel|abort|void)\b/.test(l)) return 'CANCEL';
  if (/\b(receiv|accept|collect)\b/.test(l)) return 'RECEIVE';
  if (/\b(transfer|move|ship|dispatch)\b/.test(l)) return 'TRANSFER';
  if (/\b(assign|allocat|designat)\b/.test(l)) return 'ASSIGN';
  if (/\b(archiv|close|complet|finaliz)\b/.test(l)) return 'ARCHIVE';
  if (/\b(read|view|list|search|get|fetch|load)\b/.test(l)) return 'READ';
  return 'UPDATE';
}

// Infer business object from label when metadata.businessObject is absent
function inferBusinessObject(label: string): string {
  // Strip common verbs to extract noun phrase
  const cleaned = label
    .replace(/^(create|add|new|register|submit|open|initiate|generate|issue|approve|reject|verify|update|edit|modify|change|delete|remove|cancel|receive|transfer|assign|archive|close|complete|finalize|review|inspect|check|get|list|search|view|read|fetch|load)\s+/i, '')
    .trim();
  // snake_case the remaining phrase
  return cleaned
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase() || 'record';
}

// Enrich outputData with standard inferred fields based on operation
function enrichOutput(
  base: string[],
  op: OperationType,
  obj: string,
  statusBefore?: string,
  statusAfter?: string,
  actor?: string,
): string[] {
  const fields = [...base];
  const objShort = obj.replace(/_+/g, '_').replace(/^_|_$/g, '');

  if (CREATE_OPS.has(op)) {
    if (!fields.some(f => f.endsWith('_ref_no') || f.endsWith('_no') || f.endsWith('_id') || f === 'id'))
      fields.unshift(`${objShort}_ref_no`);
    if (!fields.some(f => f.endsWith('_at') || f.endsWith('_date')))
      fields.push(`${objShort}_at`);
    if (actor && !fields.some(f => f.endsWith('_by')))
      fields.push(`${objShort}_by`);
    if (statusAfter && !fields.includes('status'))
      fields.push('status');
  }

  if (UPDATE_OPS.has(op)) {
    if (op === 'APPROVE') {
      if (!fields.includes('approval_status'))   fields.push('approval_status');
      if (!fields.includes('approved_by'))        fields.push('approved_by');
      if (!fields.includes('approved_at'))        fields.push('approved_at');
    } else if (op === 'REJECT') {
      if (!fields.includes('rejection_status'))  fields.push('rejection_status');
      if (!fields.includes('rejected_by'))        fields.push('rejected_by');
      if (!fields.includes('rejected_at'))        fields.push('rejected_at');
      if (!fields.includes('rejection_reason'))   fields.push('rejection_reason');
    } else if (op === 'VERIFY') {
      if (!fields.includes('verification_status')) fields.push('verification_status');
      if (!fields.includes('verified_by'))         fields.push('verified_by');
      if (!fields.includes('verified_at'))         fields.push('verified_at');
    } else if (op === 'CANCEL') {
      if (!fields.includes('cancelled_by'))   fields.push('cancelled_by');
      if (!fields.includes('cancelled_at'))   fields.push('cancelled_at');
      if (!fields.includes('cancel_reason'))  fields.push('cancel_reason');
      if (!fields.includes('status'))         fields.push('status');
    } else if (op === 'ARCHIVE') {
      if (!fields.includes('archived_by'))  fields.push('archived_by');
      if (!fields.includes('archived_at'))  fields.push('archived_at');
      if (!fields.includes('status'))       fields.push('status');
    }
    if (statusBefore && statusAfter) {
      if (!fields.includes('status')) fields.push('status');
    }
  }

  return fields;
}

export function analyzeFlow(nodes: CanvasNode[]): DataFlow[] {
  const results: DataFlow[] = [];
  let order = 0;

  // Preserve insertion order — skip purely structural nodes
  for (const node of nodes) {
    if (node.type === 'start' || node.type === 'end') continue;

    const meta   = node.data.metadata ?? {};
    const label  = node.data.label ?? '';
    const op     = meta.operationType ?? inferOperation(label, node.type);
    const obj    = meta.businessObject ?? inferBusinessObject(label);

    const baseOutput = (meta.outputData ?? []).filter(Boolean);
    const enriched   = enrichOutput(baseOutput, op, obj, meta.statusBefore, meta.statusAfter, meta.actor);

    const dataCreated:    string[] = [];
    const dataUpdated:    string[] = [];
    const dataReferenced: string[] = (meta.inputData ?? []).filter(Boolean);
    const dataDeleted:    string[] = [];

    if (CREATE_OPS.has(op))  dataCreated.push(...enriched);
    else if (DELETE_OPS.has(op)) dataDeleted.push(...enriched);
    else if (READ_OPS.has(op))   dataReferenced.push(...enriched);
    else                          dataUpdated.push(...enriched);

    results.push({
      nodeId:         node.id,
      nodeLabel:      label,
      businessObject: obj,
      operation:      op,
      dataCreated,
      dataUpdated,
      dataReferenced,
      dataDeleted,
      statusBefore:   meta.statusBefore || undefined,
      statusAfter:    meta.statusAfter  || undefined,
      actor:          meta.actor        || undefined,
      sortOrder:      order++,
    });
  }

  return results;
}
