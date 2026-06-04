'use client';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Database, ExternalLink, FileCode, FileText, Layers, Loader2,
  Pencil, Play, Plus, Undo2, Save, Search,
  Table2, Terminal, Trash2, X, AlertTriangle, CheckCircle2, Clock,
  Network,
} from 'lucide-react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { Tooltip } from '../components/Tooltip';
import { useAlert } from '../lib/alert-context';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { suggestTargetType, isPkLikeSerial } from '../lib/migv2/type-map';
import type { MigConn, TableMap, ColumnMap, MigJob, MigJobSummary, MigJobTableSummary, MigRun, MigRunTableState, IdConversion } from '../lib/migv2/types';
import type { MigTableInfo } from './api/migv2/tables';
import type { MigColumnInfo } from './api/migv2/columns';
import type { ConnectionRow } from './api/connections/index';

// ── Helpers ───────────────────────────────────────────────────────────────────

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function connRowToMigConn(row: ConnectionRow, database: string): MigConn {
  return {
    type: row.db_type === 'postgres' ? 'postgresql' : 'mysql',
    host: row.host,
    port: row.port,
    database,
    username: row.username,
    password: row.password_enc ?? '',
  };
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300',
    running: 'bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-300',
    completed: 'bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300',
    failed: 'bg-rose-100 dark:bg-rose-950/50 text-rose-700 dark:text-rose-300',
    rolled_back: 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300',
  };
  const Icon = status === 'running' ? Loader2
    : status === 'completed' ? CheckCircle2
    : status === 'failed' ? AlertTriangle
    : status === 'rolled_back' ? Undo2
    : Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${map[status] ?? map.pending}`}>
      <Icon size={9} className={status === 'running' ? 'animate-spin' : ''} />
      {({ rolled_back: 'rolled back' } as Record<string, string>)[status] ?? status}
    </span>
  );
}

// ── fmtVal ────────────────────────────────────────────────────────────────────

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'object') return JSON.stringify(v);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
}

// ── ConnSelect ────────────────────────────────────────────────────────────────

function ConnSelect({ connections, value, onChange, onNew, accent = 'blue' }: {
  connections: ConnectionRow[];
  value: number | null;
  onChange: (id: number | null) => void;
  onNew: () => void;
  accent?: 'blue' | 'violet';
}) {
  const focusCls = accent === 'violet' ? 'focus:border-violet-400' : 'focus:border-blue-400';
  return (
    <select
      value={value ?? ''}
      onChange={e => {
        if (e.target.value === '__new__') { onNew(); return; }
        onChange(e.target.value ? Number(e.target.value) : null);
      }}
      className={`w-full px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none ${focusCls} cursor-pointer`}
    >
      <option value="">— select connection —</option>
      {(['postgres', 'mysql'] as const).map(type => {
        const group = connections.filter(c => c.db_type === type);
        if (!group.length) return null;
        return (
          <optgroup key={type} label={type === 'postgres' ? 'PostgreSQL' : 'MySQL'}>
            {group.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </optgroup>
        );
      })}
      <option value="__new__">+ New Connection →</option>
    </select>
  );
}

// ── Guide ─────────────────────────────────────────────────────────────────────

const MIGRATION_GUIDE_SECTIONS = [
  {
    title: 'Overview',
    icon: '①',
    color: 'text-blue-600 dark:text-blue-400',
    body: [
      'This module maps and migrates tables between any two databases (MySQL → PostgreSQL or reverse). It auto-creates the target database, schema, and table if they do not exist.',
      'Serial/auto-increment primary keys are converted to deterministic UUIDs. The original integer is preserved in a separate BIGINT column (e.g. old_id) so parent-table FK references stay intact.',
      'Migration runs in chunks of 500 rows. Each run can be rolled back by deleting inserted PKs, or by TRUNCATE if more than 5,000 rows were inserted.',
    ],
  },
  {
    title: 'Connect source & target',
    icon: '②',
    color: 'text-violet-600 dark:text-violet-400',
    body: [
      'Pick a saved connection for Source (MySQL) and Target (PostgreSQL). Passwords are resolved from the stored connection record.',
      'Select the source database from the dropdown — only tables belonging to that database are listed.',
      'For the target, select an existing database or click "+ New DB" to create one on the fly. Click "+ New Schema" to type a custom schema name — the runner runs CREATE SCHEMA IF NOT EXISTS automatically.',
      'The target table list refreshes automatically after a completed migration run.',
    ],
  },
  {
    title: 'Select tables',
    icon: '③',
    color: 'text-amber-600 dark:text-amber-400',
    body: [
      'Check the tables you want to migrate. Clicking a table row opens the column mapping panel.',
      'After a completed run, migrated tables show a strikethrough name and a green ✓ badge — but only when the job is saved. Unsaved jobs never show strikethrough.',
      'The strikethrough resets when you load a different saved job.',
    ],
  },
  {
    title: 'Column mapping',
    icon: '④',
    color: 'text-teal-600 dark:text-teal-400',
    body: [
      'Src Col → Tgt Col — map each source column to the corresponding target column. Set to "— none —" to exclude a column from the INSERT.',
      'Tgt Type — auto-inferred from the source type; editable. UUID is set automatically for serial_to_uuid columns.',
      'Conv — transformation applied per-value: keep (copy as-is), →UUID (serial int → UUID v4), →TEXT/INT/BIGINT/NUMERIC/BOOL/TIMESTAMPTZ/DATE/JSONB.',
      'Keep Orig — only for →UUID columns. Auto-set to old_<colname> on load. Stores the original MySQL integer in a separate BIGINT column alongside the UUID. Clear with ✕ to disable.',
      'FK Ref — if this is a FK column pointing to a UUID-converted PK in another table, enter the source schema.table (e.g. public.users). The migrator derives the same deterministic UUID for the FK value.',
      'Include checkbox — uncheck to exclude a column entirely from the migration.',
    ],
  },
  {
    title: 'UUID conversion',
    icon: '⑤',
    color: 'text-pink-600 dark:text-pink-400',
    body: [
      'serial_to_uuid converts MySQL INT/BIGINT PKs to UUID v4 using SHA-256(schema.table + "\\0" + id). The same integer always produces the same UUID across runs.',
      'The old_<colname> BIGINT column is created in the target table alongside the UUID PK. Other tables can FK via this column if they have not been migrated yet.',
      'For child tables: set fkRef = "source_schema.parent_table" on the FK column. The migrator applies the same seqToUUID() function, so the FK resolves to the correct UUID without a pre-pass.',
    ],
  },
  {
    title: 'Jobs',
    icon: '⑥',
    color: 'text-green-600 dark:text-green-400',
    body: [
      'Save Job — saves the current source/target connection meta and full column mapping config. Unsaved changes are tracked with an "unsaved changes" badge in the header.',
      'Save as existing — in the Save dialog, pick any saved job from the list to overwrite it with the current table mappings. The button label changes to "Update Job". Use this to consolidate multiple migration sessions under one job for export.',
      'Load — restores the full column mapping from a saved job, including source/target connection, schema, and per-column conversions.',
      'Export MD — downloads the current job mapping as a Markdown document (table list, column mapping, source/target meta).',
    ],
  },
  {
    title: 'Run & rollback',
    icon: '⑦',
    color: 'text-rose-600 dark:text-rose-400',
    body: [
      'Click Migrate to start. The run console appears at the bottom showing per-table progress, row counts, and logs.',
      'The runner processes tables sequentially in chunks of 500 rows. INSERT ON CONFLICT DO NOTHING prevents duplicate row errors on re-runs.',
      'Rollback — deletes inserted rows by their PK list (tracked up to 5,000 rows). If more than 5,000 rows were inserted, rollback falls back to TRUNCATE CASCADE. The rollback SQL is included in the Export MD report.',
      'After a completed run the target table list refreshes automatically and migrated source tables are marked with strikethrough.',
    ],
  },
  {
    title: 'Incremental sync & zero-downtime cutover',
    icon: '⑧',
    color: 'text-cyan-600 dark:text-cyan-400',
    body: [
      'Incremental sync lets you keep the target in sync with the source while your app is still running on the old DB — so the final cutover window is seconds, not hours.',
      'Enable it per-table: click the ⟳ Full toggle on any table row to switch to ⟳ Incremental. Pick a watermark column (e.g. id or updated_at) and a strategy — "by ID" for append-only tables, "by Timestamp" for tables with an updated_at column (uses UPSERT instead of INSERT).',
      'Phase 1 — Full migration: run a normal full migration to copy all existing rows to the target. Save the job once done.',
      'Phase 2 — Delta syncs: with Incremental mode on, every subsequent run only fetches rows WHERE watermark_col > last_synced_value. The watermark advances automatically after each run. Repeat this as often as needed while the source DB is live.',
      'Phase 3 — Cutover: stop writes to the source (put app in maintenance mode or pause writes), run one final incremental sync to capture the last few rows, verify row counts match, then switch the app connection to PostgreSQL.',
      'Reset watermark — click the ✕ next to the watermark value to force a full re-sync on the next run. Use this if rows were updated retroactively and the timestamp strategy may have missed them.',
      'Strategy choice — use "by ID" when rows are only ever inserted (never updated). Use "by Timestamp" when rows can be updated after insert; this will UPSERT on conflict using the target PK.',
    ],
  },
  {
    title: 'CLI script — large migrations (1000+ tables)',
    icon: '⑨',
    color: 'text-amber-600 dark:text-amber-400',
    body: [
      'For databases with hundreds or thousands of tables, the web runner can be resource-constrained (browser polling, server memory, long-lived HTTP). The CLI script runs the same migration logic directly on any machine — no browser, no server process needed.',
      'Export — save the job first, then click the terminal (⌨) icon in the Jobs panel. A standalone Python 3 script is downloaded as migrate_<jobname>.py. The script embeds all connection config and column mappings from the saved job.',
      'Install dependencies (once): pip install psycopg2-binary mysql-connector-python',
      'Run — supply passwords via env vars to avoid interactive prompts: SRC_PASSWORD=... TGT_PASSWORD=... python3 migrate_myjob.py',
      '--batch START-END — process only a slice of tables (1-based). Split a 1000-table job into manageable runs: --batch 1-100, then --batch 101-200, etc. Each batch runs independently and can be parallelised across machines.',
      '--chunk-size N — rows per INSERT batch. Default is 500 (same as the web runner). Raise to 1000–5000 for CLI runs on fast networks to improve throughput.',
      '--dry-run — counts source rows and applies all transforms but writes nothing to the target. Use to verify connectivity and estimate run time before committing.',
      '--reset — ignores the saved state file and restarts all tables from offset 0.',
      'Resume — after every chunk, progress is written to <jobId>_state.json. If the script is interrupted, re-running it skips completed tables and resumes from the last saved offset. Keep this file alongside the script.',
      'Passwords — never stored in the script. Supply via SRC_PASSWORD / TGT_PASSWORD environment variables, or the script will prompt interactively. For scheduled/automated runs, inject via your CI/CD secrets or a .env file sourced before execution.',
    ],
  },
] as const;

function MigrationGuidePopover() {
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
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-colors
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
              <Network size={13} className="text-blue-500" />
              <p className="text-sm font-semibold text-gray-800 dark:text-slate-100">Migration — Guide</p>
            </div>
            <button onClick={() => setOpen(false)} className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-200">
              <X size={13} />
            </button>
          </div>
          <div className="overflow-y-auto max-h-[70vh] divide-y divide-gray-100 dark:divide-slate-800">
            {MIGRATION_GUIDE_SECTIONS.map(sec => (
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

// ── DbMultiSelect ─────────────────────────────────────────────────────────────

function DbMultiSelect({ dbs, selected, onChange }: {
  dbs: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const label = selected.length === 0
    ? '— select database —'
    : selected.length === 1
      ? selected[0]
      : `${selected.length} databases`;

  const toggle = (db: string) =>
    onChange(selected.includes(db) ? selected.filter(d => d !== db) : [...selected, db]);

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between gap-1.5 px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 hover:border-blue-400 focus:outline-none focus:border-blue-400 transition-colors font-mono"
      >
        <span className={`flex-1 text-left truncate ${selected.length === 0 ? 'text-gray-400 dark:text-slate-500' : ''}`}>{label}</span>
        <ChevronDown size={11} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-0.5 w-full rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100 dark:border-slate-700">
            <span className="text-[9px] uppercase tracking-wider text-gray-400 dark:text-slate-500 font-semibold">Databases</span>
            <div className="flex items-center gap-2">
              <button onClick={() => onChange(dbs)} className="text-[9px] text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">all</button>
              <button onClick={() => onChange([])} className="text-[9px] text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">clear</button>
            </div>
          </div>
          <div className="max-h-40 overflow-y-auto">
            {dbs.map(db => (
              <label key={db} className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-blue-50 dark:hover:bg-blue-950/20 transition-colors border-b border-gray-50 dark:border-slate-700/50 last:border-0">
                <input
                  type="checkbox"
                  checked={selected.includes(db)}
                  onChange={() => toggle(db)}
                  className="accent-blue-500 shrink-0"
                />
                <span className="text-[11px] font-mono text-gray-700 dark:text-slate-300 truncate flex-1">{db}</span>
                {selected.includes(db) && <Check size={9} className="shrink-0 text-blue-500" />}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Migration() {
  const router = useRouter();
  const { showError, showWarning } = useAlert();

  const [connections, setConnections] = useState<ConnectionRow[]>([]);

  // ── Source ────────────────────────────────────────────────────────────────────
  const [srcConnId, setSrcConnId] = useState<number | null>(null);
  const [srcDbs, setSrcDbs] = useState<string[]>([]);
  const [srcDbsSelected, setSrcDbsSelected] = useState<string[]>([]);
  const [srcSchema, setSrcSchema] = useState('');
  const [srcLoadingDbs, setSrcLoadingDbs] = useState(false);
  const [srcDbError, setSrcDbError] = useState('');
  const [srcConn, setSrcConn] = useState<MigConn>({ type: 'mysql', host: '', port: 3306, database: '', username: '', password: '' });
  const [srcConnected, setSrcConnected] = useState(false);
  const [srcConnecting, setSrcConnecting] = useState(false);
  const [srcError, setSrcError] = useState('');
  const [srcTables, setSrcTables] = useState<MigTableInfo[]>([]);
  const [srcSearch, setSrcSearch] = useState('');
  const [tgtSearch, setTgtSearch] = useState('');

  // ── Target ────────────────────────────────────────────────────────────────────
  const [tgtConnId, setTgtConnId] = useState<number | null>(null);
  const [tgtDbs, setTgtDbs] = useState<string[]>([]);
  const [tgtDb, setTgtDb] = useState('');
  const [tgtLoadingDbs, setTgtLoadingDbs] = useState(false);
  const [tgtDbError, setTgtDbError] = useState('');
  const [tgtSchemas, setTgtSchemas] = useState<string[]>([]);
  const [tgtDefaultSchema, setTgtDefaultSchema] = useState('public');
  const [tgtNewDbMode, setTgtNewDbMode] = useState(false);
  const [tgtNewDbName, setTgtNewDbName] = useState('');
  const [tgtCreatingDb, setTgtCreatingDb] = useState(false);
  const [tgtNewSchemaMode, setTgtNewSchemaMode] = useState(false);
  const [tgtNewSchemaName, setTgtNewSchemaName] = useState('');
  const [tgtTables, setTgtTables] = useState<MigTableInfo[]>([]);
  const [tgtConn, setTgtConn] = useState<MigConn>({ type: 'postgresql', host: '', port: 5432, database: '', username: '', password: '' });
  const [tgtConnected, setTgtConnected] = useState(false);
  const [tgtConnecting, setTgtConnecting] = useState(false);
  const [tgtError, setTgtError] = useState('');

  // ── Mapping ───────────────────────────────────────────────────────────────────
  const [tableMaps, setTableMaps] = useState<TableMap[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [colsCache, setColsCache] = useState<Record<string, MigColumnInfo[]>>({});
  const [loadingCols, setLoadingCols] = useState(false);
  const [fkPickerIdx, setFkPickerIdx] = useState<number | null>(null);
  const [fkManualInput, setFkManualInput] = useState('');
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty, 'This job has unsaved changes that will be lost if you leave.\nSave the job first or discard changes.');

  // ── Jobs ──────────────────────────────────────────────────────────────────────
  const [jobs, setJobs] = useState<MigJobSummary[]>([]);
  const [tgtToSrcRef, setTgtToSrcRef] = useState<Record<string, string>>({});
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [saveJobName, setSaveJobName] = useState('');
  const [saveJobDesc, setSaveJobDesc] = useState('');
  const [savingJob, setSavingJob] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveAsTarget, setSaveAsTarget] = useState<string | null>(null);
  const [jobsOpen, setJobsOpen] = useState(true);
  const [renamingJobId, setRenamingJobId] = useState<string | null>(null);
  const [renameJobVal, setRenameJobVal] = useState('');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [selectedMigratedKeys, setSelectedMigratedKeys] = useState<Set<string>>(new Set());
  const [savedMigratedSources, setSavedMigratedSources] = useState<Set<string>>(new Set());
  // Accumulate completed table states across multiple runs (session-only)
  const [accumulatedTableStates, setAccumulatedTableStates] = useState<MigRunTableState[]>([]);
  const [accumulatedTableMaps, setAccumulatedTableMaps] = useState<Map<string, TableMap>>(new Map());
  const [showSaveMigratedDialog, setShowSaveMigratedDialog] = useState(false);
  const [saveMigratedJobName, setSaveMigratedJobName] = useState('');
  const [saveMigratedTargetJobId, setSaveMigratedTargetJobId] = useState<string | null>(null);
  const [savingMigrated, setSavingMigrated] = useState(false);

  // ── Run ───────────────────────────────────────────────────────────────────────
  const [migratedTableKeys, setMigratedTableKeys] = useState<Set<string>>(new Set());
  const [currentRun, setCurrentRun] = useState<MigRun | null>(null);
  const [polling, setPolling] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollingBackTableId, setRollingBackTableId] = useState<string | null>(null);
  const [rollbackPrompt, setRollbackPrompt] = useState<{ tableId: string; tableKey: string; drop: boolean } | null>(null);
  const [runRollbackPrompt, setRunRollbackPrompt] = useState<{ drop: boolean } | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const pendingRestoreRef = useRef<MigJob | null>(null);
  const pendingTgtRef = useRef<{ database: string; schema: string } | null>(null);

  // ── Inline record preview ─────────────────────────────────────────────────────
  const [srcPreviewCols, setSrcPreviewCols] = useState<string[]>([]);
  const [srcPreviewRows, setSrcPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [srcPreviewLoading, setSrcPreviewLoading] = useState(false);
  const [tgtPreviewCols, setTgtPreviewCols] = useState<string[]>([]);
  const [tgtPreviewRows, setTgtPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [tgtPreviewLoading, setTgtPreviewLoading] = useState(false);

  // ── Target column cache ───────────────────────────────────────────────────────
  const [tgtColsCache, setTgtColsCache] = useState<Record<string, MigColumnInfo[]>>({});

  // ── Load connections ──────────────────────────────────────────────────────────
  useEffect(() => {
    void axios.get<{ connections: ConnectionRow[] }>('/api/connections')
      .then(r => {
        const conns = r.data.connections;
        setConnections(conns);
        const active = conns.filter(c => c.is_active);
        if (active[0]) setSrcConnId(prev => prev ?? active[0].id);
        if (active[1]) setTgtConnId(prev => prev ?? active[1].id);
      })
      .catch(() => {});
  }, []);

  // ── Source DB loading ─────────────────────────────────────────────────────────
  const loadSrcDbs = useCallback(async (connId: number) => {
    const row = connections.find(c => c.id === connId);
    if (!row) return;
    const isRestore = !!pendingRestoreRef.current;
    setSrcLoadingDbs(true); setSrcDbs([]); setSrcDbsSelected([]); setSrcDbError(''); setSrcSchema('');
    setSrcConnected(false); setSrcTables([]);
    if (!isRestore) { setTableMaps([]); setColsCache({}); setSelectedMapId(null); }
    try {
      const { data } = await axios.post<{ databases: string[] }>(
        '/api/schema-designer/databases',
        { type: row.db_type === 'postgres' ? 'postgresql' : 'mysql', host: row.host, port: row.port, username: row.username, password: row.password_enc ?? '' }
      );
      setSrcDbs(data.databases);
      const def = data.databases.includes(row.database_name) ? row.database_name : data.databases[0] ?? '';
      if (isRestore && pendingRestoreRef.current) {
        const job = pendingRestoreRef.current;
        const jobSrcDbs = [...new Set(
          job.tables.filter(t => t.include && t.sourceDatabase).map(t => t.sourceDatabase!)
        )];
        if (jobSrcDbs.length === 0 && job.sourceMeta.database) jobSrcDbs.push(job.sourceMeta.database);
        setSrcDbsSelected(jobSrcDbs.filter(db => data.databases.includes(db)));
      } else {
        setSrcDbsSelected(def ? [def] : []);
      }
    } catch (err) {
      setSrcDbError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed') : 'Failed');
    } finally { setSrcLoadingDbs(false); }
  }, [connections]);

  useEffect(() => {
    if (srcConnId) void loadSrcDbs(srcConnId);
    else { setSrcDbs([]); setSrcDbsSelected([]); setSrcSchema(''); setSrcConnected(false); setSrcTables([]); }
  }, [srcConnId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!srcConnId || !srcDbsSelected.length) { setSrcConnected(false); return; }
    const row = connections.find(c => c.id === srcConnId);
    if (!row) return;
    const baseConn = connRowToMigConn(row, srcDbsSelected[0]);
    setSrcConn(baseConn);
    setSrcConnecting(true); setSrcError(''); setSrcConnected(false);
    setSrcTables([]);
    if (!pendingRestoreRef.current) { setSelectedMapId(null); setSrcSchema(''); }
    void Promise.all(
      srcDbsSelected.map(db =>
        axios.post<{ tables: MigTableInfo[] }>('/api/migv2/tables', connRowToMigConn(row, db))
          .then(({ data }) => data.tables)
      )
    )
      .then(results => {
        const merged = results.flat();
        setSrcTables(merged);
        setSrcConnected(true);
        if (pendingRestoreRef.current) {
          const job = pendingRestoreRef.current;
          const firstIncluded = job.tables.find(m => m.include);
          setTableMaps(job.tables);
          setSelectedMapId(firstIncluded?.id ?? null);
          setSrcSchema(firstIncluded?.source.schema ?? (merged[0]?.schema ?? ''));
          pendingRestoreRef.current = null;
          if (firstIncluded) {
            const tableKey = `${firstIncluded.source.schema}.${firstIncluded.source.table}`;
            const colCacheKey = `${firstIncluded.sourceDatabase ?? srcDbsSelected[0]}.${tableKey}`;
            const colConn = connRowToMigConn(row, firstIncluded.sourceDatabase ?? srcDbsSelected[0]);
            void axios.post<{ columns: MigColumnInfo[] }>(
              '/api/migv2/columns', { conn: colConn, tableKey }
            ).then(({ data: colData }) => setColsCache(prev => ({ ...prev, [colCacheKey]: colData.columns })))
             .catch(() => {});
          }
        } else {
          const first = merged[0]?.schema;
          if (first) setSrcSchema(first);
        }
      })
      .catch(err => setSrcError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Connection failed') : 'Connection failed'))
      .finally(() => setSrcConnecting(false));
  }, [srcDbsSelected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Target DB loading ─────────────────────────────────────────────────────────
  const loadTgtDbs = useCallback(async (connId: number) => {
    const row = connections.find(c => c.id === connId);
    if (!row) return;
    setTgtLoadingDbs(true); setTgtDbs([]); setTgtDb(''); setTgtDbError('');
    setTgtConnected(false);
    try {
      const { data } = await axios.post<{ databases: string[] }>(
        '/api/schema-designer/databases',
        { type: row.db_type === 'postgres' ? 'postgresql' : 'mysql', host: row.host, port: row.port, username: row.username, password: row.password_enc ?? '' }
      );
      setTgtDbs(data.databases);
      const def = data.databases.includes(row.database_name) ? row.database_name : data.databases[0] ?? '';
      setTgtDb((pendingTgtRef.current?.database) || def);
    } catch (err) {
      setTgtDbError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed') : 'Failed');
    } finally { setTgtLoadingDbs(false); }
  }, [connections]);

  useEffect(() => {
    if (tgtConnId) void loadTgtDbs(tgtConnId);
    else {
      setTgtDbs([]); setTgtDb(''); setTgtConnected(false);
      setTgtNewDbMode(false); setTgtNewDbName('');
    }
  }, [tgtConnId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreateTgtDb = async () => {
    if (!tgtConnId || !tgtNewDbName.trim()) return;
    const row = connections.find(c => c.id === tgtConnId);
    if (!row) return;
    setTgtCreatingDb(true); setTgtDbError('');
    try {
      await axios.post('/api/migv2/create-db', {
        type: row.db_type === 'postgres' ? 'postgresql' : 'mysql',
        host: row.host, port: row.port,
        username: row.username, password: row.password_enc ?? '',
        newDatabase: tgtNewDbName.trim(),
      });
      const { data } = await axios.post<{ databases: string[] }>(
        '/api/schema-designer/databases',
        { type: row.db_type === 'postgres' ? 'postgresql' : 'mysql', host: row.host, port: row.port, username: row.username, password: row.password_enc ?? '' }
      );
      setTgtDbs(data.databases);
      setTgtDb(tgtNewDbName.trim());
      setTgtNewDbMode(false); setTgtNewDbName('');
    } catch (err) {
      setTgtDbError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to create database') : 'Failed to create database');
    } finally { setTgtCreatingDb(false); }
  };

  useEffect(() => {
    if (!tgtConnId || !tgtDb) { setTgtConnected(false); setTgtSchemas([]); return; }
    const row = connections.find(c => c.id === tgtConnId);
    if (!row) return;
    const conn = connRowToMigConn(row, tgtDb);
    setTgtConn(conn);
    setTgtConnecting(true); setTgtError(''); setTgtConnected(false); setTgtSchemas([]); setTgtTables([]);
    setTgtNewSchemaMode(false); setTgtNewSchemaName('');
    void axios.post<{ tables: MigTableInfo[] }>('/api/migv2/tables', conn)
      .then(({ data }) => {
        setTgtConnected(true);
        setTgtTables(data.tables);
        if (row.db_type === 'postgres') {
          const schemas = [...new Set(data.tables.map(t => t.schema))].sort();
          const list = schemas.length ? schemas : ['public'];
          setTgtSchemas(list);
          const restoreSchema = pendingTgtRef.current?.schema;
          setTgtDefaultSchema(
            restoreSchema && list.includes(restoreSchema)
              ? restoreSchema
              : list.includes('public') ? 'public' : list[0]
          );
        }
        pendingTgtRef.current = null;
      })
      .catch(err => setTgtError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Connection failed') : 'Connection failed'))
      .finally(() => setTgtConnecting(false));
  }, [tgtDb]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadSrcTables = useCallback(() => {
    if (!srcConnId || !srcDbsSelected.length) return;
    const row = connections.find(c => c.id === srcConnId);
    if (!row) return;
    void Promise.all(
      srcDbsSelected.map(db =>
        axios.post<{ tables: MigTableInfo[] }>('/api/migv2/tables', connRowToMigConn(row, db))
          .then(({ data }) => data.tables)
      )
    )
      .then(results => setSrcTables(results.flat()))
      .catch(() => {});
  }, [srcConnId, srcDbsSelected, connections]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadTgtTables = useCallback(() => {
    if (!tgtConnId || !tgtDb) return;
    const row = connections.find(c => c.id === tgtConnId);
    if (!row) return;
    void axios.post<{ tables: MigTableInfo[] }>('/api/migv2/tables', tgtConn)
      .then(({ data }) => {
        setTgtTables(data.tables);
        if (row.db_type === 'postgres') {
          const schemas = [...new Set(data.tables.map(t => t.schema))].sort();
          const list = schemas.length ? schemas : ['public'];
          setTgtSchemas(prev => {
            const merged = [...new Set([...prev, ...list])].sort();
            return merged;
          });
        }
      })
      .catch(() => {});
  }, [tgtConnId, tgtDb, tgtConn, connections]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Table toggle ──────────────────────────────────────────────────────────────
  const isTableIncluded = (schema: string, table: string, database?: string) =>
    tableMaps.some(m => m.source.schema === schema && m.source.table === table && m.include && (!database || m.sourceDatabase === database));

  const handleCheckAll = () => {
    const toAdd: typeof tableMaps = [];
    for (const t of filteredSrcTables) {
      const existing = tableMaps.find(m => m.source.schema === t.schema && m.source.table === t.name && m.sourceDatabase === t.database);
      if (!existing) {
        const existsInTarget = tgtConnected && tgtTables.some(
          tgt => tgt.schema === (tgtDefaultSchema || 'public') && tgt.name === t.name
        );
        toAdd.push({
          id: newId(), include: true,
          source: { schema: t.schema, table: t.name },
          sourceDatabase: t.database,
          target: { schema: tgtDefaultSchema || '', table: existsInTarget ? '' : t.name },
          columns: [], // lazy — fetched when table is selected
          truncateBeforeMigrate: false,
        });
      }
    }
    setTableMaps(prev => {
      const updated = prev.map(m => {
        const inFiltered = filteredSrcTables.some(t => t.schema === m.source.schema && t.name === m.source.table && t.database === m.sourceDatabase);
        return inFiltered ? { ...m, include: true } : m;
      });
      return [...updated, ...toAdd];
    });
    setDirty(true);
  };

  const handleUncheckAll = () => {
    setTableMaps(prev => prev.map(m => {
      const inFiltered = filteredSrcTables.some(t => t.schema === m.source.schema && t.name === m.source.table && t.database === m.sourceDatabase);
      return inFiltered ? { ...m, include: false } : m;
    }));
    setDirty(true);
  };

  const toggleTable = async (t: MigTableInfo) => {
    const { schema, name: table, database } = t;
    const existing = tableMaps.find(m => m.source.schema === schema && m.source.table === table && m.sourceDatabase === database);
    if (existing) {
      const willExclude = existing.include;
      setTableMaps(prev => prev.map(m =>
        m.id === existing.id ? { ...m, include: !m.include } : m
      ));
      if (willExclude) {
        const key = `${schema}.${table}`;
        setMigratedTableKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
        setSavedMigratedSources(prev => { const n = new Set(prev); n.delete(key); return n; });
      }
      setDirty(true);
      return;
    }
    const tableKey = `${schema}.${table}`;
    const colCacheKey = `${database}.${tableKey}`;
    const mapId = newId();
    const existsInTarget = tgtConnected && tgtTables.some(
      t => t.schema === (tgtDefaultSchema || 'public') && t.name === table
    );
    const autoTargetTable = !existsInTarget ? table : '';
    setTableMaps(prev => [...prev, {
      id: mapId, include: true,
      source: { schema, table },
      sourceDatabase: database,
      target: { schema: tgtDefaultSchema || '', table: autoTargetTable },
      columns: [], truncateBeforeMigrate: false,
    }]);
    setSelectedMapId(mapId);
    setLoadingCols(true);
    try {
      let srcCols = colsCache[colCacheKey];
      if (!srcCols) {
        const row = connections.find(c => c.id === srcConnId);
        const perDbConn = row ? connRowToMigConn(row, database) : { ...srcConn, database };
        const { data } = await axios.post<{ columns: MigColumnInfo[] }>(
          '/api/migv2/columns', { conn: perDbConn, tableKey }
        );
        srcCols = data.columns;
        setColsCache(prev => ({ ...prev, [colCacheKey]: srcCols }));
      }
      const columns: ColumnMap[] = srcCols.map(c => {
        const isSerial = c.isPk && (c.isAutoIncrement || isPkLikeSerial(c.rawType));
        return {
          sourceCol: c.name,
          targetCol: c.name,
          targetName: null,
          targetType: suggestTargetType(c.rawType, srcConn.type, tgtConn.type),
          nullable: c.nullable,
          defaultValue: c.defaultValue,
          include: true,
          conversion: isSerial ? 'serial_to_uuid' : 'keep',
          fkRef: c.isFk && c.fkRef ? c.fkRef.split('.').slice(0, 2).join('.') : null,
          keepLegacyAs: isSerial ? `old_${c.name}` : null,
        };
      });
      columns.forEach(c => {
        if (c.conversion === 'serial_to_uuid' && tgtConn.type === 'postgresql') c.targetType = 'UUID';
      });
      setTableMaps(prev => prev.map(m => m.id === mapId ? { ...m, columns } : m));
      setDirty(true);
    } catch { /* ignore */ } finally { setLoadingCols(false); }
  };

  // ── Mapping helpers ───────────────────────────────────────────────────────────
  const selectedMap = tableMaps.find(m => m.id === selectedMapId) ?? null;

  const updateTableMap = (id: string, patch: Partial<TableMap>) => {
    setTableMaps(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
    setDirty(true);
  };

  const updateColumn = (mapId: string, idx: number, patch: Partial<ColumnMap>) => {
    setTableMaps(prev => prev.map(m => {
      if (m.id !== mapId) return m;
      return { ...m, columns: m.columns.map((c, i) => i === idx ? { ...c, ...patch } : c) };
    }));
    setDirty(true);
  };

  const addTargetOnlyColumn = (mapId: string) => {
    setTableMaps(prev => prev.map(m => {
      if (m.id !== mapId) return m;
      const col: ColumnMap = {
        sourceCol: null, targetCol: 'new_column', targetName: null,
        targetType: tgtConn.type === 'postgresql' ? 'TEXT' : 'VARCHAR(255)',
        nullable: true, defaultValue: null, include: true, conversion: 'keep', fkRef: null,
      };
      return { ...m, columns: [...m.columns, col] };
    }));
    setDirty(true);
  };

  const removeColumn = (mapId: string, idx: number) => {
    setTableMaps(prev => prev.map(m =>
      m.id !== mapId ? m : { ...m, columns: m.columns.filter((_, i) => i !== idx) }
    ));
    setDirty(true);
  };

  // ── Derived ───────────────────────────────────────────────────────────────────
  const srcConnRow = connections.find(c => c.id === srcConnId);
  const srcIsPg = srcConnRow?.db_type === 'postgres';
  const srcSchemaList = useMemo(() => [...new Set(srcTables.map(t => t.schema))].sort(), [srcTables]);
  const filteredSrcTables = useMemo(() => srcTables.filter(t =>
    (!srcSchema || !srcIsPg || t.schema === srcSchema) &&
    (!srcSearch || t.name.toLowerCase().includes(srcSearch.toLowerCase()))
  ), [srcTables, srcSchema, srcIsPg, srcSearch]);

  const filteredTgtTables = useMemo(() => tgtTables.filter(t =>
    (tgtSchemas.length === 0 || t.schema === tgtDefaultSchema) &&
    (!tgtSearch || t.name.toLowerCase().includes(tgtSearch.toLowerCase()))
  ), [tgtTables, tgtSchemas, tgtDefaultSchema, tgtSearch]);

  const srcColsForSelected = selectedMap
    ? (colsCache[`${selectedMap.sourceDatabase ?? ''}.${selectedMap.source.schema}.${selectedMap.source.table}`] ?? [])
    : [];

  const tgtColsForSelected = selectedMap
    ? (tgtColsCache[`${selectedMap.target.schema}.${selectedMap.target.table}`] ?? [])
    : [];

  const includedCount = tableMaps.filter(m => m.include).length;
  const canStart = srcConnected && tgtConnected && includedCount > 0 && !polling;

  // Source keys already saved in any job — exclude from pending-save list
  const savedJobSourceKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const j of jobs) {
      for (const t of j.tables) {
        if (t.include) keys.add(`${t.source.schema}.${t.source.table}`);
      }
    }
    return keys;
  }, [jobs]);

  const completedMigratedStates = accumulatedTableStates
    .filter(ts => !savedMigratedSources.has(ts.sourceKey) && !savedJobSourceKeys.has(ts.sourceKey));

  // ── Jobs ──────────────────────────────────────────────────────────────────────
  const loadJobs = async () => {
    try {
      const { data } = await axios.get<{ jobs: MigJobSummary[] }>('/api/migv2/jobs');
      setJobs(data.jobs);
    } catch { /* ignore */ }
  };
  const loadTableRefs = async () => {
    try {
      const { data } = await axios.get<{ refs: { targetKey: string; sourceKey: string }[] }>(
        '/api/migv2/jobs/table-refs'
      );
      const map: Record<string, string> = {};
      for (const r of data.refs) map[r.targetKey] = r.sourceKey;
      setTgtToSrcRef(map);
    } catch { /* ignore */ }
  };
  useEffect(() => { void loadJobs(); void loadTableRefs(); }, []);

  // On page load: restore the most recent finished run — but only if there are genuinely
  // unsaved pending tables. If all tables were already saved/cleared in a prior session,
  // skip restore entirely so stale strikethrough doesn't appear.
  useEffect(() => {
    void axios.get<{ runs: MigRun[] }>('/api/migv2/run/status')
      .then(({ data }) => {
        const latest = data.runs.find(r => r.status === 'completed' || r.status === 'failed');
        if (!latest) return;
        const completedKeys = latest.tableStates
          .filter(ts => ts.status === 'completed')
          .map(ts => ts.sourceKey);
        if (completedKeys.length === 0) return;
        // Read which tables were already saved/cleared in a previous session
        let savedKeys: Set<string> = new Set();
        try {
          const arr = JSON.parse(localStorage.getItem(`mig_saved_${latest.id}`) ?? '[]') as string[];
          savedKeys = new Set(arr);
        } catch { /* ignore */ }
        // Only restore if there are unsaved pending tables
        const unsaved = completedKeys.filter(k => !savedKeys.has(k));
        if (unsaved.length === 0) return;
        setCurrentRun(latest);
        setMigratedTableKeys(new Set(completedKeys));
        if (savedKeys.size > 0) setSavedMigratedSources(savedKeys);
        // Populate accumulated state from restored run
        const statesMap = new Map(latest.tableStates.filter(ts => ts.status === 'completed').map(ts => [ts.sourceKey, ts]));
        setAccumulatedTableStates([...statesMap.values()]);
        const tMaps = new Map<string, TableMap>();
        for (const ts of statesMap.values()) {
          const tm = latest.tables.find(t => t.id === ts.id);
          if (tm) tMaps.set(ts.sourceKey, tm);
        }
        setAccumulatedTableMaps(tMaps);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSaveMigratedTables = async () => {
    if (!currentRun || selectedMigratedKeys.size === 0) return;
    setSavingMigrated(true);
    try {
      const selectedTables = [...selectedMigratedKeys]
        .map(k => accumulatedTableMaps.get(k))
        .filter((t): t is TableMap => !!t);
      if (saveMigratedTargetJobId) {
        const { data: existing } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${saveMigratedTargetJobId}`);
        const existingIds = new Set((existing.job.tables as TableMap[]).map(t => t.id));
        const merged = [...existing.job.tables, ...selectedTables.filter(t => !existingIds.has(t.id))];
        await axios.put(`/api/migv2/jobs/${saveMigratedTargetJobId}`, { tables: merged });
      } else {
        await axios.post('/api/migv2/jobs', { name: saveMigratedJobName.trim(), tables: selectedTables });
      }
      await loadJobs();
      const newSaved = new Set([...savedMigratedSources, ...selectedMigratedKeys]);
      setSavedMigratedSources(newSaved);
      try {
        localStorage.setItem(`mig_saved_${currentRun.id}`, JSON.stringify([...newSaved]));
      } catch { /* ignore */ }
      // If we added tables to the active job, sync tableMaps so "Save Job" won't overwrite them
      if (saveMigratedTargetJobId && saveMigratedTargetJobId === activeJobId) {
        setTableMaps(prev => {
          const prevIds = new Set(prev.map(m => m.id));
          const newTables = selectedTables.filter(t => !prevIds.has(t.id));
          return newTables.length ? [...prev, ...newTables] : prev;
        });
      }
      setShowSaveMigratedDialog(false);
      setSaveMigratedJobName('');
      setSaveMigratedTargetJobId(null);
      setSelectedMigratedKeys(new Set());
    } catch {
      showError('Failed to save migrated tables to job');
    } finally {
      setSavingMigrated(false);
    }
  };

  const doSaveJob = async () => {
    setSavingJob(true);
    try {
      const targetId = saveAsTarget ?? activeJobId ?? undefined;

      // When updating an existing job, merge: session tableMaps replace matching IDs,
      // tables added via pending-save (different IDs) are kept intact.
      let tables: TableMap[] = tableMaps;
      if (targetId) {
        try {
          const { data: existing } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${targetId}`);
          const sessionIds = new Set(tableMaps.map(m => m.id));
          const keptFromJob = existing.job.tables.filter(t => !sessionIds.has(t.id));
          tables = [...tableMaps, ...keptFromJob];
        } catch { /* fall back to tableMaps only */ }
      }

      const payload: Partial<MigJob> = {
        id: targetId,
        name: saveJobName.trim(), description: saveJobDesc.trim(),
        sourceMeta: { type: srcConn.type, host: srcConn.host, port: srcConn.port, database: tables.find(t => t.include)?.sourceDatabase ?? srcConn.database, username: srcConn.username },
        targetMeta: { type: tgtConn.type, host: tgtConn.host, port: tgtConn.port, database: tgtConn.database, username: tgtConn.username },
        tables,
      };
      const { data } = await axios.post<{ job: MigJob }>('/api/migv2/jobs', payload);
      setActiveJobId(data.job.id);
      setSaveAsTarget(null);
      setDirty(false); setShowSaveDialog(false);

      // Clear pending-save entries whose sourceKey is now covered by the saved job
      const savedSourceKeys = new Set(tables.filter(m => m.include).map(m => `${m.source.schema}.${m.source.table}`));
      setSavedMigratedSources(prev => {
        const next = new Set([...prev, ...[...accumulatedTableStates].filter(ts => savedSourceKeys.has(ts.sourceKey)).map(ts => ts.sourceKey)]);
        if (currentRun) {
          try { localStorage.setItem(`mig_saved_${currentRun.id}`, JSON.stringify([...next])); } catch { /* ignore */ }
        }
        return next;
      });

      await loadJobs(); void loadTableRefs();
    } catch { /* ignore */ } finally { setSavingJob(false); }
  };

  const handleSaveJob = () => {
    if (!saveJobName.trim()) return;
    const existingJob = jobs.find(j => j.id === (saveAsTarget ?? activeJobId ?? ''));
    if (tableMaps.length === 0 && existingJob && existingJob.tableCount > 0) {
      showWarning({
        title: 'Save with no tables?',
        description: `"${existingJob.name}" currently has ${existingJob.tableCount} saved table${existingJob.tableCount !== 1 ? 's' : ''}. Saving now will overwrite it with an empty table list.\n\nThis usually happens after changing the source connection. Are you sure?`,
        confirmLabel: 'Save Anyway',
        onConfirm: () => void doSaveJob(),
      });
      return;
    }
    void doSaveJob();
  };

  const handleRestoreJobFromRuns = async (jobId: string) => {
    try {
      const { data } = await axios.post<{ job: MigJob; restored: number }>(
        `/api/migv2/jobs/restore?id=${jobId}`, {}
      );
      await loadJobs();
      if (activeJobId === jobId) setTableMaps(data.job.tables);
    } catch { /* ignore */ }
  };

  const handleLoadJob = async (id: string) => {
    try {
      const { data } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${id}`);
      const job = data.job;
      setActiveJobId(id);
      setSaveJobName(job.name); setSaveJobDesc(job.description); setDirty(false);

      // Restore migrated table keys + most recent run for this job.
      // Runs are sorted latest-first — use the latest status per table so a
      // table rolled back in run N is not re-added by an older completed run.
      void axios.get<{ runs: MigRun[] }>('/api/migv2/run/status')
        .then(({ data: runData }) => {
          const tableLatestStatus = new Map<string, string>();
          let latestJobRun: MigRun | null = null;
          for (const run of runData.runs) {
            if (run.jobId !== id) continue;
            if (!latestJobRun) latestJobRun = run;
            for (const ts of run.tableStates) {
              if (!tableLatestStatus.has(ts.sourceKey)) {
                tableLatestStatus.set(ts.sourceKey, ts.status);
              }
            }
          }
          const keys = new Set<string>();
          for (const [sourceKey, status] of tableLatestStatus) {
            if (status === 'completed') keys.add(sourceKey);
          }
          setMigratedTableKeys(keys);
          if (latestJobRun) setCurrentRun(latestJobRun);
        })
        .catch(() => setMigratedTableKeys(new Set()));

      const srcMatch = connections.find(c =>
        c.host === job.sourceMeta.host && c.port === job.sourceMeta.port &&
        c.username === job.sourceMeta.username &&
        c.db_type === (job.sourceMeta.type === 'postgresql' ? 'postgres' : 'mysql')
      ) ?? connections.find(c =>
        c.host === job.sourceMeta.host && c.username === job.sourceMeta.username &&
        c.db_type === (job.sourceMeta.type === 'postgresql' ? 'postgres' : 'mysql')
      );
      const tgtMatch = connections.find(c =>
        c.host === job.targetMeta.host && c.port === job.targetMeta.port &&
        c.username === job.targetMeta.username &&
        c.db_type === (job.targetMeta.type === 'postgresql' ? 'postgres' : 'mysql')
      ) ?? connections.find(c =>
        c.host === job.targetMeta.host && c.username === job.targetMeta.username &&
        c.db_type === (job.targetMeta.type === 'postgresql' ? 'postgres' : 'mysql')
      );

      const firstIncluded = job.tables.find(m => m.include);

      const jobSrcDbs = [...new Set(
        job.tables.filter(t => t.include && t.sourceDatabase).map(t => t.sourceDatabase!)
      )];
      if (jobSrcDbs.length === 0 && job.sourceMeta.database) jobSrcDbs.push(job.sourceMeta.database);

      // Source: if same connection+dbs already active, restore directly; otherwise use ref cascade
      const allDbsAlreadySelected = srcMatch && srcMatch.id === srcConnId && jobSrcDbs.every(db => srcDbsSelected.includes(db));
      if (allDbsAlreadySelected) {
        setTableMaps(job.tables);
        setSelectedMapId(firstIncluded?.id ?? null);
        if (firstIncluded) setSrcSchema(firstIncluded.source.schema);
      } else if (srcMatch) {
        pendingRestoreRef.current = job;
        if (srcMatch.id === srcConnId) {
          // Same connection already selected — trigger multi-DB reload
          setSrcDbsSelected(jobSrcDbs);
        } else {
          setSrcConnId(srcMatch.id);
        }
      } else {
        // Connection not found — restore tables directly so mapping is not lost
        setTableMaps(job.tables);
        setSelectedMapId(firstIncluded?.id ?? null);
        if (firstIncluded) setSrcSchema(firstIncluded.source.schema);
      }

      // Target: if same connection+db already active, just set schema; otherwise use ref cascade
      if (tgtMatch) {
        const sameTgtConn = tgtMatch.id === tgtConnId && job.targetMeta.database === tgtDb;
        if (sameTgtConn) {
          if (firstIncluded?.target.schema) setTgtDefaultSchema(firstIncluded.target.schema);
        } else {
          pendingTgtRef.current = {
            database: job.targetMeta.database,
            schema: firstIncluded?.target.schema ?? 'public',
          };
          setTgtConnId(tgtMatch.id);
        }
      }
    } catch { /* ignore */ }
  };

  const handleExportJobMd = async (jobId: string) => {
    try {
      const { data } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${jobId}`);
      const job = data.job;
      const lines: string[] = [
        `# ${job.name}`,
        job.description ? `\n${job.description}` : '',
        `\n_Generated: ${new Date().toISOString()}_`,
        '',
        '## Source',
        `- **Type**: ${job.sourceMeta.type}`,
        `- **Host**: ${job.sourceMeta.host}:${job.sourceMeta.port}`,
        `- **Database**: ${job.sourceMeta.database}`,
        `- **Username**: ${job.sourceMeta.username}`,
        '',
        '## Target',
        `- **Type**: ${job.targetMeta.type}`,
        `- **Host**: ${job.targetMeta.host}:${job.targetMeta.port}`,
        `- **Database**: ${job.targetMeta.database}`,
        `- **Username**: ${job.targetMeta.username}`,
        '',
        `## Table Mappings (${job.tables.filter(m => m.include).length} of ${job.tables.length} included)`,
        '',
      ];
      job.tables.forEach((map, i) => {
        const status = map.include ? '✓' : '✗';
        const resolvedTable = map.targetAlias?.trim() || map.target.table;
        const tgtTable = resolvedTable ? `${map.target.schema}.${resolvedTable}` : '(unassigned)';
        lines.push(`### ${i + 1}. \`${map.source.schema}.${map.source.table}\` → \`${tgtTable}\` [${status}]`);
        if (map.truncateBeforeMigrate) lines.push('> ⚠ Truncate target before migrate');
        if (map.syncMode === 'incremental') {
          lines.push(`> ⟳ Incremental — ${map.incrementalStrategy ?? 'id'} by \`${map.incrementalCol ?? '—'}\`${map.lastSyncedValue ? ` · last synced: ${map.lastSyncedValue}` : ''}`);
        }
        lines.push('');
        if (map.columns.length > 0) {
          lines.push('| Source Column | Target Column | Target Type | Conversion | Include |');
          lines.push('|---|---|---|---|:---:|');
          map.columns.forEach(col => {
            lines.push(`| ${col.sourceCol ?? '*(new)*'} | ${col.targetCol || '—'} | ${col.targetType} | ${col.conversion} | ${col.include ? '✓' : '✗'} |`);
          });
        } else {
          lines.push('_No column mapping configured_');
        }
        lines.push('');
      });
      const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${job.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch { showError('Failed to export job MD'); }
  };

  const handleExportJobSql = async (jobId: string) => {
    try {
      const res = await fetch(`/api/migv2/jobs/export-sql?id=${jobId}`);
      if (!res.ok) { showError('Export SQL failed', await res.text()); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `job-${jobId.slice(0, 8)}.sql`;
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch { showError('Export SQL failed', 'Could not download SQL file.'); }
  };

  const handleExportJobScript = async (jobId: string) => {
    try {
      const res = await fetch(`/api/migv2/jobs/export-script?id=${jobId}`);
      if (!res.ok) { showError('Export Script failed', await res.text()); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `migrate-${jobId.slice(0, 8)}.py`;
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch { showError('Export Script failed', 'Could not download Python script.'); }
  };

  const handleDeleteJob = (id: string, name: string) => {
    showWarning({
      title: `Delete "${name}"?`,
      description: 'This saved job will be permanently removed and cannot be recovered.',
      confirmLabel: 'Delete Job',
      onConfirm: async () => {
        try {
          await axios.delete(`/api/migv2/jobs/${id}`);
          await loadJobs();
          if (activeJobId === id) { setActiveJobId(null); setSaveJobName(''); setSaveJobDesc(''); }
        } catch { /* ignore */ }
      },
    });
  };

  const handleOpenInSchemaStudio = async (jobId: string) => {
    try {
      const { data } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${jobId}`);
      const { targetMeta, tables: jobTables } = data.job;
      const match = connections.find(c =>
        c.host === targetMeta.host &&
        c.port === targetMeta.port &&
        c.username === targetMeta.username &&
        (targetMeta.type === 'postgresql' ? c.db_type === 'postgres' : c.db_type === 'mysql')
      );
      if (!match) {
        showWarning({
          title: 'Connection not found',
          description: `Target connection (${targetMeta.host}:${targetMeta.port} / ${targetMeta.username}) tidak ada dalam saved connections. Tambah connection ke Settings terlebih dahulu.`,
          confirmLabel: 'OK',
          onConfirm: () => {},
        });
        return;
      }
      const schema = jobTables.find(t => t.include)?.target.schema ?? 'public';
      void router.push(`/schema-studio?migJobId=${jobId}&connId=${match.id}&database=${encodeURIComponent(targetMeta.database)}&schema=${encodeURIComponent(schema)}`);
    } catch { /* ignore */ }
  };

  const handleRemoveTableFromJob = (jobId: string, tableId: string, tableLabel: string) => {
    showWarning({
      title: `Remove "${tableLabel}"?`,
      description: 'This table entry will be removed from the saved job.',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        try {
          const { data } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${jobId}`);
          const updatedTables = data.job.tables.filter(t => t.id !== tableId);
          await axios.put(`/api/migv2/jobs/${jobId}`, { tables: updatedTables });
          await loadJobs();
          if (activeJobId === jobId) setTableMaps(updatedTables);
        } catch { /* ignore */ }
      },
    });
  };

  const handleRenameJob = async (id: string, name: string) => {
    if (!name.trim()) return;
    try {
      await axios.put(`/api/migv2/jobs/${id}`, { name: name.trim() });
      await loadJobs();
      if (activeJobId === id) setSaveJobName(name.trim());
    } catch { /* ignore */ } finally { setRenamingJobId(null); }
  };

  // ── Run ───────────────────────────────────────────────────────────────────────

  // Shared handler called whenever a run reaches a terminal state (completed/failed)
  const onRunFinished = (run: MigRun) => {
    setPolling(false);
    const completedStates = run.tableStates.filter(ts => ts.status === 'completed');
    const completedKeys = completedStates.map(ts => ts.sourceKey);
    if (completedKeys.length > 0) {
      setMigratedTableKeys(prev => new Set([...prev, ...completedKeys]));
      setAccumulatedTableStates(prev => {
        const map = new Map(prev.map(s => [s.sourceKey, s]));
        for (const ts of completedStates) map.set(ts.sourceKey, ts);
        return [...map.values()];
      });
      setAccumulatedTableMaps(prev => {
        const next = new Map(prev);
        for (const ts of completedStates) {
          const tm = run.tables.find(t => t.id === ts.id);
          if (tm) next.set(ts.sourceKey, tm);
        }
        return next;
      });
      const firstTargetSchema = completedStates[0].targetKey.split('.')[0];
      if (firstTargetSchema) setTgtDefaultSchema(firstTargetSchema);
    }
    reloadSrcTables();
    reloadTgtTables();
    void loadTableRefs();
  };

  const startMigration = async () => {
    const included = tableMaps.filter(t => t.include);
    if (!included.length) return;
    setPolling(true);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/start', {
        source: srcConn, target: tgtConn, tables: included,
        jobId: activeJobId, jobName: saveJobName || 'Migration',
      });
      setCurrentRun(data.run);
      if (data.run.status === 'running' || data.run.status === 'pending') {
        scheduleAdvance(data.run.id);
      } else {
        onRunFinished(data.run); // completed in a single start call (small table)
      }
    } catch { setPolling(false); }
  };

  const scheduleAdvance = (runId: string) => setTimeout(() => void advanceMigration(runId), 1000);

  const advanceMigration = async (runId: string) => {
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/advance',
        { runId, source: srcConn, target: tgtConn });
      setCurrentRun(data.run);
      if (data.run.status === 'running') scheduleAdvance(runId);
      else onRunFinished(data.run);
    } catch { setPolling(false); }
  };

  const handleRollback = async (drop = false) => {
    if (!currentRun) return;
    setRunRollbackPrompt(null);
    setRollingBack(true);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/rollback',
        { runId: currentRun.id, target: tgtConn, dropTable: drop });
      setCurrentRun(data.run);
      if (drop) reloadTgtTables(); // only reload target list when DROP was requested (table disappears)
      setMigratedTableKeys(new Set());
      setSavedMigratedSources(new Set());
      const rolledBackKeys = new Set(currentRun.tableStates.map(ts => ts.sourceKey));
      setAccumulatedTableStates(prev => prev.filter(ts => !rolledBackKeys.has(ts.sourceKey)));
      setAccumulatedTableMaps(prev => { const n = new Map(prev); for (const k of rolledBackKeys) n.delete(k); return n; });
    } catch { /* ignore */ } finally { setRollingBack(false); }
  };

  const openRollbackPrompt = (tableId: string) => {
    const ts = currentRun?.tableStates.find(t => t.id === tableId);
    if (!ts) return;
    setRollbackPrompt({ tableId, tableKey: ts.sourceKey, drop: false });
  };

  const handleRollbackTable = async (tableId: string, drop = false) => {
    if (!currentRun) return;
    setRollbackPrompt(null);
    setRollingBackTableId(tableId);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/rollback-table',
        { runId: currentRun.id, tableId, target: tgtConn, dropTable: drop });
      setCurrentRun(data.run);
      if (drop) reloadTgtTables(); // only reload target list when DROP was requested
      const ts = data.run.tableStates.find(t => t.id === tableId);
      if (ts) {
        setMigratedTableKeys(prev => { const n = new Set(prev); n.delete(ts.sourceKey); return n; });
        setSavedMigratedSources(prev => { const n = new Set(prev); n.delete(ts.sourceKey); return n; });
        setAccumulatedTableStates(prev => prev.filter(s => s.id !== tableId));
        setAccumulatedTableMaps(prev => { const n = new Map(prev); n.delete(ts.sourceKey); return n; });
      }
    } catch { showError('Per-table rollback failed'); } finally { setRollingBackTableId(null); }
  };


  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentRun?.logs.length]);

  // Returns the source conn for a given tableMap, respecting per-table sourceDatabase
  const srcConnForMap = useCallback((map: TableMap | null): MigConn => {
    if (!srcConn.host) return srcConn;
    if (!map?.sourceDatabase || map.sourceDatabase === srcConn.database) return srcConn;
    return { ...srcConn, database: map.sourceDatabase };
  }, [srcConn]);

  // ── Auto-fetch inline records on table selection ──────────────────────────────
  useEffect(() => {
    if (!selectedMap || !srcConnected || !srcConn.host) {
      setSrcPreviewCols([]); setSrcPreviewRows([]); return;
    }
    setSrcPreviewLoading(true); setSrcPreviewCols([]); setSrcPreviewRows([]);
    void axios.post<{ columns: string[]; rows: Record<string, unknown>[] }>(
      '/api/migv2/preview',
      { conn: srcConnForMap(selectedMap), tableKey: `${selectedMap.source.schema}.${selectedMap.source.table}` }
    ).then(({ data }) => { setSrcPreviewCols(data.columns); setSrcPreviewRows(data.rows); })
     .catch(() => {}).finally(() => setSrcPreviewLoading(false));
  }, [selectedMapId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedMap || !tgtConnected || !selectedMap.target.table) {
      setTgtPreviewCols([]); setTgtPreviewRows([]); return;
    }
    const tgtKey = `${selectedMap.target.schema}.${selectedMap.target.table}`;
    const tgtTableExists = tgtTables.some(
      t => t.schema === selectedMap.target.schema && t.name === selectedMap.target.table
    );
    // Fetch target columns if not cached
    if (!tgtColsCache[tgtKey]) {
      void axios.post<{ columns: MigColumnInfo[] }>(
        '/api/migv2/columns', { conn: tgtConn, tableKey: tgtKey }
      ).then(({ data }) => setTgtColsCache(prev => ({ ...prev, [tgtKey]: data.columns })))
       .catch(() => {});
    }
    // Fetch target preview only if target table exists
    if (tgtTableExists) {
      setTgtPreviewLoading(true); setTgtPreviewCols([]); setTgtPreviewRows([]);
      void axios.post<{ columns: string[]; rows: Record<string, unknown>[] }>(
        '/api/migv2/preview', { conn: tgtConn, tableKey: tgtKey }
      ).then(({ data }) => { setTgtPreviewCols(data.columns); setTgtPreviewRows(data.rows); })
       .catch(() => {}).finally(() => setTgtPreviewLoading(false));
    }
  }, [selectedMapId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setFkPickerIdx(null); }, [selectedMapId]);

  // ── Select target table for current mapping ───────────────────────────────────
  const selectTargetTable = async (schema: string, table: string) => {
    if (!selectedMapId) return;
    updateTableMap(selectedMapId, { target: { schema, table } });
    const key = `${schema}.${table}`;
    if (tgtConnected) {
      // Fetch cols if not cached
      if (!tgtColsCache[key]) {
        void axios.post<{ columns: MigColumnInfo[] }>(
          '/api/migv2/columns', { conn: tgtConn, tableKey: key }
        ).then(({ data }) => setTgtColsCache(prev => ({ ...prev, [key]: data.columns })))
         .catch(() => {});
      }
      // Refresh preview
      setTgtPreviewLoading(true); setTgtPreviewCols([]); setTgtPreviewRows([]);
      void axios.post<{ columns: string[]; rows: Record<string, unknown>[] }>(
        '/api/migv2/preview', { conn: tgtConn, tableKey: key }
      ).then(({ data }) => { setTgtPreviewCols(data.columns); setTgtPreviewRows(data.rows); })
       .catch(() => {}).finally(() => setTgtPreviewLoading(false));
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <>
      <Head><title>Migration</title></Head>

      {/* Rollback confirm dialog */}
      {rollbackPrompt && (
        <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-sm p-5 space-y-4">
            <div>
              <p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Rollback table?</p>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-1 font-mono">{rollbackPrompt.tableKey}</p>
            </div>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rollbackPrompt.drop}
                onChange={e => setRollbackPrompt(p => p ? { ...p, drop: e.target.checked } : p)}
                className="mt-0.5 accent-rose-500"
              />
              <span className="text-xs text-gray-700 dark:text-slate-300">
                Also <span className="font-semibold text-rose-600 dark:text-rose-400">DROP</span> the target table after rollback
                <span className="block text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">
                  Runs <code className="font-mono">DROP TABLE … CASCADE</code> — cannot be undone.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setRollbackPrompt(null)}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleRollbackTable(rollbackPrompt.tableId, rollbackPrompt.drop)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-colors ${rollbackPrompt.drop ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-500 hover:bg-amber-600'}`}
              >
                {rollbackPrompt.drop ? 'Rollback & Drop' : 'Rollback'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full-run rollback confirm dialog */}
      {runRollbackPrompt && currentRun && (
        <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-sm p-5 space-y-4">
            <div>
              <p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Rollback entire run?</p>
              <p className="text-xs text-gray-500 dark:text-slate-400 mt-1">
                {currentRun.tableStates.filter(ts => ts.status === 'completed' || ts.status === 'failed').length} table(s) will be rolled back.
              </p>
            </div>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={runRollbackPrompt.drop}
                onChange={e => setRunRollbackPrompt(p => p ? { ...p, drop: e.target.checked } : p)}
                className="mt-0.5 accent-rose-500"
              />
              <span className="text-xs text-gray-700 dark:text-slate-300">
                Also <span className="font-semibold text-rose-600 dark:text-rose-400">DROP</span> all target tables after rollback
                <span className="block text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">
                  Runs <code className="font-mono">DROP TABLE … CASCADE</code> on each table — cannot be undone.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setRunRollbackPrompt(null)}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleRollback(runRollbackPrompt.drop)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium text-white transition-colors ${runRollbackPrompt.drop ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-500 hover:bg-amber-600'}`}
              >
                {runRollbackPrompt.drop ? 'Rollback & Drop All' : 'Rollback All'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col h-[calc(100vh-48px)] bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* Header */}
        <header className="shrink-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-3 shrink-0">
            <Network size={18} className="text-blue-600" />
            <div>
              <h1 className="font-bold text-sm text-gray-900 dark:text-slate-100">Migration</h1>
              <p className="text-xs text-gray-500 dark:text-slate-400">Map and migrate tables between databases</p>
            </div>
          </div>
          <div className="h-8 w-px bg-gray-200 dark:bg-slate-700 shrink-0" />
          {dirty && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400">unsaved changes</span>
          )}
          {includedCount > 0 && (
            <span className="text-xs text-gray-400 dark:text-slate-500">{includedCount} table{includedCount > 1 ? 's' : ''} selected</span>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <MigrationGuidePopover />
            <button onClick={() => { setSaveJobName(saveJobName || 'New Job'); setSaveAsTarget(null); setShowSaveDialog(true); }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors">
              <Save size={12} /> Save Job
            </button>
            <button onClick={() => void startMigration()} disabled={!canStart}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-500 text-blue-600 dark:text-blue-400 bg-transparent hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50 transition-colors">
              {polling ? <><Loader2 size={12} className="animate-spin" /> Running…</> : <><Play size={12} /> Migrate</>}
            </button>
            </div>
        </header>

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Main workspace: vertical split (tables top / columns+mapping bottom) */}
          <PanelGroup orientation="vertical" className="flex-1 min-w-0 min-h-0">

            {/* ── TOP ROW: source + target connection + tables ────────── */}
            <Panel defaultSize={50} minSize={25}>
              <PanelGroup orientation="horizontal" className="h-full">

                {/* ── SOURCE PANEL ─────────────────────────────────────── */}
                <Panel defaultSize={50} minSize={22}>
                  <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-900">

                    {/* Source header */}
                    <div className="shrink-0 p-3 border-b border-gray-200 dark:border-slate-800 bg-blue-50/50 dark:bg-blue-950/10">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                        <span className="text-[11px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 flex-1">Source</span>
                        {srcConnecting && <Loader2 size={10} className="animate-spin text-gray-400" />}
                        {srcConnected && !srcConnecting && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                            <Check size={9} /> Connected
                          </span>
                        )}
                        {srcError && !srcConnecting && (
                          <span className="text-[10px] text-rose-500 truncate max-w-[100px]" title={srcError}>{srcError}</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <ConnSelect connections={connections} value={srcConnId}
                          onChange={id => setSrcConnId(id)} onNew={() => void router.push('/settings')} accent="blue" />
                        <div className="flex items-center gap-1.5">
                          {srcConnId && (srcLoadingDbs
                            ? <div className="flex items-center gap-1.5"><Loader2 size={11} className="animate-spin text-gray-400" /><span className="text-[10px] text-gray-400">Loading databases…</span></div>
                            : srcDbs.length > 0 && (
                              <DbMultiSelect
                                dbs={srcDbs}
                                selected={srcDbsSelected}
                                onChange={setSrcDbsSelected}
                              />
                            )
                          )}
                          {srcConnected && srcIsPg && srcSchemaList.length > 0 && (
                            <select value={srcSchema} onChange={e => setSrcSchema(e.target.value)}
                              className="w-24 shrink-0 px-2 py-1 text-[11px] rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 focus:outline-none cursor-pointer font-mono">
                              {srcSchemaList.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          )}
                        </div>
                        {srcDbError && <span className="text-[10px] text-rose-500">{srcDbError}</span>}
                      </div>
                    </div>

                    {/* Tables label + search */}
                    <div className="shrink-0 px-3 pt-2 pb-1.5 border-b border-gray-100 dark:border-slate-800">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <Table2 size={10} className="text-blue-400 shrink-0" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400 flex-1">Tables</span>
                        {filteredSrcTables.length > 0 && (
                          <span className="text-[10px] text-gray-400">{filteredSrcTables.length}</span>
                        )}
                        {loadingCols && <Loader2 size={10} className="animate-spin text-gray-400" />}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {filteredSrcTables.length > 0 && (() => {
                          const allChecked = filteredSrcTables.every(t => isTableIncluded(t.schema, t.name, t.database));
                          const someChecked = !allChecked && filteredSrcTables.some(t => isTableIncluded(t.schema, t.name, t.database));
                          return (
                            <input
                              type="checkbox"
                              checked={allChecked}
                              ref={el => { if (el) el.indeterminate = someChecked; }}
                              onChange={() => allChecked ? handleUncheckAll() : handleCheckAll()}
                              title={allChecked ? 'Uncheck all' : 'Check all'}
                              className="shrink-0 accent-blue-500 cursor-pointer"
                            />
                          );
                        })()}
                        <div className="relative flex-1">
                          <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                          <input value={srcSearch} onChange={e => setSrcSearch(e.target.value)}
                            placeholder="Filter tables…"
                            className="w-full pl-6 pr-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        </div>
                      </div>
                    </div>

                    {/* Tables list */}
                    <div className="flex-1 min-h-0 overflow-y-auto panel-scroll">
                      {!srcConnected ? (
                        <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                          <Database size={28} className="text-gray-200 dark:text-slate-700" />
                          <p className="text-[11px] text-gray-400 dark:text-slate-500">Select a connection and database</p>
                        </div>
                      ) : filteredSrcTables.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">No tables found</div>
                      ) : (() => {
                        const renderTableRow = (t: MigTableInfo) => {
                          const included = isTableIncluded(t.schema, t.name, t.database);
                          const mapEntry = tableMaps.find(m => m.source.schema === t.schema && m.source.table === t.name && m.sourceDatabase === t.database);
                          const isSelected = mapEntry?.id === selectedMapId;
                          const isMigrated = migratedTableKeys.has(`${t.schema}.${t.name}`);
                          return (
                            <div key={`${t.database}.${t.schema}.${t.name}`}
                              className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b border-gray-50 dark:border-slate-800/40 ${isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}
                              onClick={() => {
                                if (mapEntry) setSelectedMapId(mapEntry.id);
                                else void toggleTable(t);
                              }}>
                              <input type="checkbox" checked={included}
                                disabled={isMigrated && included}
                                onChange={e => { e.stopPropagation(); void toggleTable(t); }}
                                onClick={e => e.stopPropagation()}
                                className="shrink-0 accent-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" />
                              <Table2 size={10} className={`shrink-0 ${isMigrated ? 'text-emerald-400 dark:text-emerald-600' : 'text-gray-400'}`} />
                              <span className={`text-[11px] font-mono flex-1 truncate ${isMigrated ? 'line-through text-gray-400 dark:text-slate-600' : isSelected ? 'text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-slate-300'}`}>
                                <span className="text-[9px] font-normal">{t.schema}.</span>{t.name}
                              </span>
                              {isMigrated && <span className="text-[9px] text-emerald-500 dark:text-emerald-600 shrink-0">✓</span>}
                              <span className="text-[10px] text-gray-400 shrink-0">{t.rowCount.toLocaleString()}</span>
                            </div>
                          );
                        };
                        if (srcDbsSelected.length <= 1) {
                          return filteredSrcTables.map(renderTableRow);
                        }
                        const byDb = srcDbsSelected.map(db => ({
                          db,
                          tables: filteredSrcTables.filter(t => t.database === db),
                        }));
                        return byDb.map(({ db, tables }) => tables.length === 0 ? null : (
                          <div key={db}>
                            <div className="sticky top-0 z-10 px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 bg-blue-50/80 dark:bg-blue-950/30 border-b border-blue-100 dark:border-blue-900/40 flex items-center gap-1">
                              <Database size={8} className="shrink-0" />{db}
                              <span className="ml-auto font-normal text-blue-400 dark:text-blue-600">{tables.length}</span>
                            </div>
                            {tables.map(renderTableRow)}
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                </Panel>

                <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors" />

                {/* ── TARGET PANEL ─────────────────────────────────────── */}
                <Panel defaultSize={50} minSize={22}>
                  <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-900">

                    {/* Target header */}
                    <div className="shrink-0 p-3 border-b border-gray-200 dark:border-slate-800 bg-violet-50/50 dark:bg-violet-950/10">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="w-2 h-2 rounded-full bg-violet-500 shrink-0" />
                        <span className="text-[11px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400 flex-1">Target</span>
                        {tgtConnecting && <Loader2 size={10} className="animate-spin text-gray-400" />}
                        {tgtConnected && !tgtConnecting && (
                          <span className="inline-flex items-center gap=0.5 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                            <Check size={9} /> Connected
                          </span>
                        )}
                        {tgtError && !tgtConnecting && (
                          <span className="text-[10px] text-rose-500 truncate max-w-[100px]" title={tgtError}>{tgtError}</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <ConnSelect connections={connections} value={tgtConnId}
                          onChange={id => setTgtConnId(id)} onNew={() => void router.push('/settings')} accent="violet" />

                        {/* DB selector / create-new-DB row */}
                        {tgtConnId && (tgtLoadingDbs
                          ? <Loader2 size={11} className="animate-spin text-gray-400" />
                          : tgtNewDbMode
                            ? (
                              <div className="flex items-center gap-1">
                                <input
                                  value={tgtNewDbName}
                                  onChange={e => setTgtNewDbName(e.target.value)}
                                  onKeyDown={e => e.key === 'Enter' && void handleCreateTgtDb()}
                                  placeholder="new-database"
                                  autoFocus
                                  className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded border border-violet-300 dark:border-violet-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono focus:outline-none focus:border-violet-500"
                                />
                                <button
                                  onClick={() => void handleCreateTgtDb()}
                                  disabled={tgtCreatingDb || !tgtNewDbName.trim()}
                                  className="px-2 py-1 text-[11px] rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1">
                                  {tgtCreatingDb ? <Loader2 size={10} className="animate-spin" /> : 'Create'}
                                </button>
                                <button
                                  onClick={() => { setTgtNewDbMode(false); setTgtNewDbName(''); }}
                                  className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
                                  <X size={11} />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1">
                                <select value={tgtDb} onChange={e => setTgtDb(e.target.value)}
                                  className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-violet-400 cursor-pointer font-mono">
                                  {!tgtDb && <option value="">— select db —</option>}
                                  {tgtDbs.map(d => <option key={d} value={d}>{d}</option>)}
                                </select>
                                <button
                                  onClick={() => setTgtNewDbMode(true)}
                                  title="Create new database"
                                  className="shrink-0 p-1 rounded text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                                  <Plus size={12} />
                                </button>
                              </div>
                            )
                        )}

                        {/* Schema selector / create-new-schema row (PG only) */}
                        {tgtConnected && tgtConn.type === 'postgresql' && (
                          tgtNewSchemaMode
                            ? (
                              <div className="flex items-center gap-1">
                                <input
                                  value={tgtNewSchemaName}
                                  onChange={e => setTgtNewSchemaName(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter' && tgtNewSchemaName.trim()) {
                                      setTgtDefaultSchema(tgtNewSchemaName.trim());
                                      setTgtNewSchemaMode(false); setTgtNewSchemaName('');
                                    }
                                  }}
                                  placeholder="new_schema"
                                  autoFocus
                                  className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 font-mono focus:outline-none focus:border-violet-500"
                                />
                                <button
                                  onClick={() => {
                                    if (tgtNewSchemaName.trim()) {
                                      setTgtDefaultSchema(tgtNewSchemaName.trim());
                                      setTgtNewSchemaMode(false); setTgtNewSchemaName('');
                                    }
                                  }}
                                  disabled={!tgtNewSchemaName.trim()}
                                  className="px-2 py-1 text-[11px] rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
                                  Use
                                </button>
                                <button
                                  onClick={() => { setTgtNewSchemaMode(false); setTgtNewSchemaName(''); }}
                                  className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
                                  <X size={11} />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1">
                                <select value={tgtDefaultSchema} onChange={e => setTgtDefaultSchema(e.target.value)}
                                  title="Default target schema"
                                  className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 focus:outline-none cursor-pointer font-mono">
                                  {tgtSchemas.map(s => <option key={s} value={s}>{s}</option>)}
                                  {tgtDefaultSchema && !tgtSchemas.includes(tgtDefaultSchema) && (
                                    <option value={tgtDefaultSchema}>{tgtDefaultSchema} (new)</option>
                                  )}
                                </select>
                                <button
                                  onClick={() => setTgtNewSchemaMode(true)}
                                  title="Use a new schema"
                                  className="shrink-0 p-1 rounded text-gray-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                                  <Plus size={12} />
                                </button>
                              </div>
                            )
                        )}

                        {tgtDbError && <span className="text-[10px] text-rose-500">{tgtDbError}</span>}
                      </div>
                    </div>

                    {/* Tables label + search */}
                    <div className="shrink-0 px-3 pt-2 pb-1.5 border-b border-gray-100 dark:border-slate-800">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <Table2 size={10} className="text-violet-400 shrink-0" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400 flex-1">Tables</span>
                        {filteredTgtTables.length > 0 && (
                          <span className="text-[10px] text-gray-400">{filteredTgtTables.length}</span>
                        )}
                      </div>
                      <div className="relative">
                        <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                        <input value={tgtSearch} onChange={e => setTgtSearch(e.target.value)}
                          placeholder="Filter tables…"
                          className="w-full pl-6 pr-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500" />
                      </div>
                    </div>

                    {/* Tables list */}
                    <div className="flex-1 min-h-0 overflow-y-auto panel-scroll">
                      {!tgtConnected ? (
                        <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                          <Database size={28} className="text-gray-200 dark:text-slate-700" />
                          <p className="text-[11px] text-gray-400 dark:text-slate-500">Select a connection and database</p>
                        </div>
                      ) : filteredTgtTables.length === 0 ? (
                        tgtTables.length === 0 ? (
                          <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                            <Table2 size={24} className="text-gray-200 dark:text-slate-700" />
                            <p className="text-[11px] text-gray-500 dark:text-slate-400 font-medium">Empty target</p>
                            <p className="text-[10px] text-gray-400 dark:text-slate-500">Source table names will be used — tables are created on first run.</p>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">No tables match</div>
                        )
                      ) : filteredTgtTables.map(t => {
                        const mapping = tableMaps.find(m => m.target.schema === t.schema && m.target.table === t.name);
                        const isTarget = selectedMap?.target.schema === t.schema && selectedMap?.target.table === t.name;
                        const isClickable = !!selectedMapId || !!mapping;
                        return (
                          <div key={`${t.schema}.${t.name}`}
                            onClick={() => {
                              if (selectedMapId) void selectTargetTable(t.schema, t.name);
                              else if (mapping) setSelectedMapId(mapping.id);
                            }}
                            className={`group flex items-center gap-2 px-3 py-1.5 border-b border-gray-50 dark:border-slate-800/40 ${isClickable ? 'cursor-pointer' : 'cursor-default'} ${isTarget ? 'bg-violet-50 dark:bg-violet-950/30' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}>
                            {mapping ? (
                              <input type="checkbox" checked={mapping.include}
                                onChange={e => { e.stopPropagation(); updateTableMap(mapping.id, { include: e.target.checked }); }}
                                onClick={e => e.stopPropagation()}
                                className="shrink-0 accent-violet-500" />
                            ) : (
                              <div className="w-3.5 h-3.5 shrink-0" />
                            )}
                            <Table2 size={10} className={`shrink-0 ${isTarget || mapping ? 'text-violet-400' : 'text-gray-300 dark:text-slate-600'}`} />
                            <span className={`text-[11px] font-mono flex-1 truncate ${isTarget ? 'text-violet-700 dark:text-violet-400 font-medium' : mapping ? 'text-gray-700 dark:text-slate-300' : 'text-gray-400 dark:text-slate-600'}`}>
                              {t.name}
                            </span>
                            <span className="text-[10px] text-gray-400 shrink-0">{t.rowCount.toLocaleString()}</span>
                            {mapping && <span className="text-[9px] px-1 py-0.5 rounded bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400 font-semibold shrink-0">mapped</span>}
                            {isTarget && !mapping && <span className="text-[9px] px-1 py-0.5 rounded bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400 font-semibold shrink-0">target</span>}
                            {!isTarget && !mapping && selectedMapId && <span className="opacity-0 group-hover:opacity-100 text-[9px] px-1 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-gray-400 dark:text-slate-500 shrink-0 transition-opacity">assign</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </Panel>

              </PanelGroup>
            </Panel>

            <PanelResizeHandle className="h-px bg-gray-200 dark:bg-slate-700 hover:bg-violet-400 dark:hover:bg-violet-500 cursor-row-resize transition-colors" />

            {/* ── COLUMN MAPPING — full width ──── */}
            <Panel defaultSize={38} minSize={15}>
              <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-900">
                {/* Column mapping header */}
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60">
                  <Layers size={10} className="text-violet-400 shrink-0" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 flex-1">Column Mapping</span>
                  {selectedMap?.target.table && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-mono text-gray-400 dark:text-slate-500 truncate max-w-[200px]">
                        {selectedMap.source.schema}.{selectedMap.source.table}
                        <span className="text-gray-300 dark:text-slate-600 mx-1">→</span>
                        {selectedMap.target.schema}.{selectedMap.targetAlias?.trim() || selectedMap.target.table}
                      </span>
                      {selectedMap.sourceDatabase && (
                        <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-mono bg-blue-50 dark:bg-blue-950/30 text-blue-500 dark:text-blue-400 border border-blue-200 dark:border-blue-800 shrink-0">
                          <Database size={8} />{selectedMap.sourceDatabase}
                        </span>
                      )}
                      {/* Target table alias override */}
                      <input
                        type="text"
                        placeholder={selectedMap.target.table}
                        value={selectedMap.targetAlias ?? ''}
                        disabled={!!selectedMap.lastSyncedValue}
                        title={selectedMap.lastSyncedValue ? 'Table sudah migrated — rollback dulu sebelum rename' : 'Override nama target table'}
                        onChange={e => updateTableMap(selectedMap.id, { targetAlias: e.target.value || null })}
                        className={`px-1.5 py-0.5 text-[10px] rounded border font-mono w-24 transition-colors ${
                          selectedMap.lastSyncedValue
                            ? 'border-gray-100 dark:border-slate-700 text-gray-300 dark:text-slate-600 bg-gray-50 dark:bg-slate-900 cursor-not-allowed'
                            : 'border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:border-violet-400 focus:outline-none'
                        }`}
                      />
                      <div className="h-3 w-px bg-gray-200 dark:bg-slate-700" />
                      <label className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-slate-400">
                        <input type="checkbox" checked={selectedMap.truncateBeforeMigrate}
                          onChange={e => updateTableMap(selectedMap.id, { truncateBeforeMigrate: e.target.checked })}
                          className="accent-rose-500" />
                        Truncate
                      </label>
                      <div className="h-3 w-px bg-gray-200 dark:bg-slate-700" />
                      {/* Sync mode toggle */}
                      <button
                        onClick={() => updateTableMap(selectedMap.id, {
                          syncMode: (selectedMap.syncMode ?? 'full') === 'incremental' ? 'full' : 'incremental',
                          incrementalCol: null, incrementalStrategy: 'id', lastSyncedValue: null,
                        })}
                        className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                          (selectedMap.syncMode ?? 'full') === 'incremental'
                            ? 'bg-violet-100 dark:bg-violet-950/40 border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300 font-medium'
                            : 'border-gray-200 dark:border-slate-600 text-gray-400 hover:text-gray-600 dark:hover:text-slate-300'
                        }`}
                      >
                        {(selectedMap.syncMode ?? 'full') === 'incremental' ? '⟳ Incremental' : '⟳ Full'}
                      </button>
                      {/* Incremental config — only shown when incremental mode is on */}
                      {(selectedMap.syncMode ?? 'full') === 'incremental' && (
                        <>
                          <select
                            value={selectedMap.incrementalCol ?? ''}
                            onChange={e => updateTableMap(selectedMap.id, { incrementalCol: e.target.value || null })}
                            className="px-1.5 py-0.5 text-[10px] rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 max-w-[120px]"
                          >
                            <option value="">— watermark col —</option>
                            {srcColsForSelected.map(c => (
                              <option key={c.name} value={c.name}>{c.name}</option>
                            ))}
                          </select>
                          <select
                            value={selectedMap.incrementalStrategy ?? 'id'}
                            onChange={e => updateTableMap(selectedMap.id, { incrementalStrategy: e.target.value as 'id' | 'timestamp' })}
                            className="px-1.5 py-0.5 text-[10px] rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300"
                          >
                            <option value="id">by ID</option>
                            <option value="timestamp">by Timestamp</option>
                          </select>
                          {selectedMap.lastSyncedValue ? (
                            <span className="inline-flex items-center gap-0.5 text-[10px] text-violet-600 dark:text-violet-400 font-mono">
                              ↑ {selectedMap.lastSyncedValue.length > 20
                                ? selectedMap.lastSyncedValue.slice(0, 20) + '…'
                                : selectedMap.lastSyncedValue}
                              <button
                                onClick={() => updateTableMap(selectedMap.id, { lastSyncedValue: null })}
                                title="Reset watermark — next run will re-sync all rows"
                                className="text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors ml-0.5"
                              >
                                <X size={9} />
                              </button>
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-300 dark:text-slate-600 italic">no watermark</span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Column mapping editor */}
                <div className="flex-1 min-h-0 overflow-auto panel-scroll">
                  {!selectedMap ? (
                    <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">
                      Select a source table first
                    </div>
                  ) : !selectedMap.target.table ? (
                    <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">
                      Select a target table to map columns
                    </div>
                  ) : loadingCols && selectedMap.columns.length === 0 ? (
                    <div className="flex items-center justify-center h-full gap-1.5 text-[11px] text-gray-400 dark:text-slate-500 animate-pulse">
                      <Loader2 size={12} className="animate-spin" /> Loading column mapping…
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse" style={{ minWidth: 580 }}>
                        <thead>
                          <tr className="bg-gray-50 dark:bg-slate-800/60 sticky top-0 z-10">
                            {([
                              { label: 'Src Col', tip: 'Source Column', desc: 'Column name from the source database table.\nExample: user_id, created_at' },
                              { label: 'Src Type', tip: 'Source Type', desc: 'Original data type in the source database.\nExample: INT, VARCHAR(255), DATETIME' },
                              { label: '', tip: null, desc: null },
                              { label: 'Tgt Col', tip: 'Target Column', desc: 'Column name in the target table. Pick from the dropdown suggestions or type a new name directly.\nTyping a name not in the list creates a new column.' },
                              { label: 'Mapping', tip: 'Mapping Type', desc: 'Whether the target column is new (does not exist yet) or existing (already present in the target table).\n• new — column will be created\n• existing — column already exists and will be populated' },
                              { label: 'Tgt Type', tip: 'Target Type', desc: 'Data type inferred for the target column. Auto-set when you pick a Tgt Col or change Conv.\nExample: BIGINT, TEXT, TIMESTAMPTZ' },
                              { label: 'Conv', tip: 'Conversion', desc: 'Datatype cast or transformation applied during migration.\n• keep — copy value as-is\n• →UUID — serial int → UUID v4\n• →TEXT, →INT, →BIGINT, →NUMERIC, →BOOL, →TIMESTAMPTZ, →DATE, →JSONB — cast to that PG type' },
                              { label: 'Keep Orig', tip: 'Keep Original ID', desc: 'Only for →UUID conversion. Stores the original MySQL serial integer in a separate BIGINT column.\nSet a column name (e.g. legacy_id) to enable.\nUseful when other tables still reference the old serial integer as a FK.' },
                              { label: 'FK Ref', tip: 'Foreign Key Reference', desc: 'If this column is a UUID FK, enter the target table it references so the migrator can resolve IDs correctly.\nExample: public.users' },
                              { label: '✓', tip: 'Include', desc: 'Toggle whether this column is included in the migration. Uncheck to exclude a column from the INSERT.' },
                              { label: '', tip: null, desc: null },
                            ] as { label: string; tip: string | null; desc: string | null }[]).map((h, i) => (
                              <th key={i} className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">
                                {h.tip ? (
                                  <Tooltip
                                    side="bottom"
                                    align={i === 0 ? 'start' : 'center'}
                                    content={
                                      <div>
                                        <p className="font-semibold text-white mb-1">{h.tip}</p>
                                        {h.desc?.split('\n').map((line, li) => (
                                          <p key={li} className={line.startsWith('•') ? 'pl-2 text-gray-300' : 'text-gray-300'}>{line}</p>
                                        ))}
                                      </div>
                                    }
                                  >
                                    <span className="cursor-help border-b border-dashed border-gray-400 dark:border-slate-500">{h.label}</span>
                                  </Tooltip>
                                ) : h.label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                          {selectedMap.columns.map((col, idx) => {
                            const srcMeta = col.sourceCol
                              ? srcColsForSelected.find(c => c.name === col.sourceCol)
                              : undefined;
                            return (
                            <tr key={idx} className={`${col.include ? '' : 'opacity-40'} hover:bg-gray-50 dark:hover:bg-slate-800/30`}>
                                  <td className="px-2 py-1.5 max-w-[100px]">
                                    <div className="flex flex-col gap-0.5">
                                      <span className="font-mono text-[11px] text-gray-700 dark:text-slate-300 truncate">
                                        {col.sourceCol ?? <span className="italic text-gray-400">*(new)*</span>}
                                      </span>
                                      {srcMeta && (
                                        <div className="flex items-center gap-0.5">
                                          {srcMeta.isPk && <span className="text-[8px] px-1 py-px rounded bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 font-semibold">PK</span>}
                                          {srcMeta.isFk && <span className="text-[8px] px-1 py-px rounded bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold">FK</span>}
                                          {!srcMeta.nullable && <span className="text-[8px] px-1 py-px rounded bg-rose-100 dark:bg-rose-950/40 text-rose-500 dark:text-rose-400 font-semibold">NN</span>}
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-2 py-1.5 font-mono text-[10px] text-gray-400 dark:text-slate-500">
                                    {colsCache[`${selectedMap.sourceDatabase ?? ''}.${selectedMap.source.schema}.${selectedMap.source.table}`]?.find(c => c.name === col.sourceCol)?.rawType ?? '—'}
                                  </td>
                                  <td className="px-1 text-[10px] text-gray-300">→</td>
                                  {/* TGT COL — select existing or switch to custom name input */}
                                  <td className="px-2 py-1">
                                    {(() => {
                                      const currentVal = col.targetName ?? col.targetCol;
                                      const isCustom = tgtColsForSelected.length > 0 && !!currentVal && !tgtColsForSelected.find(c => c.name === currentVal);
                                      if (isCustom) {
                                        return (
                                          <div className="flex items-center gap-1">
                                            <input
                                              value={currentVal}
                                              onChange={e => updateColumn(selectedMap.id, idx, { targetCol: e.target.value, targetName: null })}
                                              className="w-24 px-1.5 py-0.5 text-[11px] rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-800 text-amber-700 dark:text-amber-300 font-mono focus:outline-none focus:border-amber-500"
                                              autoFocus
                                            />
                                            <button
                                              onClick={() => updateColumn(selectedMap.id, idx, { targetCol: '', targetName: null })}
                                              className="text-gray-300 dark:text-slate-600 hover:text-violet-500 transition-colors"
                                              title="Back to list">
                                              <X size={10} />
                                            </button>
                                          </div>
                                        );
                                      }
                                      if (tgtColsForSelected.length > 0) {
                                        return (
                                          <select
                                            value={currentVal}
                                            onChange={e => {
                                              const val = e.target.value;
                                              if (val === '__custom__') {
                                                updateColumn(selectedMap.id, idx, { targetCol: '', targetName: null });
                                                return;
                                              }
                                              const matched = tgtColsForSelected.find(c => c.name === val);
                                              updateColumn(selectedMap.id, idx, {
                                                targetCol: val,
                                                targetName: null,
                                                ...(matched ? { targetType: matched.rawType.toUpperCase() } : {}),
                                              });
                                            }}
                                            className="max-w-[120px] px-1.5 py-0.5 text-[11px] rounded border border-violet-200 dark:border-violet-800 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono focus:outline-none focus:border-violet-400">
                                            <option value="">— none —</option>
                                            <option value="__custom__">✎ new name…</option>
                                            {tgtColsForSelected.map(c => {
                                              const assignedTo = selectedMap.columns.find((r, rIdx) => rIdx !== idx && r.targetCol === c.name);
                                              return (
                                                <option key={c.name} value={c.name}>
                                                  {assignedTo ? `✓ ${assignedTo.sourceCol ?? '(new)'} → ${c.name}` : c.name}
                                                </option>
                                              );
                                            })}
                                          </select>
                                        );
                                      }
                                      return (
                                        <input
                                          value={currentVal}
                                          onChange={e => updateColumn(selectedMap.id, idx, { targetCol: e.target.value, targetName: null })}
                                          className="w-24 px-1.5 py-0.5 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono"
                                        />
                                      );
                                    })()}
                                  </td>
                                  {/* MAPPING — new vs existing */}
                                  <td className="px-2 py-1">
                                    {(col.targetName ?? col.targetCol) ? (
                                      tgtColsForSelected.length > 0 && tgtColsForSelected.find(c => c.name === (col.targetName ?? col.targetCol)) ? (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold uppercase tracking-wide">existing</span>
                                      ) : (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-semibold uppercase tracking-wide">new</span>
                                      )
                                    ) : (
                                      <span className="text-[9px] text-gray-300 dark:text-slate-600">—</span>
                                    )}
                                  </td>
                                  {/* TGT TYPE — label only */}
                                  <td className="px-2 py-1.5 font-mono text-[10px] text-gray-500 dark:text-slate-400 whitespace-nowrap">
                                    {col.targetType || '—'}
                                  </td>
                                  {/* CONV */}
                                  <td className="px-2 py-1">
                                    <select value={col.conversion}
                                      onChange={e => {
                                        const conv = e.target.value as IdConversion;
                                        const typeMap: Record<string, string> = {
                                          serial_to_uuid: tgtConn.type === 'postgresql' ? 'UUID' : 'VARCHAR(36)',
                                          to_text: 'TEXT',
                                          to_integer: 'INTEGER',
                                          to_bigint: 'BIGINT',
                                          to_numeric: 'NUMERIC',
                                          to_boolean: 'BOOLEAN',
                                          to_timestamptz: 'TIMESTAMPTZ',
                                          to_date: 'DATE',
                                          to_jsonb: 'JSONB',
                                        };
                                        const targetType = typeMap[conv] ?? col.targetType;
                                        updateColumn(selectedMap.id, idx, {
                                          conversion: conv, targetType,
                                          // clear legacy column name if switching away from serial_to_uuid
                                          ...(conv !== 'serial_to_uuid' ? { keepLegacyAs: null } : {}),
                                        });
                                      }}
                                      className="text-[10px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 py-0.5 px-1">
                                      <option value="keep">keep</option>
                                      <option value="serial_to_uuid">→UUID</option>
                                      <optgroup label="Cast to PG type">
                                        <option value="to_text">→TEXT</option>
                                        <option value="to_integer">→INT</option>
                                        <option value="to_bigint">→BIGINT</option>
                                        <option value="to_numeric">→NUMERIC</option>
                                        <option value="to_boolean">→BOOL</option>
                                        <option value="to_timestamptz">→TIMESTAMPTZ</option>
                                        <option value="to_date">→DATE</option>
                                        <option value="to_jsonb">→JSONB</option>
                                      </optgroup>
                                    </select>
                                  </td>
                                  {/* KEEP ORIG — only active for serial_to_uuid */}
                                  <td className="px-2 py-1">
                                    {col.conversion === 'serial_to_uuid' ? (
                                      col.keepLegacyAs ? (
                                        <div className="flex items-center gap-1">
                                          <input
                                            value={col.keepLegacyAs}
                                            onChange={e => updateColumn(selectedMap.id, idx, { keepLegacyAs: e.target.value || null })}
                                            className="w-20 px-1.5 py-0.5 text-[10px] rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-800 text-amber-700 dark:text-amber-300 font-mono focus:outline-none focus:border-amber-500" />
                                          <button
                                            onClick={() => updateColumn(selectedMap.id, idx, { keepLegacyAs: null })}
                                            className="text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors">
                                            <X size={10} />
                                          </button>
                                        </div>
                                      ) : (
                                        <button
                                          onClick={() => updateColumn(selectedMap.id, idx, {
                                            keepLegacyAs: col.sourceCol ? `old_${col.sourceCol}` : 'legacy_id',
                                          })}
                                          className="text-[10px] text-gray-400 dark:text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 font-mono transition-colors">
                                          + keep
                                        </button>
                                      )
                                    ) : (
                                      <span className="text-[10px] text-gray-200 dark:text-slate-700">—</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-1">
                                    {col.conversion === 'serial_to_uuid' ? (
                                      <span className="text-[10px] text-gray-200 dark:text-slate-700 font-mono">—</span>
                                    ) : (
                                      <div className="relative">
                                        <button
                                          onClick={() => { setFkPickerIdx(fkPickerIdx === idx ? null : idx); setFkManualInput(''); }}
                                          className={`w-24 px-1.5 py-0.5 text-[10px] rounded border font-mono text-left truncate block w-full
                                            ${col.fkRef
                                              ? 'border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 bg-blue-50/30 dark:bg-blue-950/20'
                                              : 'border-gray-200 dark:border-slate-700 text-gray-400 dark:text-slate-500 bg-white dark:bg-slate-800 hover:border-blue-300 dark:hover:border-blue-700'}`}>
                                          {col.fkRef || 'pick…'}
                                        </button>
                                        {fkPickerIdx === idx && (
                                          <div className="absolute left-0 top-full mt-1 z-[9999] w-60 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden">
                                            <div className="px-2.5 py-1.5 border-b border-gray-100 dark:border-slate-800 flex items-center justify-between">
                                              <span className="text-[10px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">FK Reference</span>
                                              <button onClick={() => setFkPickerIdx(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X size={10} /></button>
                                            </div>
                                            {/* Manual input — for FK refs from other databases/schemas not in current srcTables */}
                                            <div className="px-2.5 py-1.5 border-b border-gray-100 dark:border-slate-800 flex items-center gap-1.5">
                                              <input
                                                value={fkManualInput}
                                                onChange={e => setFkManualInput(e.target.value)}
                                                onKeyDown={e => {
                                                  if (e.key === 'Enter' && fkManualInput.trim()) {
                                                    updateColumn(selectedMap.id, idx, {
                                                      fkRef: fkManualInput.trim(),
                                                      ...(tgtConn.type === 'postgresql' ? { targetType: 'UUID' } : {}),
                                                    });
                                                    setFkPickerIdx(null);
                                                    setFkManualInput('');
                                                  }
                                                }}
                                                placeholder={srcIsPg ? 'db.schema.table (Enter to set)' : 'db.table (Enter to set)'}
                                                className="flex-1 px-1.5 py-0.5 text-[10px] font-mono rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder:text-gray-300 dark:placeholder:text-slate-600"
                                              />
                                              {fkManualInput.trim() && (
                                                <button
                                                  onClick={() => {
                                                    updateColumn(selectedMap.id, idx, {
                                                      fkRef: fkManualInput.trim(),
                                                      ...(tgtConn.type === 'postgresql' ? { targetType: 'UUID' } : {}),
                                                    });
                                                    setFkPickerIdx(null);
                                                    setFkManualInput('');
                                                  }}
                                                  className="shrink-0 p-0.5 rounded text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors"
                                                >
                                                  <Check size={10} />
                                                </button>
                                              )}
                                            </div>
                                            <div className="max-h-52 overflow-y-auto">
                                              <button
                                                onClick={() => { updateColumn(selectedMap.id, idx, { fkRef: null }); setFkPickerIdx(null); }}
                                                className="w-full px-2.5 py-1 text-left text-[10px] text-gray-400 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800 italic">
                                                — clear —
                                              </button>
                                              {srcDbsSelected.map(db => {
                                                const dbTables = srcTables.filter(t => t.database === db);
                                                const schemas = [...new Set(dbTables.map(t => t.schema))].sort();
                                                return schemas.map(schema => {
                                                  const tables = dbTables.filter(t => t.schema === schema);
                                                  if (!tables.length) return null;
                                                  return (
                                                    <div key={`${db}.${schema}`}>
                                                      <div className="px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500 bg-gray-50 dark:bg-slate-800/60 sticky top-0">
                                                        {srcDbsSelected.length > 1 ? `${db} · ${schema}` : schema}
                                                      </div>
                                                      {tables.map(t => {
                                                        const fkKey = srcIsPg ? `${t.database}.${t.schema}.${t.name}` : `${t.database}.${t.name}`;
                                                        return (
                                                          <button key={`${t.database}.${t.schema}.${t.name}`}
                                                            onClick={() => {
                                                              updateColumn(selectedMap.id, idx, {
                                                                fkRef: fkKey,
                                                                ...(tgtConn.type === 'postgresql' ? { targetType: 'UUID' } : {}),
                                                              });
                                                              setFkPickerIdx(null);
                                                            }}
                                                            className="w-full px-2.5 py-1.5 text-left hover:bg-blue-50 dark:hover:bg-blue-950/30 border-b border-gray-50 dark:border-slate-800/50 last:border-0">
                                                            <div className="text-[10px] font-mono font-medium text-gray-700 dark:text-slate-200">{t.name}</div>
                                                            <div className="text-[9px] text-gray-400 dark:text-slate-500 mt-0.5">{t.rowCount.toLocaleString()} rows · {fkKey}</div>
                                                          </button>
                                                        );
                                                      })}
                                                    </div>
                                                  );
                                                });
                                              })}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5 text-center">
                                    <input type="checkbox" checked={col.include}
                                      onChange={e => updateColumn(selectedMap.id, idx, { include: e.target.checked })}
                                      className="accent-violet-500" />
                                  </td>
                                  <td className="px-1 py-1.5">
                                    {col.sourceCol === null && (
                                      <button onClick={() => removeColumn(selectedMap.id, idx)}
                                        className="p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors">
                                        <X size={11} />
                                      </button>
                                    )}
                                  </td>
                                </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-800 flex justify-end">
                            <button onClick={() => addTargetOnlyColumn(selectedMap.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-medium border border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                              <Plus size={11} /> Add target-only column
                            </button>
                          </div>
                    </div>
                  )}
                </div>
              </div>
            </Panel>

            <PanelResizeHandle className="h-px bg-gray-200 dark:bg-slate-700 hover:bg-violet-400 dark:hover:bg-violet-500 cursor-row-resize transition-colors" />

            {/* ── RECORDS — full width ──── */}
            <Panel defaultSize={22} minSize={10}>
              <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-900">
                {/* Records header */}
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60">
                  <Database size={10} className="text-gray-400 shrink-0" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 flex-1">Records</span>
                  {srcPreviewLoading && <Loader2 size={10} className="animate-spin text-gray-400" />}
                  {!srcPreviewLoading && srcPreviewRows.length > 0 && (
                    <span className="text-[10px] text-gray-400">{srcPreviewRows.length}</span>
                  )}
                  {selectedMap && (
                    <span className="text-[10px] text-blue-500 dark:text-blue-400 font-mono truncate max-w-[160px]">
                      {selectedMap.source.schema}.{selectedMap.source.table}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-h-0 overflow-auto panel-scroll">
                  {srcPreviewLoading ? (
                    <div className="flex items-center justify-center h-full gap-1.5 text-[11px] text-gray-400">
                      <Loader2 size={11} className="animate-spin" /> Loading…
                    </div>
                  ) : srcPreviewCols.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">
                      {selectedMap ? 'No records' : 'Select a table'}
                    </div>
                  ) : (
                    <table className="text-xs border-collapse">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-gray-50 dark:bg-slate-800">
                          <th className="px-2 py-1 text-left text-[9px] font-semibold text-gray-400 dark:text-slate-500 border-b border-gray-200 dark:border-slate-700 w-7">#</th>
                          {srcPreviewCols.map(col => (
                            <th key={col} className="px-2 py-1 text-left text-[9px] font-semibold text-gray-600 dark:text-slate-300 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap font-mono">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                        {srcPreviewRows.map((row, i) => (
                          <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                            <td className="px-2 py-1 text-[9px] text-gray-300 dark:text-slate-600 font-mono">{i + 1}</td>
                            {srcPreviewCols.map(col => {
                              const val = row[col];
                              const isNull = val === null || val === undefined;
                              return (
                                <td key={col} className="px-2 py-1 font-mono whitespace-nowrap">
                                  <span className={isNull ? 'text-gray-300 dark:text-slate-600 italic text-[9px]' : 'text-gray-700 dark:text-slate-300 text-[10px]'}>
                                    {fmtVal(val)}
                                  </span>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </Panel>

          </PanelGroup>

          {/* ── JOBS PANEL (collapsible) ────────────────────────────────── */}
          <div className={`shrink-0 flex flex-col border-l border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden transition-[width] duration-200 ease-in-out ${jobsOpen ? 'w-60' : 'w-9'}`}>
            <div className="shrink-0 flex items-center gap-1.5 px-2 py-2.5 border-b border-gray-200 dark:border-slate-800">
              {jobsOpen && <Save size={11} className="text-gray-400 shrink-0" />}
              {jobsOpen && (
                <span className="text-[11px] font-semibold text-gray-700 dark:text-slate-300 flex-1 truncate">Saved Jobs</span>
              )}
              {jobsOpen && jobs.length > 0 && (
                <span className="text-[10px] text-gray-400 shrink-0">{jobs.length}</span>
              )}
              <button onClick={() => setJobsOpen(o => !o)}
                className="shrink-0 p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 transition-colors ml-auto">
                {jobsOpen ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
              </button>
            </div>

            {jobsOpen ? (
              <div className="flex-1 overflow-auto panel-scroll p-2 space-y-1.5">
                {jobs.length === 0 ? (
                  <div className="py-8 text-center">
                    <Save size={22} className="mx-auto text-gray-200 dark:text-slate-700 mb-2" />
                    <p className="text-[11px] text-gray-400 dark:text-slate-500">No saved jobs</p>
                  </div>
                ) : jobs.map(job => (
                  <div key={job.id}
                    className={`rounded-lg border p-2 transition-colors ${activeJobId === job.id ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/20' : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/50'}`}>
                    <div className="flex items-start gap-1 mb-0.5">
                      {renamingJobId === job.id ? (
                        <input
                          autoFocus
                          value={renameJobVal}
                          onChange={e => setRenameJobVal(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') void handleRenameJob(job.id, renameJobVal);
                            if (e.key === 'Escape') setRenamingJobId(null);
                          }}
                          className="flex-1 text-[11px] font-medium bg-white dark:bg-slate-700 border border-blue-400 rounded px-1 py-0.5 text-gray-800 dark:text-slate-200 outline-none"
                        />
                      ) : (
                        <p className="text-[11px] font-medium text-gray-800 dark:text-slate-200 flex-1 truncate">{job.name}</p>
                      )}
                      {renamingJobId === job.id ? (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button onClick={() => void handleRenameJob(job.id, renameJobVal)}
                            className="p-0.5 rounded text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors">
                            <Check size={11} />
                          </button>
                          <button onClick={() => setRenamingJobId(null)}
                            className="p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                            <X size={11} />
                          </button>
                        </div>
                      ) : (
                        <span className="text-[10px] text-gray-400 shrink-0">v{job.version}</span>
                      )}
                    </div>
                    {job.description && (
                      <p className="text-[10px] text-gray-400 dark:text-slate-500 truncate mb-1">{job.description}</p>
                    )}
                    <div className="flex items-center gap-1 mb-1.5">
                      <p className="text-[10px] text-gray-400 flex-1">{job.tableCount} tables · {new Date(job.updatedAt).toLocaleDateString()}</p>
                      <button
                        onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
                        className="flex items-center gap-0.5 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                      >
                        {expandedJobId === job.id ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                      </button>
                    </div>
                    {expandedJobId === job.id && (
                      <div className="mb-1.5 border border-gray-100 dark:border-slate-700 rounded overflow-hidden">
                        {job.tables.length === 0 ? (
                          <div className="px-2 py-2 flex items-center gap-2">
                            <p className="text-[10px] text-amber-500 dark:text-amber-400 italic flex-1">No tables — job may be corrupted</p>
                            <button
                              onClick={() => void handleRestoreJobFromRuns(job.id)}
                              title="Restore tables from run history"
                              className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
                            >
                              Restore
                            </button>
                          </div>
                        ) : job.tables.map((t: MigJobTableSummary) => (
                          <div key={t.id} className={`flex items-center gap-1 px-2 py-1 border-b border-gray-50 dark:border-slate-800 last:border-0 ${!t.include ? 'opacity-40' : ''}`}>
                            <span className="text-[10px] text-gray-600 dark:text-slate-300 flex-1 truncate min-w-0">
                              <span className="text-gray-400">{t.source.schema}.</span>{t.source.table}
                              <span className="text-gray-300 dark:text-slate-600 mx-1">→</span>
                              <span className="text-gray-400">{t.target.schema}.</span>{t.targetAlias?.trim() || t.target.table}
                              {t.targetAlias?.trim() && t.targetAlias.trim() !== t.target.table && (
                                <span className="text-violet-400 ml-0.5 italic text-[9px]"> ✎</span>
                              )}
                            </span>
                            {t.sourceDatabase && (
                              <span className="shrink-0 px-1 py-0.5 rounded text-[9px] font-mono bg-blue-50 dark:bg-blue-950/30 text-blue-400 dark:text-blue-500 border border-blue-100 dark:border-blue-900">{t.sourceDatabase}</span>
                            )}
                            <button
                              onClick={() => handleRemoveTableFromJob(job.id, t.id, `${t.source.schema}.${t.source.table}`)}
                              title="Remove table from job"
                              className="shrink-0 p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
                            >
                              <X size={10} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-1 mt-0.5">
                      <div className="flex items-center gap-1 min-w-0">
                        {activeJobId === job.id && (
                          <span className="text-[9px] px-1 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-medium shrink-0">active</span>
                        )}
                        <button onClick={() => void handleLoadJob(job.id)}
                          className="shrink-0 px-3 py-1 rounded text-[10px] font-medium bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors">
                          Load
                        </button>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                      <Tooltip content="Analyze in Schema Studio" side="top">
                        <button onClick={() => void handleOpenInSchemaStudio(job.id)}
                          className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-violet-500 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                          <ExternalLink size={12} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Export DDL SQL" side="top">
                        <button onClick={() => void handleExportJobSql(job.id)}
                          className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors">
                          <FileCode size={12} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Export CLI script" side="top">
                        <button onClick={() => void handleExportJobScript(job.id)}
                          className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors">
                          <Terminal size={12} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Export Markdown" side="top">
                        <button onClick={() => void handleExportJobMd(job.id)}
                          className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                          <FileText size={12} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Rename job" side="top">
                        <button onClick={() => { setRenamingJobId(job.id); setRenameJobVal(job.name); }}
                          className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                          <Pencil size={12} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Delete job" side="top">
                        <button onClick={() => handleDeleteJob(job.id, job.name)}
                          className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                          <Trash2 size={12} />
                        </button>
                      </Tooltip>
                      </div>
                    </div>
                  </div>
                ))}

                {/* ── Pending Save Log ────────────────────────── */}
                {completedMigratedStates.length > 0 && (
                  <>
                    <div className="flex items-center gap-1.5 pt-2 pb-0.5">
                      <div className="flex-1 h-px bg-gray-100 dark:bg-slate-700" />
                      <span className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 shrink-0 uppercase tracking-wide">Pending Save</span>
                      <button
                        onClick={() => {
                          const allKeys = new Set([...savedMigratedSources, ...completedMigratedStates.map(ts => ts.sourceKey)]);
                          setSavedMigratedSources(allKeys);
                          if (currentRun) {
                            try { localStorage.setItem(`mig_saved_${currentRun.id}`, JSON.stringify([...allKeys])); } catch { /* ignore */ }
                          }
                        }}
                        title="Clear all — mark all as saved without saving to a job"
                        className="shrink-0 p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-gray-500 dark:hover:text-slate-400 transition-colors"
                      >
                        <X size={9} />
                      </button>
                      <div className="flex-1 h-px bg-gray-100 dark:bg-slate-700" />
                    </div>
                    <div className="flex items-center gap-1 px-0.5 py-0.5">
                      <button
                        onClick={() => {
                          if (selectedMigratedKeys.size === completedMigratedStates.length) {
                            setSelectedMigratedKeys(new Set());
                          } else {
                            setSelectedMigratedKeys(new Set(completedMigratedStates.map(ts => ts.sourceKey)));
                          }
                        }}
                        className="flex items-center gap-1 text-[10px] text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition-colors"
                      >
                        <div className={`w-3 h-3 rounded border flex items-center justify-center transition-colors ${selectedMigratedKeys.size === completedMigratedStates.length ? 'bg-blue-500 border-blue-500' : 'border-gray-300 dark:border-slate-600'}`}>
                          {selectedMigratedKeys.size === completedMigratedStates.length && <Check size={8} className="text-white" />}
                        </div>
                        All
                      </button>
                      <span className="text-[10px] text-gray-400 dark:text-slate-500 flex-1 ml-1">{completedMigratedStates.length} table{completedMigratedStates.length !== 1 ? 's' : ''}</span>
                      {selectedMigratedKeys.size > 0 && (
                        <button
                          onClick={() => setShowSaveMigratedDialog(true)}
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/60 transition-colors"
                        >
                          <Save size={9} /> Save {selectedMigratedKeys.size}
                        </button>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      {completedMigratedStates.map(ts => {
                        const isSelected = selectedMigratedKeys.has(ts.sourceKey);
                        const isRollingBackThis = rollingBackTableId === ts.id;
                        const canRollback = currentRun && (currentRun.status === 'completed' || currentRun.status === 'failed');
                        return (
                          <div
                            key={ts.id}
                            onClick={() => setSelectedMigratedKeys(prev => {
                              const next = new Set(prev);
                              if (next.has(ts.sourceKey)) next.delete(ts.sourceKey); else next.add(ts.sourceKey);
                              return next;
                            })}
                            className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer transition-colors ${isSelected ? 'bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900' : 'border border-transparent hover:bg-gray-50 dark:hover:bg-slate-800/50'}`}
                          >
                            <div className={`w-3 h-3 rounded border shrink-0 flex items-center justify-center transition-colors ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-300 dark:border-slate-600'}`}>
                              {isSelected && <Check size={8} className="text-white" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] text-gray-700 dark:text-slate-300 truncate font-mono">{ts.sourceKey}</p>
                              <p className="text-[9px] text-gray-400 dark:text-slate-500">
                                {ts.rowsMigrated.toLocaleString()} written
                                {(ts.rowsSkipped ?? 0) > 0 && <span className="ml-1 text-amber-500 dark:text-amber-400">{ts.rowsSkipped.toLocaleString()} skipped</span>}
                                {(ts.rowsErrored ?? 0) > 0 && <span className="ml-1 text-rose-500 dark:text-rose-400">{ts.rowsErrored.toLocaleString()} errors</span>}
                              </p>
                            </div>
                            {canRollback && (
                              <button
                                onClick={e => { e.stopPropagation(); openRollbackPrompt(ts.id); }}
                                disabled={!!rollingBackTableId}
                                title={`Rollback ${ts.sourceKey}`}
                                className="shrink-0 p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 disabled:opacity-40 transition-colors"
                              >
                                {isRollingBackThis ? <Loader2 size={9} className="animate-spin" /> : <Undo2 size={9} />}
                              </button>
                            )}
                            <CheckCircle2 size={10} className="text-emerald-500 shrink-0" />
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-[10px] text-gray-400 dark:text-slate-600 select-none"
                  style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                  Saved Jobs
                </span>
              </div>
            )}
          </div>
        </div>

        {/* ── RUN CONSOLE (appears when run is active) ──────────────────── */}
        {currentRun && (
          <div className="shrink-0 border-t border-gray-200 dark:border-slate-700 flex flex-col bg-white dark:bg-slate-900" style={{ height: 260 }}>
            <div className="shrink-0 px-4 py-2 border-b border-gray-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">
              <StatusBadge status={currentRun.status} />
              <span className="text-xs text-gray-500 dark:text-slate-400">
                {currentRun.migratedRows.toLocaleString()} / {currentRun.totalRows.toLocaleString()} rows
              </span>
              <span className="text-xs text-gray-400 font-mono">{currentRun.id.slice(0, 8)}</span>
              <div className="flex-1" />
              {(currentRun.status === 'completed' || currentRun.status === 'failed') && (
                <button onClick={() => setRunRollbackPrompt({ drop: false })} disabled={rollingBack}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-100 disabled:opacity-50 transition-colors">
                  {rollingBack ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} Rollback
                </button>
              )}
              <button onClick={() => setCurrentRun(null)}
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
                <X size={13} />
              </button>
            </div>
            <div className="flex flex-1 min-h-0">
              {/* Per-table progress */}
              <div className="shrink-0 w-56 border-r border-gray-100 dark:border-slate-800 overflow-auto panel-scroll p-2 space-y-2">
                {currentRun.tableStates.map(ts => {
                  const totalProcessed = ts.rowsMigrated + (ts.rowsSkipped ?? 0);
                  const pct = ts.rowsSource > 0 ? Math.min(100, Math.round(totalProcessed / ts.rowsSource * 100)) : 0;
                  const isRollingBackThis = rollingBackTableId === ts.id;
                  const canRollbackThis = (ts.status === 'completed' || ts.status === 'failed') && !polling;
                  return (
                    <div key={ts.id}>
                      <div className="flex items-center gap-1 mb-0.5">
                        <span className="text-[10px] font-mono text-gray-700 dark:text-slate-300 flex-1 truncate">{ts.sourceKey}</span>
                        <StatusBadge status={ts.status} />
                        {canRollbackThis && (
                          <button
                            onClick={() => openRollbackPrompt(ts.id)}
                            disabled={!!rollingBackTableId}
                            title={`Rollback ${ts.sourceKey}`}
                            className="shrink-0 p-0.5 rounded text-gray-400 hover:text-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 disabled:opacity-40 transition-colors"
                          >
                            {isRollingBackThis ? <Loader2 size={9} className="animate-spin" /> : <Undo2 size={9} />}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 h-1 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-500 ${ts.status === 'completed' ? 'bg-emerald-500' : ts.status === 'failed' ? 'bg-rose-500' : ts.status === 'rolled_back' ? 'bg-amber-500' : 'bg-blue-500'}`}
                            style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-gray-400 shrink-0">{pct}%</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span className="text-[9px] text-gray-400">{ts.rowsMigrated.toLocaleString()} written</span>
                        {(ts.rowsSkipped ?? 0) > 0 && (
                          <span className="text-[9px] text-amber-500 dark:text-amber-400">{ts.rowsSkipped.toLocaleString()} skipped</span>
                        )}
                        {(ts.rowsErrored ?? 0) > 0 && (
                          <span className="text-[9px] text-rose-500 dark:text-rose-400">{ts.rowsErrored.toLocaleString()} errors</span>
                        )}
                      </div>
                      {ts.error && <p className="text-[10px] text-rose-500 mt-0.5 truncate">{ts.error}</p>}
                    </div>
                  );
                })}
              </div>
              {/* Live logs */}
              <div className="flex-1 overflow-auto panel-scroll bg-gray-900 dark:bg-black p-3 font-mono text-[11px] text-gray-300">
                {currentRun.logs.map((line, i) => (
                  <div key={i} className={`leading-5 ${line.includes('ERROR') ? 'text-rose-400' : line.includes('completed') ? 'text-emerald-400' : line.includes('ROLLBACK') ? 'text-amber-400' : line.includes('skipped') ? 'text-amber-400' : ''}`}>
                    {line}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Save Pending Tables dialog */}
      {showSaveMigratedDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-slate-200 mb-1">Save to Job</h3>
            <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">{selectedMigratedKeys.size} table{selectedMigratedKeys.size !== 1 ? 's' : ''} selected</p>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">New job name</label>
                <input
                  value={saveMigratedJobName}
                  onChange={e => { setSaveMigratedJobName(e.target.value); setSaveMigratedTargetJobId(null); }}
                  placeholder="e.g. Dev → Staging"
                  disabled={!!saveMigratedTargetJobId}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-40"
                />
              </div>
              {jobs.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Or add to existing job</label>
                  <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-gray-200 dark:border-slate-600 p-1.5 bg-gray-50 dark:bg-slate-900/50">
                    {jobs.map(j => (
                      <button key={j.id} type="button"
                        onClick={() => setSaveMigratedTargetJobId(prev => prev === j.id ? null : j.id)}
                        className={`w-full text-left px-2 py-1.5 rounded-md text-[11px] transition-colors ${saveMigratedTargetJobId === j.id ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium' : 'hover:bg-white dark:hover:bg-slate-700 text-gray-700 dark:text-slate-300'}`}>
                        <span className="font-medium">{j.name}</span>
                        <span className="ml-1.5 text-gray-400 dark:text-slate-500">{j.tableCount} tables · v{j.version}</span>
                      </button>
                    ))}
                  </div>
                  {saveMigratedTargetJobId && (
                    <p className="text-[10px] text-blue-600 dark:text-blue-400 mt-1">
                      Selected tables will be appended to this job (duplicates skipped).
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => { setShowSaveMigratedDialog(false); setSaveMigratedJobName(''); setSaveMigratedTargetJobId(null); }}
                className="flex-1 py-2 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => void handleSaveMigratedTables()}
                disabled={savingMigrated || (!saveMigratedTargetJobId && !saveMigratedJobName.trim())}
                className="flex-1 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {savingMigrated ? 'Saving…' : saveMigratedTargetJobId ? 'Add to Job' : 'Create Job'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FK picker backdrop */}
      {fkPickerIdx !== null && (
        <div className="fixed inset-0 z-[9998]" onClick={() => setFkPickerIdx(null)} />
      )}

      {/* Save Job dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-slate-200 mb-4">Save Migration Job</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Job name *</label>
                <input value={saveJobName} onChange={e => { setSaveJobName(e.target.value); setSaveAsTarget(null); }} placeholder="e.g. Dev → Staging"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Description</label>
                <input value={saveJobDesc} onChange={e => setSaveJobDesc(e.target.value)} placeholder="Optional"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              {/* Save as existing job */}
              {jobs.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Save as existing job</label>
                  <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-gray-200 dark:border-slate-600 p-1.5 bg-gray-50 dark:bg-slate-900/50">
                    {jobs.map(j => (
                      <button key={j.id} type="button"
                        onClick={() => {
                          if (saveAsTarget === j.id) {
                            setSaveAsTarget(null);
                            setSaveJobName(saveJobName);
                          } else {
                            setSaveAsTarget(j.id);
                            setSaveJobName(j.name);
                            setSaveJobDesc(j.description);
                          }
                        }}
                        className={`w-full text-left px-2 py-1.5 rounded-md text-[11px] transition-colors ${saveAsTarget === j.id ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium' : 'hover:bg-white dark:hover:bg-slate-700 text-gray-700 dark:text-slate-300'}`}>
                        <span className="font-medium">{j.name}</span>
                        <span className="ml-1.5 text-gray-400 dark:text-slate-500">{j.tableCount} tables · v{j.version}</span>
                      </button>
                    ))}
                  </div>
                  {saveAsTarget && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1">
                      Will overwrite existing job with current table mappings.
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => { setShowSaveDialog(false); setSaveAsTarget(null); }}
                className="flex-1 py-2 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button onClick={handleSaveJob} disabled={savingJob || !saveJobName.trim()}
                className="flex-1 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {savingJob ? 'Saving…' : saveAsTarget ? 'Update Job' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
