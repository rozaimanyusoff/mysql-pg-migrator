'use client';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import {
  ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp,
  Database, FileCode, FileText, Layers, Loader2,
  Pause, Pencil, Play, Plus, Undo2, Save, Search, Sparkles, Square,
  Table2, Terminal, Trash2, X, AlertTriangle, CheckCircle2, Clock, Eye, RotateCcw,
  Calendar, Info,
} from 'lucide-react';
import { toast } from 'sonner';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { Tooltip } from '../components/Tooltip';
import { useAlert } from '../lib/alert-context';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { suggestTargetType, isPkLikeSerial } from '../lib/migv2/type-map';
import type { MigConn, TableMap, ColumnMap, MigJob, MigJobSummary, MigJobTableSummary, MigRun, MigRunTableState, IdConversion } from '../lib/migv2/types';
import type { DiagnoseResult } from './api/ai/diagnose';
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
    aborted: 'bg-orange-100 dark:bg-orange-950/50 text-orange-700 dark:text-orange-300',
  };
  const Icon = status === 'running' ? Loader2
    : status === 'completed' ? CheckCircle2
    : status === 'failed' ? AlertTriangle
    : status === 'rolled_back' ? Undo2
    : status === 'aborted' ? X
    : Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[12px] font-semibold ${map[status] ?? map.pending}`}>
      <Icon size={11} className={status === 'running' ? 'animate-spin' : ''} />
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
      className={`w-full px-2 py-1 text-[13px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none ${focusCls} cursor-pointer`}
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
        className="w-full flex items-center justify-between gap-1.5 px-2 py-1 text-[13px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 hover:border-blue-400 focus:outline-none focus:border-blue-400 transition-colors font-mono"
      >
        <span className={`flex-1 text-left truncate ${selected.length === 0 ? 'text-gray-400 dark:text-slate-500' : ''}`}>{label}</span>
        <ChevronDown size={13} className={`shrink-0 text-slate-500 dark:text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-0.5 w-full rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-lg overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1 border-b border-gray-100 dark:border-slate-700">
            <span className="text-[11px] uppercase tracking-wider text-gray-400 dark:text-slate-500 font-semibold">Databases</span>
            <div className="flex items-center gap-2">
              <button onClick={() => onChange(dbs)} className="text-[11px] text-blue-500 hover:text-blue-700 dark:hover:text-blue-300">all</button>
              <button onClick={() => onChange([])} className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">clear</button>
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
                <span className="text-[13px] font-mono text-gray-700 dark:text-slate-300 truncate flex-1">{db}</span>
                {selected.includes(db) && <Check size={11} className="shrink-0 text-blue-500" />}
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
  const { showError, showWarning, showConfirm } = useAlert();

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
  const [fkPickerPos, setFkPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [openColPickerIdx, setOpenColPickerIdx] = useState<number | null>(null);
  const [colPickerPos, setColPickerPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [colPickerFilter, setColPickerFilter] = useState('');
  const [openSrcColPickerIdx, setOpenSrcColPickerIdx] = useState<number | null>(null);
  const [srcColPickerPos, setSrcColPickerPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [srcColPickerFilter, setSrcColPickerFilter] = useState('');
  const [fkManualInput, setFkManualInput] = useState('');
  const [dirty, setDirty] = useState(false);
  useUnsavedGuard(dirty, 'This job has unsaved changes that will be lost if you leave.\nSave the job first or discard changes.');

  // ── Jobs ──────────────────────────────────────────────────────────────────────
  const [jobs, setJobs] = useState<MigJobSummary[]>([]);
  const [tgtToSrcRef, setTgtToSrcRef] = useState<Record<string, string>>({});
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [saveJobName, setSaveJobName] = useState('');
  const [saveJobDesc, setSaveJobDesc] = useState('');
  // When true, after a successful Save the user is taken straight to the
  // Scheduler with the Add-Schedule form open for the new job.
  const [scheduleAfterSave, setScheduleAfterSave] = useState(false);
  const [filterCol, setFilterCol] = useState('');
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  // Diagnostics modal
  const [diagnoseModal, setDiagnoseModal] = useState<{
    open: boolean;
    sourceKey: string;
    targetKey: string;
    error: string;
    result: DiagnoseResult | null;
    loading: boolean;
  }>({ open: false, sourceKey: '', targetKey: '', error: '', result: null, loading: false });
  const [savingJob, setSavingJob] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [saveAsTarget, setSaveAsTarget] = useState<string | null>(null);
  const [jobsOpen, setJobsOpen] = useState(true);
  const [renamingJobId, setRenamingJobId] = useState<string | null>(null);
  const [renameJobVal, setRenameJobVal] = useState('');
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [selectedMigratedKeys, setSelectedMigratedKeys] = useState<Set<string>>(new Set());
  const [savedMigratedSources, setSavedMigratedSources] = useState<Set<string>>(new Set());
  // Accumulate completed table states across multiple runs — persisted to localStorage
  const PENDING_KEY = 'mig_pending_session';
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
  const stopRequestedRef = useRef(false);
  const [pausedTableIds, setPausedTableIds] = useState<Set<string>>(new Set());
  const pendingJobRestoreRef = useRef<{ tables: TableMap[]; srcDbs: string[]; selectedMapId: string | null; srcSchema: string } | null>(null);
  const pendingTgtDbRestoreRef = useRef<string | null>(null);
  const pendingTgtSchemaRestoreRef = useRef<string | null>(null);
  const srcRestorePendingRef = useRef(false);
  const [highlightTgtKey, setHighlightTgtKey] = useState<string | null>(null);
  const tgtRowRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // ── Schema drift (Scenario 4) ─────────────────────────────────────────────────
  interface ColDrift { col: string; from: string; to: string }
  interface TableDrift {
    tableId: string; sourceKey: string; targetKey: string;
    added: { name: string; rawType: string }[];
    removed: string[];
    typeChanged: ColDrift[];
  }
  const [schemaDrift, setSchemaDrift] = useState<TableDrift[]>([]);
  const [showDriftDialog, setShowDriftDialog] = useState(false);
  const pendingDriftScanRef = useRef(false);

  // ── Inline record preview ─────────────────────────────────────────────────────
  const [showRecords, setShowRecords] = useState(false);
  const [srcPreviewCols, setSrcPreviewCols] = useState<string[]>([]);
  const [srcPreviewRows, setSrcPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [srcPreviewLoading, setSrcPreviewLoading] = useState(false);
  const [tgtPreviewCols, setTgtPreviewCols] = useState<string[]>([]);
  const [tgtPreviewRows, setTgtPreviewRows] = useState<Record<string, unknown>[]>([]);
  const [tgtPreviewLoading, setTgtPreviewLoading] = useState(false);

  // ── Target column cache ───────────────────────────────────────────────────────
  const [tgtColsCache, setTgtColsCache] = useState<Record<string, MigColumnInfo[]>>({});
  const [newSchemaBannerDismissed, setNewSchemaBannerDismissed] = useState(false);

  // ── Load connections ──────────────────────────────────────────────────────────
  useEffect(() => {
    void axios.get<{ connections: ConnectionRow[] }>('/api/connections')
      .then(r => setConnections(r.data.connections))
      .catch(() => {});
  }, []);

  // ── Source DB loading ─────────────────────────────────────────────────────────
  const loadSrcDbs = useCallback(async (connId: number) => {
    const row = connections.find(c => c.id === connId);
    if (!row) return;
    setSrcLoadingDbs(true); setSrcDbs([]); setSrcDbsSelected([]); setSrcDbError(''); setSrcSchema('');
    setSrcConnected(false); setSrcTables([]);
    setTableMaps([]); setColsCache({}); setSelectedMapId(null);
    try {
      const { data } = await axios.post<{ databases: string[] }>(
        '/api/schema-designer/databases',
        { type: row.db_type === 'postgres' ? 'postgresql' : 'mysql', host: row.host, port: row.port, username: row.username, password: row.password_enc ?? '' }
      );
      setSrcDbs(data.databases);
      const restore = pendingJobRestoreRef.current;
      if (restore) {
        pendingJobRestoreRef.current = null;
        srcRestorePendingRef.current = true;
        const validDbs = restore.srcDbs.filter(d => data.databases.includes(d));
        const def = data.databases.includes(row.database_name) ? row.database_name : data.databases[0] ?? '';
        setSrcDbsSelected(validDbs.length ? validDbs : (def ? [def] : []));
        setTableMaps(restore.tables);
        setSelectedMapId(restore.selectedMapId);
        if (restore.srcSchema) setSrcSchema(restore.srcSchema);
      } else {
        const def = data.databases.includes(row.database_name) ? row.database_name : data.databases[0] ?? '';
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
    const isRestore = srcRestorePendingRef.current;
    srcRestorePendingRef.current = false;
    if (!isRestore) { setSelectedMapId(null); setSrcSchema(''); }
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
        if (!isRestore) {
          const first = merged[0]?.schema;
          if (first) setSrcSchema(first);
        }
      })
      .catch(err => {
        const raw: string = axios.isAxiosError(err) ? (err.response?.data?.error ?? '') : '';
        const msg = raw.toLowerCase().includes('timeout')
          ? 'Connection timed out — check host, port & firewall'
          : raw.toLowerCase().includes('password') || raw.toLowerCase().includes('auth')
          ? 'Authentication failed — check credentials'
          : raw.toLowerCase().includes('econnrefused') || raw.toLowerCase().includes('refused')
          ? 'Connection refused — server unreachable'
          : raw || 'Connection failed';
        setSrcError(msg);
      })
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
      const restoreTgtDb = pendingTgtDbRestoreRef.current;
      if (restoreTgtDb) {
        pendingTgtDbRestoreRef.current = null;
        const db = data.databases.includes(restoreTgtDb) ? restoreTgtDb : (data.databases.includes(row.database_name) ? row.database_name : data.databases[0] ?? '');
        setTgtDb(db);
      } else {
        const def = data.databases.includes(row.database_name) ? row.database_name : data.databases[0] ?? '';
        setTgtDb(def);
      }
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
          setTgtDefaultSchema(list.includes('public') ? 'public' : list[0]);
        }
      })
      .catch(err => {
        const raw: string = axios.isAxiosError(err) ? (err.response?.data?.error ?? '') : '';
        const msg = raw.toLowerCase().includes('timeout')
          ? 'Connection timed out — check host, port & firewall'
          : raw.toLowerCase().includes('password') || raw.toLowerCase().includes('auth')
          ? 'Authentication failed — check credentials'
          : raw.toLowerCase().includes('econnrefused') || raw.toLowerCase().includes('refused')
          ? 'Connection refused — server unreachable'
          : raw || 'Connection failed';
        setTgtError(msg);
      })
      .finally(() => setTgtConnecting(false));
  }, [tgtDb]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply pending target schema restore once the target DB connects.
  // We do NOT require the schema to exist in tgtSchemas — the dropdown supports a "(new)"
  // option, so we can restore even when the schema hasn't been created yet.
  useEffect(() => {
    if (!tgtConnected) return;
    const restoreSchema = pendingTgtSchemaRestoreRef.current;
    if (restoreSchema) {
      pendingTgtSchemaRestoreRef.current = null;
      setTgtDefaultSchema(restoreSchema);
    }
  }, [tgtConnected]); // eslint-disable-line react-hooks/exhaustive-deps

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
          conversion: 'keep',
          fkRef: c.isFk && c.fkRef ? c.fkRef.split('.').slice(0, 2).join('.') : null,
          keepLegacyAs: null,
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

  const addUnmatchedTgtCol = (mapId: string, col: MigColumnInfo) => {
    setTableMaps(prev => prev.map(m => {
      if (m.id !== mapId) return m;
      const entry: ColumnMap = {
        sourceCol: null, targetCol: col.name, targetName: null,
        targetType: col.rawType.toUpperCase(),
        nullable: col.nullable,
        defaultValue: col.defaultValue,
        include: true, conversion: 'keep',
        fkRef: col.fkRef ? col.fkRef.split('.').slice(0, 2).join('.') : null,
        keepLegacyAs: null,
      };
      return { ...m, columns: [...m.columns, entry] };
    }));
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

  // Columns where source is int/bigint but target is UUID and conversion is still 'keep' —
  // these will fail at runtime with "invalid input syntax for type uuid".
  const intUuidMismatchIndices = useMemo(() => {
    if (!selectedMap) return new Set<number>();
    const isIntSrc = (rawType: string) =>
      /^(tinyint|smallint|mediumint|int|integer|bigint|int4|int8|serial|bigserial|smallserial)(\(.*\))?$/i.test(rawType.trim());
    const isUuidTgt = (t: string) => /^uuid$/i.test(t.trim());
    const result = new Set<number>();
    selectedMap.columns.forEach((col, idx) => {
      if (!col.include || col.conversion !== 'keep') return;
      if (!isUuidTgt(col.targetType)) return;
      const srcMeta = col.sourceCol ? srcColsForSelected.find(c => c.name === col.sourceCol) : undefined;
      if (srcMeta && isIntSrc(srcMeta.rawType)) result.add(idx);
    });
    return result;
  }, [selectedMap, srcColsForSelected]);

  // Target columns that exist in the target table but are not yet in the mapping
  const unmatchedTgtCols = useMemo(() => {
    if (!selectedMap || !tgtColsForSelected.length) return [];
    const mappedNames = new Set(selectedMap.columns.map(c => c.targetName ?? c.targetCol));
    return tgtColsForSelected.filter(c => !mappedNames.has(c.name));
  }, [selectedMap, tgtColsForSelected]);

  const includedCount = tableMaps.filter(m => m.include).length;
  const canStart = srcConnected && tgtConnected && includedCount > 0 && !polling;

  // Included tables whose target table does not exist yet — these are created
  // fresh on first run, preserving source columns & data types. Drives the
  // "migrating into a new schema" guidance banner.
  const newTargetTables = useMemo(
    () => tableMaps.filter(m =>
      m.include &&
      !!m.target.table &&
      !tgtTables.some(t =>
        t.schema === m.target.schema &&
        (m.targetAlias?.trim() || m.target.table) === t.name
      )
    ),
    [tableMaps, tgtTables]
  );
  const newTargetSchema = newTargetTables[0]?.target.schema ?? '';
  // Re-show banner whenever a genuinely new auto-create candidate appears
  const prevNewTargetCountRef = useRef(0);
  useEffect(() => {
    if (newTargetTables.length > prevNewTargetCountRef.current) setNewSchemaBannerDismissed(false);
    prevNewTargetCountRef.current = newTargetTables.length;
  }, [newTargetTables.length]);

  // Change the default target schema and re-point any table maps still on the
  // previous default, so already-selected tables follow the schema you pick.
  const changeTgtSchema = (next: string) => {
    const schema = next.trim();
    setTgtNewSchemaMode(false); setTgtNewSchemaName('');
    if (!schema || schema === tgtDefaultSchema) { setTgtDefaultSchema(schema); return; }
    const prev = tgtDefaultSchema;
    setTgtDefaultSchema(schema);
    setTableMaps(ms => {
      const moved = ms.some(m => m.target.schema === prev);
      if (moved) setDirty(true);
      return ms.map(m =>
        m.target.schema === prev ? { ...m, target: { ...m.target, schema } } : m
      );
    });
  };

  // Open the Save dialog pre-filled. When schedule=true, jump to the Scheduler
  // after a successful save; otherwise stay on the page (save now, schedule later).
  const openSave = (schedule: boolean) => {
    if (!saveJobName.trim()) {
      const def = `${srcConn.database || 'source'} → ${newTargetSchema || tgtConn.database || 'target'}`;
      setSaveJobName(def);
    }
    setSaveAsTarget(null);
    setScheduleAfterSave(schedule);
    setShowSaveDialog(true);
  };

  // Confirm before adopting a brand-new target schema — guards against typos,
  // since the schema is created on the target DB on first run.
  const confirmNewSchema = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    if (tgtSchemas.includes(name)) { changeTgtSchema(name); return; }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      showWarning({
        title: 'Invalid schema name',
        description: `"${name}" isn't a valid schema name. Use letters, digits and underscores, starting with a letter or underscore.`,
      });
      return;
    }
    showConfirm({
      title: 'Create new schema?',
      description: `A new schema "${name}" will be created on the target database "${tgtConn.database}" on the first run. Double-check the spelling — a typo creates an unintended schema.`,
      confirmLabel: 'Use this schema',
      cancelLabel: 'Cancel',
      onConfirm: () => changeTgtSchema(name),
    });
  };

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

  // Persist accumulated pending states to localStorage whenever they change.
  // This lets multiple runs accumulate across page reloads and route navigations.
  useEffect(() => {
    if (accumulatedTableStates.length === 0) return;
    try {
      const mapsObj: Record<string, TableMap> = {};
      accumulatedTableMaps.forEach((v, k) => { mapsObj[k] = v; });
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        states: accumulatedTableStates,
        maps: mapsObj,
        saved: [...savedMigratedSources],
      }));
    } catch { /* ignore */ }
  }, [accumulatedTableStates, accumulatedTableMaps]); // eslint-disable-line react-hooks/exhaustive-deps

  // On page load: restore accumulated pending states from localStorage (merges all past runs).
  // Falls back to scanning the latest run file if no localStorage key exists yet.
  useEffect(() => {
    // Primary: restore from persisted pending session
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as {
          states: MigRunTableState[];
          maps: Record<string, TableMap>;
          saved?: string[];
        };
        if (parsed.states?.length > 0) {
          const savedSet = new Set<string>(parsed.saved ?? []);
          const unsaved = parsed.states.filter(ts => !savedSet.has(ts.sourceKey));
          if (unsaved.length > 0) {
            setAccumulatedTableStates(unsaved);
            setAccumulatedTableMaps(new Map(Object.entries(parsed.maps ?? {})));
            setMigratedTableKeys(new Set(unsaved.map(ts => ts.sourceKey)));
            if (savedSet.size > 0) setSavedMigratedSources(savedSet);
            return; // primary restore succeeded — skip legacy run-based restore
          }
        }
      }
    } catch { /* ignore */ }

    // Fallback: restore from the single latest run (legacy path, no localStorage key yet)
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
    if (selectedMigratedKeys.size === 0) return;
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
        const srcMeta = srcConn.host
          ? { type: srcConn.type, host: srcConn.host, port: srcConn.port, database: srcConn.database, username: srcConn.username }
          : undefined;
        const tgtMeta = tgtConn.host
          ? { type: tgtConn.type, host: tgtConn.host, port: tgtConn.port, database: tgtConn.database, username: tgtConn.username }
          : undefined;
        await axios.post('/api/migv2/jobs', { name: saveMigratedJobName.trim(), tables: selectedTables, sourceMeta: srcMeta, targetMeta: tgtMeta });
      }
      await loadJobs();
      const newSaved = new Set([...savedMigratedSources, ...selectedMigratedKeys]);
      setSavedMigratedSources(newSaved);
      // Update persisted pending session — mark saved keys so they survive reload
      try {
        const raw = localStorage.getItem(PENDING_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { states: MigRunTableState[]; maps: Record<string, TableMap>; saved?: string[] };
          parsed.saved = [...newSaved];
          localStorage.setItem(PENDING_KEY, JSON.stringify(parsed));
        }
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
    if (!srcConn.host) { showError('Select a source connection before saving.'); return; }
    if (!tgtConn.host) { showError('Select a target connection before saving.'); return; }
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
        filterCol: filterCol.trim() || null,
        filterFrom: filterFrom.trim() || null,
        filterTo: filterTo.trim() || null,
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

      const savedJobId = data.job.id;
      if (scheduleAfterSave) {
        setScheduleAfterSave(false);
        toast.success(`Job "${data.job.name}" saved — set up its schedule.`);
        void router.push(`/scheduler?highlight=${savedJobId}`);
      } else {
        toast.success(`Job "${data.job.name}" saved.`, {
          description: 'Schedule it to run server-side via the Scheduler.',
          action: {
            label: 'Go to Scheduler',
            onClick: () => { void router.push(`/scheduler?highlight=${savedJobId}`); },
          },
        });
      }
    } catch { /* ignore */ } finally { setSavingJob(false); }
  };

  const handleSaveJob = () => {
    if (!saveJobName.trim()) return;
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
      setFilterCol(job.filterCol ?? '');
      setFilterFrom(job.filterFrom ?? '');
      setFilterTo(job.filterTo ?? '');

      // Restore migrated table keys + most recent run for this job.
      // Runs are sorted latest-first — use the latest status per table so a
      // table rolled back in run N is not re-added by an older completed run.
      //
      // Two-pass scan:
      // 1. Runs with matching jobId (direct association)
      // 2. All other runs — cross-match by sourceKey against job's tables
      //    (covers ad-hoc runs saved to job via pending-save, which have jobId: null)
      void axios.get<{ runs: MigRun[] }>('/api/migv2/run/status')
        .then(({ data: runData }) => {
          const jobSourceKeys = new Set(job.tables.map(t => `${t.source.schema}.${t.source.table}`));
          const tableLatestStatus = new Map<string, string>();
          let latestJobRun: MigRun | null = null;

          // Pass 1: runs directly associated with this job
          for (const run of runData.runs) {
            if (run.jobId !== id) continue;
            if (!latestJobRun) latestJobRun = run;
            for (const ts of run.tableStates) {
              if (!tableLatestStatus.has(ts.sourceKey)) {
                tableLatestStatus.set(ts.sourceKey, ts.status);
              }
            }
          }

          // Pass 2: runs with no jobId (ad-hoc) — match by sourceKey
          for (const run of runData.runs) {
            if (run.jobId !== null && run.jobId !== undefined) continue;
            for (const ts of run.tableStates) {
              if (jobSourceKeys.has(ts.sourceKey) && !tableLatestStatus.has(ts.sourceKey)) {
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

      const firstIncluded = job.tables.find(m => m.include);

      // Try to restore source and target connections from saved metadata
      const normType = (t: string) => t === 'postgresql' ? 'postgres' : t;
      const srcMatch = job.sourceMeta ? connections.find(c =>
        c.host === job.sourceMeta.host &&
        c.port === job.sourceMeta.port &&
        c.username === job.sourceMeta.username &&
        c.db_type === normType(job.sourceMeta.type)
      ) : undefined;
      const tgtMatch = job.targetMeta ? connections.find(c =>
        c.host === job.targetMeta.host &&
        c.port === job.targetMeta.port &&
        c.username === job.targetMeta.username &&
        c.db_type === normType(job.targetMeta.type)
      ) : undefined;

      if (srcMatch) {
        const srcDbs = [...new Set(job.tables.map(t => t.sourceDatabase).filter((d): d is string => !!d))];
        if (!srcDbs.length && job.sourceMeta.database) srcDbs.push(job.sourceMeta.database);
        pendingJobRestoreRef.current = {
          tables: job.tables,
          srcDbs,
          selectedMapId: firstIncluded?.id ?? null,
          srcSchema: firstIncluded?.source.schema ?? '',
        };
        if (srcConnId !== srcMatch.id) {
          setSrcConnId(srcMatch.id);
        } else {
          void loadSrcDbs(srcMatch.id);
        }
      } else {
        setTableMaps(job.tables);
        setSelectedMapId(firstIncluded?.id ?? null);
        if (firstIncluded) setSrcSchema(firstIncluded.source.schema);
      }

      if (tgtMatch) {
        pendingTgtDbRestoreRef.current = job.targetMeta.database;
        const savedTgtSchema = job.tables.find(t => t.include)?.target.schema ?? null;
        // Always use the ref — loadTgtDbs resets tgtDb→''→DB which causes tgtDb effect
        // to fire twice and override any direct setTgtDefaultSchema call.
        if (savedTgtSchema) pendingTgtSchemaRestoreRef.current = savedTgtSchema;
        if (tgtConnId !== tgtMatch.id) {
          setTgtConnId(tgtMatch.id);
        } else {
          void loadTgtDbs(tgtMatch.id);
        }
      }

      pendingDriftScanRef.current = true;
    } catch { /* ignore */ }
  };

  const handleExportJobMd = async (jobId: string) => {
    try {
      const res = await fetch(`/api/migv2/jobs/export-md?id=${jobId}`);
      if (!res.ok) { showError('Failed to export job MD'); return; }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `job-${jobId.slice(0, 8)}.md`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch { showError('Failed to export job MD'); }
  };

  const _handleExportJobMdLegacy = async (jobId: string) => {
    try {
      const { data } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${jobId}`);
      const job = data.job;
      const lines: string[] = [
        `# ${job.name}`,
        job.description ? `\n${job.description}` : '',
        `\n_Generated: ${new Date().toISOString()}_`,
        '',
      ];

      if (job.sourceMeta) {
        lines.push(
          '## Source',
          `- **Type**: ${job.sourceMeta.type}`,
          `- **Host**: ${job.sourceMeta.host}:${job.sourceMeta.port}`,
          `- **Database**: ${job.sourceMeta.database}`,
          `- **Username**: ${job.sourceMeta.username}`,
          '',
        );
      }
      if (job.targetMeta) {
        lines.push(
          '## Target',
          `- **Type**: ${job.targetMeta.type}`,
          `- **Host**: ${job.targetMeta.host}:${job.targetMeta.port}`,
          `- **Database**: ${job.targetMeta.database}`,
          `- **Username**: ${job.targetMeta.username}`,
          '',
        );
      }

      if (job.filterCol) {
        lines.push(
          '## Row Filter',
          `- **Column**: \`${job.filterCol}\``,
          `- **From**: ${job.filterFrom ?? '—'}`,
          `- **To**: ${job.filterTo ?? '—'}`,
          '',
        );
      }

      const includedTables = job.tables.filter(m => m.include);
      lines.push(`## Table Mappings (${includedTables.length} of ${job.tables.length} included)`, '');

      job.tables.forEach((map, i) => {
        const status = map.include ? '✓' : '✗';
        const resolvedTable = map.targetAlias?.trim() || map.target.table;
        const tgtTable = resolvedTable ? `${map.target.schema}.${resolvedTable}` : '(unassigned)';
        lines.push(`### ${i + 1}. \`${map.source.schema}.${map.source.table}\` → \`${tgtTable}\` [${status}]`);

        const flags: string[] = [];
        if (map.truncateBeforeMigrate) flags.push('Truncate before migrate');
        if (map.skipConstraints)       flags.push('Skip constraints (DISABLE TRIGGER ALL)');
        if (flags.length) lines.push(`> ⚠ ${flags.join(' · ')}`);

        if (map.syncMode === 'incremental') {
          lines.push(`> ⟳ Incremental — ${map.incrementalStrategy ?? 'id'} on \`${map.incrementalCol ?? '—'}\`${map.lastSyncedValue ? ` · last synced: \`${map.lastSyncedValue}\`` : ''}`);
        }
        lines.push('');

        const includedCols = map.columns.filter(c => c.include);
        const excludedCols = map.columns.filter(c => !c.include);

        if (includedCols.length > 0) {
          lines.push('| # | Source Column | → | Target Column | Mapping | Tgt Type | Conv | Keep / Default | FK Ref |');
          lines.push('|--:|---|:---:|---|---|---|---|---|---|');
          includedCols.forEach((col, ci) => {
            const srcCol   = col.sourceCol ?? '*(new)*';
            const tgtCol   = (col.targetName ?? col.targetCol) || '—';
            const renamed  = col.targetName && col.targetName !== col.targetCol ? ` _(was \`${col.targetCol}\`)_` : '';
            const mapping  = col.sourceCol === null ? 'target-only' : 'mapped';
            const conv     = col.conversion === 'keep' ? 'keep' : col.conversion.replace('serial_to_uuid', '→UUID').replace('to_', '→');
            const keepDef  = col.conversion === 'serial_to_uuid' && col.keepLegacyAs
              ? `legacy: \`${col.keepLegacyAs}\``
              : col.sourceCol === null && col.defaultValue
              ? `default: \`${col.defaultValue}\``
              : '—';
            const fkRef    = col.fkRef ?? '—';
            lines.push(`| ${ci + 1} | \`${srcCol}\` | → | \`${tgtCol}\`${renamed} | ${mapping} | ${col.targetType || '—'} | ${conv} | ${keepDef} | ${fkRef} |`);
          });
          lines.push('');
        } else {
          lines.push('_No column mapping configured — table will be auto-created on first run._', '');
        }

        if (excludedCols.length > 0) {
          lines.push(`<details><summary>Excluded columns (${excludedCols.length})</summary>`, '');
          lines.push('| Source Column | Target Column | Tgt Type |');
          lines.push('|---|---|---|');
          excludedCols.forEach(col => {
            lines.push(`| ${col.sourceCol ?? '*(new)*'} | ${(col.targetName ?? col.targetCol) || '—'} | ${col.targetType || '—'} |`);
          });
          lines.push('', '</details>', '');
        }
      });

      lines.push('---', `_Exported from DB Maintenance Tools · Job ID: \`${job.id}\`_`);

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
      if (!res.ok) { showError('Export script failed', await res.text()); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = disposition.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `migration-${jobId.slice(0, 8)}.mjs`;
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
    } catch { showError('Export script failed', 'Could not download migration script.'); }
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

  const startMigration = async (force = false) => {
    const included = tableMaps.filter(t => t.include);
    if (!included.length) return;
    const unset = included.filter(t => t.columns.length > 0 && !t.isSet);
    if (unset.length > 0) {
      showWarning({
        title: 'Mappings not marked as ready',
        description: `${unset.length} table${unset.length > 1 ? 's have' : ' has'} column mapping configured but not marked as ready:\n\n` +
          unset.map(t => `• ${t.source.schema}.${t.source.table}`).join('\n') +
          '\n\nOpen each table, review the mapping, then click Set before running.',
      });
      return;
    }
    if (!force) {
      const badCols = included.flatMap(m =>
        m.columns
          .filter(c => c.include && c.sourceCol === null && !c.defaultValue)
          .map(c => `• ${m.source.schema}.${m.source.table} → ${c.targetCol} (${c.targetType})`)
      );
      if (badCols.length) {
        showConfirm({
          title: 'Target-only columns without a default value',
          description: `These columns have no source column and no default value set:\n\n${badCols.join('\n')}\n\nThey will insert NULL for every row. If any are NOT NULL in the target, the migration will fail.\n\nTo fix: set a value in "Keep / Default", or uncheck the column to let the DB handle it with its own DEFAULT.\n\nRun anyway?`,
          onConfirm: () => void startMigration(true),
        });
        return;
      }
    }
    stopRequestedRef.current = false;
    setPausedTableIds(new Set());
    setPolling(true);
    setCurrentRun(null);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/start', {
        source: srcConn, target: tgtConn, tables: included,
        jobId: activeJobId, jobName: saveJobName || 'Migration',
        filterCol: filterCol.trim() || null,
        filterFrom: filterFrom.trim() || null,
        filterTo: filterTo.trim() || null,
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
    if (stopRequestedRef.current) { setPolling(false); return; }
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/advance',
        { runId, source: srcConn, target: tgtConn, pausedTableIds: [...pausedTableIds] });
      setCurrentRun(data.run);
      if (data.run.status === 'running' && !stopRequestedRef.current) scheduleAdvance(runId);
      else onRunFinished(data.run);
    } catch { setPolling(false); }
  };

  const emergencyStop = async () => {
    stopRequestedRef.current = true;
    setPolling(false);
    if (!currentRun) return;
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/stop', { runId: currentRun.id });
      setCurrentRun(data.run);
    } catch { /* run state may be stale; stopRequestedRef already prevents further advances */ }
  };

  const handleReset = () => {
    showConfirm({
      title: 'Reset session?',
      description: 'This will clear the source and target connections, all table mappings, and the current run. Saved jobs are not affected.',
      confirmLabel: 'Reset',
      cancelLabel: 'Cancel',
      onConfirm: () => {
        stopRequestedRef.current = true;
        setPolling(false);
        setSrcConnId(null);
        setTgtConnId(null);
        setTgtDb('');
        setSrcDbsSelected([]);
        setSrcSchema('');
        setTableMaps([]);
        setSelectedMapId(null);
        setColsCache({});
        setActiveJobId(null);
        setDirty(false);
        setCurrentRun(null);
        setPausedTableIds(new Set());
        setAccumulatedTableStates([]);
        setAccumulatedTableMaps(new Map());
        setSavedMigratedSources(new Set());
        setMigratedTableKeys(new Set());
        try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
      },
    });
  };

  const scanTargetDrift = async (maps: TableMap[]) => {
    if (!tgtConn.host) return;
    const drifts: TableDrift[] = [];
    for (const map of maps) {
      if (!map.target.table || map.columns.length === 0) continue;
      const targetTable = map.targetAlias?.trim() || map.target.table;
      const tgtKey = `${map.target.schema}.${targetTable}`;
      try {
        const { data } = await axios.post<{ columns: MigColumnInfo[] }>(
          '/api/migv2/columns', { conn: tgtConn, tableKey: tgtKey }
        );
        const actualByName = new Map(data.columns.map(c => [c.name, c]));
        const savedTargetCols = map.columns.filter(c => c.targetCol && c.include).map(c => c.targetCol);

        const added = data.columns
          .filter(c => !savedTargetCols.includes(c.name))
          .map(c => ({ name: c.name, rawType: c.rawType }));

        const removed = savedTargetCols.filter(c => !actualByName.has(c));

        const typeChanged: ColDrift[] = map.columns
          .filter(c => c.targetCol && c.include && actualByName.has(c.targetCol))
          .flatMap(c => {
            const actual = actualByName.get(c.targetCol)!;
            return actual.rawType.toUpperCase() !== c.targetType.toUpperCase()
              ? [{ col: c.targetCol, from: c.targetType, to: actual.rawType.toUpperCase() }]
              : [];
          });

        if (added.length || removed.length || typeChanged.length) {
          drifts.push({
            tableId: map.id,
            sourceKey: `${map.source.schema}.${map.source.table}`,
            targetKey: tgtKey,
            added, removed, typeChanged,
          });
        }
      } catch { /* target table may not exist yet — skip */ }
    }
    if (drifts.length) { setSchemaDrift(drifts); setShowDriftDialog(true); }
  };

  const acceptDrift = (drift: TableDrift) => {
    setTableMaps(prev => prev.map(m => {
      if (m.id !== drift.tableId) return m;
      let cols = m.columns.filter(c => !drift.removed.includes(c.targetCol));
      cols = cols.map(c => {
        const changed = drift.typeChanged.find(d => d.col === c.targetCol);
        return changed ? { ...c, targetType: changed.to } : c;
      });
      const newCols: ColumnMap[] = drift.added.map(a => ({
        sourceCol: null, targetCol: a.name, targetName: null,
        targetType: a.rawType.toUpperCase(), nullable: true, defaultValue: null,
        include: true, conversion: 'keep', fkRef: null, keepLegacyAs: null,
      }));
      return { ...m, columns: [...cols, ...newCols] };
    }));
    setSchemaDrift(prev => prev.filter(d => d.tableId !== drift.tableId));
    setDirty(true);
  };

  const acceptAllDrift = () => {
    schemaDrift.forEach(d => acceptDrift(d));
    setShowDriftDialog(false);
  };

  const startTableMigration = async (mapId: string, force = false, truncate = false) => {
    const map = tableMaps.find(m => m.id === mapId);
    if (!map || polling) return;
    if (map.columns.length > 0 && !map.isSet) {
      showWarning({ title: 'Mapping not ready', description: `Mapping for ${map.source.schema}.${map.source.table} has not been marked as ready.\n\nOpen the column mapping, review it, then click Set before running.` });
      return;
    }
    if (!force) {
      const badCols = map.columns.filter(c => c.include && c.sourceCol === null && !c.defaultValue);
      if (badCols.length) {
        showConfirm({
          title: 'Target-only columns without a default value',
          description: `These columns in ${map.source.schema}.${map.source.table} have no source column and no default value:\n\n${badCols.map(c => `• ${c.targetCol} (${c.targetType})`).join('\n')}\n\nThey will insert NULL for every row. If any are NOT NULL in the target, the migration will fail.\n\nTo fix: set a value in "Keep / Default", or uncheck the column to let the DB use its own DEFAULT.\n\nRun anyway?`,
          onConfirm: () => void startTableMigration(mapId, true, truncate),
        });
        return;
      }
    }
    stopRequestedRef.current = false;
    setPausedTableIds(new Set());
    setPolling(true);
    setCurrentRun(null);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/start', {
        source: srcConn, target: tgtConn,
        tables: [{ ...map, include: true, truncateBeforeMigrate: truncate || map.truncateBeforeMigrate }],
        jobId: activeJobId, jobName: saveJobName || 'Migration',
        filterCol: filterCol.trim() || null,
        filterFrom: filterFrom.trim() || null,
        filterTo: filterTo.trim() || null,
      });
      setCurrentRun(data.run);
      if (data.run.status === 'running' || data.run.status === 'pending') {
        scheduleAdvance(data.run.id);
      } else {
        onRunFinished(data.run);
      }
    } catch { setPolling(false); }
  };

  const stopTableInRun = async (mapId: string) => {
    if (!currentRun) return;
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/stop-table', {
        runId: currentRun.id, tableId: mapId,
      });
      setCurrentRun(data.run);
    } catch { /* ignore */ }
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
      try {
        const raw = localStorage.getItem(PENDING_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { states: MigRunTableState[]; maps: Record<string, TableMap>; saved?: string[] };
          parsed.states = parsed.states.filter(ts => !rolledBackKeys.has(ts.sourceKey));
          for (const k of rolledBackKeys) delete parsed.maps[k];
          if (parsed.states.length > 0) localStorage.setItem(PENDING_KEY, JSON.stringify(parsed));
          else localStorage.removeItem(PENDING_KEY);
        }
      } catch { /* ignore */ }
    } catch { /* ignore */ } finally { setRollingBack(false); }
  };

  const openDiagnose = async (mapping: TableMap, runState: MigRunTableState) => {
    const sourceKey = `${mapping.source.schema}.${mapping.source.table}`;
    const targetKey = `${mapping.target.schema}.${mapping.targetAlias?.trim() || mapping.target.table}`;
    const error = runState.error ?? 'Unknown error';
    setDiagnoseModal({ open: true, sourceKey, targetKey, error, result: null, loading: true });
    try {
      const body = {
        error,
        sourceKey,
        targetKey,
        columnMappings: mapping.columns,
        runId: currentRun?.id,
        filterCol: filterCol || null,
        filterFrom: filterFrom || null,
        filterTo: filterTo || null,
      };
      const res = await fetch('/api/ai/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setDiagnoseModal(prev => ({ ...prev, result: data, loading: false }));
    } catch (err) {
      setDiagnoseModal(prev => ({
        ...prev, loading: false,
        result: {
          rootCause: 'Diagnosis request failed',
          explanation: err instanceof Error ? err.message : String(err),
          suggestedFix: 'Check ANTHROPIC_API_KEY is set in your .env file.',
          columnFixes: [],
          severity: 'info',
        },
      }));
    }
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

  // ── Scan target for schema drift after job load ───────────────────────────────
  useEffect(() => {
    if (!tgtConnected || !pendingDriftScanRef.current) return;
    pendingDriftScanRef.current = false;
    void scanTargetDrift(tableMaps);
  }, [tgtConnected]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Scroll + flash-highlight the paired target row when highlightTgtKey changes ──
  useEffect(() => {
    if (!highlightTgtKey) return;
    const el = tgtRowRefs.current.get(highlightTgtKey);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const timer = setTimeout(() => setHighlightTgtKey(null), 1500);
    return () => clearTimeout(timer);
  }, [highlightTgtKey]); // eslint-disable-line react-hooks/exhaustive-deps

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
    const resolvedTgtTable = selectedMap.targetAlias?.trim() || selectedMap.target.table;
    const tgtKey = `${selectedMap.target.schema}.${resolvedTgtTable}`;
    const tgtTableExists = tgtTables.some(
      t => t.schema === selectedMap.target.schema && t.name === resolvedTgtTable
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
              <p className="font-semibold text-gray-900 dark:text-slate-100 text-base">Rollback table?</p>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1 font-mono">{rollbackPrompt.tableKey}</p>
            </div>
            <label className="flex items-start gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rollbackPrompt.drop}
                onChange={e => setRollbackPrompt(p => p ? { ...p, drop: e.target.checked } : p)}
                className="mt-0.5 accent-rose-500"
              />
              <span className="text-sm text-gray-700 dark:text-slate-300">
                Also <span className="font-semibold text-rose-600 dark:text-rose-400">DROP</span> the target table after rollback
                <span className="block text-[13px] text-gray-400 dark:text-slate-500 mt-0.5">
                  Runs <code className="font-mono">DROP TABLE … CASCADE</code> — cannot be undone.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setRollbackPrompt(null)}
                className="px-3 py-1.5 rounded-lg text-base text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleRollbackTable(rollbackPrompt.tableId, rollbackPrompt.drop)}
                className={`px-4 py-1.5 rounded-lg text-base font-medium text-white transition-colors ${rollbackPrompt.drop ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-500 hover:bg-amber-600'}`}
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
              <p className="font-semibold text-gray-900 dark:text-slate-100 text-base">Rollback entire run?</p>
              <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
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
              <span className="text-sm text-gray-700 dark:text-slate-300">
                Also <span className="font-semibold text-rose-600 dark:text-rose-400">DROP</span> all target tables after rollback
                <span className="block text-[13px] text-gray-400 dark:text-slate-500 mt-0.5">
                  Runs <code className="font-mono">DROP TABLE … CASCADE</code> on each table — cannot be undone.
                </span>
              </span>
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button
                onClick={() => setRunRollbackPrompt(null)}
                className="px-3 py-1.5 rounded-lg text-base text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleRollback(runRollbackPrompt.drop)}
                className={`px-4 py-1.5 rounded-lg text-base font-medium text-white transition-colors ${runRollbackPrompt.drop ? 'bg-rose-600 hover:bg-rose-700' : 'bg-amber-500 hover:bg-amber-600'}`}
              >
                {runRollbackPrompt.drop ? 'Rollback & Drop All' : 'Rollback All'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-col h-[calc(100vh-48px)] bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* Header */}
        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Main workspace + run console — wrapped so Jobs panel stays full height */}
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
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
                        <span className="text-[13px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 flex-1">Source</span>
                        {srcConnecting && <Loader2 size={12} className="animate-spin text-slate-500 dark:text-slate-400" />}
                        {srcConnected && !srcConnecting && (
                          <span className="inline-flex items-center gap-0.5 text-[12px] text-emerald-600 dark:text-emerald-400 font-medium">
                            <Check size={11} /> Connected
                          </span>
                        )}
                        {srcError && !srcConnecting && (
                          <span className="text-[12px] text-rose-500 truncate max-w-[100px]" title={srcError}>{srcError}</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <ConnSelect connections={connections.filter(c => c.db_type === 'mysql')} value={srcConnId}
                          onChange={id => setSrcConnId(id)} onNew={() => void router.push('/settings')} accent="blue" />
                        <div className="flex items-center gap-1.5">
                          {srcConnId && (srcLoadingDbs
                            ? <div className="flex items-center gap-1.5"><Loader2 size={13} className="animate-spin text-slate-500 dark:text-slate-400" /><span className="text-[12px] text-slate-500 dark:text-slate-400">Loading databases…</span></div>
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
                              className="w-24 shrink-0 px-2 py-1 text-[13px] rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 focus:outline-none cursor-pointer font-mono">
                              {srcSchemaList.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          )}
                        </div>
                        {srcDbError && <span className="text-[12px] text-rose-500">{srcDbError}</span>}
                      </div>
                    </div>

                    {/* Tables label + search */}
                    <div className="shrink-0 px-3 pt-2 pb-1.5 border-b border-gray-100 dark:border-slate-800">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <Table2 size={12} className="text-blue-400 shrink-0" />
                        <span className="text-[12px] font-semibold uppercase tracking-wider text-gray-500 dark:text-slate-400 flex-1">Tables</span>
                        {filteredSrcTables.length > 0 && (
                          <span className="text-[12px] text-gray-400">{filteredSrcTables.length}</span>
                        )}
                        {loadingCols && <Loader2 size={12} className="animate-spin text-slate-500 dark:text-slate-400" />}
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
                          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
                          <input value={srcSearch} onChange={e => setSrcSearch(e.target.value)}
                            placeholder="Filter tables…"
                            className="w-full pl-6 pr-2 py-1 text-[13px] rounded border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                        </div>
                      </div>
                    </div>

                    {/* Tables list */}
                    <div className="flex-1 min-h-0 overflow-y-auto panel-scroll">
                      {!srcConnected ? (
                        <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                          <Database size={30} className="text-slate-400 dark:text-slate-500" />
                          <p className="text-[13px] text-gray-400 dark:text-slate-500">Select a connection and database</p>
                        </div>
                      ) : filteredSrcTables.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-[13px] text-gray-400 dark:text-slate-500 italic">No tables found</div>
                      ) : (() => {
                        const renderTableRow = (t: MigTableInfo) => {
                          const included = isTableIncluded(t.schema, t.name, t.database);
                          const mapEntry = tableMaps.find(m => m.source.schema === t.schema && m.source.table === t.name && m.sourceDatabase === t.database);
                          const isSelected = mapEntry?.id === selectedMapId;
                          const isMigrated = migratedTableKeys.has(`${t.schema}.${t.name}`);
                          return (
                            <div key={`${t.database}.${t.schema}.${t.name}`}
                              className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b border-gray-100 dark:border-slate-800/60 ${
                                isSelected
                                  ? 'bg-blue-100 dark:bg-blue-950/40'
                                  : isMigrated
                                  ? 'bg-emerald-50/50 dark:bg-emerald-950/10 hover:bg-emerald-50 dark:hover:bg-emerald-950/20'
                                  : mapEntry
                                  ? 'bg-blue-50/60 dark:bg-blue-950/10 hover:bg-blue-50 dark:hover:bg-blue-950/20'
                                  : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'
                              }`}
                              onClick={() => {
                                if (mapEntry) {
                                  setSelectedMapId(mapEntry.id);
                                  const resolvedTgt = mapEntry.targetAlias?.trim() || mapEntry.target.table;
                                  if (resolvedTgt) setHighlightTgtKey(`${mapEntry.target.schema}.${resolvedTgt}`);
                                } else void toggleTable(t);
                              }}>
                              <input type="checkbox" checked={included}
                                disabled={isMigrated && included}
                                onChange={e => { e.stopPropagation(); void toggleTable(t); }}
                                onClick={e => e.stopPropagation()}
                                className="shrink-0 accent-blue-500 disabled:opacity-40 disabled:cursor-not-allowed" />
                              <Table2 size={12} className={`shrink-0 ${isMigrated ? 'text-emerald-400 dark:text-emerald-600' : mapEntry ? 'text-blue-400 dark:text-blue-500' : 'text-slate-500 dark:text-slate-400'}`} />
                              <span className={`text-[13px] font-mono truncate ${mapEntry ? 'flex-none max-w-[45%]' : 'flex-1'} ${isMigrated ? 'line-through text-gray-400 dark:text-slate-500' : isSelected ? 'text-blue-700 dark:text-blue-400 font-medium' : mapEntry ? 'text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-slate-300'}`}>
                                <span className="text-[11px] font-normal">{t.schema}.</span>{t.name}
                              </span>
                              {mapEntry && (() => {
                                const resolvedTgt = mapEntry.targetAlias?.trim() || mapEntry.target.table;
                                return (
                                  <span className="flex items-center gap-0.5 flex-1 min-w-0 text-[11px] text-slate-400 dark:text-slate-500 truncate">
                                    <span className="shrink-0">→</span>
                                    <span className="font-mono truncate">
                                      <span className="text-[10px]">{mapEntry.target.schema}.</span>{resolvedTgt}
                                    </span>
                                  </span>
                                );
                              })()}
                              {/* Mapping status: distinguishes auto (1:1, no badge) from hand-configured maps */}
                              {mapEntry && mapEntry.columns.length > 0 && (
                                mapEntry.isSet ? (
                                  <span title="Mapping reviewed & marked ready to run"
                                    className="inline-flex items-center gap-0.5 text-[10px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-semibold shrink-0">
                                    <Check size={9} />set
                                  </span>
                                ) : (
                                  <span title="Columns configured — click to review or edit"
                                    className="text-[10px] px-1 py-0.5 rounded bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400 font-semibold shrink-0">custom</span>
                                )
                              )}
                              {isMigrated && <span className="text-[11px] text-emerald-500 dark:text-emerald-600 shrink-0">✓</span>}
                              <span className="text-[12px] text-gray-400 shrink-0">{t.rowCount.toLocaleString()}</span>
                              <button
                                title="Show records"
                                onClick={e => {
                                  e.stopPropagation();
                                  setShowRecords(true);
                                  if (mapEntry) setSelectedMapId(mapEntry.id);
                                  else void toggleTable(t);
                                }}
                                className="shrink-0 p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-400 dark:text-slate-400 hover:text-blue-500 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-all">
                                <Eye size={12} />
                              </button>
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
                            <div className="sticky top-0 z-10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-blue-600 dark:text-blue-400 bg-blue-50/80 dark:bg-blue-950/30 border-b border-blue-100 dark:border-blue-900/40 flex items-center gap-1">
                              <Database size={10} className="shrink-0" />{db}
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
                        <span className="text-[13px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400 flex-1">Target</span>
                        {tgtConnecting && <Loader2 size={12} className="animate-spin text-slate-500 dark:text-slate-400" />}
                        {tgtConnected && !tgtConnecting && (
                          <span className="inline-flex items-center gap=0.5 text-[12px] text-emerald-600 dark:text-emerald-400 font-medium">
                            <Check size={11} /> Connected
                          </span>
                        )}
                        {tgtError && !tgtConnecting && (
                          <span className="text-[12px] text-rose-500 truncate max-w-[100px]" title={tgtError}>{tgtError}</span>
                        )}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <ConnSelect connections={connections.filter(c => c.db_type === 'postgres')} value={tgtConnId}
                          onChange={id => setTgtConnId(id)} onNew={() => void router.push('/settings')} accent="violet" />

                        {/* DB + Schema side by side */}
                        {tgtConnId && (
                          <div className="flex items-start gap-1">
                            {/* DB */}
                            <div className="flex-1 min-w-0">
                              {tgtLoadingDbs
                                ? <Loader2 size={13} className="animate-spin text-slate-500 dark:text-slate-400 mt-1" />
                                : tgtNewDbMode
                                  ? (
                                    <div className="flex items-center gap-1">
                                      <input value={tgtNewDbName} onChange={e => setTgtNewDbName(e.target.value)}
                                        onKeyDown={e => e.key === 'Enter' && void handleCreateTgtDb()}
                                        placeholder="new-database" autoFocus
                                        className="flex-1 min-w-0 px-2 py-1 text-[13px] rounded border border-violet-300 dark:border-violet-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono focus:outline-none focus:border-violet-500" />
                                      <button onClick={() => void handleCreateTgtDb()} disabled={tgtCreatingDb || !tgtNewDbName.trim()}
                                        className="px-2 py-1 text-[13px] rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 flex items-center gap-1">
                                        {tgtCreatingDb ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
                                      </button>
                                      <button onClick={() => { setTgtNewDbMode(false); setTgtNewDbName(''); }}
                                        className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
                                        <X size={13} />
                                      </button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-0.5">
                                      <select value={tgtDb} onChange={e => setTgtDb(e.target.value)}
                                        className="flex-1 min-w-0 px-2 py-1 text-[13px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-violet-400 cursor-pointer font-mono">
                                        {!tgtDb && <option value="">— db —</option>}
                                        {tgtDbs.map(d => <option key={d} value={d}>{d}</option>)}
                                      </select>
                                      <button onClick={() => setTgtNewDbMode(true)} title="Create new database"
                                        className="shrink-0 p-1 rounded text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                                        <Plus size={13} />
                                      </button>
                                    </div>
                                  )
                              }
                            </div>
                            {/* Schema (PG only) */}
                            {tgtConnected && tgtConn.type === 'postgresql' && (
                              <div className="flex-1 min-w-0">
                                {tgtNewSchemaMode
                                  ? (
                                    <div className="flex items-center gap-1">
                                      <input value={tgtNewSchemaName} onChange={e => setTgtNewSchemaName(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter' && tgtNewSchemaName.trim()) confirmNewSchema(tgtNewSchemaName); }}
                                        placeholder="new_schema" autoFocus
                                        className="flex-1 min-w-0 px-2 py-1 text-[13px] rounded border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 font-mono focus:outline-none focus:border-violet-500" />
                                      <button onClick={() => { if (tgtNewSchemaName.trim()) confirmNewSchema(tgtNewSchemaName); }}
                                        disabled={!tgtNewSchemaName.trim()}
                                        className="px-2 py-1 text-[13px] rounded bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">Use</button>
                                      <button onClick={() => { setTgtNewSchemaMode(false); setTgtNewSchemaName(''); }}
                                        className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X size={13} /></button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-0.5">
                                      <select value={tgtDefaultSchema} onChange={e => changeTgtSchema(e.target.value)}
                                        title="Default target schema"
                                        className="flex-1 min-w-0 px-2 py-1 text-[13px] rounded border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 focus:outline-none cursor-pointer font-mono">
                                        {tgtSchemas.map(s => <option key={s} value={s}>{s}</option>)}
                                        {tgtDefaultSchema && !tgtSchemas.includes(tgtDefaultSchema) && (
                                          <option value={tgtDefaultSchema}>{tgtDefaultSchema} (new)</option>
                                        )}
                                      </select>
                                      <button onClick={() => setTgtNewSchemaMode(true)} title="Use a new schema"
                                        className="shrink-0 p-1 rounded text-slate-500 dark:text-slate-400 hover:text-violet-600 dark:hover:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                                        <Plus size={13} />
                                      </button>
                                    </div>
                                  )
                                }
                              </div>
                            )}
                          </div>
                        )}

                        {tgtDbError && <span className="text-[12px] text-rose-500">{tgtDbError}</span>}
                      </div>
                    </div>

                    {/* Tables label + search + Run All */}
                    <div className="shrink-0 px-3 pt-2 pb-1.5 border-b border-gray-100 dark:border-slate-800">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <Table2 size={12} className="text-violet-400 shrink-0" />
                        <span className="text-[12px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 flex-1">Tables</span>
                        {filteredTgtTables.length > 0 && (
                          <span className="text-[12px] text-slate-500 dark:text-slate-400">{filteredTgtTables.length}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="relative flex-1 min-w-0">
                          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
                          <input value={tgtSearch} onChange={e => setTgtSearch(e.target.value)}
                            placeholder="Filter tables…"
                            className="w-full pl-6 pr-2 py-1 text-[13px] rounded border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500" />
                        </div>
                        {polling ? (
                          <button onClick={() => void emergencyStop()} title="Stop all tables"
                            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-rose-300 dark:border-rose-700 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 animate-pulse transition-colors">
                            <Square size={11} /> Stop All
                          </button>
                        ) : tableMaps.filter(m => m.include).length > 0 && tgtConnected && srcConnected ? (
                          <button onClick={() => void startMigration()} title="Run all mapped tables"
                            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium border border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                            <Play size={11} /> Run All
                          </button>
                        ) : null}
                      </div>
                    </div>

                    {/* New-schema migration guidance */}
                    {!polling && tgtConnected && srcConnected && newTargetTables.length > 0 && !newSchemaBannerDismissed && (
                      <div className="shrink-0 mx-3 mt-2 rounded-lg border border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 p-3">
                        <div className="flex items-start gap-2">
                          <Info size={14} className="text-amber-500 shrink-0 mt-0.5" />
                          <div className="min-w-0">
                            <p className="text-[12.5px] font-semibold text-amber-700 dark:text-amber-300">
                              Migrating into a new schema{newTargetSchema ? ` “${newTargetSchema}”` : ''}
                            </p>
                            <p className="text-[12px] text-amber-700/90 dark:text-amber-200/80 mt-0.5 leading-snug">
                              {newTargetTables.length} target {newTargetTables.length === 1 ? 'table doesn’t' : 'tables don’t'} exist yet —
                              each maps 1:1 by default and is created on first run, preserving source columns &amp; data types.
                              Click any source table to customize its columns, types, or PK&nbsp;→&nbsp;UUID before running.
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-2.5">
                          <button onClick={() => void startMigration()}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] font-medium bg-violet-600 text-white hover:bg-violet-700 transition-colors">
                            <Play size={12} /> Run now
                          </button>
                          <button onClick={() => openSave(false)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] font-medium border border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors">
                            <Save size={12} /> Save
                          </button>
                          <button onClick={() => openSave(true)}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] font-medium border border-amber-400 dark:border-amber-600 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors">
                            <Calendar size={12} /> Save &amp; Schedule
                          </button>
                          <button
                            onClick={() => {
                              const newIds = new Set(newTargetTables.map(m => m.id));
                              setTableMaps(prev => prev.map(m =>
                                newIds.has(m.id)
                                  ? { ...m, target: { ...m.target, table: '' } }
                                  : m
                              ));
                              setNewSchemaBannerDismissed(true);
                              setDirty(true);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] font-medium border border-gray-300 dark:border-slate-600 text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors ml-auto">
                            <X size={12} /> Cancel
                          </button>
                        </div>
                        <p className="text-[11px] text-amber-700/70 dark:text-amber-200/60 mt-1.5">
                          Save stores the job (editable later &amp; runnable from the Scheduler). Save &amp; Schedule also opens the scheduler now.
                        </p>
                      </div>
                    )}

                    {/* Tables list */}
                    <div className="flex-1 min-h-0 overflow-y-auto panel-scroll">
                      {!tgtConnected ? (
                        <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                          <Database size={30} className="text-slate-400 dark:text-slate-500" />
                          <p className="text-[13px] text-gray-400 dark:text-slate-500">Select a connection and database</p>
                        </div>
                      ) : filteredTgtTables.length === 0 ? (
                        tgtTables.length === 0 ? (
                          <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                            <Table2 size={26} className="text-slate-400 dark:text-slate-500" />
                            <p className="text-[13px] text-gray-500 dark:text-slate-400 font-medium">Empty target</p>
                            <p className="text-[12px] text-gray-400 dark:text-slate-500">Source table names will be used — tables are created on first run.</p>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center h-full text-[13px] text-gray-400 dark:text-slate-500 italic">No tables match</div>
                        )
                      ) : filteredTgtTables.map(t => {
                        const mapping = tableMaps.find(m => m.target.schema === t.schema && (m.targetAlias?.trim() || m.target.table) === t.name);
                        const isTarget = !!(selectedMap && selectedMap.target.schema === t.schema && (selectedMap.targetAlias?.trim() || selectedMap.target.table) === t.name);
                        const isClickable = !!selectedMapId || !!mapping;
                        const runState = currentRun?.tableStates.find(ts =>
                          (mapping && ts.id === mapping.id) || ts.targetKey === `${t.schema}.${t.name}`
                        );
                        const accumState = accumulatedTableStates.find(ts => ts.targetKey === `${t.schema}.${t.name}`);
                        const isRunning = runState?.status === 'running';
                        const isPaused = !!(mapping && pausedTableIds.has(mapping.id));
                        const totalProcessed = (runState?.rowsMigrated ?? 0) + (runState?.rowsSkipped ?? 0);
                        const pct = runState && runState.rowsSource > 0
                          ? Math.min(100, Math.round(totalProcessed / runState.rowsSource * 100))
                          : runState ? 0 : null;
                        const errorCount = runState?.rowsErrored ?? accumState?.rowsErrored ?? 0;
                        const hasErrors = errorCount > 0;
                        const tgtRowKey = `${t.schema}.${t.name}`;
                        const isHighlighted = highlightTgtKey === tgtRowKey;
                        return (
                          <div key={tgtRowKey}
                            ref={el => { if (el) tgtRowRefs.current.set(tgtRowKey, el); else tgtRowRefs.current.delete(tgtRowKey); }}
                            onClick={() => {
                              if (selectedMapId) void selectTargetTable(t.schema, t.name);
                              else if (mapping) setSelectedMapId(mapping.id);
                            }}
                            className={`group border-b border-gray-100 dark:border-slate-800/60 ${isClickable ? 'cursor-pointer' : 'cursor-default'} transition-colors duration-700 ${isHighlighted ? 'bg-blue-100 dark:bg-blue-900/40' : isTarget ? 'bg-blue-100 dark:bg-blue-950/40' : mapping ? 'bg-blue-50/60 dark:bg-blue-950/10 hover:bg-blue-50 dark:hover:bg-blue-950/20' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}>

                            {/* Row 1: checkbox + icon + name + mapped badge + source table */}
                            <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5">
                              {mapping ? (
                                <input type="checkbox" checked={mapping.include}
                                  onChange={e => { e.stopPropagation(); updateTableMap(mapping.id, { include: e.target.checked }); }}
                                  onClick={e => e.stopPropagation()}
                                  className="shrink-0 accent-blue-500" />
                              ) : (
                                <div className="w-3.5 h-3.5 shrink-0" />
                              )}
                              <Table2 size={12} className={`shrink-0 ${isTarget ? 'text-blue-500' : mapping ? 'text-blue-400 dark:text-blue-500' : 'text-slate-400 dark:text-slate-500'}`} />
                              <span className={`text-[13px] font-mono truncate ${isTarget ? 'text-blue-700 dark:text-blue-400 font-medium' : mapping ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-600'}`}>
                                {t.name}
                              </span>
                              {/* mapped badge */}
                              {mapping && (
                                <span className="text-[11px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold shrink-0">mapped</span>
                              )}
                              {/* set badge */}
                              {mapping?.isSet && (
                                <span className="inline-flex items-center gap-0.5 text-[11px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-semibold shrink-0">
                                  <Check size={9} />set
                                </span>
                              )}
                              {/* incremental sync badge */}
                              {mapping?.syncMode === 'incremental' && (
                                <Tooltip
                                  content={
                                    mapping.incrementalCol
                                      ? `Incremental ${mapping.incrementalStrategy ?? 'id'} sync on "${mapping.incrementalCol}"${mapping.lastSyncedValue ? ` — synced through ${mapping.lastSyncedValue}` : ' — first run migrates all rows'}`
                                      : 'Incremental sync — set a watermark column in the column mapping header'
                                  }
                                  side="top">
                                  <span className="inline-flex items-center gap-0.5 text-[11px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold shrink-0">
                                    ⟳ Inc{mapping.lastSyncedValue ? <span className="font-normal opacity-80">· since {mapping.lastSyncedValue}</span> : null}
                                  </span>
                                </Tooltip>
                              )}
                              {isTarget && !mapping && (
                                <span className="text-[11px] px-1 py-0.5 rounded bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400 font-semibold shrink-0">target</span>
                              )}
                              {!isTarget && !mapping && selectedMapId && (
                                <span className="opacity-0 group-hover:opacity-100 text-[11px] px-1 py-0.5 rounded bg-gray-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 shrink-0 transition-opacity">assign</span>
                              )}
                              {/* source table name */}
                              {mapping && (
                                <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate shrink-0">
                                  ← {mapping.source.schema}.{mapping.source.table}
                                </span>
                              )}
                              {/* row count (unmapped, no run) */}
                              {!mapping && !runState && (
                                <span className="text-[12px] text-slate-400 dark:text-slate-500 shrink-0">{t.rowCount.toLocaleString()}</span>
                              )}
                            </div>

                            {/* Row 2: progress + status + play/pause/stop + rollback + sync + error */}
                            {mapping && (
                              <div className="flex items-center gap-1.5 pl-9 pr-3 pb-1.5" onClick={e => e.stopPropagation()}>
                                {/* progress bar */}
                                {pct !== null ? (
                                  <>
                                    <div className="flex-1 max-w-80 h-1.5 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden min-w-0">
                                      <div className={`h-full rounded-full transition-all duration-500 ${
                                        runState?.status === 'completed' ? 'bg-emerald-500'
                                        : runState?.status === 'failed' ? 'bg-rose-500'
                                        : runState?.status === 'aborted' || runState?.status === 'rolled_back' ? 'bg-amber-500'
                                        : isPaused ? 'bg-amber-400' : 'bg-violet-500'
                                      }`} style={{ width: `${pct}%` }} />
                                    </div>
                                    <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 shrink-0">{pct}%</span>
                                    {(runState!.rowsMigrated > 0 || runState!.rowsErrored > 0) && (
                                      <span className="text-[11px] text-slate-400 dark:text-slate-500 shrink-0">
                                        {runState!.rowsMigrated.toLocaleString()}w
                                        {runState!.rowsErrored > 0 && <span className="text-rose-500 dark:text-rose-400 ml-0.5">{runState!.rowsErrored.toLocaleString()}e</span>}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <div className="flex-1" />
                                )}

                                {/* status badge */}
                                {runState && <StatusBadge status={runState.status} />}

                                {/* play / pause / stop / restart+truncate */}
                                <div className="flex items-center gap-0.5 shrink-0">
                                  {isRunning && !isPaused ? (
                                    <>
                                      <button onClick={() => setPausedTableIds(prev => { const n = new Set(prev); n.add(mapping.id); return n; })}
                                        title="Pause" className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-amber-500 hover:border-amber-400 dark:hover:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors">
                                        <Pause size={12} />
                                      </button>
                                      <button onClick={() => void stopTableInRun(mapping.id)}
                                        title="Stop" className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-rose-500 hover:border-rose-400 dark:hover:border-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                                        <Square size={12} />
                                      </button>
                                    </>
                                  ) : isPaused ? (
                                    <button onClick={() => setPausedTableIds(prev => { const n = new Set(prev); n.delete(mapping.id); return n; })}
                                      title="Resume" className="p-0.5 rounded border border-amber-400 dark:border-amber-500 text-amber-500 dark:text-amber-400 hover:text-violet-600 dark:hover:text-violet-400 hover:border-violet-400 dark:hover:border-violet-500 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                                      <Play size={12} />
                                    </button>
                                  ) : (
                                    <>
                                      <button onClick={() => void startTableMigration(mapping.id)}
                                        disabled={polling} title="Re-run this table (keep existing rows, skip conflicts)"
                                        className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-violet-600 dark:hover:text-violet-400 hover:border-violet-400 dark:hover:border-violet-500 hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-30 transition-colors">
                                        <Play size={12} />
                                      </button>
                                      {runState && (runState.status === 'completed' || runState.status === 'failed') && (
                                        <button
                                          onClick={() => showConfirm({
                                            title: `Restart with Truncate — ${mapping.source.schema}.${mapping.source.table}`,
                                            description: `This will DELETE all existing rows in the target table "${mapping.target.schema}.${mapping.targetAlias?.trim() || mapping.target.table}" before re-running.\n\nUse this when a previous run wrote partial data that must be cleared first.\n\nProceed?`,
                                            onConfirm: () => void startTableMigration(mapping.id, true, true),
                                          })}
                                          disabled={polling}
                                          title="Restart with Truncate — clear target rows then re-run from scratch"
                                          className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-400 dark:hover:border-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-30 transition-colors">
                                          <RotateCcw size={12} />
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>

                                {/* rollback (completed or failed) */}
                                {runState && (runState.status === 'completed' || runState.status === 'failed') && !polling && (
                                  <button onClick={() => openRollbackPrompt(mapping.id)}
                                    title="Rollback this table"
                                    className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-amber-500 hover:border-amber-400 dark:hover:border-amber-500 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors">
                                    <Undo2 size={12} />
                                  </button>
                                )}

                                {/* incremental / full sync toggle */}
                                <button
                                  onClick={() => updateTableMap(mapping.id, {
                                    syncMode: (mapping.syncMode ?? 'full') === 'incremental' ? 'full' : 'incremental',
                                  })}
                                  title={`Sync mode: ${(mapping.syncMode ?? 'full') === 'incremental' ? 'Incremental' : 'Full'} — click to toggle`}
                                  className={`p-0.5 rounded border text-[10px] font-mono transition-colors ${
                                    (mapping.syncMode ?? 'full') === 'incremental'
                                      ? 'border-blue-400 dark:border-blue-500 text-blue-500 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30'
                                      : 'border-slate-300 dark:border-slate-500 text-slate-500 dark:text-slate-300 hover:text-slate-700 dark:hover:text-slate-100 hover:bg-gray-100 dark:hover:bg-slate-700'
                                  }`}>
                                  {(mapping.syncMode ?? 'full') === 'incremental' ? '⟳Inc' : '⟳Sync'}
                                </button>

                                {/* error icon + diagnose */}
                                {hasErrors && (
                                  <>
                                    <Tooltip content={`${errorCount.toLocaleString()} error${errorCount !== 1 ? 's' : ''}`} side="left">
                                      <span className="shrink-0 text-rose-500 dark:text-rose-400">
                                        <AlertTriangle size={12} />
                                      </span>
                                    </Tooltip>
                                    {runState?.status === 'failed' && runState.error && (
                                      <Tooltip content="AI Diagnose — analyse failure cause" side="left">
                                        <button onClick={() => void openDiagnose(mapping, runState)}
                                          className="p-0.5 rounded border border-violet-300 dark:border-violet-600 text-violet-500 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                                          <Sparkles size={12} />
                                        </button>
                                      </Tooltip>
                                    )}
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* ── Ghost rows: mapped tables whose target table doesn't exist yet ── */}
                      {tgtConnected && tableMaps
                        .filter(m => {
                          if (!m.include || !m.target.table) return false;
                          const resolvedName = m.targetAlias?.trim() || m.target.table;
                          return !tgtTables.some(t => t.schema === m.target.schema && t.name === resolvedName);
                        })
                        .map(m => {
                          const targetTable = m.targetAlias?.trim() || m.target.table;
                          const isSelected = m.id === selectedMapId;
                          const runState = currentRun?.tableStates.find(ts => ts.id === m.id);
                          const accumState = accumulatedTableStates.find(ts => ts.sourceKey === `${m.source.schema}.${m.source.table}`);
                          const totalProcessed = (runState?.rowsMigrated ?? 0) + (runState?.rowsSkipped ?? 0);
                          const pct = runState && runState.rowsSource > 0
                            ? Math.min(100, Math.round(totalProcessed / runState.rowsSource * 100))
                            : runState ? 0 : null;
                          const isRunning = runState?.status === 'running';
                          const isPaused = pausedTableIds.has(m.id);
                          const hasErrors = (runState?.rowsErrored ?? accumState?.rowsErrored ?? 0) > 0;
                          return (
                            <div key={`new:${m.id}`}
                              onClick={() => setSelectedMapId(m.id)}
                              className={`border-b border-blue-100 dark:border-blue-900/30 cursor-pointer transition-colors ${isSelected ? 'bg-blue-100 dark:bg-blue-950/30' : 'bg-blue-50/40 dark:bg-blue-950/10 hover:bg-blue-50 dark:hover:bg-blue-950/20'}`}>

                              {/* Row 1: checkbox + icon + name + new badge + source ref */}
                              <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-0.5">
                                <input type="checkbox" checked={m.include}
                                  onChange={e => { e.stopPropagation(); updateTableMap(m.id, { include: e.target.checked }); }}
                                  onClick={e => e.stopPropagation()}
                                  className="shrink-0 accent-violet-500" />
                                <Table2 size={12} className="shrink-0 text-blue-400" />
                                <span className="text-[13px] font-mono truncate text-blue-700 dark:text-blue-400">
                                  {targetTable}
                                </span>
                                <span className="text-[11px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-semibold shrink-0">new</span>
                                {m.isSet && (
                                  <span className="inline-flex items-center gap-0.5 text-[11px] px-1 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-semibold shrink-0">
                                    <Check size={9} />set
                                  </span>
                                )}
                                <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 truncate ml-auto shrink-0">
                                  ← {m.source.schema}.{m.source.table}
                                </span>
                              </div>

                              {/* Row 2: progress / "auto-create" hint + run controls */}
                              <div className="flex items-center gap-1.5 pl-9 pr-3 pb-1.5" onClick={e => e.stopPropagation()}>
                                {pct !== null ? (
                                  <>
                                    <div className="flex-1 max-w-80 h-1.5 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden min-w-0">
                                      <div className={`h-full rounded-full transition-all duration-500 ${
                                        runState?.status === 'completed' ? 'bg-emerald-500'
                                        : runState?.status === 'failed' ? 'bg-rose-500'
                                        : isPaused ? 'bg-amber-400' : 'bg-violet-500'
                                      }`} style={{ width: `${pct}%` }} />
                                    </div>
                                    <span className="text-[11px] font-mono text-slate-400 dark:text-slate-500 shrink-0">{pct}%</span>
                                    {(runState!.rowsMigrated > 0 || runState!.rowsErrored > 0) && (
                                      <span className="text-[11px] text-slate-400 dark:text-slate-500 shrink-0">
                                        {runState!.rowsMigrated.toLocaleString()}w
                                        {runState!.rowsErrored > 0 && <span className="text-rose-500 ml-0.5">{runState!.rowsErrored.toLocaleString()}e</span>}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  <span className="flex-1 text-[11px] text-blue-400 dark:text-blue-600 italic">
                                    table will be auto-created on first run
                                  </span>
                                )}
                                {runState && <StatusBadge status={runState.status} />}
                                {hasErrors && <AlertTriangle size={12} className="text-rose-500 shrink-0" />}
                                <div className="flex items-center gap-0.5 shrink-0">
                                  {isRunning && !isPaused ? (
                                    <>
                                      <button onClick={() => setPausedTableIds(prev => { const n = new Set(prev); n.add(m.id); return n; })}
                                        title="Pause" className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-amber-500 hover:border-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors">
                                        <Pause size={12} />
                                      </button>
                                      <button onClick={() => void stopTableInRun(m.id)}
                                        title="Stop" className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-rose-500 hover:border-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                                        <Square size={12} />
                                      </button>
                                    </>
                                  ) : isPaused ? (
                                    <button onClick={() => setPausedTableIds(prev => { const n = new Set(prev); n.delete(m.id); return n; })}
                                      title="Resume" className="p-0.5 rounded border border-amber-400 dark:border-amber-500 text-amber-500 hover:text-violet-600 hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                                      <Play size={12} />
                                    </button>
                                  ) : (
                                    <>
                                      <button onClick={() => void startTableMigration(m.id)}
                                        disabled={polling} title="Re-run this table (keep existing rows, skip conflicts)"
                                        className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-violet-600 hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-30 transition-colors">
                                        <Play size={12} />
                                      </button>
                                      {runState && (runState.status === 'completed' || runState.status === 'failed') && (
                                        <button
                                          onClick={() => showConfirm({
                                            title: `Restart with Truncate — ${m.source.schema}.${m.source.table}`,
                                            description: `This will DELETE all existing rows in the target table "${m.target.schema}.${m.targetAlias?.trim() || m.target.table}" before re-running.\n\nUse this when a previous run wrote partial data that must be cleared first.\n\nProceed?`,
                                            onConfirm: () => void startTableMigration(m.id, true, true),
                                          })}
                                          disabled={polling}
                                          title="Restart with Truncate — clear target rows then re-run from scratch"
                                          className="p-0.5 rounded border border-slate-300 dark:border-slate-500 text-slate-600 dark:text-slate-200 hover:text-rose-600 dark:hover:text-rose-400 hover:border-rose-400 dark:hover:border-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-30 transition-colors">
                                          <RotateCcw size={12} />
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
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
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-slate-700 bg-gray-100 dark:bg-slate-800/80">
                  <Layers size={12} className="text-violet-400 shrink-0" />
                  <span className="text-[12px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500">Column Mapping</span>
                  {selectedMap?.target.table && (
                    <div className="flex items-center gap-2 flex-1 justify-center">
                      <span className="text-[12px] font-mono text-gray-500 dark:text-slate-400 truncate max-w-[280px]">
                        {selectedMap.source.schema}.{selectedMap.source.table}
                        <span className="text-gray-400 dark:text-slate-300 mx-1.5 text-sm font-medium">→</span>
                        {selectedMap.target.schema}.{selectedMap.targetAlias?.trim() || selectedMap.target.table}
                      </span>
                    </div>
                  )}
                  {!selectedMap?.target.table && <div className="flex-1" />}
                  {selectedMap?.target.table && (
                    <div className="flex items-center gap-2">
                      <label className="inline-flex items-center gap-1 text-[12px] text-gray-500 dark:text-slate-400">
                        <input type="checkbox" checked={selectedMap.truncateBeforeMigrate}
                          onChange={e => updateTableMap(selectedMap.id, { truncateBeforeMigrate: e.target.checked })}
                          className="accent-rose-500" />
                        Truncate
                      </label>
                      <Tooltip side="top" content={
                        <div>
                          <p className="font-semibold text-white mb-1">Skip Constraints</p>
                          <p className="text-gray-300">Runs <span className="font-mono text-white">DISABLE TRIGGER ALL</span> on the target table before inserting, then re-enables after.</p>
                          <p className="text-gray-300 mt-1">Use when FK or check constraints block rows that depend on tables not yet migrated. All rows will be inserted regardless of violations.</p>
                          <p className="text-amber-400 mt-1">PostgreSQL only. Requires table owner or superuser.</p>
                        </div>
                      }>
                        <label className="inline-flex items-center gap-1 text-[12px] text-gray-500 dark:text-slate-400 cursor-help">
                          <input type="checkbox" checked={selectedMap.skipConstraints ?? false}
                            onChange={e => updateTableMap(selectedMap.id, { skipConstraints: e.target.checked })}
                            className="accent-amber-500" />
                          Skip Constraints
                        </label>
                      </Tooltip>
                      <div className="h-3 w-px bg-gray-200 dark:bg-slate-700" />
                      <button
                        onClick={() => updateTableMap(selectedMap.id, { isSet: !selectedMap.isSet })}
                        title={selectedMap.isSet ? 'Mapping marked as ready — click to unset' : 'Mark this mapping as ready to run'}
                        className={`inline-flex items-center gap-1 text-[12px] px-2 py-0.5 rounded border font-medium transition-colors ${
                          selectedMap.isSet
                            ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400'
                            : 'border-gray-200 dark:border-slate-500 text-gray-500 dark:text-slate-300 hover:border-emerald-300 dark:hover:border-emerald-600 hover:text-emerald-600 dark:hover:text-emerald-400'
                        }`}
                      >
                        {selectedMap.isSet ? <><Check size={11} /> Set</> : 'Set'}
                      </button>
                      {/* Incremental config — only shown when incremental mode is on */}
                      {(selectedMap.syncMode ?? 'full') === 'incremental' && (
                        <>
                          <select
                            value={selectedMap.incrementalCol ?? ''}
                            onChange={e => updateTableMap(selectedMap.id, { incrementalCol: e.target.value || null })}
                            className="px-1.5 py-0.5 text-[12px] rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 max-w-[120px]"
                          >
                            <option value="">— watermark col —</option>
                            {srcColsForSelected.map(c => (
                              <option key={c.name} value={c.name}>{c.name}</option>
                            ))}
                          </select>
                          <select
                            value={selectedMap.incrementalStrategy ?? 'id'}
                            onChange={e => updateTableMap(selectedMap.id, { incrementalStrategy: e.target.value as 'id' | 'timestamp' })}
                            className="px-1.5 py-0.5 text-[12px] rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300"
                          >
                            <option value="id">by ID</option>
                            <option value="timestamp">by Timestamp</option>
                          </select>
                          {selectedMap.lastSyncedValue ? (
                            <span className="inline-flex items-center gap-0.5 text-[12px] text-violet-600 dark:text-violet-400 font-mono">
                              ↑ {selectedMap.lastSyncedValue.length > 20
                                ? selectedMap.lastSyncedValue.slice(0, 20) + '…'
                                : selectedMap.lastSyncedValue}
                              <button
                                onClick={() => updateTableMap(selectedMap.id, { lastSyncedValue: null })}
                                title="Reset watermark — next run will re-sync all rows"
                                className="text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors ml-0.5"
                              >
                                <X size={11} />
                              </button>
                            </span>
                          ) : (
                            <span className="text-[12px] text-gray-300 dark:text-slate-600 italic">no watermark</span>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Column mapping editor */}
                <div className="flex-1 min-h-0 overflow-auto panel-scroll">
                  {!selectedMap ? (
                    <div className="flex items-center justify-center h-full text-[13px] text-gray-400 dark:text-slate-500 italic">
                      Select a source table first
                    </div>
                  ) : !selectedMap.target.table ? (
                    <div className="flex items-center justify-center h-full text-[13px] text-gray-400 dark:text-slate-500 italic">
                      Select a target table to map columns
                    </div>
                  ) : loadingCols && selectedMap.columns.length === 0 ? (
                    <div className="flex items-center justify-center h-full gap-1.5 text-[13px] text-gray-400 dark:text-slate-500 animate-pulse">
                      <Loader2 size={14} className="animate-spin" /> Loading column mapping…
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      {intUuidMismatchIndices.size > 0 && (
                        <div className="sticky top-0 z-20 mx-0 px-3 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-300 dark:border-amber-700/60 flex items-center gap-2">
                          <AlertTriangle size={13} className="text-amber-500 shrink-0" />
                          <p className="text-[12px] text-amber-700 dark:text-amber-300 flex-1">
                            <span className="font-semibold">{intUuidMismatchIndices.size} column{intUuidMismatchIndices.size > 1 ? 's' : ''}</span> map int → UUID with <span className="font-mono">keep</span> — nilai integer tidak akan diterima oleh UUID column.
                            Set <span className="font-mono">→UUID</span> conversion + pilih <span className="font-mono">FK Ref</span> untuk setiap column.
                          </p>
                          <button
                            onClick={() => {
                              if (!selectedMap) return;
                              setTableMaps(prev => prev.map(m => {
                                if (m.id !== selectedMap.id) return m;
                                return {
                                  ...m,
                                  columns: m.columns.map((c, i) =>
                                    intUuidMismatchIndices.has(i)
                                      ? { ...c, conversion: 'serial_to_uuid' as const, targetType: 'UUID', keepLegacyAs: null }
                                      : c
                                  ),
                                };
                              }));
                              setDirty(true);
                            }}
                            className="shrink-0 px-2 py-1 text-[11px] font-semibold rounded bg-amber-500 hover:bg-amber-600 text-white transition-colors">
                            Fix All →UUID
                          </button>
                        </div>
                      )}
                      <table className="w-full text-sm border-collapse border border-gray-200 dark:border-slate-700 [&_td]:border [&_td]:border-gray-100 dark:[&_td]:border-slate-800" style={{ minWidth: 580 }}>
                        <thead>
                          <tr className="bg-gray-50 dark:bg-slate-800/60 sticky top-0 z-10">
                            {([
                              { label: '✓', tip: 'Include', desc: 'Toggle whether this column is included in the migration. Uncheck to exclude a column from the INSERT.' },
                              { label: 'Src Col', tip: 'Source Column', desc: 'Column name from the source database table.\nExample: user_id, created_at' },
                              { label: 'Src Type', tip: 'Source Type', desc: 'Original data type in the source database.\nExample: INT, VARCHAR(255), DATETIME' },
                              { label: '', tip: null, desc: null },
                              { label: 'Tgt Col', tip: 'Target Column', desc: 'Column name in the target table. Pick from the dropdown suggestions or type a new name directly.\nTyping a name not in the list creates a new column.' },
                              { label: 'Mapping', tip: 'Mapping Type', desc: 'Whether the target column is new (does not exist yet) or existing (already present in the target table).\n• new — column will be created\n• existing — column already exists and will be populated' },
                              { label: 'Tgt Type', tip: 'Target Type', desc: 'Data type inferred for the target column. Auto-set when you pick a Tgt Col or change Conv.\nExample: BIGINT, TEXT, TIMESTAMPTZ' },
                              { label: 'Conv', tip: 'Conversion', desc: 'Datatype cast or transformation applied during migration.\n• keep — copy value as-is\n• →UUID — serial int → UUID v4\n• →TEXT, →INT, →BIGINT, →NUMERIC, →BOOL, →TIMESTAMPTZ, →DATE, →JSONB — cast to that PG type' },
                              { label: 'Keep / Default', tip: 'Keep Orig / Default Value', desc: '→UUID columns: stores the original serial integer in a separate BIGINT column (e.g. legacy_id).\nTarget-only columns (no source): type a literal default value inserted for every row.\n• Leave empty to insert NULL — will fail if the column is NOT NULL.\n• Examples: true, 0, 2024-01-01' },
                              { label: 'FK Ref', tip: 'Foreign Key Reference', desc: 'If this column is a UUID FK, enter the target table it references so the migrator can resolve IDs correctly.\nExample: public.users' },
                              { label: '', tip: null, desc: null },
                            ] as { label: string; tip: string | null; desc: string | null }[]).map((h, i) => (
                              <th key={i} className="text-left px-2 py-1.5 text-[12px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider border border-gray-200 dark:border-slate-700 whitespace-nowrap">
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
                            const hasIntUuidMismatch = intUuidMismatchIndices.has(idx);
                            return (
                            <tr key={idx} className={`${col.include ? '' : 'opacity-40'} ${hasIntUuidMismatch ? 'bg-amber-50/60 dark:bg-amber-950/20' : ''} hover:bg-gray-50 dark:hover:bg-slate-800/30`}>
                                  <td className="px-2 py-1.5 text-center">
                                    <input type="checkbox" checked={col.include}
                                      onChange={e => updateColumn(selectedMap.id, idx, { include: e.target.checked })}
                                      className="accent-violet-500" />
                                  </td>
                                  <td className="px-2 py-1.5 max-w-[120px]">
                                    {(() => {
                                      const isSrcOpen = openSrcColPickerIdx === idx;
                                      return (
                                        <div className="flex flex-col gap-0.5">
                                          <input
                                            readOnly={!isSrcOpen}
                                            value={isSrcOpen ? srcColPickerFilter : (col.sourceCol ?? '')}
                                            placeholder="*(new)*"
                                            onFocus={e => {
                                              const rect = e.currentTarget.getBoundingClientRect();
                                              setSrcColPickerPos({ top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 160) });
                                              setOpenSrcColPickerIdx(idx);
                                              setSrcColPickerFilter('');
                                            }}
                                            onChange={e => setSrcColPickerFilter(e.target.value)}
                                            onBlur={() => setTimeout(() => { setOpenSrcColPickerIdx(null); setSrcColPickerPos(null); }, 120)}
                                            className={`w-full px-1.5 py-0.5 text-[13px] rounded border font-mono focus:outline-none bg-white dark:bg-slate-800 truncate
                                              ${isSrcOpen
                                                ? 'border-violet-400 dark:border-violet-500 text-gray-800 dark:text-slate-200'
                                                : col.sourceCol
                                                ? 'border-transparent text-gray-700 dark:text-slate-300 cursor-pointer hover:border-gray-300 dark:hover:border-slate-600'
                                                : 'border-dashed border-gray-300 dark:border-slate-600 text-gray-400 dark:text-slate-500 italic cursor-pointer hover:border-violet-400 dark:hover:border-violet-500'}`}
                                          />
                                          {srcMeta && (
                                            <div className="flex items-center gap-0.5">
                                              {srcMeta.isPk && <span className="text-[10px] px-1 py-px rounded bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 font-semibold">PK</span>}
                                              {srcMeta.isFk && <span className="text-[10px] px-1 py-px rounded bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold">FK</span>}
                                              {!srcMeta.nullable && <span className="text-[10px] px-1 py-px rounded bg-rose-100 dark:bg-rose-950/40 text-rose-500 dark:text-rose-400 font-semibold">NN</span>}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })()}
                                  </td>
                                  <td className="px-2 py-1.5 font-mono text-[12px] text-gray-400 dark:text-slate-500">
                                    {colsCache[`${selectedMap.sourceDatabase ?? ''}.${selectedMap.source.schema}.${selectedMap.source.table}`]?.find(c => c.name === col.sourceCol)?.rawType ?? '—'}
                                  </td>
                                  <td className="px-1 text-[12px] text-gray-300">→</td>
                                  {/* TGT COL — select existing or switch to custom name input */}
                                  <td className="px-2 py-1">
                                    {(() => {
                                      const currentVal = col.targetName ?? col.targetCol;
                                      const isMatched = tgtColsForSelected.length > 0 && !!currentVal && !!tgtColsForSelected.find(c => c.name === currentVal);
                                      const isOpen = openColPickerIdx === idx;
                                      return (
                                        <input
                                          value={isOpen ? colPickerFilter : currentVal}
                                          onFocus={e => {
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            setColPickerPos({ top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 160) });
                                            setOpenColPickerIdx(idx);
                                            setColPickerFilter('');
                                          }}
                                          onChange={e => {
                                            const val = e.target.value;
                                            setColPickerFilter(val);
                                            const matched = tgtColsForSelected.find(c => c.name === val);
                                            updateColumn(selectedMap.id, idx, {
                                              targetCol: val, targetName: null,
                                              ...(matched ? { targetType: matched.rawType.toUpperCase() } : {}),
                                            });
                                          }}
                                          onBlur={() => setTimeout(() => { setOpenColPickerIdx(null); setColPickerPos(null); }, 120)}
                                          className={`w-28 px-1.5 py-0.5 text-[13px] rounded border font-mono focus:outline-none bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 ${
                                            isOpen
                                              ? 'border-violet-400 dark:border-violet-500'
                                              : isMatched
                                              ? 'border-violet-200 dark:border-violet-800'
                                              : currentVal
                                              ? 'border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                                              : 'border-gray-200 dark:border-slate-700'
                                          }`}
                                          placeholder="col name"
                                        />
                                      );
                                    })()}
                                  </td>
                                  {/* MAPPING — new vs existing */}
                                  <td className="px-2 py-1">
                                    {(col.targetName ?? col.targetCol) ? (
                                      tgtColsForSelected.length > 0 && tgtColsForSelected.find(c => c.name === (col.targetName ?? col.targetCol)) ? (
                                        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold uppercase tracking-wide">existing</span>
                                      ) : (
                                        <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-semibold uppercase tracking-wide">new</span>
                                      )
                                    ) : (
                                      <span className="text-[11px] text-gray-300 dark:text-slate-600">—</span>
                                    )}
                                  </td>
                                  {/* TGT TYPE — label only */}
                                  <td className="px-2 py-1.5 font-mono text-[12px] text-gray-500 dark:text-slate-400 whitespace-nowrap">
                                    {col.targetType || '—'}
                                  </td>
                                  {/* CONV */}
                                  <td className="px-2 py-1">
                                    <div className="flex items-center gap-1">
                                    {hasIntUuidMismatch && (
                                      <Tooltip side="top" content={
                                        <div>
                                          <p className="font-semibold text-amber-300 mb-1">int → UUID mismatch</p>
                                          <p className="text-gray-300">Source is integer tapi target column adalah UUID. <span className="font-mono text-white">keep</span> akan fail semasa runtime.</p>
                                          <p className="text-gray-300 mt-1">Tukar ke <span className="font-mono text-white">→UUID</span> dan set <span className="font-mono text-white">FK Ref</span> ke table yang dirujuk.</p>
                                        </div>
                                      }>
                                        <AlertTriangle size={12} className="text-amber-500 shrink-0 cursor-help" />
                                      </Tooltip>
                                    )}
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
                                      className="text-[12px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 py-0.5 px-1">
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
                                    </div>
                                  </td>
                                  {/* KEEP ORIG (serial_to_uuid) / DEFAULT VALUE (target-only) */}
                                  <td className="px-2 py-1">
                                    {col.conversion === 'serial_to_uuid' ? (
                                      col.keepLegacyAs ? (
                                        <div className="flex items-center gap-1">
                                          <input
                                            value={col.keepLegacyAs}
                                            onChange={e => updateColumn(selectedMap.id, idx, { keepLegacyAs: e.target.value || null })}
                                            className="w-20 px-1.5 py-0.5 text-[12px] rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-slate-800 text-amber-700 dark:text-amber-300 font-mono focus:outline-none focus:border-amber-500" />
                                          <Tooltip
                                            side="top"
                                            content={
                                              <div>
                                                <p className="font-semibold text-amber-300 mb-1">→UUID is optional</p>
                                                <p className="text-gray-300">Only use UUID conversion if your target schema genuinely requires UUID PKs.</p>
                                                <p className="text-gray-300 mt-1">For simple int→int migrations, set Conv to <span className="font-mono text-white">keep</span> to avoid FK rewiring overhead.</p>
                                              </div>
                                            }>
                                            <span className="animate-pulse cursor-default text-amber-400 dark:text-amber-500 hover:text-amber-600 dark:hover:text-amber-300 transition-colors">
                                              <AlertTriangle size={13} />
                                            </span>
                                          </Tooltip>
                                          <button
                                            onClick={() => updateColumn(selectedMap.id, idx, { keepLegacyAs: null })}
                                            className="text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors">
                                            <X size={12} />
                                          </button>
                                        </div>
                                      ) : (
                                        <button
                                          onClick={() => updateColumn(selectedMap.id, idx, {
                                            keepLegacyAs: col.sourceCol ? `old_${col.sourceCol}` : 'legacy_id',
                                          })}
                                          className="text-[12px] text-gray-400 dark:text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 font-mono transition-colors">
                                          + keep
                                        </button>
                                      )
                                    ) : col.sourceCol === null ? (
                                      <Tooltip
                                        side="top"
                                        content={
                                          <div>
                                            <p className="font-semibold text-white mb-1">Default Value</p>
                                            <p className="text-gray-300">Value inserted for every row since this column has no source.</p>
                                            <p className="text-gray-300 mt-1">Leave empty to insert <span className="font-mono text-white">NULL</span> (will fail if the column is NOT NULL).</p>
                                            <p className="text-gray-300 mt-1">Examples: <span className="font-mono text-white">true</span>, <span className="font-mono text-white">0</span>, <span className="font-mono text-white">2024-01-01</span></p>
                                          </div>
                                        }>
                                        <input
                                          type="text"
                                          placeholder="default…"
                                          value={col.defaultValue ?? ''}
                                          onChange={e => updateColumn(selectedMap.id, idx, { defaultValue: e.target.value || null })}
                                          className={`w-20 px-1.5 py-0.5 text-[12px] rounded border font-mono focus:outline-none focus:border-violet-400 dark:focus:border-violet-600 bg-white dark:bg-slate-800
                                            ${col.defaultValue
                                              ? 'border-violet-300 dark:border-violet-700 text-violet-700 dark:text-violet-300'
                                              : 'border-gray-200 dark:border-slate-700 text-gray-400 dark:text-slate-500'}`}
                                        />
                                      </Tooltip>
                                    ) : (
                                      <span className="text-[12px] text-gray-200 dark:text-slate-700">—</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-1">
                                    <button
                                      onClick={e => {
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        if (fkPickerIdx === idx) {
                                          setFkPickerIdx(null); setFkPickerPos(null);
                                        } else {
                                          setFkPickerIdx(idx);
                                          setFkPickerPos({ top: rect.bottom + 4, left: rect.left });
                                        }
                                        setFkManualInput('');
                                      }}
                                      className={`w-24 px-1.5 py-0.5 text-[12px] rounded border font-mono text-left truncate block
                                        ${col.fkRef
                                          ? 'border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400 bg-blue-50/30 dark:bg-blue-950/20'
                                          : 'border-gray-200 dark:border-slate-700 text-gray-400 dark:text-slate-500 bg-white dark:bg-slate-800 hover:border-blue-300 dark:hover:border-blue-700'}`}>
                                      {col.fkRef || 'pick…'}
                                    </button>
                                  </td>
                                  <td className="px-1 py-1.5">
                                    {col.sourceCol === null && (
                                      <button onClick={() => removeColumn(selectedMap.id, idx)}
                                        className="p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors">
                                        <X size={13} />
                                      </button>
                                    )}
                                  </td>
                                </tr>
                                );
                              })}
                              {/* ── Unmatched target columns ── */}
                              {unmatchedTgtCols.length > 0 && (
                                <>
                                  <tr>
                                    <td colSpan={11} className="px-3 py-1 bg-slate-50 dark:bg-slate-800/40 border-t-2 border-dashed border-gray-200 dark:border-slate-700">
                                      <span className="text-[11px] text-gray-400 dark:text-slate-500 uppercase tracking-wider font-semibold">
                                        Unmatched target columns — {unmatchedTgtCols.length} not in mapping
                                      </span>
                                    </td>
                                  </tr>
                                  {unmatchedTgtCols.map(col => (
                                    <tr key={`unmatched-${col.name}`}
                                      className="opacity-50 hover:opacity-80 transition-opacity bg-slate-50/50 dark:bg-slate-800/20">
                                      <td className="px-2 py-1.5 text-center">
                                        <input type="checkbox" checked={false}
                                          onChange={() => addUnmatchedTgtCol(selectedMap.id, col)}
                                          className="accent-violet-500 cursor-pointer" />
                                      </td>
                                      <td className="px-2 py-1.5">
                                        <span className="text-[12px] text-gray-300 dark:text-slate-600 font-mono italic">—</span>
                                      </td>
                                      <td className="px-2 py-1.5">
                                        <span className="text-[12px] text-gray-300 dark:text-slate-600">—</span>
                                      </td>
                                      <td className="px-1 py-1 text-gray-300 dark:text-slate-700 text-center">→</td>
                                      <td className="px-2 py-1.5">
                                        <div className="flex items-center gap-1 flex-wrap">
                                          <span className="text-[13px] font-mono text-gray-500 dark:text-slate-400">{col.name}</span>
                                          {col.isPk && <span className="text-[10px] px-1 py-px rounded bg-blue-100 dark:bg-blue-950/40 text-blue-500 dark:text-blue-400 font-semibold">PK</span>}
                                          {!col.nullable && <span className="text-[10px] px-1 py-px rounded bg-rose-100 dark:bg-rose-950/40 text-rose-500 dark:text-rose-400 font-semibold">NN</span>}
                                        </div>
                                      </td>
                                      <td className="px-2 py-1.5">
                                        <span className="text-[11px] px-1.5 py-0.5 rounded font-medium bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400">EXISTING</span>
                                      </td>
                                      <td className="px-2 py-1.5">
                                        <span className="text-[12px] text-gray-400 dark:text-slate-500 font-mono">{col.rawType.toUpperCase()}</span>
                                      </td>
                                      <td className="px-2 py-1.5">
                                        <span className="text-[12px] text-gray-300 dark:text-slate-700">—</span>
                                      </td>
                                      <td className="px-2 py-1.5">
                                        <span className="text-[12px] text-gray-300 dark:text-slate-700 font-mono">
                                          {col.defaultValue ?? '—'}
                                        </span>
                                      </td>
                                      <td className="px-2 py-1.5">
                                        <span className="text-[12px] text-gray-300 dark:text-slate-700">—</span>
                                      </td>
                                      <td className="px-1 py-1.5" />
                                    </tr>
                                  ))}
                                </>
                              )}
                            </tbody>
                          </table>
                          <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-800 flex justify-end">
                            <button onClick={() => addTargetOnlyColumn(selectedMap.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[13px] font-medium border border-violet-300 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                              <Plus size={13} /> Add target-only column
                            </button>
                          </div>
                    </div>
                  )}
                </div>
              </div>
            </Panel>

            {showRecords && <PanelResizeHandle className="h-px bg-gray-200 dark:bg-slate-700 hover:bg-violet-400 dark:hover:bg-violet-500 cursor-row-resize transition-colors" />}

            {/* ── RECORDS — full width ──── */}
            {showRecords && <Panel defaultSize={22} minSize={10}>
              <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-900">
                {/* Records header */}
                <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-slate-700 bg-gray-100 dark:bg-slate-800/80">
                  <Database size={12} className="text-slate-500 dark:text-slate-400 shrink-0" />
                  <span className="text-[12px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 flex-1">Records</span>
                  {srcPreviewLoading && <Loader2 size={12} className="animate-spin text-slate-500 dark:text-slate-400" />}
                  {!srcPreviewLoading && srcPreviewRows.length > 0 && (
                    <span className="text-[12px] text-gray-400">{srcPreviewRows.length}</span>
                  )}
                  {selectedMap && (
                    <span className="text-[12px] text-blue-500 dark:text-blue-400 font-mono truncate max-w-[160px]">
                      {selectedMap.source.schema}.{selectedMap.source.table}
                    </span>
                  )}
                  <button onClick={() => setShowRecords(false)}
                    className="shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors">
                    <X size={12} />
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-auto panel-scroll">
                  {srcPreviewLoading ? (
                    <div className="flex items-center justify-center h-full gap-1.5 text-[13px] text-gray-400">
                      <Loader2 size={13} className="animate-spin" /> Loading…
                    </div>
                  ) : srcPreviewCols.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-[13px] text-gray-400 dark:text-slate-500 italic">
                      {selectedMap ? 'No records' : 'Select a table'}
                    </div>
                  ) : (
                    <table className="text-sm border-collapse">
                      <thead className="sticky top-0 z-10">
                        <tr className="bg-gray-50 dark:bg-slate-800">
                          <th className="px-2 py-1 text-left text-[11px] font-semibold text-gray-400 dark:text-slate-500 border-b border-gray-200 dark:border-slate-700 w-7">#</th>
                          {srcPreviewCols.map(col => (
                            <th key={col} className="px-2 py-1 text-left text-[11px] font-semibold text-gray-600 dark:text-slate-300 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap font-mono">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                        {srcPreviewRows.map((row, i) => (
                          <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                            <td className="px-2 py-1 text-[11px] text-gray-300 dark:text-slate-600 font-mono">{i + 1}</td>
                            {srcPreviewCols.map(col => {
                              const val = row[col];
                              const isNull = val === null || val === undefined;
                              return (
                                <td key={col} className="px-2 py-1 font-mono whitespace-nowrap">
                                  <span className={isNull ? 'text-gray-300 dark:text-slate-600 italic text-[11px]' : 'text-gray-700 dark:text-slate-300 text-[12px]'}>
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
            </Panel>}

          </PanelGroup>

          {/* ── RUN CONSOLE (appears when run is active) ──────────────────── */}
          {currentRun && (
            <div className="shrink-0 border-t border-gray-200 dark:border-slate-700 relative" style={{ height: 200 }}>
              <button onClick={() => setCurrentRun(null)}
                className="absolute top-1.5 right-1.5 z-10 p-0.5 rounded text-gray-500 hover:text-gray-200 hover:bg-white/10 transition-colors">
                <X size={13} />
              </button>
              <div className="h-full overflow-auto panel-scroll bg-gray-900 dark:bg-black p-3 font-mono text-[13px] text-gray-300">
                {currentRun.logs.length === 0 && currentRun.status !== 'running' && currentRun.status !== 'pending' && (
                  <div className="text-gray-500 italic">No log output.</div>
                )}
                {currentRun.logs.length === 0 && (currentRun.status === 'running' || currentRun.status === 'pending') && (
                  <div className="text-gray-500 italic flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-violet-400 animate-pulse" />Starting…
                  </div>
                )}
                {currentRun.logs.map((line, i) => (
                  <div key={i} className={`leading-5 ${
                    line.includes('ERROR') || /\d+ errors/.test(line) ? 'text-rose-400'
                    : (line.includes('completed') || line.includes('Total:')) && (line.includes('(0 rows)') || line.includes('Total: 0 rows')) ? 'text-amber-400'
                    : line.includes('completed') || line.includes('Total:') ? 'text-emerald-400'
                    : line.includes('ROLLBACK') || line.includes('skipped') ? 'text-amber-400'
                    : ''
                  }`}>
                    {line}
                  </div>
                ))}
                {currentRun.errors.filter(e => !currentRun.logs.some(l => l.includes(e))).map((e, i) => (
                  <div key={`err-${i}`} className="leading-5 text-rose-400">[error] {e}</div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          )}
          </div>{/* end main workspace wrapper */}

          {/* ── JOBS PANEL (collapsible) ────────────────────────────────── */}
          <div className={`shrink-0 flex flex-col border-l border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden transition-[width] duration-200 ease-in-out ${jobsOpen ? 'w-80' : 'w-9'}`}>
            <div className="shrink-0 flex items-center gap-1.5 px-2 py-2.5 border-b border-gray-200 dark:border-slate-800">
              {jobsOpen && <Save size={13} className="text-slate-500 dark:text-slate-400 shrink-0" />}
              {jobsOpen && (
                <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-300 flex-1 truncate">Saved Jobs</span>
              )}
              {jobsOpen && jobs.length > 0 && (
                <span className="text-[12px] text-gray-400 shrink-0">{jobs.length}</span>
              )}
              {jobsOpen && (
                <button
                  onClick={handleReset}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] font-medium border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 bg-white dark:bg-slate-800 hover:border-rose-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                  <RotateCcw size={12} /> Reset
                </button>
              )}
              {jobsOpen && (
                <button
                  onClick={() => { setSaveJobName(saveJobName || 'New Job'); setSaveAsTarget(null); setShowSaveDialog(true); }}
                  className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[12px] font-medium border transition-colors ${dirty ? 'border-rose-500 text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/20 animate-pulse' : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700'}`}
                >
                  <Save size={12} /> Save
                </button>
              )}
              <button onClick={() => setJobsOpen(o => !o)}
                className="shrink-0 p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 transition-colors ml-auto">
                {jobsOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
              </button>
            </div>

            {jobsOpen ? (
              <div className="flex-1 overflow-auto panel-scroll p-2 space-y-1.5">
                {jobs.length === 0 ? (
                  <div className="py-8 text-center">
                    <Save size={24} className="mx-auto text-slate-400 dark:text-slate-500 mb-2" />
                    <p className="text-[13px] text-gray-400 dark:text-slate-500">No saved jobs</p>
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
                          className="flex-1 text-[13px] font-medium bg-white dark:bg-slate-700 border border-blue-400 rounded px-1 py-0.5 text-gray-800 dark:text-slate-200 outline-none"
                        />
                      ) : (
                        <p className="text-[13px] font-medium text-gray-800 dark:text-slate-200 flex-1 truncate">{job.name}</p>
                      )}
                      {renamingJobId === job.id ? (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button onClick={() => void handleRenameJob(job.id, renameJobVal)}
                            className="p-0.5 rounded text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors">
                            <Check size={13} />
                          </button>
                          <button onClick={() => setRenamingJobId(null)}
                            className="p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                            <X size={13} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-0.5 shrink-0">
                          <Tooltip content="Rename job" side="top">
                            <button onClick={() => { setRenamingJobId(job.id); setRenameJobVal(job.name); }}
                              className="p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                              <Pencil size={12} />
                            </button>
                          </Tooltip>
                          <Tooltip content="Delete job" side="top">
                            <button onClick={() => handleDeleteJob(job.id, job.name)}
                              className="p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                              <Trash2 size={12} />
                            </button>
                          </Tooltip>
                        </div>
                      )}
                    </div>
                    {job.description && (
                      <p className="text-[12px] text-gray-400 dark:text-slate-500 truncate mb-1">{job.description}</p>
                    )}
                    <div className="flex items-center gap-1 mb-1.5">
                      <p className="text-[12px] text-gray-400 flex-1">{job.tableCount} tables · {new Date(job.updatedAt).toLocaleDateString()}</p>
                      <button
                        onClick={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
                        className="flex items-center gap-0.5 text-[12px] text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                      >
                        {expandedJobId === job.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                      </button>
                    </div>
                    {expandedJobId === job.id && (
                      <div className="mb-1.5 border border-gray-100 dark:border-slate-700 rounded overflow-hidden">
                        {job.tables.length === 0 ? (
                          <div className="px-2 py-2 flex items-center gap-2">
                            <p className="text-[12px] text-amber-500 dark:text-amber-400 italic flex-1">No tables — job may be corrupted</p>
                            <button
                              onClick={() => void handleRestoreJobFromRuns(job.id)}
                              title="Restore tables from run history"
                              className="shrink-0 px-1.5 py-0.5 rounded text-[12px] font-medium bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
                            >
                              Restore
                            </button>
                          </div>
                        ) : job.tables.map((t: MigJobTableSummary) => (
                          <div key={t.id} className={`flex items-center gap-1 px-2 py-1 border-b border-gray-50 dark:border-slate-800 last:border-0 ${!t.include ? 'opacity-40' : ''}`}>
                            <span className="text-[12px] text-gray-600 dark:text-slate-300 flex-1 truncate min-w-0">
                              <span className="text-gray-400">{t.source.schema}.</span>{t.source.table}
                              <span className="text-gray-400 dark:text-slate-400 mx-1">→</span>
                              <span className="text-gray-400">{t.target.schema}.</span>{t.targetAlias?.trim() || t.target.table}
                              {t.targetAlias?.trim() && t.targetAlias.trim() !== t.target.table && (
                                <span className="text-violet-400 ml-0.5 italic text-[11px]"> ✎</span>
                              )}
                            </span>
                            {t.sourceDatabase && (
                              <span className="shrink-0 px-1 py-0.5 rounded text-[11px] font-mono bg-blue-50 dark:bg-blue-950/30 text-blue-400 dark:text-blue-500 border border-blue-100 dark:border-blue-900">{t.sourceDatabase}</span>
                            )}
                            <button
                              onClick={() => handleRemoveTableFromJob(job.id, t.id, `${t.source.schema}.${t.source.table}`)}
                              title="Remove table from job"
                              className="shrink-0 p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
                            >
                              <X size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-1 mt-0.5">
                      <div className="flex items-center gap-1 min-w-0">
                        {activeJobId === job.id && dirty && (
                          <Tooltip content="Save unsaved changes" side="top">
                            <button
                              onClick={() => { setSaveAsTarget(null); setSaveJobName(saveJobName || job.name); void doSaveJob(); }}
                              className="shrink-0 p-0.5 rounded text-amber-500 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors animate-pulse">
                              <Save size={13} />
                            </button>
                          </Tooltip>
                        )}
                        <button onClick={() => void handleLoadJob(job.id)}
                          className="shrink-0 px-3 py-1 rounded text-[12px] font-medium bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600 transition-colors">
                          Load
                        </button>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <Tooltip content="Export CLI script (.mjs) — run from terminal" side="top">
                          <button onClick={() => void handleExportJobScript(job.id)}
                            className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-violet-500 hover:bg-violet-50 dark:hover:bg-violet-950/30 transition-colors">
                            <Terminal size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Export DDL SQL" side="top">
                          <button onClick={() => void handleExportJobSql(job.id)}
                            className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors">
                            <FileCode size={14} />
                          </button>
                        </Tooltip>
                        <Tooltip content="Export Markdown" side="top">
                          <button onClick={() => void handleExportJobMd(job.id)}
                            className="p-1 rounded text-slate-500 dark:text-slate-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                            <FileText size={14} />
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
                      <span className="text-[12px] font-semibold text-gray-400 dark:text-slate-500 shrink-0 uppercase tracking-wide">Pending Save</span>
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
                        <X size={11} />
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
                        className="flex items-center gap-1 text-[12px] text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200 transition-colors"
                      >
                        <div className={`w-3 h-3 rounded border flex items-center justify-center transition-colors ${selectedMigratedKeys.size === completedMigratedStates.length ? 'bg-blue-500 border-blue-500' : 'border-gray-300 dark:border-slate-600'}`}>
                          {selectedMigratedKeys.size === completedMigratedStates.length && <Check size={10} className="text-white" />}
                        </div>
                        All
                      </button>
                      <span className="text-[12px] text-gray-400 dark:text-slate-500 flex-1 ml-1">{completedMigratedStates.length} table{completedMigratedStates.length !== 1 ? 's' : ''}</span>
                      {selectedMigratedKeys.size > 0 && (
                        <button
                          onClick={() => setShowSaveMigratedDialog(true)}
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[12px] font-medium bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/60 transition-colors"
                        >
                          <Save size={11} /> Save {selectedMigratedKeys.size}
                        </button>
                      )}
                    </div>
                    <div className="space-y-0.5">
                      {completedMigratedStates.map(ts => {
                        const isSelected = selectedMigratedKeys.has(ts.sourceKey);
                        const isRollingBackThis = rollingBackTableId === ts.id;
                        const canRollback = currentRun && (currentRun.status === 'completed' || currentRun.status === 'failed');
                        // accumulatedTableMaps has the authoritative snapshot from the actual run
                        const savedMap = accumulatedTableMaps.get(ts.sourceKey);
                        const isNavigated = !!savedMap && selectedMapId === savedMap.id;
                        const handleNavigate = () => {
                          if (!savedMap) return;
                          const alreadyInSession = tableMaps.some(m => m.id === savedMap.id);
                          if (!alreadyInSession) {
                            // Inject the run snapshot into the session so it can be displayed.
                            // Remove any stale entry for the same source table first.
                            setTableMaps(prev => [
                              ...prev.filter(m => `${m.source.schema}.${m.source.table}` !== ts.sourceKey),
                              savedMap,
                            ]);
                          }
                          setSelectedMapId(savedMap.id);
                        };
                        return (
                          <div
                            key={ts.id}
                            onClick={() => {
                              setSelectedMigratedKeys(prev => {
                                const next = new Set(prev);
                                if (next.has(ts.sourceKey)) next.delete(ts.sourceKey); else next.add(ts.sourceKey);
                                return next;
                              });
                              handleNavigate();
                            }}
                            className={`flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer transition-colors ${isNavigated ? 'bg-violet-50 dark:bg-violet-950/20 border border-violet-200 dark:border-violet-800' : isSelected ? 'bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900' : 'border border-transparent hover:bg-gray-50 dark:hover:bg-slate-800/50'}`}
                          >
                            <div className={`w-3 h-3 rounded border shrink-0 flex items-center justify-center transition-colors ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-300 dark:border-slate-600'}`}>
                              {isSelected && <Check size={10} className="text-white" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <Tooltip side="left" content={
                                <div>
                                  <p className="font-mono text-white text-[12px]">{ts.sourceKey}</p>
                                  <p className="text-gray-400 text-[11px] my-0.5">→</p>
                                  <p className="font-mono text-white text-[12px]">{ts.targetKey}</p>
                                  {!savedMap && <p className="text-amber-400 text-[11px] mt-1">Mapping snapshot not available — click will not navigate.</p>}
                                </div>
                              }>
                              <div className="flex items-center gap-1 min-w-0">
                                <p className="text-[12px] text-gray-700 dark:text-slate-300 truncate font-mono">{ts.sourceKey}</p>
                                <span className="text-[11px] text-gray-300 dark:text-slate-600 shrink-0">→</span>
                                <p className="text-[12px] text-gray-500 dark:text-slate-400 truncate font-mono">{ts.targetKey}</p>
                              </div>
                              </Tooltip>
                              <p className="text-[11px] text-gray-400 dark:text-slate-500">
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
                                {isRollingBackThis ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
                              </button>
                            )}
                            <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <span className="text-[12px] text-gray-400 dark:text-slate-600 select-none"
                  style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
                  Saved Jobs
                </span>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Save Pending Tables dialog */}
      {showSaveMigratedDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-base font-semibold text-gray-800 dark:text-slate-200 mb-1">Save to Job</h3>
            <p className="text-sm text-gray-400 dark:text-slate-500 mb-4">{selectedMigratedKeys.size} table{selectedMigratedKeys.size !== 1 ? 's' : ''} selected</p>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">New job name</label>
                <input
                  value={saveMigratedJobName}
                  onChange={e => { setSaveMigratedJobName(e.target.value); setSaveMigratedTargetJobId(null); }}
                  placeholder="e.g. Dev → Staging"
                  disabled={!!saveMigratedTargetJobId}
                  className="w-full px-3 py-2 text-base rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-40"
                />
              </div>
              {jobs.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">Or add to existing job</label>
                  <div className="max-h-36 overflow-y-auto space-y-1 rounded-lg border border-gray-200 dark:border-slate-600 p-1.5 bg-gray-50 dark:bg-slate-900/50">
                    {jobs.map(j => (
                      <button key={j.id} type="button"
                        onClick={() => setSaveMigratedTargetJobId(prev => prev === j.id ? null : j.id)}
                        className={`w-full text-left px-2 py-1.5 rounded-md text-[13px] transition-colors ${saveMigratedTargetJobId === j.id ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium' : 'hover:bg-white dark:hover:bg-slate-700 text-gray-700 dark:text-slate-300'}`}>
                        <span className="font-medium">{j.name}</span>
                        <span className="ml-1.5 text-gray-400 dark:text-slate-500">{j.tableCount} tables · v{j.version}</span>
                      </button>
                    ))}
                  </div>
                  {saveMigratedTargetJobId && (
                    <p className="text-[12px] text-blue-600 dark:text-blue-400 mt-1">
                      Selected tables will be appended to this job (duplicates skipped).
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => { setShowSaveMigratedDialog(false); setSaveMigratedJobName(''); setSaveMigratedTargetJobId(null); }}
                className="flex-1 py-2 rounded-lg text-base text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button
                onClick={() => void handleSaveMigratedTables()}
                disabled={savingMigrated || (!saveMigratedTargetJobId && !saveMigratedJobName.trim())}
                className="flex-1 py-2 rounded-lg text-base font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {savingMigrated ? 'Saving…' : saveMigratedTargetJobId ? 'Add to Job' : 'Create Job'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TGT COL combobox dropdown */}
      {openColPickerIdx !== null && colPickerPos && selectedMap && tgtColsForSelected.length > 0 && typeof window !== 'undefined' && createPortal(
        <div
          style={{ position: 'fixed', top: colPickerPos.top, left: colPickerPos.left, width: colPickerPos.width, zIndex: 9999 }}
          className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden"
          onMouseDown={e => e.preventDefault()}
        >
          <div className="max-h-48 overflow-y-auto">
            {(() => {
              const filter = colPickerFilter.toLowerCase();
              const filtered = tgtColsForSelected.filter(c => !filter || c.name.toLowerCase().includes(filter));
              return filtered.length > 0 ? (
                filtered.map(c => {
                  const assignedTo = selectedMap.columns.find((r, rIdx) => rIdx !== openColPickerIdx && r.targetCol === c.name);
                  const isCurrent = (selectedMap.columns[openColPickerIdx]?.targetName ?? selectedMap.columns[openColPickerIdx]?.targetCol) === c.name;
                  return (
                    <div
                      key={c.name}
                      onMouseDown={() => {
                        updateColumn(selectedMap.id, openColPickerIdx, { targetCol: c.name, targetName: null, targetType: c.rawType.toUpperCase() });
                        setOpenColPickerIdx(null); setColPickerPos(null);
                      }}
                      className={`flex items-center justify-between gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] font-mono ${
                        isCurrent
                          ? 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300'
                          : assignedTo
                          ? 'text-gray-400 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800'
                          : 'text-gray-700 dark:text-slate-300 hover:bg-violet-50 dark:hover:bg-violet-950/30'
                      }`}
                    >
                      <span>{c.name}</span>
                      {assignedTo && <span className="text-[11px] shrink-0 text-gray-400 dark:text-slate-500">← {assignedTo.sourceCol ?? '(new)'}</span>}
                      {isCurrent && <Check size={11} className="shrink-0 text-violet-500" />}
                    </div>
                  );
                })
              ) : (
                <div
                  onMouseDown={() => {
                    updateColumn(selectedMap.id, openColPickerIdx, { targetCol: colPickerFilter, targetName: null });
                    setOpenColPickerIdx(null); setColPickerPos(null);
                  }}
                  className="px-2.5 py-1.5 cursor-pointer text-[13px] font-mono text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
                >
                  ✎ new &ldquo;{colPickerFilter}&rdquo;
                </div>
              );
            })()}
          </div>
        </div>,
        document.body
      )}

      {/* SRC COL picker portal */}
      {openSrcColPickerIdx !== null && srcColPickerPos && selectedMap && typeof window !== 'undefined' && createPortal(
        <div
          style={{ position: 'fixed', top: srcColPickerPos.top, left: srcColPickerPos.left, width: srcColPickerPos.width, zIndex: 9999 }}
          className="bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden"
          onMouseDown={e => e.preventDefault()}
        >
          <div className="max-h-48 overflow-y-auto">
            {(() => {
              const filter = srcColPickerFilter.toLowerCase();
              const filtered = srcColsForSelected.filter(c => !filter || c.name.toLowerCase().includes(filter));
              const currentSourceCol = selectedMap.columns[openSrcColPickerIdx]?.sourceCol;
              if (filtered.length === 0) {
                return (
                  <div className="px-2.5 py-2 text-[12px] text-gray-400 dark:text-slate-500 italic">
                    {srcColsForSelected.length === 0 ? 'Load source table columns first' : 'No match'}
                  </div>
                );
              }
              return filtered.map(c => {
                const assignedTo = selectedMap.columns.find((r, rIdx) => rIdx !== openSrcColPickerIdx && r.sourceCol === c.name);
                const isCurrent = currentSourceCol === c.name;
                return (
                  <div
                    key={c.name}
                    onMouseDown={() => {
                      const suggestedType = suggestTargetType(c.rawType, selectedMap.source.schema === selectedMap.sourceDatabase ? 'mysql' : 'mysql', tgtConn.type);
                      updateColumn(selectedMap.id, openSrcColPickerIdx, {
                        sourceCol: c.name,
                        targetType: suggestedType,
                        nullable: c.nullable,
                      });
                      setOpenSrcColPickerIdx(null); setSrcColPickerPos(null);
                    }}
                    className={`flex items-center justify-between gap-2 px-2.5 py-1.5 cursor-pointer text-[13px] font-mono ${
                      isCurrent
                        ? 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300'
                        : assignedTo
                        ? 'text-gray-400 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800'
                        : 'text-gray-700 dark:text-slate-300 hover:bg-violet-50 dark:hover:bg-violet-950/30'
                    }`}
                  >
                    <span>{c.name}</span>
                    <span className="text-[11px] shrink-0 text-gray-400 dark:text-slate-500">{c.rawType}</span>
                    {assignedTo && <span className="text-[11px] shrink-0 text-amber-500">→ {assignedTo.targetCol}</span>}
                    {isCurrent && <Check size={11} className="shrink-0 text-violet-500" />}
                  </div>
                );
              });
            })()}
          </div>
        </div>,
        document.body
      )}

      {/* FK picker backdrop */}
      {fkPickerIdx !== null && typeof window !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => { setFkPickerIdx(null); setFkPickerPos(null); }} />
          {fkPickerPos && selectedMap && (
            <div
              className="fixed z-[9999] w-60 bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden"
              style={{ top: fkPickerPos.top, left: fkPickerPos.left }}
            >
              <div className="px-2.5 py-1.5 border-b border-gray-100 dark:border-slate-800 flex items-center justify-between">
                <span className="text-[12px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">FK Reference</span>
                <button onClick={() => { setFkPickerIdx(null); setFkPickerPos(null); }} className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"><X size={12} /></button>
              </div>
              <div className="px-2.5 py-1.5 border-b border-gray-100 dark:border-slate-800 flex items-center gap-1.5">
                <input
                  autoFocus
                  value={fkManualInput}
                  onChange={e => setFkManualInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && fkManualInput.trim() && fkPickerIdx !== null) {
                      updateColumn(selectedMap.id, fkPickerIdx, { fkRef: fkManualInput.trim(), ...(tgtConn.type === 'postgresql' ? { targetType: 'UUID' } : {}) });
                      setFkPickerIdx(null); setFkPickerPos(null); setFkManualInput('');
                    }
                  }}
                  placeholder={srcIsPg ? 'db.schema.table (Enter to set)' : 'db.table (Enter to set)'}
                  className="flex-1 px-1.5 py-0.5 text-[12px] font-mono rounded border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-400 placeholder:text-gray-300 dark:placeholder:text-slate-600"
                />
                {fkManualInput.trim() && (
                  <button
                    onClick={() => {
                      if (fkPickerIdx === null) return;
                      updateColumn(selectedMap.id, fkPickerIdx, { fkRef: fkManualInput.trim(), ...(tgtConn.type === 'postgresql' ? { targetType: 'UUID' } : {}) });
                      setFkPickerIdx(null); setFkPickerPos(null); setFkManualInput('');
                    }}
                    className="shrink-0 p-0.5 rounded text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                    <Check size={12} />
                  </button>
                )}
              </div>
              <div className="max-h-52 overflow-y-auto">
                <button
                  onClick={() => { if (fkPickerIdx !== null) updateColumn(selectedMap.id, fkPickerIdx, { fkRef: null }); setFkPickerIdx(null); setFkPickerPos(null); }}
                  className="w-full px-2.5 py-1 text-left text-[12px] text-gray-400 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800 italic">
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
                        <div className="px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-gray-400 dark:text-slate-500 bg-gray-50 dark:bg-slate-800/60 sticky top-0">
                          {srcDbsSelected.length > 1 ? `${db} · ${schema}` : schema}
                        </div>
                        {tables.map(t => {
                          const fkKey = srcIsPg ? `${t.database}.${t.schema}.${t.name}` : `${t.database}.${t.name}`;
                          return (
                            <button key={`${t.database}.${t.schema}.${t.name}`}
                              onClick={() => {
                                if (fkPickerIdx !== null) updateColumn(selectedMap.id, fkPickerIdx, { fkRef: fkKey, ...(tgtConn.type === 'postgresql' ? { targetType: 'UUID' } : {}) });
                                setFkPickerIdx(null); setFkPickerPos(null);
                              }}
                              className="w-full px-2.5 py-1.5 text-left hover:bg-blue-50 dark:hover:bg-blue-950/30 border-b border-gray-50 dark:border-slate-800/50 last:border-0">
                              <div className="text-[12px] font-mono font-medium text-gray-700 dark:text-slate-200">{t.name}</div>
                              <div className="text-[11px] text-gray-400 dark:text-slate-500 mt-0.5">{t.rowCount.toLocaleString()} rows · {fkKey}</div>
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
        </>,
        document.body
      )}

      {/* Schema drift dialog */}
      {showDriftDialog && schemaDrift.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 w-full max-w-3xl shadow-xl flex flex-col max-h-[80vh]">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle size={16} className="text-amber-500 shrink-0" />
              <h3 className="text-base font-semibold text-gray-800 dark:text-slate-200">Target schema drift detected</h3>
            </div>
            <p className="text-sm text-gray-500 dark:text-slate-400 mb-4">
              {schemaDrift.length} table{schemaDrift.length > 1 ? 's have' : ' has'} changed in the target database since this job was last saved. Review and accept remaps to update the loaded job.
            </p>
            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {schemaDrift.map(drift => (
                <div key={drift.tableId} className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
                  <div className="flex items-center gap-3 px-3 py-2 bg-gray-50 dark:bg-slate-800/60 border-b border-gray-100 dark:border-slate-700">
                    <div className="flex items-center min-w-0 flex-1">
                      <span className="text-[13px] font-medium font-mono text-gray-700 dark:text-slate-200 truncate">{drift.sourceKey}</span>
                      <span className="text-gray-400 dark:text-slate-400 mx-1.5 shrink-0">→</span>
                      <span className="text-[13px] font-medium font-mono text-violet-600 dark:text-violet-400 truncate">{drift.targetKey}</span>
                    </div>
                    <button
                      onClick={() => { acceptDrift(drift); if (schemaDrift.length === 1) setShowDriftDialog(false); }}
                      className="shrink-0 px-3 py-1 rounded text-[12px] font-medium bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/50 transition-colors">
                      Accept
                    </button>
                  </div>
                  <div className="divide-y divide-gray-50 dark:divide-slate-800">
                    {drift.removed.map(col => (
                      <div key={col} className="flex items-center gap-3 px-3 py-1.5">
                        <span className="text-[11px] font-bold text-rose-500 w-4 shrink-0">−</span>
                        <span className="text-[12px] font-mono text-rose-600 dark:text-rose-400 whitespace-nowrap">{col}</span>
                        <span className="text-[11px] text-gray-400 dark:text-slate-500 ml-auto shrink-0">removed from target</span>
                      </div>
                    ))}
                    {drift.added.map(c => (
                      <div key={c.name} className="flex items-center gap-3 px-3 py-1.5">
                        <span className="text-[11px] font-bold text-emerald-500 w-4 shrink-0">+</span>
                        <span className="text-[12px] font-mono text-emerald-600 dark:text-emerald-400 whitespace-nowrap">{c.name}</span>
                        <span className="text-[11px] font-mono text-gray-400 dark:text-slate-500 whitespace-nowrap">{c.rawType}</span>
                        <span className="text-[11px] text-gray-400 dark:text-slate-500 ml-auto shrink-0">new in target</span>
                      </div>
                    ))}
                    {drift.typeChanged.map(c => (
                      <div key={c.col} className="flex items-center gap-3 px-3 py-1.5">
                        <span className="text-[11px] font-bold text-amber-500 w-4 shrink-0">~</span>
                        <span className="text-[12px] font-mono text-gray-700 dark:text-slate-300 whitespace-nowrap">{c.col}</span>
                        <span className="text-[11px] font-mono text-rose-400 line-through whitespace-nowrap">{c.from}</span>
                        <span className="text-[11px] text-gray-400 mx-0.5 shrink-0">→</span>
                        <span className="text-[11px] font-mono text-amber-500 whitespace-nowrap">{c.to}</span>
                        <span className="text-[11px] text-gray-400 dark:text-slate-500 ml-auto shrink-0">type changed</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowDriftDialog(false)}
                className="flex-1 py-2 rounded-lg text-base text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                Keep as-is
              </button>
              <button onClick={acceptAllDrift}
                className="flex-1 py-2 rounded-lg text-base font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors">
                Accept all remaps
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Diagnose modal */}
      {diagnoseModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 w-full max-w-lg shadow-xl flex flex-col max-h-[85vh]">
            {/* header */}
            <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100 dark:border-slate-700 shrink-0">
              <Sparkles size={15} className="text-violet-500 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-800 dark:text-slate-100">AI Diagnosis</p>
                <p className="text-[11px] text-gray-400 dark:text-slate-500 truncate">{diagnoseModal.sourceKey}</p>
              </div>
              <button onClick={() => setDiagnoseModal(prev => ({ ...prev, open: false }))}
                className="p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-700 text-gray-400 dark:text-slate-500 transition-colors">
                <X size={14} />
              </button>
            </div>

            {/* body */}
            <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
              {/* original error */}
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-1">Error</p>
                <pre className="text-[11px] text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 rounded-lg p-2.5 whitespace-pre-wrap break-all font-mono border border-rose-200 dark:border-rose-800/50">
                  {diagnoseModal.error}
                </pre>
              </div>

              {diagnoseModal.loading && (
                <div className="flex items-center gap-2 text-violet-500 dark:text-violet-400 py-4 justify-center">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-sm">Analysing failure…</span>
                </div>
              )}

              {diagnoseModal.result && !diagnoseModal.loading && (
                <>
                  {/* severity + root cause */}
                  <div className={`rounded-lg p-3 border ${
                    diagnoseModal.result.severity === 'critical'
                      ? 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800/50'
                      : diagnoseModal.result.severity === 'warning'
                      ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/50'
                      : 'bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800/50'
                  }`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                        diagnoseModal.result.severity === 'critical'
                          ? 'bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-300'
                          : diagnoseModal.result.severity === 'warning'
                          ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-600 dark:text-amber-300'
                          : 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300'
                      }`}>{diagnoseModal.result.severity}</span>
                    </div>
                    <p className="text-sm font-semibold text-gray-800 dark:text-slate-100">{diagnoseModal.result.rootCause}</p>
                  </div>

                  {/* explanation */}
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-1">Explanation</p>
                    <p className="text-sm text-gray-700 dark:text-slate-300 leading-relaxed">{diagnoseModal.result.explanation}</p>
                  </div>

                  {/* suggested fix */}
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-1">How to fix</p>
                    <p className="text-sm text-gray-700 dark:text-slate-300 leading-relaxed whitespace-pre-line">{diagnoseModal.result.suggestedFix}</p>
                  </div>

                  {/* column-level fixes */}
                  {diagnoseModal.result.columnFixes.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-1.5">Column mapping fixes</p>
                      <div className="space-y-2">
                        {diagnoseModal.result.columnFixes.map((cf, i) => (
                          <div key={i} className="rounded-lg border border-gray-200 dark:border-slate-600 p-2.5 bg-gray-50 dark:bg-slate-900/40">
                            <p className="text-[12px] font-mono font-semibold text-violet-600 dark:text-violet-400 mb-0.5">{cf.col}</p>
                            <p className="text-[11px] text-rose-600 dark:text-rose-400 mb-0.5">Issue: {cf.issue}</p>
                            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">Fix: {cf.fix}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* footer */}
            <div className="shrink-0 px-5 py-3 border-t border-gray-100 dark:border-slate-700 flex justify-end">
              <button onClick={() => setDiagnoseModal(prev => ({ ...prev, open: false }))}
                className="px-4 py-1.5 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors border border-gray-200 dark:border-slate-600">
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save Job dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-base font-semibold text-gray-800 dark:text-slate-200 mb-1">{scheduleAfterSave ? 'Save & Schedule Job' : 'Save Migration Job'}</h3>
            {scheduleAfterSave && (
              <p className="text-[12px] text-gray-500 dark:text-slate-400 mb-3">
                Saves this configuration, then opens the Scheduler so you can pick when it runs.
              </p>
            )}
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">Job name *</label>
                <input value={saveJobName} onChange={e => { setSaveJobName(e.target.value); setSaveAsTarget(null); }} placeholder="e.g. Dev → Staging"
                  className="w-full px-3 py-2 text-base rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">Description</label>
                <input value={saveJobDesc} onChange={e => setSaveJobDesc(e.target.value)} placeholder="Optional"
                  className="w-full px-3 py-2 text-base rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              {/* Row-range filter */}
              <div className="rounded-lg border border-gray-200 dark:border-slate-600 p-3 space-y-2 bg-gray-50 dark:bg-slate-900/40">
                <p className="text-[12px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Row-range filter <span className="normal-case font-normal">(optional)</span></p>
                <div>
                  <label className="block text-[12px] text-gray-500 dark:text-slate-400 mb-0.5">Timestamp column</label>
                  <input value={filterCol} onChange={e => setFilterCol(e.target.value)} placeholder="e.g. created_at"
                    className="w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="block text-[12px] text-gray-500 dark:text-slate-400 mb-0.5">From</label>
                    <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  </div>
                  <div className="flex-1">
                    <label className="block text-[12px] text-gray-500 dark:text-slate-400 mb-0.5">To</label>
                    <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  </div>
                </div>
                {filterCol.trim() && (
                  <p className="text-[11px] text-blue-600 dark:text-blue-400">
                    Only rows where <code className="font-mono">{filterCol.trim()}</code>
                    {filterFrom && ` ≥ ${filterFrom}`}{filterFrom && filterTo && ' and'}{filterTo && ` ≤ ${filterTo}`} will be migrated.
                  </p>
                )}
              </div>
              {/* Save as existing job */}
              {jobs.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">Save as existing job</label>
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
                        className={`w-full text-left px-2 py-1.5 rounded-md text-[13px] transition-colors ${saveAsTarget === j.id ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium' : 'hover:bg-white dark:hover:bg-slate-700 text-gray-700 dark:text-slate-300'}`}>
                        <span className="font-medium">{j.name}</span>
                        <span className="ml-1.5 text-gray-400 dark:text-slate-500">{j.tableCount} tables · v{j.version}</span>
                      </button>
                    ))}
                  </div>
                  {saveAsTarget && (
                    <p className="text-[12px] text-amber-600 dark:text-amber-400 mt-1">
                      Will overwrite existing job with current table mappings.
                    </p>
                  )}
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => { setShowSaveDialog(false); setSaveAsTarget(null); setScheduleAfterSave(false); }}
                className="flex-1 py-2 rounded-lg text-base text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button onClick={handleSaveJob} disabled={savingJob || !saveJobName.trim()}
                className="flex-1 py-2 rounded-lg text-base font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {savingJob ? 'Saving…' : scheduleAfterSave ? 'Save & Schedule' : saveAsTarget ? 'Update Job' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
