'use client';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  ArrowLeft, Plus, Trash2, Play, Copy, Check, RefreshCw, ChevronRight,
  ChevronLeft, Download, Save, Loader2, X, Edit3, AlertTriangle,
  CheckCircle2, XCircle, Info, Database, GitBranch, Table2, Workflow,
  FileCode2, FileText, BookOpen, Network, Layers, Settings2,
  ArrowRight, LayoutDashboard,
} from 'lucide-react';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  Handle, Position, type Node, type Edge, type Connection,
  useReactFlow, ReactFlowProvider, MarkerType,
  BaseEdge, getSmoothStepPath, type EdgeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAuth } from '../lib/auth-context';
import type {
  FtdProject, FtdEntity, FtdRelationship,
  EntityField, ValidationIssue, DictionaryEntry, NodeMetadata, NodeType,
} from '../lib/flow-types';

// Raw DB row shape for data flows (snake_case from PostgreSQL)
interface DbDataFlow {
  id?: number;
  project_id?: number;
  node_id?: string;
  node_label?: string;
  business_object?: string;
  operation?: string;
  data_created?: string[];
  data_updated?: string[];
  data_referenced?: string[];
  data_deleted?: string[];
  status_before?: string;
  status_after?: string;
  actor?: string;
  sort_order?: number;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4 | 5 | 6;

interface RfNodeData { label: string; metadata: NodeMetadata; nodeType: NodeType; [key: string]: unknown }

// ─── Canvas: Custom node shapes ───────────────────────────────────────────────

function StartNode({ data }: { data: RfNodeData }) {
  return (
    <div className="flex items-center justify-center w-20 h-20 rounded-full bg-emerald-500 border-2 border-emerald-600 shadow-lg text-white font-bold text-sm select-none">
      Start
      <Handle type="source" position={Position.Bottom} className="!bg-emerald-700 !w-3 !h-3" />
    </div>
  );
}

function EndNode({ data }: { data: RfNodeData }) {
  return (
    <div className="flex items-center justify-center w-20 h-20 rounded-full bg-rose-500 border-2 border-rose-600 shadow-lg text-white font-bold text-sm select-none">
      End
      <Handle type="target" position={Position.Top} className="!bg-rose-700 !w-3 !h-3" />
    </div>
  );
}

function ProcessNode({ data, selected }: { data: RfNodeData; selected?: boolean }) {
  return (
    <div className={`min-w-[160px] max-w-[220px] rounded-lg border-2 shadow-md bg-blue-50 dark:bg-blue-950 select-none
        ${selected ? 'border-blue-500 ring-2 ring-blue-300 dark:ring-blue-600' : 'border-blue-300 dark:border-blue-700'}`}>
      <Handle type="target" position={Position.Top}    className="!bg-blue-500 !w-3 !h-3" />
      <div className="px-3 py-2 bg-blue-500 text-white text-xs font-semibold rounded-t-md">Process</div>
      <div className="px-3 py-2 text-xs font-medium text-blue-900 dark:text-blue-100 leading-tight">{data.label}</div>
      {data.metadata?.businessObject && (
        <div className="px-3 pb-2 text-[10px] text-blue-600 dark:text-blue-400 italic">{data.metadata.businessObject}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-blue-500 !w-3 !h-3" />
    </div>
  );
}

function DecisionNode({ data, selected }: { data: RfNodeData; selected?: boolean }) {
  const W = 160, H = 84;
  // Diamond tips sit exactly at midpoints of the bounding box edges — same as default Handle positions
  const pts = `${W / 2},2 ${W - 2},${H / 2} ${W / 2},${H - 2} 2,${H / 2}`;
  const fill   = selected ? '#451a03' : '#1c0a00';
  const stroke = selected ? '#fbbf24' : '#f59e0b';
  return (
    <div style={{ width: W, height: H, position: 'relative' }} className="select-none">
      {/* Handles at true diamond tips (default positions = midpoints of bounding box = diamond vertices) */}
      <Handle type="target" position={Position.Top}    className="!bg-amber-400 !w-3 !h-3 !border-2 !border-amber-700" />
      <Handle type="source" position={Position.Bottom} className="!bg-amber-400 !w-3 !h-3 !border-2 !border-amber-700" />
      <Handle type="source" position={Position.Right}  className="!bg-amber-400 !w-3 !h-3 !border-2 !border-amber-700" id="yes" />
      <Handle type="source" position={Position.Left}   className="!bg-amber-400 !w-3 !h-3 !border-2 !border-amber-700" id="no"  />
      {/* SVG diamond — no rotation tricks, pure polygon */}
      <svg width={W} height={H} style={{ position: 'absolute', top: 0, left: 0 }}>
        <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={selected ? 2.5 : 2} />
      </svg>
      {/* Label centered over diamond */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1 }}
        className="text-xs font-semibold text-amber-300 text-center leading-tight px-8">
        {data.label}
      </div>
    </div>
  );
}

function ApprovalNode({ data, selected }: { data: RfNodeData; selected?: boolean }) {
  return (
    <div className={`min-w-[160px] max-w-[220px] rounded-xl border-2 shadow-md bg-purple-50 dark:bg-purple-950 select-none
        ${selected ? 'border-purple-500 ring-2 ring-purple-300 dark:ring-purple-600' : 'border-purple-300 dark:border-purple-700'}`}>
      <Handle type="target" position={Position.Top}    className="!bg-purple-500 !w-3 !h-3" />
      <div className="px-3 py-2 bg-purple-500 text-white text-xs font-semibold rounded-t-xl">Approval</div>
      <div className="px-3 py-2 text-xs font-medium text-purple-900 dark:text-purple-100 leading-tight">{data.label}</div>
      {data.metadata?.actor && (
        <div className="px-3 pb-2 text-[10px] text-purple-600 dark:text-purple-400">by {data.metadata.actor}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!bg-purple-500 !w-3 !h-3" />
    </div>
  );
}

function DataObjectNode({ data, selected }: { data: RfNodeData; selected?: boolean }) {
  return (
    <div className={`min-w-[140px] max-w-[200px] rounded border-2 shadow-md bg-cyan-50 dark:bg-cyan-950 select-none
        ${selected ? 'border-cyan-500 ring-2 ring-cyan-300' : 'border-cyan-300 dark:border-cyan-700'}`}
      style={{ borderRadius: '4px 4px 0 0' }}>
      <Handle type="target" position={Position.Top}    className="!bg-cyan-500 !w-3 !h-3" />
      <div className="px-3 py-2 bg-cyan-500 text-white text-xs font-semibold">Data Object</div>
      <div className="px-3 py-2 text-xs font-medium text-cyan-900 dark:text-cyan-100">{data.label}</div>
      <Handle type="source" position={Position.Bottom} className="!bg-cyan-500 !w-3 !h-3" />
    </div>
  );
}

const nodeTypes = { start: StartNode, end: EndNode, process: ProcessNode, decision: DecisionNode, approval: ApprovalNode, data_object: DataObjectNode };

// ─── ERD custom node ──────────────────────────────────────────────────────────

function ErdTableNode({ data }: { data: { entity: FtdEntity } }) {
  const e = data.entity;
  const catColor: Record<string, string> = {
    master: 'bg-green-600', transaction: 'bg-blue-600', detail: 'bg-sky-500',
    junction: 'bg-violet-600', log: 'bg-orange-500', audit: 'bg-gray-500', config: 'bg-teal-600',
  };
  return (
    <div className="min-w-[200px] max-w-[260px] rounded-lg border border-gray-300 dark:border-slate-600 shadow-lg bg-white dark:bg-slate-800 text-xs">
      <Handle type="target" position={Position.Left}   className="!bg-slate-400 !w-2 !h-2" />
      <Handle type="source" position={Position.Right}  className="!bg-slate-400 !w-2 !h-2" />
      <div className={`px-3 py-1.5 ${catColor[e.category] ?? 'bg-slate-600'} text-white font-bold rounded-t-lg flex items-center gap-1`}>
        <Table2 size={10} />
        <span>{e.schemaName}.{e.tableName}</span>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-700">
        {e.fields.map(f => (
          <div key={f.id} className="flex items-center gap-1 px-2 py-0.5">
            <span className={`w-4 text-center font-bold ${f.isPk ? 'text-amber-500' : f.isFk ? 'text-blue-400' : 'text-transparent'}`}>
              {f.isPk ? 'PK' : f.isFk ? 'FK' : ''}
            </span>
            <span className={`flex-1 ${f.isPk ? 'font-semibold' : ''} text-gray-800 dark:text-slate-200`}>{f.name}</span>
            <span className="text-gray-400 dark:text-slate-500 text-[10px]">{f.pgType}</span>
            {!f.nullable && <span className="text-rose-400 text-[9px]">*</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const erdNodeTypes = { erd_table: ErdTableNode };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid(): string { return `n${Date.now()}_${Math.random().toString(36).slice(2, 7)}`; }

const OPERATION_TYPES = ['CREATE','READ','UPDATE','DELETE','APPROVE','REJECT','VERIFY','ASSIGN','TRANSFER','RECEIVE','ISSUE','CANCEL','ARCHIVE'];
const ENTITY_CATEGORIES = ['master','transaction','detail','junction','log','audit','config'];
const PG_TYPES = ['BIGSERIAL','BIGINT','INTEGER','SMALLINT','VARCHAR(50)','VARCHAR(100)','VARCHAR(255)','TEXT','BOOLEAN','NUMERIC(15,2)','TIMESTAMP','DATE','JSONB'];

function copyToClipboard(text: string, setCopied: (v: boolean) => void) {
  navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
}

// ─── FieldHint — "?" popover for metadata field labels ───────────────────────

const FIELD_HINTS: Record<string, { title: string; body: string; examples: { domain: string; node: string; values: string[] }[] }> = {
  outputData: {
    title: 'Output / Produced Data',
    body: 'Fields that this step CREATES or UPDATES in the database. The system turns these into columns in the entity table. Write one field name per line in snake_case.',
    examples: [
      { domain: 'Procurement',  node: 'Create Purchase Request', values: ['request_ref_no', 'requested_by', 'requested_at', 'department', 'status'] },
      { domain: 'HR',           node: 'Submit Leave Application', values: ['leave_ref_no', 'leave_type', 'start_date', 'end_date', 'reason'] },
      { domain: 'Healthcare',   node: 'Register Patient',         values: ['patient_no', 'full_name', 'ic_no', 'date_of_birth', 'contact_no'] },
      { domain: 'Finance',      node: 'Create Invoice',           values: ['invoice_no', 'due_date', 'total_amount', 'tax_amount', 'status'] },
      { domain: 'Approval step (UPDATE)', node: 'Approve Request', values: ['approval_status', 'approved_by', 'approved_at', 'approval_remarks'] },
    ],
  },
  inputData: {
    title: 'Input / Referenced Data',
    body: 'Fields that this step READS or REQUIRES from another entity or a previous step. The system turns these into foreign key columns (e.g. purchase_id → FK to purchase_requests table). Write one field name per line.',
    examples: [
      { domain: 'Procurement',  node: 'Add Purchase Items',  values: ['purchase_id', 'item_id'] },
      { domain: 'HR',           node: 'Approve Leave',       values: ['leave_id', 'approver_id'] },
      { domain: 'Healthcare',   node: 'Book Appointment',    values: ['patient_id', 'doctor_id', 'slot_id'] },
      { domain: 'Finance',      node: 'Record Payment',      values: ['invoice_id', 'account_id', 'payment_method_id'] },
      { domain: 'Education',    node: 'Enroll Subject',      values: ['student_id', 'subject_id', 'semester_id'] },
    ],
  },
};

function FieldHint({ field }: { field: 'outputData' | 'inputData' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos]   = useState({ top: 0, right: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const hint = FIELD_HINTS[field];

  function handleOpen(e: React.MouseEvent) {
    e.stopPropagation();
    if (!open && btnRef.current) {
      const r       = btnRef.current.getBoundingClientRect();
      const POP_W   = 288;
      const POP_H   = 420; // conservative estimate
      const GAP     = 8;

      // Horizontal: prefer right-aligned to button; clamp so it never goes off left edge
      const rightFromEdge = window.innerWidth - r.right;
      const leftIfRightAligned = r.right - POP_W;
      const clampedRight = leftIfRightAligned < 8
        ? window.innerWidth - Math.min(POP_W + 8, window.innerWidth - 8)
        : rightFromEdge;

      // Vertical: open downward if room, otherwise open upward
      const spaceBelow = window.innerHeight - r.bottom - GAP;
      const openDown   = spaceBelow >= POP_H || spaceBelow >= window.innerHeight / 2;

      setPos({
        top:    openDown ? r.bottom + GAP : Math.max(8, r.top - POP_H - GAP),
        right:  clampedRight,
      });
    }
    setOpen(o => !o);
  }

  return (
    <span className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={handleOpen}
        className="ml-1 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-gray-300 dark:bg-slate-600 text-gray-600 dark:text-slate-300 text-[9px] font-bold leading-none hover:bg-blue-400 hover:text-white dark:hover:bg-blue-500 transition-colors align-middle"
        title="What is this?"
      >?</button>
      {open && (
        <>
          {/* backdrop */}
          <span className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          {/* popover — fixed so it escapes overflow:hidden parents */}
          <span
            style={{ top: pos.top, right: pos.right, width: 288, maxHeight: 'calc(100vh - 32px)' }}
            className="fixed z-[9999] rounded-xl border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 shadow-2xl p-3 flex flex-col gap-2 text-left overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <span className="font-semibold text-xs text-gray-800 dark:text-slate-100">{hint.title}</span>
            <span className="text-[11px] text-gray-600 dark:text-slate-300 leading-relaxed">{hint.body}</span>
            <span className="border-t border-gray-100 dark:border-slate-700 pt-2">
              <span className="block text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide mb-1.5">Examples</span>
              {hint.examples.map(ex => (
                <span key={ex.domain} className="block mb-1.5">
                  <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400">{ex.domain}</span>
                  <span className="text-[10px] text-gray-400 dark:text-slate-500"> — {ex.node}</span>
                  <span className="flex flex-wrap gap-1 mt-0.5">
                    {ex.values.map(v => (
                      <code key={v} className="px-1 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-[10px] text-gray-700 dark:text-slate-300">{v}</code>
                    ))}
                  </span>
                </span>
              ))}
            </span>
          </span>
        </>
      )}
    </span>
  );
}

function catBadge(cat: string) {
  const cls: Record<string,string> = {
    master: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    transaction: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    detail: 'bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300',
    junction: 'bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300',
    log: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300',
    audit: 'bg-gray-100 text-gray-700 dark:bg-gray-900/40 dark:text-gray-300',
    config: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  };
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${cls[cat] ?? 'bg-gray-100 text-gray-600'}`}>{cat}</span>;
}

// ─── Step indicator ───────────────────────────────────────────────────────────

const STEPS = [
  { n: 1, label: 'Business Flow', icon: Workflow },
  { n: 2, label: 'Data Flow',     icon: GitBranch },
  { n: 3, label: 'Entities',      icon: Table2 },
  { n: 4, label: 'Relationships', icon: Network },
  { n: 5, label: 'ERD',           icon: LayoutDashboard },
  { n: 6, label: 'Outputs',       icon: FileCode2 },
];

// ─── Guide ────────────────────────────────────────────────────────────────────

const FTD_GUIDE_SECTIONS = [
  {
    title: 'How it works',
    icon: '①',
    color: 'text-blue-600 dark:text-blue-400',
    body: [
      'Draw your business process on the canvas (Step 1). Add nodes for each activity, decision, approval, or data object. Fill in the metadata panel on the right for each node.',
      'Click Analyse Flow — the system extracts data flows, suggests entities, infers column types, and proposes FK/M:N relationships automatically.',
      'Review and confirm entities (Step 3) and relationships (Step 4), then generate the ERD (Step 5) and export PostgreSQL DDL + Drizzle ORM schema (Step 6).',
    ],
  },
  {
    title: 'Node types',
    icon: '②',
    color: 'text-violet-600 dark:text-violet-400',
    body: [
      'Start / End — mark the entry and exit points of the process. Not analysed for data.',
      'Process — a discrete activity (e.g. "Submit Purchase Request"). Most entity inference comes from process nodes.',
      'Decision — a branching condition (e.g. "Amount > 10,000?"). Connect multiple outgoing edges with labels.',
      'Approval — a human sign-off step. Automatically injects approved_by / approved_at / approval_status fields.',
      'Data Object — a document or artefact that flows through the process (e.g. "Invoice", "Purchase Order").',
    ],
  },
  {
    title: 'Node metadata',
    icon: '③',
    color: 'text-amber-600 dark:text-amber-400',
    body: [
      'Actor — who performs this step (e.g. "Finance Manager"). Drives the users entity and _by FK columns.',
      'Business Object — the main data entity involved (e.g. "Purchase Request"). Used as the table name.',
      'Operation Type — CREATE, READ, UPDATE, DELETE, APPROVE, VERIFY, ASSIGN, etc. Controls which fields are generated.',
      'Output / Produced Data — fields created or set in this step (e.g. "request_date, total_amount"). Become table columns.',
      'Input / Referenced Data — fields read but not written (e.g. "supplier_name, budget_code"). Influence FK inference.',
      'Status Before / After — document the status machine. Drives the status_logs table and status ENUM columns.',
    ],
  },
  {
    title: 'Entities step',
    icon: '④',
    color: 'text-teal-600 dark:text-teal-400',
    body: [
      'Each candidate entity shows its suggested table name, category, and auto-inferred fields with PostgreSQL types.',
      'Edit the table name, category, or individual field names and types. All changes are saved back to the project.',
      'Confirm entities you want to keep. Reject entities that are duplicates or not relevant. Use Confirm All to accept the full set.',
      'The users entity is always injected when actor metadata is present. status_logs is injected for approval/verify workflows.',
    ],
  },
  {
    title: 'Relationships step',
    icon: '⑤',
    color: 'text-pink-600 dark:text-pink-400',
    body: [
      'Relationships are inferred from FK field patterns: _id suffix → one_to_many; _by suffix → FK to users.',
      'Tables with 2+ FK columns and ≤ 3 total non-FK columns are detected as junction tables → many_to_many.',
      'Add custom relationships manually via the Add button. Edit cardinality (optional / mandatory) and the FK column name.',
      'Confirmed relationships become FOREIGN KEY CONSTRAINT in the DDL and references() calls in the Drizzle schema.',
    ],
  },
  {
    title: 'Outputs',
    icon: '⑥',
    color: 'text-green-600 dark:text-green-400',
    body: [
      'PostgreSQL DDL — CREATE SCHEMA + CREATE TABLE statements with FK constraints and indexes on FK columns.',
      'Drizzle ORM — TypeScript schema using pgSchema(), pgTable(), and relations() ready to drop into your project.',
      'Data Dictionary — tabular reference of every table and column with type, nullability, FK target, description, and example.',
      'Validation — design issues flagged as errors, warnings, or info (missing PK, vague column names, unconstrained status, etc.).',
    ],
  },
] as const;

function FlowGuidePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false); };
    const onKey   = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onMouse); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border transition-colors
          ${open
            ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-600 dark:bg-blue-950/40 dark:text-blue-300'
            : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-blue-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50/60 dark:hover:bg-blue-950/20'}`}
      >
        <span className="font-bold">?</span> Guide
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-[9999] w-[440px] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
            <div className="flex items-center gap-2">
              <Workflow size={13} className="text-blue-500" />
              <p className="text-sm font-semibold text-gray-800 dark:text-slate-100">Flow-to-Database Designer — Guide</p>
            </div>
            <button onClick={() => setOpen(false)} className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-200">
              <X size={13} />
            </button>
          </div>
          <div className="overflow-y-auto max-h-[70vh] divide-y divide-gray-100 dark:divide-slate-800">
            {FTD_GUIDE_SECTIONS.map(sec => (
              <div key={sec.title} className="px-4 py-3.5 space-y-2">
                <p className={`text-[11px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${sec.color}`}>
                  <span>{sec.icon}</span> {sec.title}
                </p>
                <ul className="space-y-1.5">
                  {sec.body.map((line, i) => (
                    <li key={i} className="flex gap-2 text-xs text-gray-600 dark:text-slate-300 leading-relaxed">
                      <span className="text-gray-300 dark:text-slate-600 shrink-0 mt-0.5">–</span>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function FlowDesignerPage() {
  useAuth();

  // ── Project selection ─────────────────────────────────────────────────────
  const [projects, setProjects]       = useState<FtdProject[]>([]);
  const [activeProject, setActive]    = useState<FtdProject | null>(null);
  const [showNewProj, setShowNewProj] = useState(false);
  const [newProjForm, setNewProjForm] = useState({ name: '', description: '', domain: '', schemaName: 'app' });
  const [projLoading, setProjLoading] = useState(false);

  // ── Wizard step ───────────────────────────────────────────────────────────
  const [step, setStep] = useState<Step>(1);

  // ── Canvas (step 1) ───────────────────────────────────────────────────────
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<RfNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode]  = useState<Node<RfNodeData> | null>(null);
  const [metaForm, setMetaForm]          = useState<NodeMetadata>({});
  const [labelEdit, setLabelEdit]        = useState('');
  const [canvasSaving, setCanvasSaving]  = useState(false);

  // ── Data flows (step 2) ───────────────────────────────────────────────────
  const [dataFlows, setDataFlows]    = useState<DbDataFlow[]>([]);
  const [analyzing, setAnalyzing]    = useState(false);

  // ── Entities (step 3) ─────────────────────────────────────────────────────
  const [entities, setEntities]          = useState<FtdEntity[]>([]);
  const [selectedEntity, setSelEntity]   = useState<FtdEntity | null>(null);
  const [editingField, setEditingField]  = useState<EntityField | null>(null);
  const [entitySaving, setEntitySaving]  = useState(false);

  // ── Relationships (step 4) ────────────────────────────────────────────────
  const [relationships, setRels]        = useState<FtdRelationship[]>([]);
  const [relSaving, setRelSaving]       = useState(false);
  const [showAddRel, setShowAddRel]     = useState(false);
  const [newRelForm, setNewRelForm]     = useState<Partial<FtdRelationship>>({ relationshipType: 'one_to_many', cardinality: 'optional', confirmed: true });

  // ── ERD (step 5) ──────────────────────────────────────────────────────────
  const [erdNodes, setErdNodes, onErdNC] = useNodesState<Node>([]);
  const [erdEdges, setErdEdges, onErdEC] = useEdgesState<Edge>([]);

  // ── Outputs (step 6) ──────────────────────────────────────────────────────
  const [ddl, setDdl]                = useState('');
  const [drizzle, setDrizzle]        = useState('');
  const [dictionary, setDictionary]  = useState<DictionaryEntry[]>([]);
  const [validations, setValidations]= useState<ValidationIssue[]>([]);
  const [generating, setGenerating]  = useState(false);
  const [outputTab, setOutputTab]    = useState<'ddl'|'drizzle'|'dictionary'|'validation'>('ddl');
  const [copied, setCopied]          = useState(false);

  const [toast, setToast] = useState('');

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  // ── Load projects ─────────────────────────────────────────────────────────
  useEffect(() => {
    axios.get('/api/flow-designer/projects').then(r => setProjects(r.data.projects ?? []));
  }, []);

  async function createProject() {
    if (!newProjForm.name.trim()) return;
    setProjLoading(true);
    try {
      const { data } = await axios.post('/api/flow-designer/projects', newProjForm);
      const proj = data.project as FtdProject;
      setProjects(p => [proj, ...p]);
      setActive(proj);
      setShowNewProj(false);
      setNewProjForm({ name: '', description: '', domain: '', schemaName: 'app' });
      setStep(1);
    } catch { showToast('Failed to create project'); }
    finally { setProjLoading(false); }
  }

  async function deleteProject(id: number) {
    if (!confirm('Delete this project and all its data?')) return;
    await axios.delete(`/api/flow-designer/projects?id=${id}`);
    setProjects(p => p.filter(x => x.id !== id));
    if (activeProject?.id === id) setActive(null);
  }

  async function openProject(proj: FtdProject) {
    setActive(proj);
    setStep(1);
    // Load canvas
    try {
      const { data } = await axios.get(`/api/flow-designer/canvas?projectId=${proj.id}`);
      const loadedNodes = (data.nodes ?? []).map((n: { id: string; type: NodeType; position: { x: number; y: number }; data: { label: string; metadata: NodeMetadata } }) => ({
        id: n.id, type: n.type, position: n.position,
        data: { label: n.data.label, metadata: n.data.metadata ?? {}, nodeType: n.type },
      }));
      setNodes(loadedNodes);
      setEdges(data.edges ?? []);
    } catch { /* new project */ }
    // Load entities + relationships
    try {
      const [entR, relR, dfR] = await Promise.all([
        axios.get(`/api/flow-designer/entities?projectId=${proj.id}`),
        axios.get(`/api/flow-designer/relationships?projectId=${proj.id}`),
        axios.get(`/api/flow-designer/dataflows?projectId=${proj.id}`),
      ]);
      setEntities(mapEntities(entR.data.entities ?? []));
      setRels(mapRels(relR.data.relationships ?? []));
      setDataFlows(entR.data.dataFlows ?? dfR.data.dataFlows ?? []);
    } catch { /* ok */ }
  }

  function mapEntities(rows: Record<string, unknown>[]): FtdEntity[] {
    return rows.map(r => ({
      id: r.id as number, tableName: r.table_name as string, displayName: r.display_name as string,
      category: r.category as FtdEntity['category'], description: r.description as string,
      schemaName: r.schema_name as string, confirmed: r.confirmed as boolean, rejected: r.rejected as boolean,
      fields: (r.fields ?? []) as EntityField[], sourceNodes: (r.source_nodes ?? []) as string[],
      sortOrder: r.sort_order as number,
    }));
  }

  function mapRels(rows: Record<string, unknown>[]): FtdRelationship[] {
    return rows.map(r => ({
      id: r.id as number, sourceEntity: r.source_entity as string, targetEntity: r.target_entity as string,
      relationshipType: r.relationship_type as FtdRelationship['relationshipType'],
      cardinality: r.cardinality as FtdRelationship['cardinality'],
      label: r.label as string | undefined, foreignKeyColumn: r.foreign_key_column as string | undefined,
      confirmed: r.confirmed as boolean, rejected: r.rejected as boolean,
    }));
  }

  // ── Canvas helpers ────────────────────────────────────────────────────────

  function addNode(type: NodeType) {
    const id = uid();
    const label = type === 'start' ? 'Start' : type === 'end' ? 'End'
      : type === 'process' ? 'New Process' : type === 'decision' ? 'Decision'
      : type === 'approval' ? 'Approval Step' : 'Data Object';
    const newNode: Node<RfNodeData> = {
      id, type,
      position: { x: 100 + Math.random() * 200, y: 100 + Math.random() * 200 },
      data: { label, metadata: {}, nodeType: type },
    };
    setNodes(ns => [...ns, newNode]);
  }

  const onConnect = useCallback((conn: Connection) => {
    setEdges(es => addEdge({ ...conn, markerEnd: { type: MarkerType.ArrowClosed } }, es));
  }, [setEdges]);

  function onNodeClick(_: React.MouseEvent, node: Node<RfNodeData>) {
    setSelectedNode(node);
    setMetaForm(node.data.metadata ?? {});
    setLabelEdit(node.data.label);
  }

  function onPaneClick() { setSelectedNode(null); }

  function applyMeta() {
    if (!selectedNode) return;
    setNodes(ns => ns.map(n => n.id === selectedNode.id
      ? { ...n, data: { ...n.data, label: labelEdit, metadata: metaForm } }
      : n
    ));
    setSelectedNode(prev => prev ? { ...prev, data: { ...prev.data, label: labelEdit, metadata: metaForm } } : null);
  }

  function deleteSelectedNode() {
    if (!selectedNode) return;
    setNodes(ns => ns.filter(n => n.id !== selectedNode.id));
    setEdges(es => es.filter(e => e.source !== selectedNode.id && e.target !== selectedNode.id));
    setSelectedNode(null);
  }

  async function saveCanvas() {
    if (!activeProject) return;
    setCanvasSaving(true);
    try {
      const canvasNodes = nodes.map(n => ({
        id: n.id, type: n.type, position: n.position,
        data: { label: n.data.label, metadata: n.data.metadata ?? {} },
      }));
      await axios.post('/api/flow-designer/canvas', { projectId: activeProject.id, nodes: canvasNodes, edges });
      showToast('Canvas saved');
    } catch { showToast('Save failed'); }
    finally { setCanvasSaving(false); }
  }

  // ── Analyze flow ──────────────────────────────────────────────────────────

  async function analyzeFlow() {
    if (!activeProject || !nodes.length) { showToast('Add nodes to the canvas first'); return; }
    setAnalyzing(true);
    try {
      await saveCanvas();
      const canvasNodes = nodes.map(n => ({
        id: n.id, type: n.type, position: n.position,
        data: { label: n.data.label, metadata: n.data.metadata ?? {} },
      }));
      const { data } = await axios.post('/api/flow-designer/analyze', {
        projectId: activeProject.id, nodes: canvasNodes,
      });
      setDataFlows(data.dataFlows ?? []);
      setEntities(mapEntities(data.entities ?? []));
      setRels(mapRels(data.relationships ?? []));
      showToast('Analysis complete — review the Data Flow');
      setStep(2);
    } catch (e) { showToast('Analysis failed: ' + (axios.isAxiosError(e) ? e.response?.data?.error : String(e))); }
    finally { setAnalyzing(false); }
  }

  // ── Entity actions ────────────────────────────────────────────────────────

  async function updateEntity(e: FtdEntity) {
    if (!activeProject) return;
    setEntitySaving(true);
    try {
      await axios.put('/api/flow-designer/entities', { projectId: activeProject.id, id: e.id, ...e });
      setEntities(es => es.map(x => x.id === e.id ? e : x));
      if (selectedEntity?.id === e.id) setSelEntity(e);
    } catch { showToast('Save failed'); }
    finally { setEntitySaving(false); }
  }

  async function confirmAll() {
    if (!activeProject) return;
    await axios.patch('/api/flow-designer/entities', { projectId: activeProject.id, action: 'confirm_all' });
    setEntities(es => es.map(e => ({ ...e, confirmed: true, rejected: false })));
    showToast('All entities confirmed');
  }

  // ── Relationship actions ──────────────────────────────────────────────────

  async function updateRel(r: FtdRelationship) {
    if (!activeProject) return;
    setRelSaving(true);
    try {
      await axios.put('/api/flow-designer/relationships', { projectId: activeProject.id, id: r.id, ...r });
      setRels(rs => rs.map(x => x.id === r.id ? r : x));
    } catch { showToast('Save failed'); }
    finally { setRelSaving(false); }
  }

  async function addRelationship() {
    if (!activeProject || !newRelForm.sourceEntity || !newRelForm.targetEntity) return;
    try {
      const { data } = await axios.post('/api/flow-designer/relationships', { projectId: activeProject.id, ...newRelForm });
      setRels(rs => [...rs, mapRels([data.relationship])[0]]);
      setShowAddRel(false);
      setNewRelForm({ relationshipType: 'one_to_many', cardinality: 'optional', confirmed: true });
    } catch { showToast('Failed to add relationship'); }
  }

  async function deleteRel(id: number) {
    if (!activeProject) return;
    await axios.delete(`/api/flow-designer/relationships?projectId=${activeProject.id}&id=${id}`);
    setRels(rs => rs.filter(r => r.id !== id));
  }

  // ── Build ERD canvas from confirmed entities + relationships ───────────────

  function buildErd() {
    const confirmed = entities.filter(e => e.confirmed && !e.rejected);
    const confirmedRels = relationships.filter(r => r.confirmed && !r.rejected);

    const COLS = 3;
    const W = 280, H_BASE = 80, ROW_H = 20;

    const erdN: Node[] = confirmed.map((e, i) => ({
      id: `erd_${e.tableName}`,
      type: 'erd_table',
      position: {
        x: (i % COLS) * (W + 40) + 20,
        y: Math.floor(i / COLS) * 320 + 20,
      },
      data: { entity: e },
      draggable: true,
    }));

    const erdE: Edge[] = confirmedRels
      .filter(r => r.relationshipType !== 'many_to_many')
      .map(r => ({
        id:     `erel_${r.id}`,
        source: `erd_${r.sourceEntity}`,
        target: `erd_${r.targetEntity}`,
        label:  r.relationshipType === 'one_to_many' ? '1 : N' : '1 : 1',
        markerEnd: { type: MarkerType.ArrowClosed },
        style: { stroke: '#6366f1' },
        labelStyle: { fontSize: 10 },
      }));

    setErdNodes(erdN);
    setErdEdges(erdE);
    setStep(5);
  }

  // ── Generate outputs ──────────────────────────────────────────────────────

  async function generate() {
    if (!activeProject) return;
    setGenerating(true);
    try {
      const { data } = await axios.post('/api/flow-designer/generate', { projectId: activeProject.id });
      setDdl(data.ddl ?? '');
      setDrizzle(data.drizzle ?? '');
      setDictionary(data.dictionary ?? []);
      setValidations(data.validations ?? []);
      showToast('Outputs generated');
      setStep(6);
    } catch (e) { showToast('Generation failed: ' + (axios.isAxiosError(e) ? e.response?.data?.error : String(e))); }
    finally { setGenerating(false); }
  }

  function downloadText(content: string, filename: string) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  if (!activeProject) {
    return (
      <>
        <Head><title>Flow-to-Database Designer</title></Head>
        <div className="min-h-screen bg-gray-50 dark:bg-slate-900 text-gray-900 dark:text-slate-100">
          {/* Header — same pattern as other modules */}
          <header className="shrink-0 sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-3 flex items-center gap-4">
            <div className="flex items-center gap-3 shrink-0">
              <Workflow size={18} className="text-blue-600" />
              <div>
                <h1 className="font-bold text-sm text-gray-900 dark:text-slate-100">Flow-to-Database Designer</h1>
                <p className="text-xs text-gray-500 dark:text-slate-400">Design a business process → generate PostgreSQL schema &amp; Drizzle ORM</p>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-3 shrink-0">
              <FlowGuidePopover />
              <div className="h-5 w-px bg-gray-200 dark:bg-slate-700" />
              <nav className="flex items-center gap-1 text-sm">
                <Link href="/" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Home</Link>
                <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
                <span className="px-3 py-1 rounded-lg bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold">Flow Designer</span>
              </nav>
            </div>
          </header>

          {/* Projects */}
          <div className="max-w-4xl mx-auto p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">Projects</h2>
              <button onClick={() => setShowNewProj(true)}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
                <Plus size={14} /> New Project
              </button>
            </div>

            {showNewProj && (
              <div className="mb-6 p-5 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40">
                <h3 className="font-semibold mb-4">New Project</h3>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: 'Project Name *', key: 'name', placeholder: 'e.g. Procurement System' },
                    { label: 'Domain', key: 'domain', placeholder: 'e.g. Inventory, HR, Finance' },
                    { label: 'DB Schema Name', key: 'schemaName', placeholder: 'app' },
                  ].map(f => (
                    <div key={f.key}>
                      <label className="block text-xs font-medium mb-1">{f.label}</label>
                      <input value={(newProjForm as Record<string,string>)[f.key]}
                        onChange={e => setNewProjForm(p => ({ ...p, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm" />
                    </div>
                  ))}
                  <div className="col-span-2">
                    <label className="block text-xs font-medium mb-1">Description</label>
                    <textarea value={newProjForm.description}
                      onChange={e => setNewProjForm(p => ({ ...p, description: e.target.value }))}
                      rows={2} placeholder="Briefly describe the business domain…"
                      className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm" />
                  </div>
                </div>
                <div className="flex gap-3 mt-4">
                  <button onClick={createProject} disabled={projLoading}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
                    {projLoading ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create
                  </button>
                  <button onClick={() => setShowNewProj(false)}
                    className="px-4 py-2 bg-gray-200 dark:bg-slate-700 rounded-lg text-sm">Cancel</button>
                </div>
              </div>
            )}

            {projects.length === 0 && !showNewProj && (
              <div className="text-center py-20 text-gray-400 dark:text-slate-500">
                <Workflow size={40} className="mx-auto mb-3 opacity-30" />
                <p className="font-medium">No projects yet</p>
                <p className="text-sm mt-1">Create a project to start designing your database from a business process.</p>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {projects.map(p => (
                <div key={p.id} className="p-5 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:shadow-md transition-shadow">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h3 className="font-semibold text-base">{p.name}</h3>
                      {p.domain && <p className="text-xs text-blue-500 mt-0.5">{p.domain}</p>}
                    </div>
                    <button onClick={() => deleteProject(p.id)} className="p-1.5 text-gray-400 hover:text-rose-500"><Trash2 size={14} /></button>
                  </div>
                  {p.description && <p className="text-xs text-gray-500 dark:text-slate-400 mb-3 line-clamp-2">{p.description}</p>}
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-gray-400 dark:text-slate-500">Schema: <code>{p.schema_name ?? p.schemaName}</code></span>
                    <button onClick={() => openProject(p)}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700">
                      Open <ArrowRight size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </>
    );
  }

  // ─── Workspace ─────────────────────────────────────────────────────────────
  const confirmedEntities    = entities.filter(e => e.confirmed && !e.rejected);
  const confirmedRels        = relationships.filter(r => r.confirmed && !r.rejected);
  const errCount             = validations.filter(v => v.severity === 'error').length;
  const warnCount            = validations.filter(v => v.severity === 'warning').length;

  return (
    <>
      <Head><title>{activeProject.name} — Flow Designer</title></Head>
      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 px-4 py-3 bg-slate-800 text-white rounded-xl shadow-xl text-sm flex items-center gap-2">
          <Info size={14} /> {toast}
        </div>
      )}

      <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-900 text-gray-900 dark:text-slate-100 overflow-hidden">
        {/* Header — same sticky pattern as other modules */}
        <header className="shrink-0 sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-4 py-3 flex items-center gap-3">
          <button onClick={() => setActive(null)}
            className="p-1.5 rounded-lg text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
            <ArrowLeft size={16} />
          </button>
          <div className="h-6 w-px bg-gray-200 dark:bg-slate-700 shrink-0" />
          <Workflow size={16} className="text-blue-600 shrink-0" />
          <div className="shrink-0 min-w-0">
            <h1 className="font-bold text-sm text-gray-900 dark:text-slate-100 truncate leading-tight">{activeProject.name}</h1>
            <p className="text-[10px] text-gray-500 dark:text-slate-400 leading-tight">
              Schema: <code className="font-mono">{activeProject.schema_name ?? activeProject.schemaName}</code>
              {activeProject.domain && <> · {activeProject.domain}</>}
            </p>
          </div>
          <div className="h-6 w-px bg-gray-200 dark:bg-slate-700 shrink-0" />
          {/* Step tabs */}
          <div className="flex items-center gap-0.5 overflow-x-auto">
            {STEPS.map(s => (
              <button key={s.n} onClick={() => setStep(s.n as Step)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors
                  ${step === s.n
                    ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                    : 'text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-800 dark:hover:text-slate-200'}`}>
                <s.icon size={12} />
                <span className="hidden sm:inline">{s.label}</span>
                <span className="inline sm:hidden">{s.n}</span>
              </button>
            ))}
          </div>
          {/* Guide + Breadcrumb */}
          <div className="ml-auto flex items-center gap-3 shrink-0">
            <FlowGuidePopover />
            <div className="h-5 w-px bg-gray-200 dark:bg-slate-700" />
            <nav className="flex items-center gap-1 text-sm">
              <button onClick={() => setActive(null)} className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Projects</button>
              <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
              <span className="px-3 py-1 rounded-lg bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold truncate max-w-[160px]">{activeProject.name}</span>
            </nav>
          </div>
        </header>

        {/* Step content */}
        <div className="flex-1 overflow-hidden">

          {/* ── Step 1: Business Flow Canvas ─────────────────────────────── */}
          {step === 1 && (
            <div className="flex h-full">
              {/* Node palette */}
              <div className="w-44 flex-shrink-0 border-r border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 flex flex-col gap-2 overflow-y-auto">
                <p className="text-[10px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide mb-1">Add Node</p>
                {([
                  { type: 'start',       label: 'Start',        cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300' },
                  { type: 'process',     label: 'Process',      cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300' },
                  { type: 'decision',    label: 'Decision',     cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300' },
                  { type: 'approval',    label: 'Approval',     cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300' },
                  { type: 'data_object', label: 'Data Object',  cls: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300' },
                  { type: 'end',         label: 'End',          cls: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' },
                ] as { type: NodeType; label: string; cls: string }[]).map(nt => (
                  <button key={nt.type} onClick={() => addNode(nt.type)}
                    className={`w-full px-3 py-2 rounded-lg text-xs font-medium text-left ${nt.cls} hover:opacity-80 transition-opacity`}>
                    + {nt.label}
                  </button>
                ))}
                <div className="border-t border-gray-200 dark:border-slate-600 my-2" />
                <button onClick={saveCanvas} disabled={canvasSaving}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 rounded-lg text-xs font-medium hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50">
                  {canvasSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
                </button>
                <button onClick={analyzeFlow} disabled={analyzing}
                  className="flex items-center justify-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50">
                  {analyzing ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Analyze Flow
                </button>
                <div className="border-t border-gray-200 dark:border-slate-600 my-2" />
                <p className="text-[10px] text-gray-400 dark:text-slate-500 leading-tight">
                  Click a node to edit its metadata. Connect nodes by dragging from the handles.
                </p>
              </div>

              {/* Canvas */}
              <div className="flex-1 relative">
                <ReactFlowProvider>
                  <ReactFlow
                    nodes={nodes} edges={edges}
                    onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
                    onConnect={onConnect} onNodeClick={onNodeClick} onPaneClick={onPaneClick}
                    nodeTypes={nodeTypes} fitView
                    className="bg-gray-50 dark:bg-slate-900">
                    <Background gap={16} color="#e5e7eb" className="dark:!text-slate-700" />
                    <Controls className="[&>button]:!bg-white dark:[&>button]:!bg-slate-700 [&>button]:!border-gray-200 dark:[&>button]:!border-slate-600" />
                    <MiniMap nodeColor={n => ({ start: '#10b981', end: '#f43f5e', process: '#3b82f6', decision: '#f59e0b', approval: '#a855f7', data_object: '#06b6d4' }[(n.type ?? 'process')] ?? '#888')} />
                  </ReactFlow>
                </ReactFlowProvider>
              </div>

              {/* Metadata panel — onKeyDown stopPropagation prevents React Flow from stealing keystrokes */}
              {selectedNode && (
                <div className="w-72 flex-shrink-0 border-l border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 overflow-y-auto flex flex-col gap-3"
                  onKeyDown={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-sm">Node Metadata</h3>
                    <div className="flex gap-1">
                      <button onClick={deleteSelectedNode} className="p-1 text-rose-400 hover:text-rose-600"><Trash2 size={14} /></button>
                      <button onClick={() => setSelectedNode(null)} className="p-1 text-gray-400 hover:text-gray-600"><X size={14} /></button>
                    </div>
                  </div>

                  <div>
                    <label className="block text-[10px] font-medium text-gray-500 dark:text-slate-400 mb-1">Label</label>
                    <input value={labelEdit} onChange={e => setLabelEdit(e.target.value)}
                      className="w-full px-2 py-1.5 text-xs rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900" />
                  </div>

                  {[
                    { key: 'actor',          label: 'Actor',           placeholder: 'e.g. Procurement Officer' },
                    { key: 'action',         label: 'Action',          placeholder: 'e.g. Submit request' },
                    { key: 'businessObject', label: 'Business Object',  placeholder: 'e.g. purchase_request' },
                    { key: 'relatedDocument',label: 'Related Document', placeholder: 'e.g. PR Form, LPO' },
                    { key: 'remarks',        label: 'Remarks',          placeholder: 'Additional notes…' },
                  ].map(f => (
                    <div key={f.key}>
                      <label className="block text-[10px] font-medium text-gray-500 dark:text-slate-400 mb-1">{f.label}</label>
                      <input value={(metaForm as Record<string,string>)[f.key] ?? ''}
                        onChange={e => setMetaForm(m => ({ ...m, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        className="w-full px-2 py-1.5 text-xs rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900" />
                    </div>
                  ))}

                  <div>
                    <label className="block text-[10px] font-medium text-gray-500 dark:text-slate-400 mb-1">Operation Type</label>
                    <select value={metaForm.operationType ?? ''}
                      onChange={e => setMetaForm(m => ({ ...m, operationType: e.target.value as NodeMetadata['operationType'] || undefined }))}
                      className="w-full px-2 py-1.5 text-xs rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900">
                      <option value="">— auto-detect —</option>
                      {OPERATION_TYPES.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  </div>

                  {[
                    { key: 'statusBefore', label: 'Status Before', placeholder: 'e.g. draft' },
                    { key: 'statusAfter',  label: 'Status After',  placeholder: 'e.g. submitted' },
                    { key: 'decisionCondition', label: 'Decision Condition', placeholder: 'e.g. Amount > RM 5000' },
                  ].map(f => (
                    <div key={f.key}>
                      <label className="block text-[10px] font-medium text-gray-500 dark:text-slate-400 mb-1">{f.label}</label>
                      <input value={(metaForm as Record<string,string>)[f.key] ?? ''}
                        onChange={e => setMetaForm(m => ({ ...m, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        className="w-full px-2 py-1.5 text-xs rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900" />
                    </div>
                  ))}

                  {/* Output Data */}
                  <div>
                    <label className="block text-[10px] font-medium text-gray-500 dark:text-slate-400 mb-1">
                      Output / Produced Data <FieldHint field="outputData" /> <span className="text-gray-400">(one per line)</span>
                    </label>
                    <textarea
                      value={(metaForm.outputData ?? []).join('\n')}
                      onChange={e => setMetaForm(m => ({ ...m, outputData: e.target.value.split('\n') }))}
                      onBlur={e => setMetaForm(m => ({ ...m, outputData: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
                      onKeyDown={e => e.stopPropagation()}
                      rows={4} placeholder={'request_ref_no\nrequested_by\nstatus'}
                      className="w-full px-2 py-1.5 text-xs rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 font-mono" />
                  </div>

                  {/* Input Data */}
                  <div>
                    <label className="block text-[10px] font-medium text-gray-500 dark:text-slate-400 mb-1">
                      Input / Referenced Data <FieldHint field="inputData" /> <span className="text-gray-400">(one per line)</span>
                    </label>
                    <textarea
                      value={(metaForm.inputData ?? []).join('\n')}
                      onChange={e => setMetaForm(m => ({ ...m, inputData: e.target.value.split('\n') }))}
                      onBlur={e => setMetaForm(m => ({ ...m, inputData: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
                      onKeyDown={e => e.stopPropagation()}
                      rows={3} placeholder={'purchase_id\nitem_id'}
                      className="w-full px-2 py-1.5 text-xs rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-900 font-mono" />
                  </div>

                  <button onClick={applyMeta}
                    className="w-full py-2 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700">
                    Apply Changes
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Data Flow Review ────────────────────────────────── */}
          {step === 2 && (
            <div className="h-full overflow-y-auto p-6">
              <div className="max-w-5xl mx-auto">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-lg font-bold">Generated Data Flow</h2>
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">Review how each process step interacts with data. Go back to add metadata if steps look incomplete.</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setStep(1)} className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-700">
                      <ChevronLeft size={14} /> Canvas
                    </button>
                    <button onClick={() => setStep(3)} disabled={!entities.length}
                      className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40">
                      Review Entities <ChevronRight size={14} />
                    </button>
                  </div>
                </div>

                {dataFlows.length === 0 ? (
                  <div className="text-center py-20 text-gray-400">
                    <GitBranch size={36} className="mx-auto mb-3 opacity-30" />
                    <p>No data flow generated yet. Go back to Canvas and click <strong>Analyze Flow</strong>.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {dataFlows.map((df, i) => (
                      <div key={df.node_id ?? i} className="p-4 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800">
                        <div className="flex items-center gap-3 mb-3">
                          <span className="w-6 h-6 flex items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs font-bold flex-shrink-0">
                            {i + 1}
                          </span>
                          <h3 className="font-semibold text-sm">{df.node_label}</h3>
                          <span className="px-2 py-0.5 bg-gray-100 dark:bg-slate-700 rounded text-xs font-mono font-bold text-gray-600 dark:text-slate-300">
                            {df.operation}
                          </span>
                          {df.business_object && (
                            <span className="px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 rounded text-xs font-mono">{df.business_object}</span>
                          )}
                          {df.actor && <span className="text-xs text-gray-500 dark:text-slate-400 ml-auto">by {df.actor}</span>}
                        </div>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                          {[
                            { label: 'Data Created',    fields: df.data_created,    color: 'text-emerald-600 dark:text-emerald-400' },
                            { label: 'Data Updated',    fields: df.data_updated,    color: 'text-blue-600 dark:text-blue-400' },
                            { label: 'Data Referenced', fields: df.data_referenced, color: 'text-amber-600 dark:text-amber-400' },
                            { label: 'Data Deleted',    fields: df.data_deleted,    color: 'text-rose-600 dark:text-rose-400' },
                          ].map(col => (
                            <div key={col.label}>
                              <p className={`font-semibold mb-1 ${col.color}`}>{col.label}</p>
                              {(col.fields ?? []).length > 0
                                ? (col.fields ?? []).map((f: string) => <div key={f} className="font-mono text-[11px] text-gray-700 dark:text-slate-300">{f}</div>)
                                : <span className="text-gray-300 dark:text-slate-600 italic">none</span>
                              }
                            </div>
                          ))}
                        </div>
                        {(df.status_before || df.status_after) && (
                          <div className="mt-2 flex items-center gap-2 text-xs text-gray-500 dark:text-slate-400">
                            Status: <code>{df.status_before ?? '?'}</code> → <code>{df.status_after ?? '?'}</code>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 3: Entities ─────────────────────────────────────────── */}
          {step === 3 && (
            <div className="flex h-full overflow-hidden">
              {/* Entity list */}
              <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 overflow-y-auto">
                <div className="p-3 border-b border-gray-200 dark:border-slate-700 flex items-center gap-2">
                  <h3 className="font-semibold text-sm flex-1">Entities ({entities.length})</h3>
                  <button onClick={confirmAll} title="Confirm all"
                    className="p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded-lg"><CheckCircle2 size={14} /></button>
                </div>
                <div className="p-2 space-y-1">
                  {entities.map(e => (
                    <button key={e.id} onClick={() => setSelEntity(e)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg text-xs transition-colors
                        ${selectedEntity?.id === e.id ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700' : 'hover:bg-gray-50 dark:hover:bg-slate-700'}
                        ${e.rejected ? 'opacity-40 line-through' : ''}
                        ${e.confirmed && !e.rejected ? 'border-l-2 border-emerald-500' : ''}`}>
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${e.confirmed && !e.rejected ? 'bg-emerald-500' : e.rejected ? 'bg-rose-400' : 'bg-gray-300 dark:bg-slate-500'}`} />
                        <span className="font-mono font-medium truncate">{e.tableName}</span>
                        <span className="ml-auto">{catBadge(e.category)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Entity detail editor */}
              <div className="flex-1 overflow-y-auto p-5">
                {!selectedEntity ? (
                  <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-slate-500">
                    <Table2 size={36} className="opacity-30 mb-3" />
                    <p>Select an entity from the list to review and confirm its fields.</p>
                  </div>
                ) : (
                  <div className="max-w-3xl">
                    {/* Entity header */}
                    <div className="flex items-start gap-4 mb-5">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-1">
                          <input value={selectedEntity.displayName}
                            onChange={e => setSelEntity(s => s ? { ...s, displayName: e.target.value } : null)}
                            className="text-xl font-bold bg-transparent border-b border-transparent hover:border-gray-300 focus:border-blue-500 outline-none dark:text-white" />
                          {catBadge(selectedEntity.category)}
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-slate-400">
                          <code>{selectedEntity.schemaName}.{selectedEntity.tableName}</code>
                          <select value={selectedEntity.category}
                            onChange={e => setSelEntity(s => s ? { ...s, category: e.target.value as FtdEntity['category'] } : null)}
                            className="px-2 py-1 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs">
                            {ENTITY_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                        <textarea value={selectedEntity.description}
                          onChange={e => setSelEntity(s => s ? { ...s, description: e.target.value } : null)}
                          rows={2} placeholder="Describe this entity…"
                          className="w-full mt-2 px-2 py-1.5 text-xs rounded-md border border-gray-200 dark:border-slate-600 bg-gray-50 dark:bg-slate-900" />
                      </div>
                      <div className="flex flex-col gap-2">
                        <button onClick={() => updateEntity({ ...selectedEntity!, confirmed: true, rejected: false })}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700">
                          <CheckCircle2 size={12} /> Confirm
                        </button>
                        <button onClick={() => updateEntity({ ...selectedEntity!, rejected: true, confirmed: false })}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 rounded-lg text-xs font-medium hover:bg-rose-200 dark:hover:bg-rose-900/50">
                          <XCircle size={12} /> Reject
                        </button>
                        <button onClick={() => updateEntity(selectedEntity!)} disabled={entitySaving}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 rounded-lg text-xs font-medium hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50">
                          {entitySaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
                        </button>
                      </div>
                    </div>

                    {/* Fields table */}
                    <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-slate-700/50 text-gray-500 dark:text-slate-400 text-[11px] uppercase tracking-wide">
                            <th className="px-3 py-2 text-left w-8">#</th>
                            <th className="px-3 py-2 text-left">Column</th>
                            <th className="px-3 py-2 text-left">Type</th>
                            <th className="px-3 py-2 text-center w-16">Null</th>
                            <th className="px-3 py-2 text-center w-12">PK</th>
                            <th className="px-3 py-2 text-center w-12">FK</th>
                            <th className="px-3 py-2 text-center w-12">UQ</th>
                            <th className="px-3 py-2 text-left">Default</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                          {(selectedEntity.fields ?? []).map((f, fi) => (
                            <tr key={f.id} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                              <td className="px-3 py-1.5 text-gray-400 dark:text-slate-500">{fi + 1}</td>
                              <td className="px-3 py-1.5">
                                <input value={f.name}
                                  onChange={e => setSelEntity(s => s ? {
                                    ...s, fields: s.fields.map((fld, i) => i === fi ? { ...fld, name: e.target.value } : fld)
                                  } : null)}
                                  className="w-full bg-transparent font-mono text-gray-800 dark:text-slate-200 border-b border-transparent hover:border-gray-300 focus:border-blue-500 outline-none" />
                              </td>
                              <td className="px-3 py-1.5">
                                <select value={f.pgType}
                                  onChange={e => setSelEntity(s => s ? {
                                    ...s, fields: s.fields.map((fld, i) => i === fi ? { ...fld, pgType: e.target.value } : fld)
                                  } : null)}
                                  className="bg-transparent text-gray-600 dark:text-slate-400 text-[11px] border-none outline-none cursor-pointer">
                                  {PG_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                  {!PG_TYPES.includes(f.pgType) && <option value={f.pgType}>{f.pgType}</option>}
                                </select>
                              </td>
                              {[
                                { key: 'nullable', label: '' },
                                { key: 'isPk', label: '' },
                                { key: 'isFk', label: '' },
                                { key: 'isUnique', label: '' },
                              ].map(col => (
                                <td key={col.key} className="px-3 py-1.5 text-center">
                                  <input type="checkbox" checked={!!(f as unknown as Record<string,unknown>)[col.key]}
                                    onChange={e => setSelEntity(s => s ? {
                                      ...s, fields: s.fields.map((fld, i) => i === fi ? { ...fld, [col.key]: e.target.checked } : fld)
                                    } : null)}
                                    className="rounded" />
                                </td>
                              ))}
                              <td className="px-3 py-1.5">
                                <input value={f.defaultValue ?? ''}
                                  onChange={e => setSelEntity(s => s ? {
                                    ...s, fields: s.fields.map((fld, i) => i === fi ? { ...fld, defaultValue: e.target.value || undefined } : fld)
                                  } : null)}
                                  className="w-full bg-transparent font-mono text-gray-500 dark:text-slate-500 text-[11px] border-b border-transparent hover:border-gray-300 focus:border-blue-500 outline-none" />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {/* Add field */}
                      <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-700">
                        <button onClick={() => setSelEntity(s => s ? {
                          ...s, fields: [...s.fields, { id: uid(), name: 'new_column', pgType: 'VARCHAR(255)', nullable: true, isPk: false, isFk: false, isUnique: false }]
                        } : null)}
                          className="text-xs text-blue-500 hover:text-blue-700 font-medium flex items-center gap-1">
                          <Plus size={12} /> Add Column
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 4: Relationships ─────────────────────────────────────── */}
          {step === 4 && (
            <div className="h-full overflow-y-auto p-6">
              <div className="max-w-4xl mx-auto">
                <div className="flex items-center justify-between mb-5">
                  <div>
                    <h2 className="text-lg font-bold">Suggested Relationships</h2>
                    <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">Confirm, reject, or add custom relationships between entities.</p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => setShowAddRel(true)}
                      className="flex items-center gap-1.5 px-3 py-2 border border-gray-300 dark:border-slate-600 rounded-lg text-sm hover:bg-gray-50 dark:hover:bg-slate-700">
                      <Plus size={14} /> Add
                    </button>
                    <button onClick={buildErd} disabled={confirmedRels.length === 0 && confirmedEntities.length === 0}
                      className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40">
                      Generate ERD <ChevronRight size={14} />
                    </button>
                  </div>
                </div>

                {showAddRel && (
                  <div className="mb-5 p-4 rounded-xl border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/40">
                    <h3 className="font-semibold text-sm mb-3">Add Relationship</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      {[
                        { label: 'Source Entity', key: 'sourceEntity' },
                        { label: 'Target Entity', key: 'targetEntity' },
                        { label: 'FK Column', key: 'foreignKeyColumn' },
                      ].map(f => (
                        <div key={f.key}>
                          <label className="block text-xs font-medium mb-1">{f.label}</label>
                          <input value={(newRelForm as Record<string,string|undefined>)[f.key] ?? ''}
                            onChange={e => setNewRelForm(r => ({ ...r, [f.key]: e.target.value }))}
                            list={f.key === 'sourceEntity' || f.key === 'targetEntity' ? 'entity-list' : undefined}
                            className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs" />
                        </div>
                      ))}
                      <div>
                        <label className="block text-xs font-medium mb-1">Type</label>
                        <select value={newRelForm.relationshipType ?? 'one_to_many'}
                          onChange={e => setNewRelForm(r => ({ ...r, relationshipType: e.target.value as FtdRelationship['relationshipType'] }))}
                          className="w-full px-2 py-1.5 rounded border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-xs">
                          {['one_to_one','one_to_many','many_to_many'].map(t => <option key={t} value={t}>{t.replace(/_/g,' ')}</option>)}
                        </select>
                      </div>
                    </div>
                    <datalist id="entity-list">{entities.map(e => <option key={e.tableName} value={e.tableName} />)}</datalist>
                    <div className="flex gap-2 mt-3">
                      <button onClick={addRelationship} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700"><Plus size={12} className="inline mr-1" />Add</button>
                      <button onClick={() => setShowAddRel(false)} className="px-3 py-1.5 bg-gray-200 dark:bg-slate-700 rounded-lg text-xs">Cancel</button>
                    </div>
                  </div>
                )}

                {relationships.length === 0 ? (
                  <div className="text-center py-20 text-gray-400 dark:text-slate-500">
                    <Network size={36} className="mx-auto mb-3 opacity-30" />
                    <p>No relationships suggested. Run "Analyze Flow" first, or add relationships manually.</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {relationships.map(r => (
                      <div key={r.id} className={`p-4 rounded-xl border transition-colors
                        ${r.confirmed && !r.rejected ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-950/20'
                          : r.rejected ? 'border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/20 opacity-50'
                          : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800'}`}>
                        <div className="flex items-center gap-3 flex-wrap">
                          <code className="text-sm font-bold text-blue-600 dark:text-blue-400">{r.sourceEntity}</code>
                          <ArrowRight size={14} className="text-gray-400" />
                          <code className="text-sm font-bold text-blue-600 dark:text-blue-400">{r.targetEntity}</code>
                          <span className="px-2 py-0.5 bg-gray-100 dark:bg-slate-700 rounded text-xs font-mono">{r.relationshipType?.replace(/_/g,' ')}</span>
                          <span className={`px-2 py-0.5 rounded text-xs ${r.cardinality === 'mandatory' ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-400'}`}>{r.cardinality}</span>
                          {r.foreignKeyColumn && <code className="text-xs text-gray-500 dark:text-slate-400">via {r.foreignKeyColumn}</code>}
                          <div className="ml-auto flex gap-1.5">
                            <button onClick={() => updateRel({ ...r, confirmed: true, rejected: false })}
                              className="p-1.5 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded-lg" title="Confirm"><CheckCircle2 size={14} /></button>
                            <button onClick={() => updateRel({ ...r, rejected: true, confirmed: false })}
                              className="p-1.5 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-900/30 rounded-lg" title="Reject"><XCircle size={14} /></button>
                            <button onClick={() => deleteRel(r.id!)}
                              className="p-1.5 text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700 rounded-lg" title="Delete"><Trash2 size={14} /></button>
                          </div>
                        </div>
                        {r.label && <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 ml-1">{r.label}</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 5: ERD ───────────────────────────────────────────────── */}
          {step === 5 && (
            <div className="flex flex-col h-full">
              <div className="flex items-center gap-3 p-3 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex-shrink-0">
                <div className="flex-1">
                  <h2 className="font-semibold text-sm">Entity Relationship Diagram</h2>
                  <p className="text-[11px] text-gray-500 dark:text-slate-400">{confirmedEntities.length} tables · {confirmedRels.length} relationships</p>
                </div>
                <button onClick={buildErd} className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg text-xs hover:bg-gray-50 dark:hover:bg-slate-700">
                  <RefreshCw size={12} /> Refresh ERD
                </button>
                <button onClick={generate} disabled={generating || confirmedEntities.length === 0}
                  className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40">
                  {generating ? <Loader2 size={14} className="animate-spin" /> : <FileCode2 size={14} />}
                  Generate Outputs
                </button>
              </div>
              <div className="flex-1">
                <ReactFlowProvider>
                  <ReactFlow
                    nodes={erdNodes} edges={erdEdges}
                    onNodesChange={onErdNC} onEdgesChange={onErdEC}
                    nodeTypes={erdNodeTypes} fitView
                    className="bg-gray-50 dark:bg-slate-900"
                    nodesDraggable edgesReconnectable={false}>
                    <Background gap={20} color="#e5e7eb" className="dark:!text-slate-800" />
                    <Controls />
                    <MiniMap />
                  </ReactFlow>
                </ReactFlowProvider>
              </div>
            </div>
          )}

          {/* ── Step 6: Outputs ───────────────────────────────────────────── */}
          {step === 6 && (
            <div className="h-full flex flex-col overflow-hidden">
              {/* Output tabs */}
              <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 flex-shrink-0">
                {([
                  { key: 'ddl',        label: 'PostgreSQL DDL',   icon: Database },
                  { key: 'drizzle',    label: 'Drizzle Schema',   icon: FileCode2 },
                  { key: 'dictionary', label: 'Data Dictionary',  icon: BookOpen },
                  { key: 'validation', label: `Validation ${errCount > 0 ? `(${errCount} errors)` : warnCount > 0 ? `(${warnCount} warnings)` : ''}`, icon: AlertTriangle },
                ] as { key: typeof outputTab; label: string; icon: React.ElementType }[]).map(t => (
                  <button key={t.key} onClick={() => setOutputTab(t.key)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
                      ${outputTab === t.key ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700'}
                      ${t.key === 'validation' && errCount > 0 ? 'text-rose-600' : ''}`}>
                    <t.icon size={12} /> {t.label}
                  </button>
                ))}
                <div className="ml-auto flex gap-2">
                  {(outputTab === 'ddl' || outputTab === 'drizzle') && (
                    <>
                      <button onClick={() => copyToClipboard(outputTab === 'ddl' ? ddl : drizzle, setCopied)}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg text-xs hover:bg-gray-50 dark:hover:bg-slate-700">
                        {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />} {copied ? 'Copied!' : 'Copy'}
                      </button>
                      <button onClick={() => downloadText(outputTab === 'ddl' ? ddl : drizzle, outputTab === 'ddl' ? 'schema.sql' : 'schema.ts')}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-300 dark:border-slate-600 rounded-lg text-xs hover:bg-gray-50 dark:hover:bg-slate-700">
                        <Download size={12} /> Download
                      </button>
                    </>
                  )}
                  {!ddl && (
                    <button onClick={generate} disabled={generating || confirmedEntities.length === 0}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 disabled:opacity-40">
                      {generating ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />} Generate
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-auto">
                {/* DDL */}
                {outputTab === 'ddl' && (
                  ddl
                    ? <pre className="p-4 text-xs font-mono text-gray-800 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">{ddl}</pre>
                    : <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-slate-500">
                        <Database size={36} className="opacity-30 mb-3" />
                        <p>Confirm entities and relationships, then click <strong>Generate Outputs</strong> from the ERD step.</p>
                      </div>
                )}

                {/* Drizzle */}
                {outputTab === 'drizzle' && (
                  drizzle
                    ? <pre className="p-4 text-xs font-mono text-gray-800 dark:text-slate-200 leading-relaxed whitespace-pre-wrap">{drizzle}</pre>
                    : <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-slate-500">
                        <FileCode2 size={36} className="opacity-30 mb-3" />
                        <p>Generate outputs first.</p>
                      </div>
                )}

                {/* Dictionary */}
                {outputTab === 'dictionary' && (
                  dictionary.length > 0
                    ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs border-collapse">
                          <thead className="sticky top-0 bg-gray-50 dark:bg-slate-700">
                            <tr>
                              {['Table','Category','Column','Type','Null','Default','PK','FK','UQ','Description'].map(h => (
                                <th key={h} className="px-3 py-2 text-left font-semibold text-gray-600 dark:text-slate-300 border-b border-gray-200 dark:border-slate-600 whitespace-nowrap">{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 dark:divide-slate-700">
                            {dictionary.map((d, i) => (
                              <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-700/30">
                                <td className="px-3 py-1.5 font-mono font-medium text-blue-600 dark:text-blue-400 whitespace-nowrap">{d.tableName}</td>
                                <td className="px-3 py-1.5">{catBadge(d.tableCategory)}</td>
                                <td className="px-3 py-1.5 font-mono text-gray-800 dark:text-slate-200">{d.columnName}</td>
                                <td className="px-3 py-1.5 font-mono text-gray-500 dark:text-slate-400 whitespace-nowrap">{d.dataType}</td>
                                <td className="px-3 py-1.5 text-center">{d.nullable ? '✓' : <span className="text-rose-500">*</span>}</td>
                                <td className="px-3 py-1.5 font-mono text-gray-400 dark:text-slate-500">{d.defaultValue || '-'}</td>
                                <td className="px-3 py-1.5 text-center">{d.isPk ? <span className="text-amber-500 font-bold">PK</span> : ''}</td>
                                <td className="px-3 py-1.5 text-center">{d.isFk ? <span className="text-blue-400 font-bold">FK</span> : ''}</td>
                                <td className="px-3 py-1.5 text-center">{d.isUnique ? '✓' : ''}</td>
                                <td className="px-3 py-1.5 text-gray-500 dark:text-slate-400 max-w-xs truncate">{d.columnDescription || d.businessMeaning || '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
                    : <div className="flex flex-col items-center justify-center h-full text-gray-400 dark:text-slate-500">
                        <BookOpen size={36} className="opacity-30 mb-3" />
                        <p>Generate outputs first.</p>
                      </div>
                )}

                {/* Validation */}
                {outputTab === 'validation' && (
                  <div className="p-5 max-w-3xl mx-auto">
                    {validations.length === 0
                      ? <div className="flex flex-col items-center justify-center py-20 text-gray-400 dark:text-slate-500">
                          <CheckCircle2 size={36} className="opacity-30 mb-3 text-emerald-500" />
                          <p>No validation issues found. Your design looks good!</p>
                        </div>
                      : (
                        <div className="space-y-2">
                          {(['error','warning','info'] as ValidationIssue['severity'][]).map(sev => {
                            const items = validations.filter(v => v.severity === sev);
                            if (!items.length) return null;
                            const icons = { error: <XCircle size={14} className="text-rose-500" />, warning: <AlertTriangle size={14} className="text-amber-500" />, info: <Info size={14} className="text-blue-500" /> };
                            const cls = { error: 'border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/20', warning: 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/20', info: 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20' };
                            return items.map((v, i) => (
                              <div key={`${sev}_${i}`} className={`flex items-start gap-3 p-3 rounded-xl border ${cls[sev]} text-sm`}>
                                {icons[sev]}
                                <div className="flex-1">
                                  <p className="text-gray-800 dark:text-slate-200">{v.message}</p>
                                  {v.entityName && <p className="text-xs text-gray-500 dark:text-slate-400 mt-0.5">Entity: <code>{v.entityName}</code>{v.fieldName ? ` · Field: ${v.fieldName}` : ''}</p>}
                                </div>
                                <span className="text-[10px] uppercase font-semibold text-gray-400 dark:text-slate-500">{sev}</span>
                              </div>
                            ));
                          })}
                        </div>
                      )
                    }
                  </div>
                )}
              </div>
            </div>
          )}

        </div>
      </div>
    </>
  );
}
