import Head from 'next/head';
import { useState, useEffect, useRef, useCallback } from 'react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import {
  Brain, Loader2, Send, Save, CheckCircle2, AlertTriangle,
  ChevronDown, Database, Table2, Sparkles, Info, ArrowRight,
  RefreshCw, ExternalLink, X, ChevronRight,
} from 'lucide-react';
import Link from 'next/link';
import Navbar from '../components/Navbar';
import FooterBar from '../components/FooterBar';
import type { ConnectionRow } from './api/connections/index';
import type { MigTableInfo } from './api/migv2/tables';
import type { ChatSchemas, SourceTable, TargetTable } from './api/ai-migration/chat';
import type { SaveProposalResponse } from './api/ai-migration/save-proposal';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProposalColumn {
  sourceCol: string;
  targetCol: string;
  sourceMysqlType: string;
  targetPgType: string;
  conversion: string;
  nullable: boolean;
  defaultValue: string | null;
  notes?: string;
}

interface ProposalTable {
  source: { schema: string; table: string };
  target: { schema: string; table: string };
  order: number;
  confidence: 'high' | 'medium' | 'low';
  notes?: string;
  unmatched?: boolean;
  columns?: ProposalColumn[];
}

interface Proposal {
  tables: ProposalTable[];
  warnings?: string[];
  unmatched?: string[];
}

interface ChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  rawContent: string;
  proposal?: Proposal;
  ts: Date;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uid() { return Math.random().toString(36).slice(2); }

function connFromRow(row: ConnectionRow) {
  return {
    type: row.db_type === 'postgres' ? 'postgresql' : 'mysql',
    host: row.host, port: row.port,
    database: row.database_name,
    username: row.username,
    password: row.password_enc ?? '',
  } as const;
}

function getDisplayText(accText: string): string {
  const startIdx = accText.indexOf('[MAPPING_PROPOSAL]');
  if (startIdx === -1) return accText.trim();
  const endIdx = accText.indexOf('[/MAPPING_PROPOSAL]');
  if (endIdx !== -1) {
    return (accText.slice(0, startIdx) + accText.slice(endIdx + '[/MAPPING_PROPOSAL]'.length)).trim();
  }
  // Partial block mid-stream — show only text before the delimiter
  return accText.slice(0, startIdx).trim();
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DbSelect({ value, onChange, options, loading, placeholder }: {
  value: string; onChange: (v: string) => void;
  options: string[]; loading: boolean; placeholder: string;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-9 px-3 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg">
        <Loader2 size={14} className="animate-spin text-slate-500 dark:text-slate-400" />
      </div>
    );
  }
  if (options.length > 0) {
    return (
      <div className="relative">
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full appearance-none bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 pr-7 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
        >
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 pointer-events-none" />
      </div>
    );
  }
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
    />
  );
}

