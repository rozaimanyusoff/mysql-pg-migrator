// ─── Shared types for Flow-to-Database Designer ───────────────────────────────

export type NodeType = 'start' | 'process' | 'decision' | 'approval' | 'data_object' | 'end';

export type OperationType =
  | 'CREATE' | 'READ' | 'UPDATE' | 'DELETE'
  | 'APPROVE' | 'REJECT' | 'VERIFY' | 'ASSIGN'
  | 'TRANSFER' | 'RECEIVE' | 'ISSUE' | 'CANCEL' | 'ARCHIVE';

export type EntityCategory =
  | 'master' | 'transaction' | 'detail' | 'junction' | 'log' | 'audit' | 'config';

export type RelationshipType = 'one_to_one' | 'one_to_many' | 'many_to_many';
export type Cardinality      = 'optional' | 'mandatory';
export type ValidationSeverity = 'error' | 'warning' | 'info';

// ─── Canvas ───────────────────────────────────────────────────────────────────

export interface NodeMetadata {
  actor?:             string;
  action?:            string;
  businessObject?:    string;
  operationType?:     OperationType;
  inputData?:         string[];   // fields coming in / referenced
  outputData?:        string[];   // fields produced or updated
  statusBefore?:      string;
  statusAfter?:       string;
  decisionCondition?: string;
  relatedDocument?:   string;
  remarks?:           string;
}

export interface FlowNodeData {
  label:    string;
  metadata: NodeMetadata;
}

export interface CanvasEdge {
  id:       string;
  source:   string;
  target:   string;
  label?:   string;
}

export interface CanvasNode {
  id:       string;
  type:     NodeType;
  position: { x: number; y: number };
  data:     FlowNodeData;
}

// ─── Data Flow ────────────────────────────────────────────────────────────────

export interface DataFlow {
  nodeId:         string;
  nodeLabel:      string;
  businessObject: string;
  operation:      string;
  dataCreated:    string[];
  dataUpdated:    string[];
  dataReferenced: string[];
  dataDeleted:    string[];
  statusBefore?:  string;
  statusAfter?:   string;
  actor?:         string;
  sortOrder:      number;
}

// ─── Entity / Field ───────────────────────────────────────────────────────────

export interface EntityField {
  id:               string;
  name:             string;       // snake_case column name
  pgType:           string;       // e.g. VARCHAR(255), BIGINT, TIMESTAMP
  nullable:         boolean;
  isPk:             boolean;
  isFk:             boolean;
  fkRef?:           string;       // "schema.table(col)"
  isUnique:         boolean;
  defaultValue?:    string;
  checkConstraint?: string;
  enumValues?:      string[];
  description?:     string;
  example?:         string;
  businessMeaning?: string;
}

export interface FtdEntity {
  id?:         number;
  tableName:   string;             // snake_case table name
  displayName: string;
  category:    EntityCategory;
  description: string;
  schemaName:  string;
  confirmed:   boolean;
  rejected:    boolean;
  fields:      EntityField[];
  sourceNodes: string[];
  sortOrder:   number;
}

// ─── Relationships ────────────────────────────────────────────────────────────

export interface FtdRelationship {
  id?:               number;
  sourceEntity:      string;
  targetEntity:      string;
  relationshipType:  RelationshipType;
  cardinality:       Cardinality;
  label?:            string;
  foreignKeyColumn?: string;
  confirmed:         boolean;
  rejected:          boolean;
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface ValidationIssue {
  id?:         number;
  severity:    ValidationSeverity;
  category:    string;
  message:     string;
  entityName?: string;
  fieldName?:  string;
  resolved:    boolean;
}

// ─── Data Dictionary ──────────────────────────────────────────────────────────

export interface DictionaryEntry {
  tableName:        string;
  tableCategory:    string;
  tableDescription: string;
  columnName:       string;
  columnDescription:string;
  dataType:         string;
  nullable:         boolean;
  defaultValue:     string;
  isPk:             boolean;
  isFk:             boolean;
  fkRef:            string;
  isUnique:         boolean;
  checkConstraint:  string;
  enumValues:       string;
  example:          string;
  businessMeaning:  string;
}

// ─── Project ──────────────────────────────────────────────────────────────────

export interface FtdProject {
  id:           number;
  name:         string;
  description:  string;
  domain:       string;
  schema_name:  string;  // DB column name (snake_case)
  schemaName?:  string;  // alias — optional for backwards compat
  status:       string;
  created_at:   string;
  updated_at:   string;
}