function ConnPanel({
  label, accent,
  connections, filter, connId, onConnChange,
  dbValue, onDbChange, schemaValue, onSchemaChange,
}: {
  label: string; accent: 'orange' | 'blue';
  connections: ConnectionRow[]; filter: 'mysql' | 'postgres';
  connId: number | null; onConnChange: (id: number | null) => void;
  dbValue: string; onDbChange: (v: string) => void;
  schemaValue?: string; onSchemaChange?: (v: string) => void;
}) {
  const filtered = connections.filter(c => c.db_type === filter);
  const conn = filtered.find(c => c.id === connId) ?? null;
  const [dbOpts, setDbOpts] = useState<string[]>([]);
  const [schemaOpts, setSchemaOpts] = useState<string[]>([]);
  const [loadingDb, setLoadingDb] = useState(false);
  const [loadingSchema, setLoadingSchema] = useState(false);

  useEffect(() => {
    if (!conn) { setDbOpts([]); setSchemaOpts([]); return; }
    setLoadingDb(true);
    fetch('/api/ai-migration/databases', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connFromRow(conn)),
    })
      .then(r => r.json())
      .then(data => {
        const list: string[] = data.databases ?? [];
        setDbOpts(list);
        if (list.length > 0) {
          const pick = list.includes(conn.database_name) ? conn.database_name : list[0];
          onDbChange(pick);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingDb(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  useEffect(() => {
    if (filter !== 'postgres' || !conn || !dbValue) { setSchemaOpts([]); return; }
    setLoadingSchema(true);
    fetch('/api/ai-migration/schemas', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conn: connFromRow(conn), database: dbValue }),
    })
      .then(r => r.json())
      .then(data => {
        const list: string[] = data.schemas ?? [];
        setSchemaOpts(list);
        if (list.length > 0 && onSchemaChange) {
          const pick = schemaValue && list.includes(schemaValue) ? schemaValue : (list.includes('public') ? 'public' : list[0]);
          onSchemaChange(pick);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingSchema(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, dbValue, filter]);

  const accentRing = accent === 'orange' ? 'focus:ring-orange-500' : 'focus:ring-blue-500';
  const accentBadge = accent === 'orange'
    ? 'bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300'
    : 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300';

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`text-[12px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${accentBadge}`}>{label}</span>
        <span className="text-[12px] text-gray-400 dark:text-slate-500">{filter === 'mysql' ? 'MySQL' : 'PostgreSQL'}</span>
      </div>
      <div className="flex gap-1.5 flex-wrap">
        <div className="relative flex-1 min-w-40">
          <select
            value={connId ?? ''}
            onChange={e => {
              onConnChange(e.target.value ? Number(e.target.value) : null);
              onDbChange('');
              onSchemaChange?.('');
            }}
            className={`w-full appearance-none bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 pr-7 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 ${accentRing} truncate`}
          >
            <option value="">Select connection…</option>
            {filtered.map(c => (
              <option key={c.id} value={c.id}>{c.label} — {c.host}/{c.database_name}</option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400 pointer-events-none" />
        </div>

        {conn && (
          <div className="w-28 shrink-0">
            <DbSelect value={dbValue} onChange={v => { onDbChange(v); onSchemaChange?.(''); }}
              options={dbOpts} loading={loadingDb} placeholder="database" />
          </div>
        )}

        {conn && filter === 'postgres' && onSchemaChange && (
          <div className="w-24 shrink-0">
            <DbSelect value={schemaValue ?? ''} onChange={onSchemaChange}
              options={schemaOpts} loading={loadingSchema} placeholder="schema" />
          </div>
        )}
      </div>

      {conn && dbValue && (
        <p className="mt-1 text-[12px] text-gray-400 dark:text-slate-500 truncate">
          {conn.host}:{conn.port} /&nbsp;
          <span className="font-medium text-gray-600 dark:text-slate-300">{dbValue}</span>
          {filter === 'postgres' && schemaValue && (
            <span> / <span className="font-medium text-violet-600 dark:text-violet-400">{schemaValue}</span></span>
          )}
        </p>
      )}
    </div>
  );
}

// ── Proposal Card ─────────────────────────────────────────────────────────────

const confidenceBadge: Record<string, string> = {
  high: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300',
  medium: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300',
  low: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
};

function ProposalCard({ proposal, onSave }: { proposal: Proposal; onSave: () => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const matched = proposal.tables.filter(t => !t.unmatched);
  const unmatched = proposal.unmatched ?? proposal.tables.filter(t => t.unmatched).map(t => t.source.table);

  return (
    <div className="mt-3 rounded-xl border border-violet-200 dark:border-violet-800 overflow-hidden bg-white dark:bg-slate-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-violet-50 dark:bg-violet-950/30 border-b border-violet-200 dark:border-violet-800">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-violet-600 dark:text-violet-400" />
          <span className="text-sm font-semibold text-violet-800 dark:text-violet-300">Mapping Proposal — Dry Run Preview</span>
          <span className="text-[12px] px-1.5 py-0.5 rounded-full bg-violet-200 dark:bg-violet-800 text-violet-700 dark:text-violet-300">
            {matched.length} table{matched.length !== 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={onSave}
          className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[13px] font-semibold bg-violet-600 hover:bg-violet-700 text-white transition-colors"
        >
          <Save size={13} />
          Save as Job
        </button>
      </div>

      {/* Warnings */}
      {proposal.warnings && proposal.warnings.length > 0 && (
        <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800">
          {proposal.warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <AlertTriangle size={13} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <span className="text-[13px] text-amber-700 dark:text-amber-400">{w}</span>
            </div>
          ))}
        </div>
      )}

      {/* Table rows */}
      <div className="divide-y divide-gray-100 dark:divide-slate-800">
        {matched.map(t => {
          const key = `${t.source.schema}.${t.source.table}`;
          const isOpen = expanded === key;
          return (
            <div key={key}>
              <button
                onClick={() => setExpanded(isOpen ? null : key)}
                className="w-full flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-800/40 transition-colors text-left"
              >
                <ChevronRight
                  size={14}
                  className={`text-gray-400 transition-transform shrink-0 ${isOpen ? 'rotate-90' : ''}`}
                />
                <span className="font-mono text-sm text-gray-800 dark:text-slate-200 font-medium">{t.source.table}</span>
                <ArrowRight size={13} className="text-slate-500 dark:text-slate-400 shrink-0" />
                <span className="font-mono text-sm text-violet-700 dark:text-violet-300 font-medium">{t.target.table}</span>
                <span className={`ml-auto text-[12px] font-semibold px-1.5 py-0.5 rounded-full shrink-0 ${confidenceBadge[t.confidence] ?? confidenceBadge.medium}`}>
                  {t.confidence}
                </span>
                {t.columns && (
                  <span className="text-[12px] text-gray-400 dark:text-slate-500 shrink-0">
                    {t.columns.length} col{t.columns.length !== 1 ? 's' : ''}
                  </span>
                )}
              </button>

              {isOpen && t.columns && (
                <div className="px-4 pb-3">
                  {t.notes && (
                    <p className="text-[13px] text-gray-500 dark:text-slate-400 mb-2 italic">{t.notes}</p>
                  )}
                  <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
                    <table className="w-full text-[13px]">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-slate-800/60">
                          <th className="text-left px-3 py-1.5 font-semibold text-gray-500 dark:text-slate-400">Source col</th>
                          <th className="text-left px-3 py-1.5 font-semibold text-gray-500 dark:text-slate-400">MySQL type</th>
                          <th className="text-left px-3 py-1.5 font-semibold text-gray-500 dark:text-slate-400">→ Target col</th>
                          <th className="text-left px-3 py-1.5 font-semibold text-gray-500 dark:text-slate-400">PG type</th>
                          <th className="text-left px-3 py-1.5 font-semibold text-gray-500 dark:text-slate-400">Conversion</th>
                        </tr>
                      </thead>
                      <tbody>
                        {t.columns.map((c, i) => (
                          <tr
                            key={c.sourceCol}
                            className={`border-t border-gray-100 dark:border-slate-800 ${i % 2 ? 'bg-gray-50/30 dark:bg-slate-800/10' : ''}`}
                          >
                            <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-slate-300">{c.sourceCol}</td>
                            <td className="px-3 py-1.5 font-mono text-gray-400 dark:text-slate-500">{c.sourceMysqlType}</td>
                            <td className="px-3 py-1.5 font-mono text-violet-700 dark:text-violet-300">{c.targetCol}</td>
                            <td className="px-3 py-1.5 font-mono text-blue-600 dark:text-blue-400">{c.targetPgType}</td>
                            <td className="px-3 py-1.5">
                              <span className={`px-1.5 py-0.5 rounded text-[12px] font-medium ${
                                c.conversion === 'keep'
                                  ? 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-400'
                                  : 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300'
                              }`}>
                                {c.conversion}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Unmatched */}
      {unmatched.length > 0 && (
        <div className="px-4 py-2.5 border-t border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-800/20">
          <p className="text-[13px] text-gray-500 dark:text-slate-400 mb-1 font-medium">
            {unmatched.length} unmatched source table{unmatched.length !== 1 ? 's' : ''} (no target match found):
          </p>
          <div className="flex flex-wrap gap-1">
            {unmatched.map(n => (
              <span key={n} className="text-[12px] font-mono px-1.5 py-0.5 rounded bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-slate-400">
                {n}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

function MessageBubble({ msg, onSave }: { msg: ChatMsg; onSave: (proposal: Proposal) => void }) {
  const isUser = msg.role === 'user';

  return (
    <div className={`flex gap-2.5 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
        isUser
          ? 'bg-violet-600 text-white'
          : 'bg-gradient-to-br from-violet-500 to-blue-600 text-white'
      }`}>
        {isUser ? (
          <span className="text-[12px] font-bold">You</span>
        ) : (
          <Brain size={15} />
        )}
      </div>

      <div className={`flex-1 min-w-0 max-w-[85%] ${isUser ? 'flex flex-col items-end' : ''}`}>
        <div className={`rounded-xl px-4 py-3 text-base leading-relaxed whitespace-pre-wrap break-words ${
          isUser
            ? 'bg-violet-600 text-white rounded-tr-sm'
            : 'bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 border border-gray-200 dark:border-slate-700 rounded-tl-sm'
        }`}>
          {msg.text || <span className="opacity-50 italic">…</span>}
        </div>

        {msg.proposal && !isUser && (
          <ProposalCard proposal={msg.proposal} onSave={() => onSave(msg.proposal!)} />
        )}

        <p className="mt-1 text-[12px] text-gray-400 dark:text-slate-500">
          {msg.ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </div>
  );
}

// ── Save Job Dialog ────────────────────────────────────────────────────────────

function SaveJobDialog({
  proposal, sourceConn, targetConn, sourceDb, targetDb, targetSchema,
  onClose, onSaved,
}: {
  proposal: Proposal;
  sourceConn: ConnectionRow; targetConn: ConnectionRow;
  sourceDb: string; targetDb: string; targetSchema: string;
  onClose: () => void;
  onSaved: (result: SaveProposalResponse) => void;
}) {
  const defaultName = `${sourceDb} → ${targetDb}.${targetSchema} (AI, ${new Date().toLocaleDateString('en-GB')})`;
  const [jobName, setJobName] = useState(defaultName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (!jobName.trim()) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/ai-migration/save-proposal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceConn: connFromRow(sourceConn),
          targetConn: connFromRow(targetConn),
          sourceDb, targetDb, targetPgSchema: targetSchema,
          jobName: jobName.trim(),
          proposal,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save');
      onSaved(data as SaveProposalResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-slate-700 w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Save size={17} className="text-violet-600" />
            <span className="font-semibold text-gray-800 dark:text-slate-200">Save Migration Job</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
            <X size={18} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="p-3 rounded-lg bg-violet-50 dark:bg-violet-950/30 border border-violet-200 dark:border-violet-800 text-sm text-violet-700 dark:text-violet-400">
            <strong>{proposal.tables.filter(t => !t.unmatched).length}</strong> table mapping{proposal.tables.filter(t => !t.unmatched).length !== 1 ? 's' : ''} will be saved as a migration job.
            You can review and run it from the <strong>Migration</strong> module.
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-600 dark:text-slate-400 mb-1.5">Job name</label>
            <input
              value={jobName}
              onChange={e => setJobName(e.target.value)}
              className="w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-base text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </div>
          {error && (
            <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-400">
              {error}
            </div>
          )}
          <div className="flex gap-2 justify-end">
            <button onClick={onClose} className="px-4 py-2 text-base rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!jobName.trim() || saving}
              className="flex items-center gap-2 px-4 py-2 text-base font-semibold rounded-lg bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {saving ? 'Saving…' : 'Save Job'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AiMigrationPage() {
  const [connections, setConnections] = useState<ConnectionRow[]>([]);

  // Source (MySQL)
  const [srcId, setSrcId] = useState<number | null>(null);
  const [srcDb, setSrcDb] = useState('');

  // Target (PG)
  const [tgtId, setTgtId] = useState<number | null>(null);
  const [tgtDb, setTgtDb] = useState('');
  const [tgtSchema, setTgtSchema] = useState('public');

  // Tables
  const [srcTables, setSrcTables] = useState<MigTableInfo[]>([]);
  const [tgtTables, setTgtTables] = useState<TargetTable[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingSrc, setLoadingSrc] = useState(false);
  const [loadingTgt, setLoadingTgt] = useState(false);

  // Chat
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [cachedSchemas, setCachedSchemas] = useState<ChatSchemas | null>(null);
  const [latestProposal, setLatestProposal] = useState<Proposal | null>(null);
  const [pendingText, setPendingText] = useState('');

  // Save dialog
  const [showSave, setShowSave] = useState(false);
  const [proposalToSave, setProposalToSave] = useState<Proposal | null>(null);
  const [savedResult, setSavedResult] = useState<SaveProposalResponse | null>(null);

  const chatRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const srcConn = connections.find(c => c.id === srcId) ?? null;
  const tgtConn = connections.find(c => c.id === tgtId) ?? null;

  const ready = !!srcConn && !!srcDb && !!tgtConn && !!tgtDb && !!tgtSchema && selected.size > 0;

  // Load connections
  useEffect(() => {
    fetch('/api/connections')
      .then(r => r.json())
      .then(data => setConnections(data.connections ?? []))
      .catch(() => {});
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    const el = chatRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pendingText, statusMsg]);

  // Load source tables
  async function loadSourceTables() {
    if (!srcConn || !srcDb) return;
    setLoadingSrc(true);
    setSrcTables([]);
    setSelected(new Set());
    try {
      const res = await fetch('/api/migv2/tables', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...connFromRow(srcConn), database: srcDb }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed');
      const list: MigTableInfo[] = data.tables ?? [];
      setSrcTables(list);
      setSelected(new Set(list.map(t => `${t.schema}.${t.name}`)));
    } catch { /* ignore */ }
    finally { setLoadingSrc(false); }
  }

  // Auto-load target tables when target conn+schema changes
  useEffect(() => {
    if (!tgtConn || !tgtDb || !tgtSchema) { setTgtTables([]); return; }
    setLoadingTgt(true);
    setTgtTables([]);
    // Re-use the migv2/tables API which supports PG
    fetch('/api/migv2/tables', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...connFromRow(tgtConn), database: tgtDb }),
    })
      .then(r => r.json())
      .then(data => {
        const all: MigTableInfo[] = data.tables ?? [];
        // Filter by selected schema
        const inSchema = all.filter(t => t.schema === tgtSchema);
        setTgtTables(inSchema.map(t => ({
          schema: t.schema, name: t.name, columns: [],
        } as unknown as TargetTable)));
      })
      .catch(() => {})
      .finally(() => setLoadingTgt(false));
  // eslint-disable name-deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgtId, tgtDb, tgtSchema]);

  // Reset chat when connections change
  useEffect(() => {
    setMessages([]);
    setCachedSchemas(null);
    setLatestProposal(null);
    setSavedResult(null);
    setPendingText('');
  }, [srcId, srcDb, tgtId, tgtDb, tgtSchema]);

  function toggleTable(key: string) {
    setSelected(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  }
  function toggleAll() {
    setSelected(selected.size === srcTables.length ? new Set() : new Set(srcTables.map(t => `${t.schema}.${t.name}`)));
  }

  // ── SSE Chat call ──────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (userText: string) => {
    if (!srcConn || !tgtConn || isLoading) return;

    const userMsg: ChatMsg = { id: uid(), role: 'user', text: userText, rawContent: userText, ts: new Date() };
    const updatedMsgs = [...messages, userMsg];
    setMessages(updatedMsgs);
    setInput('');
    setIsLoading(true);
    setStatusMsg('');
    setPendingText('');

    // Build API messages (full history including raw content)
    const apiMessages = updatedMsgs.map(m => ({ role: m.role, content: m.rawContent }));

    const selectedTableList = srcTables
      .filter(t => selected.has(`${t.schema}.${t.name}`))
      .map(t => ({ schema: t.schema, name: t.name, rowCount: t.rowCount }));

    try {
      const res = await fetch('/api/ai-migration/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceConn: { ...connFromRow(srcConn), database: srcDb },
          targetConn: { ...connFromRow(tgtConn), database: tgtDb },
          sourceDb: srcDb,
          targetDb: tgtDb,
          targetPgSchema: tgtSchema,
          sourceTables: selectedTableList,
          messages: apiMessages,
          schemas: cachedSchemas ?? undefined,
        }),
      });

      if (!res.ok || !res.body) throw new Error('Failed to connect to AI');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let accText = '';
      let newProposal: Proposal | null = null;
      let newSchemas: ChatSchemas | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';

        for (const part of parts) {
          const lines = part.split('\n');
          let evtType = '';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
          }
          if (!dataStr || evtType === 'ping') continue;

          try {
            const payload = JSON.parse(dataStr);
            if (evtType === 'status') {
              setStatusMsg(payload.message ?? '');
            } else if (evtType === 'schemas') {
              newSchemas = payload as ChatSchemas;
              setCachedSchemas(newSchemas);
            } else if (evtType === 'text') {
              accText += payload.chunk ?? '';
              setPendingText(getDisplayText(accText));
            } else if (evtType === 'proposal') {
              newProposal = payload as Proposal;
              setLatestProposal(newProposal);
            } else if (evtType === 'error') {
              throw new Error(payload.message ?? 'AI error');
            }
          } catch (parseErr) {
            if (evtType === 'error') throw new Error(String(parseErr));
          }
        }
      }

      const displayText = getDisplayText(accText);
      const assistantMsg: ChatMsg = {
        id: uid(),
        role: 'assistant',
        text: displayText,
        rawContent: accText,
        proposal: newProposal ?? undefined,
        ts: new Date(),
      };
      setMessages(prev => [...prev, assistantMsg]);
    } catch (err) {
      const errMsg: ChatMsg = {
        id: uid(), role: 'assistant',
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
        rawContent: '',
        ts: new Date(),
      };
      setMessages(prev => [...prev, errMsg]);
    } finally {
      setIsLoading(false);
      setStatusMsg('');
      setPendingText('');
    }
  }, [srcConn, tgtConn, isLoading, messages, srcTables, selected, srcDb, tgtDb, tgtSchema, cachedSchemas]);

  function handleAnalyze() {
    const tableNames = srcTables
      .filter(t => selected.has(`${t.schema}.${t.name}`))
      .map(t => t.name)
      .join(', ');
    sendMessage(
      `Please analyze my MySQL source schema (tables: ${tableNames}) and find the best matching existing tables in PostgreSQL schema "${tgtSchema}". Generate a complete mapping proposal with column type conversions, ordering by FK dependencies, and flag any potential data compatibility issues.`
    );
  }

  function handleSend() {
    const text = input.trim();
    if (!text || isLoading) return;
    sendMessage(text);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function openSaveDialog(proposal: Proposal) {
    setProposalToSave(proposal);
    setShowSave(true);
  }

  function handleSaved(result: SaveProposalResponse) {
    setSavedResult(result);
    setShowSave(false);
    setProposalToSave(null);
  }

  return (
    <>
      <Head><title>AI Migration Assistant</title></Head>
      <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 overflow-hidden">
        <Navbar />

        {/* Page header */}
        <div className="shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <div className="px-4 py-3">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center">
                <Brain size={16} className="text-white" />
              </div>
              <h1 className="text-lg font-semibold text-gray-900 dark:text-slate-100">AI Migration Assistant</h1>
              <span className="text-[12px] px-2 py-0.5 rounded-full bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-400 font-medium">Scenario 1 · Existing Target</span>
              {savedResult && (
                <Link href="/migration" className="ml-auto flex items-center gap-1.5 text-sm text-violet-600 dark:text-violet-400 hover:underline">
                  <CheckCircle2 size={15} className="text-emerald-500" />
                  Job saved: {savedResult.jobName}
                  <ExternalLink size={13} />
                </Link>
              )}
            </div>

            {/* Connection panels */}
            <div className="flex gap-4">
              <ConnPanel
                label="Source" accent="orange"
                connections={connections} filter="mysql"
                connId={srcId} onConnChange={id => { setSrcId(id); setSrcDb(''); }}
                dbValue={srcDb} onDbChange={setSrcDb}
              />
              <div className="flex items-center pt-4">
                <ArrowRight size={18} className="text-slate-400 dark:text-slate-500 shrink-0" />
              </div>
              <ConnPanel
                label="Target" accent="blue"
                connections={connections} filter="postgres"
                connId={tgtId} onConnChange={id => { setTgtId(id); setTgtDb(''); setTgtSchema('public'); }}
                dbValue={tgtDb} onDbChange={setTgtDb}
                schemaValue={tgtSchema} onSchemaChange={setTgtSchema}
              />
            </div>
          </div>
        </div>

        {/* Main content */}
        <div className="flex-1 min-h-0">
          <PanelGroup orientation="horizontal">
            {/* Left: Tables sidebar */}
            <Panel defaultSize={28} minSize={18}>
              <div className="h-full flex flex-col border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                {/* Source tables */}
                <div className="flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60 shrink-0">
                    <div className="flex items-center gap-1.5">
                      <Database size={14} className="text-orange-500" />
                      <span className="text-[13px] font-semibold text-gray-600 dark:text-slate-400 uppercase tracking-wide">Source Tables</span>
                    </div>
                    <button
                      onClick={loadSourceTables}
                      disabled={!srcConn || !srcDb || loadingSrc}
                      className="flex items-center gap-1 text-[12px] text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {loadingSrc ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                      Load
                    </button>
                  </div>

                  {srcTables.length > 0 ? (
                    <>
                      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 dark:border-slate-800 shrink-0">
                        <span className="text-[12px] text-gray-400 dark:text-slate-500">
                          {selected.size}/{srcTables.length} selected
                        </span>
                        <button onClick={toggleAll} className="text-[12px] text-violet-600 dark:text-violet-400 hover:underline">
                          {selected.size === srcTables.length ? 'None' : 'All'}
                        </button>
                      </div>
                      <div className="flex-1 overflow-y-auto">
                        {srcTables.map(t => {
                          const key = `${t.schema}.${t.name}`;
                          return (
                            <label key={key} className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 dark:hover:bg-slate-800/40 cursor-pointer border-b border-gray-50 dark:border-slate-800/60 last:border-0">
                              <input
                                type="checkbox"
                                checked={selected.has(key)}
                                onChange={() => toggleTable(key)}
                                className="rounded border-gray-300 dark:border-slate-600 text-violet-600 focus:ring-violet-500 w-3 h-3"
                              />
                              <span className="text-[13px] text-gray-700 dark:text-slate-300 flex-1 truncate font-mono">{t.name}</span>
                              <span className="text-[12px] text-gray-400 dark:text-slate-500 shrink-0 tabular-nums">
                                {t.rowCount.toLocaleString()}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex items-center justify-center p-4">
                      <p className="text-[13px] text-gray-400 dark:text-slate-500 text-center">
                        {srcConn && srcDb ? 'Click Load to fetch tables' : 'Select a MySQL connection first'}
                      </p>
                    </div>
                  )}
                </div>

                {/* Target tables */}
                <div className="border-t border-gray-200 dark:border-slate-700 shrink-0" style={{ maxHeight: '40%' }}>
                  <div className="flex items-center gap-1.5 px-3 py-2.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/60">
                    <Database size={14} className="text-blue-500" />
                    <span className="text-[13px] font-semibold text-gray-600 dark:text-slate-400 uppercase tracking-wide">Target Tables</span>
                    {loadingTgt && <Loader2 size={12} className="animate-spin text-slate-500 dark:text-slate-400 ml-auto" />}
                    {!loadingTgt && tgtTables.length > 0 && (
                      <span className="ml-auto text-[12px] text-gray-400">{tgtTables.length}</span>
                    )}
                  </div>
                  <div className="overflow-y-auto" style={{ maxHeight: 'calc(40vh - 40px)' }}>
                    {tgtTables.length > 0 ? tgtTables.map(t => (
                      <div key={t.name} className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-50 dark:border-slate-800/60 last:border-0">
                        <Table2 size={12} className="text-blue-400 shrink-0" />
                        <span className="text-[13px] text-gray-600 dark:text-slate-400 font-mono truncate">{t.name}</span>
                      </div>
                    )) : (
                      <p className="px-3 py-3 text-[13px] text-gray-400 dark:text-slate-500">
                        {tgtConn && tgtDb ? 'Loading…' : 'Select target connection'}
                      </p>
                    )}
                  </div>
                </div>

                {/* Analyze button */}
                <div className="p-3 border-t border-gray-200 dark:border-slate-700 shrink-0">
                  <button
                    onClick={handleAnalyze}
                    disabled={!ready || isLoading}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-base font-semibold bg-gradient-to-r from-violet-600 to-blue-600 hover:from-violet-700 hover:to-blue-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-sm"
                  >
                    {isLoading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                    {isLoading ? 'Analyzing…' : 'Analyze & Map'}
                  </button>
                  {!ready && (
                    <p className="mt-1.5 text-[12px] text-center text-gray-400 dark:text-slate-500">
                      {!srcConn || !srcDb ? 'Select source connection' :
                        !tgtConn || !tgtDb ? 'Select target connection' :
                        selected.size === 0 ? 'Select tables to analyze' : ''}
                    </p>
                  )}
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-violet-400 dark:hover:bg-violet-500 cursor-col-resize transition-colors" />

            {/* Right: Chat area */}
            <Panel defaultSize={72} minSize={30}>
              <div className="h-full flex flex-col bg-gray-50 dark:bg-slate-950">
                {/* Messages */}
                <div ref={chatRef} className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
                  {messages.length === 0 && !isLoading && (
                    <div className="flex flex-col items-center justify-center h-full text-center space-y-4 py-16">
                      <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-lg">
                        <Brain size={26} className="text-white" />
                      </div>
                      <div>
                        <h2 className="text-lg font-semibold text-gray-700 dark:text-slate-300 mb-1">
                          AI Migration Assistant
                        </h2>
                        <p className="text-base text-gray-400 dark:text-slate-500 max-w-sm leading-relaxed">
                          Select your source (MySQL) and target (PostgreSQL) connections, load source tables, then click <strong className="text-violet-600 dark:text-violet-400">Analyze & Map</strong> to start.
                        </p>
                      </div>
                      <div className="grid grid-cols-1 gap-2 text-left max-w-sm w-full">
                        {[
                          { icon: Database, text: 'Reads both source and target schemas' },
                          { icon: Sparkles, text: 'Matches tables by name and column similarity' },
                          { icon: ArrowRight, text: 'Maps column types with safe conversions' },
                          { icon: Save, text: 'Saves confirmed mapping as a migration job' },
                        ].map(({ icon: Icon, text }, i) => (
                          <div key={i} className="flex items-center gap-2.5 p-2.5 rounded-lg bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-800">
                            <Icon size={15} className="text-violet-500 shrink-0" />
                            <span className="text-sm text-gray-600 dark:text-slate-400">{text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {messages.map(msg => (
                    <MessageBubble key={msg.id} msg={msg} onSave={openSaveDialog} />
                  ))}

                  {/* Streaming indicator */}
                  {isLoading && (
                    <div className="flex gap-2.5">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                        <Brain size={15} className="text-white" />
                      </div>
                      <div className="flex-1 max-w-[85%]">
                        {statusMsg && (
                          <div className="flex items-center gap-2 mb-2 text-sm text-gray-400 dark:text-slate-500">
                            <Loader2 size={13} className="animate-spin" />
                            {statusMsg}
                          </div>
                        )}
                        {pendingText && (
                          <div className="rounded-xl rounded-tl-sm px-4 py-3 text-base leading-relaxed bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 border border-gray-200 dark:border-slate-700 whitespace-pre-wrap">
                            {pendingText}
                            <span className="inline-block w-1.5 h-4 bg-violet-500 animate-pulse ml-0.5 align-text-bottom rounded-sm" />
                          </div>
                        )}
                        {!pendingText && !statusMsg && (
                          <div className="flex items-center gap-1 px-4 py-3">
                            {[0, 1, 2].map(i => (
                              <span key={i} className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Input area */}
                <div className="shrink-0 border-t border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
                  {latestProposal && !isLoading && (
                    <div className="flex items-center gap-2 mb-2.5">
                      <Info size={13} className="text-violet-500 shrink-0" />
                      <span className="text-[13px] text-gray-500 dark:text-slate-400">
                        Proposal ready — {latestProposal.tables.filter(t => !t.unmatched).length} table mapping{latestProposal.tables.filter(t => !t.unmatched).length !== 1 ? 's' : ''}.
                        Ask AI to refine, or save it.
                      </span>
                      <button
                        onClick={() => openSaveDialog(latestProposal)}
                        className="ml-auto flex items-center gap-1.5 px-3 py-1 rounded-lg text-[13px] font-semibold bg-violet-600 hover:bg-violet-700 text-white transition-colors"
                      >
                        <Save size={13} />
                        Save as Job
                      </button>
                    </div>
                  )}

                  <div className="flex gap-2 items-end">
                    <textarea
                      ref={inputRef}
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      rows={2}
                      placeholder={
                        messages.length === 0
                          ? 'Type a message or click Analyze & Map →'
                          : 'Ask AI to refine the mapping… (Enter to send, Shift+Enter for newline)'
                      }
                      disabled={isLoading}
                      className="flex-1 bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl px-3.5 py-2.5 text-base text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none disabled:opacity-50"
                    />
                    <button
                      onClick={handleSend}
                      disabled={!input.trim() || isLoading}
                      className="flex items-center justify-center w-10 h-10 rounded-xl bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                    >
                      {isLoading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                    </button>
                  </div>
                </div>
              </div>
            </Panel>
          </PanelGroup>
        </div>

        <FooterBar />
      </div>

      {/* Save dialog */}
      {showSave && proposalToSave && srcConn && tgtConn && (
        <SaveJobDialog
          proposal={proposalToSave}
          sourceConn={srcConn} targetConn={tgtConn}
          sourceDb={srcDb} targetDb={tgtDb} targetSchema={tgtSchema}
          onClose={() => { setShowSave(false); setProposalToSave(null); }}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}
