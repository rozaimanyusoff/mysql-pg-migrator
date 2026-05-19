'use client';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { randomUUID } from 'crypto';
import {
  ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight,
  Database, Download, Eye, EyeOff, FileText, Layers, Loader2,
  Play, Plus, RefreshCw, RotateCcw, Save, Search, Settings2,
  Table2, Trash2, X, AlertTriangle, CheckCircle2, Clock,
  Plug, Unplug, Network,
} from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import { suggestTargetType, isPkLikeSerial } from '../lib/migv2/type-map';
import type { MigConn, TableMap, ColumnMap, MigJob, MigJobSummary, MigRun, DbType, IdConversion } from '../lib/migv2/types';
import type { MigTableInfo } from './api/migv2/tables';
import type { MigColumnInfo } from './api/migv2/columns';

// ── Helpers ───────────────────────────────────────────────────────────────────

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('auth_token') ?? '';
}

function authHeaders() {
  return { Authorization: `Bearer ${getToken()}` };
}

const EMPTY_CONN: MigConn = {
  type: 'postgresql', host: 'localhost', port: 5432, database: '', username: '', password: '',
};

// ── Sub-components ────────────────────────────────────────────────────────────

function ConnForm({
  label, conn, onChange, connected, onConnect, onDisconnect, connecting, error,
}: {
  label: string;
  conn: MigConn;
  onChange: (c: MigConn) => void;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  connecting: boolean;
  error: string;
}) {
  const [showPw, setShowPw] = useState(false);

  return (
    <div className="flex-1 min-w-0 p-3 rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">{label}</span>
        {connected
          ? <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400 font-medium"><Check size={10} /> Connected</span>
          : error ? <span className="text-[11px] text-rose-500 truncate max-w-[120px]" title={error}>{error}</span> : null}
      </div>

      {/* DB type toggle */}
      <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-slate-600 mb-2 w-fit">
        {(['postgresql', 'mysql'] as DbType[]).map(t => (
          <button key={t} disabled={connected}
            onClick={() => onChange({ ...conn, type: t, port: t === 'postgresql' ? 5432 : 3306 })}
            className={`px-2.5 py-1 text-[11px] font-medium transition-colors ${conn.type === t ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-700 text-gray-500 dark:text-slate-400'} disabled:cursor-default`}>
            {t === 'postgresql' ? 'PG' : 'MySQL'}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-1.5 mb-1.5">
        <input value={conn.host} disabled={connected} placeholder="host"
          onChange={e => onChange({ ...conn, host: e.target.value })}
          className="col-span-2 px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-200 disabled:opacity-60" />
        <input value={conn.port} disabled={connected} placeholder="port" type="number"
          onChange={e => onChange({ ...conn, port: Number(e.target.value) })}
          className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-200 disabled:opacity-60" />
        <input value={conn.database} disabled={connected} placeholder="database"
          onChange={e => onChange({ ...conn, database: e.target.value })}
          className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-200 disabled:opacity-60" />
        <input value={conn.username} disabled={connected} placeholder="user"
          onChange={e => onChange({ ...conn, username: e.target.value })}
          className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-200 disabled:opacity-60" />
        <div className="relative">
          <input type={showPw ? 'text' : 'password'} value={conn.password} disabled={connected} placeholder="password"
            onChange={e => onChange({ ...conn, password: e.target.value })}
            className="w-full pl-2 pr-7 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-800 dark:text-slate-200 disabled:opacity-60" />
          <button type="button" onClick={() => setShowPw(v => !v)} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400">
            {showPw ? <EyeOff size={11} /> : <Eye size={11} />}
          </button>
        </div>
      </div>

      {!connected
        ? <button onClick={onConnect} disabled={connecting || !conn.host || !conn.username}
            className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {connecting ? <Loader2 size={11} className="animate-spin" /> : <Plug size={11} />}
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        : <button onClick={onDisconnect}
            className="w-full inline-flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
            <Unplug size={11} /> Disconnect
          </button>}
    </div>
  );
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
    : status === 'rolled_back' ? RotateCcw
    : Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${map[status] ?? map.pending}`}>
      <Icon size={10} className={status === 'running' ? 'animate-spin' : ''} />
      {status}
    </span>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type ActiveTab = 'mapping' | 'jobs' | 'execute';

export default function Migration() {
  useAuth();

  // ── Connections ─────────────────────────────────────────────────────────────
  const [srcConn, setSrcConn] = useState<MigConn>({ ...EMPTY_CONN, type: 'mysql', port: 3306 });
  const [tgtConn, setTgtConn] = useState<MigConn>({ ...EMPTY_CONN, type: 'postgresql', port: 5432 });
  const [srcConnected, setSrcConnected] = useState(false);
  const [tgtConnected, setTgtConnected] = useState(false);
  const [srcConnecting, setSrcConnecting] = useState(false);
  const [tgtConnecting, setTgtConnecting] = useState(false);
  const [srcError, setSrcError] = useState('');
  const [tgtError, setTgtError] = useState('');

  // ── Source tables ────────────────────────────────────────────────────────────
  const [srcTables, setSrcTables] = useState<MigTableInfo[]>([]);
  const [srcSearch, setSrcSearch] = useState('');
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());

  // ── Mapping config ───────────────────────────────────────────────────────────
  const [tableMaps, setTableMaps] = useState<TableMap[]>([]);
  const [selectedMapId, setSelectedMapId] = useState<string | null>(null);
  const [colsCache, setColsCache] = useState<Record<string, MigColumnInfo[]>>({}); // source cols by "schema.table"
  const [loadingCols, setLoadingCols] = useState(false);
  const [dirty, setDirty] = useState(false);

  // ── Jobs ─────────────────────────────────────────────────────────────────────
  const [jobs, setJobs] = useState<MigJobSummary[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [saveJobName, setSaveJobName] = useState('');
  const [saveJobDesc, setSaveJobDesc] = useState('');
  const [savingJob, setSavingJob] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);

  // ── Execution ────────────────────────────────────────────────────────────────
  const [currentRun, setCurrentRun] = useState<MigRun | null>(null);
  const [polling, setPolling] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // ── UI ────────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<ActiveTab>('mapping');

  // ── Connect source ────────────────────────────────────────────────────────────

  const connectSource = async () => {
    setSrcConnecting(true); setSrcError('');
    try {
      const { data } = await axios.post<{ tables: MigTableInfo[] }>(
        '/api/migv2/tables', srcConn, { headers: authHeaders() }
      );
      setSrcTables(data.tables);
      setSrcConnected(true);
      // Auto-expand first schema
      const firstSchema = data.tables[0]?.schema;
      if (firstSchema) setExpandedSchemas(new Set([firstSchema]));
    } catch (err) {
      setSrcError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Connection failed') : 'Connection failed');
    } finally { setSrcConnecting(false); }
  };

  const disconnectSource = () => {
    setSrcConnected(false); setSrcTables([]); setTableMaps([]); setColsCache({}); setSelectedMapId(null);
  };

  // ── Connect target ────────────────────────────────────────────────────────────

  const connectTarget = async () => {
    setTgtConnecting(true); setTgtError('');
    try {
      // Just test connection by fetching tables (we don't need them, but it validates creds)
      await axios.post('/api/migv2/tables', tgtConn, { headers: authHeaders() });
      setTgtConnected(true);
    } catch (err) {
      setTgtError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Connection failed') : 'Connection failed');
    } finally { setTgtConnecting(false); }
  };

  const disconnectTarget = () => { setTgtConnected(false); };

  // ── Source table selection ─────────────────────────────────────────────────────

  const isTableIncluded = (schema: string, table: string) =>
    tableMaps.some(m => m.source.schema === schema && m.source.table === table && m.include);

  const toggleTable = async (schema: string, table: string) => {
    const key = `${schema}.${table}`;
    const existing = tableMaps.find(m => m.source.schema === schema && m.source.table === table);

    if (existing) {
      setTableMaps(prev => prev.map(m =>
        m.source.schema === schema && m.source.table === table ? { ...m, include: !m.include } : m
      ));
      setDirty(true);
      return;
    }

    // New table: load source columns and auto-map
    setLoadingCols(true);
    try {
      let srcCols = colsCache[key];
      if (!srcCols) {
        const { data } = await axios.post<{ columns: MigColumnInfo[] }>(
          '/api/migv2/columns', { conn: srcConn, tableKey: key }, { headers: authHeaders() }
        );
        srcCols = data.columns;
        setColsCache(prev => ({ ...prev, [key]: srcCols }));
      }

      const columns: ColumnMap[] = srcCols.map(c => {
        const isPk = c.isPk;
        const isSerial = isPk && (c.isAutoIncrement || isPkLikeSerial(c.rawType));
        return {
          sourceCol: c.name,
          targetCol: c.name,
          targetType: suggestTargetType(c.rawType, srcConn.type, tgtConn.type),
          nullable: c.nullable,
          defaultValue: c.defaultValue,
          include: true,
          conversion: isSerial ? 'serial_to_uuid' : 'keep',
          fkRef: c.isFk && c.fkRef
            ? c.fkRef.split('.').slice(0, 2).join('.')
            : null,
        };
      });

      // For UUID conversion: if PK column flagged serial_to_uuid, adjust type
      columns.forEach(c => {
        if (c.conversion === 'serial_to_uuid' && tgtConn.type === 'postgresql') {
          c.targetType = 'UUID';
        }
      });

      const newMap: TableMap = {
        id: newId(),
        include: true,
        source: { schema, table },
        target: { schema, table },
        columns,
        truncateBeforeMigrate: false,
      };

      setTableMaps(prev => [...prev, newMap]);
      setSelectedMapId(newMap.id);
      setDirty(true);
    } catch { /* ignore */ } finally { setLoadingCols(false); }
  };

  // ── Column mapping editor helpers ──────────────────────────────────────────────

  const selectedMap = tableMaps.find(m => m.id === selectedMapId) ?? null;

  const updateTableMap = (id: string, patch: Partial<TableMap>) => {
    setTableMaps(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
    setDirty(true);
  };

  const updateColumn = (mapId: string, colIdx: number, patch: Partial<ColumnMap>) => {
    setTableMaps(prev => prev.map(m => {
      if (m.id !== mapId) return m;
      const columns = m.columns.map((c, i) => i === colIdx ? { ...c, ...patch } : c);
      return { ...m, columns };
    }));
    setDirty(true);
  };

  const addTargetOnlyColumn = (mapId: string) => {
    setTableMaps(prev => prev.map(m => {
      if (m.id !== mapId) return m;
      const newCol: ColumnMap = {
        sourceCol: null, targetCol: 'new_column',
        targetType: tgtConn.type === 'postgresql' ? 'TEXT' : 'VARCHAR(255)',
        nullable: true, defaultValue: null, include: true,
        conversion: 'keep', fkRef: null,
      };
      return { ...m, columns: [...m.columns, newCol] };
    }));
    setDirty(true);
  };

  const removeColumn = (mapId: string, colIdx: number) => {
    setTableMaps(prev => prev.map(m => {
      if (m.id !== mapId) return m;
      return { ...m, columns: m.columns.filter((_, i) => i !== colIdx) };
    }));
    setDirty(true);
  };

  // ── Source tree ─────────────────────────────────────────────────────────────────

  const srcSchemas = useMemo(() => {
    const schemas = [...new Set(srcTables.map(t => t.schema))];
    return schemas.map(s => ({
      schema: s,
      tables: srcTables.filter(t => t.schema === s && (
        !srcSearch || t.name.toLowerCase().includes(srcSearch.toLowerCase())
      )),
    })).filter(s => s.tables.length > 0 || !srcSearch);
  }, [srcTables, srcSearch]);

  const includedCount = tableMaps.filter(m => m.include).length;

  // ── Jobs ──────────────────────────────────────────────────────────────────────

  const loadJobs = async () => {
    try {
      const { data } = await axios.get<{ jobs: MigJobSummary[] }>('/api/migv2/jobs', { headers: authHeaders() });
      setJobs(data.jobs);
    } catch { /* ignore */ }
  };

  useEffect(() => { void loadJobs(); }, []);

  const handleSaveJob = async () => {
    if (!saveJobName.trim()) return;
    setSavingJob(true);
    try {
      const jobPayload: Partial<MigJob> = {
        id: activeJobId ?? undefined,
        name: saveJobName.trim(),
        description: saveJobDesc.trim(),
        sourceMeta: { type: srcConn.type, host: srcConn.host, port: srcConn.port, database: srcConn.database, username: srcConn.username },
        targetMeta: { type: tgtConn.type, host: tgtConn.host, port: tgtConn.port, database: tgtConn.database, username: tgtConn.username },
        tables: tableMaps,
      };
      const { data } = await axios.post<{ job: MigJob }>('/api/migv2/jobs', jobPayload, { headers: authHeaders() });
      setActiveJobId(data.job.id);
      setDirty(false);
      setShowSaveDialog(false);
      await loadJobs();
    } catch { /* ignore */ } finally { setSavingJob(false); }
  };

  const handleLoadJob = async (id: string) => {
    try {
      const { data } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${id}`, { headers: authHeaders() });
      const job = data.job;
      setSrcConn({ ...srcConn, type: job.sourceMeta.type, host: job.sourceMeta.host, port: job.sourceMeta.port, database: job.sourceMeta.database, username: job.sourceMeta.username });
      setTgtConn({ ...tgtConn, type: job.targetMeta.type, host: job.targetMeta.host, port: job.targetMeta.port, database: job.targetMeta.database, username: job.targetMeta.username });
      setTableMaps(job.tables);
      setActiveJobId(id);
      setSaveJobName(job.name);
      setSaveJobDesc(job.description);
      setDirty(false);
      setActiveTab('mapping');
    } catch { /* ignore */ }
  };

  const handleDeleteJob = async (id: string) => {
    try {
      await axios.delete(`/api/migv2/jobs/${id}`, { headers: authHeaders() });
      await loadJobs();
      if (activeJobId === id) { setActiveJobId(null); setSaveJobName(''); setSaveJobDesc(''); }
    } catch { /* ignore */ }
  };

  // ── Migration execution ────────────────────────────────────────────────────────

  const startMigration = async () => {
    const includedTables = tableMaps.filter(t => t.include);
    if (!includedTables.length) return;
    setPolling(true);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/start', {
        source: srcConn,
        target: tgtConn,
        tables: includedTables,
        jobId: activeJobId,
        jobName: saveJobName || 'Migration',
      }, { headers: authHeaders() });
      setCurrentRun(data.run);
      setActiveTab('execute');
      if (data.run.status === 'running' || data.run.status === 'pending') {
        scheduleAdvance(data.run.id);
      } else {
        setPolling(false);
      }
    } catch { setPolling(false); }
  };

  const scheduleAdvance = (runId: string) => {
    setTimeout(() => void advanceMigration(runId), 1000);
  };

  const advanceMigration = async (runId: string) => {
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/advance', {
        runId, source: srcConn, target: tgtConn,
      }, { headers: authHeaders() });
      setCurrentRun(data.run);
      if (data.run.status === 'running') {
        scheduleAdvance(runId);
      } else {
        setPolling(false);
      }
    } catch { setPolling(false); }
  };

  const handleRollback = async () => {
    if (!currentRun) return;
    setRollingBack(true);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/rollback', {
        runId: currentRun.id, target: tgtConn,
      }, { headers: authHeaders() });
      setCurrentRun(data.run);
    } catch { /* ignore */ } finally { setRollingBack(false); }
  };

  const handleExportMd = () => {
    if (!currentRun) return;
    const a = document.createElement('a');
    a.href = `/api/migv2/export-md?id=${currentRun.id}`;
    a.setAttribute('data-auth', getToken());
    // Use fetch to download with auth header
    void (async () => {
      const res = await fetch(`/api/migv2/export-md?id=${currentRun.id}`, { headers: authHeaders() });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `migration-${currentRun.id.slice(0, 8)}.md`;
      link.click();
      URL.revokeObjectURL(url);
    })();
  };

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentRun?.logs.length]);

  // ── Derived ───────────────────────────────────────────────────────────────────

  const canStart = srcConnected && tgtConnected && includedCount > 0 && !polling;

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <>
      <Head><title>Migration</title></Head>
      <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <header className="shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2 flex items-center gap-3">
          <Link href="/" className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">
            <ArrowLeft size={16} />
          </Link>
          <div className="flex items-center gap-2">
            <Database size={16} className="text-blue-500" />
            <span className="text-sm font-semibold text-gray-800 dark:text-slate-200">Migration</span>
          </div>
          {dirty && (
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400">
              unsaved changes
            </span>
          )}
          <div className="flex-1" />
          {includedCount > 0 && (
            <span className="text-xs text-gray-400 dark:text-slate-500">{includedCount} table{includedCount > 1 ? 's' : ''} selected</span>
          )}
          <button onClick={() => { setSaveJobName(saveJobName || 'New Job'); setShowSaveDialog(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700">
            <Save size={12} /> Save Job
          </button>
          <button onClick={() => void startMigration()} disabled={!canStart}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {polling ? <><Loader2 size={12} className="animate-spin" /> Running…</> : <><Play size={12} /> Migrate</>}
          </button>
        </header>

        {/* ── Connections bar ───────────────────────────────────────────── */}
        <div className="shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3 flex items-start gap-3">
          <ConnForm
            label="Source"
            conn={srcConn} onChange={setSrcConn}
            connected={srcConnected} connecting={srcConnecting} error={srcError}
            onConnect={() => void connectSource()} onDisconnect={disconnectSource}
          />
          <div className="flex items-center self-center pt-6">
            <ArrowRight size={20} className="text-gray-300 dark:text-slate-600" />
          </div>
          <ConnForm
            label="Target"
            conn={tgtConn} onChange={setTgtConn}
            connected={tgtConnected} connecting={tgtConnecting} error={tgtError}
            onConnect={() => void connectTarget()} onDisconnect={disconnectTarget}
          />
        </div>

        {/* ── Body ─────────────────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0">

          {/* ── Left panel — source tables tree ───────────────────────── */}
          <aside className="w-56 shrink-0 flex flex-col border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="p-2 border-b border-gray-100 dark:border-slate-800">
              <div className="relative">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={srcSearch} onChange={e => setSrcSearch(e.target.value)}
                  placeholder="Filter tables…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto py-1">
              {!srcConnected && (
                <div className="px-4 py-8 text-center">
                  <Database size={24} className="mx-auto text-gray-200 dark:text-slate-700 mb-2" />
                  <p className="text-xs text-gray-400 dark:text-slate-500">Connect source DB</p>
                </div>
              )}

              {srcConnected && srcSchemas.map(({ schema, tables }) => {
                const isExpanded = expandedSchemas.has(schema);
                return (
                  <div key={schema}>
                    <div className="flex items-center gap-1.5 px-2 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800"
                      onClick={() => setExpandedSchemas(prev => {
                        const n = new Set(prev);
                        n.has(schema) ? n.delete(schema) : n.add(schema);
                        return n;
                      })}>
                      {isExpanded ? <ChevronDown size={11} className="text-gray-400 shrink-0" /> : <ChevronRight size={11} className="text-gray-400 shrink-0" />}
                      <Database size={11} className="text-blue-500 shrink-0" />
                      <span className="text-xs font-medium text-gray-700 dark:text-slate-300 flex-1 truncate">{schema}</span>
                      <span className="text-[10px] text-gray-400">{tables.length}</span>
                    </div>
                    {isExpanded && tables.map(t => {
                      const included = isTableIncluded(t.schema, t.name);
                      const mapEntry = tableMaps.find(m => m.source.schema === t.schema && m.source.table === t.name);
                      const isSelected = mapEntry?.id === selectedMapId;
                      return (
                        <div key={t.name}
                          className={`flex items-center gap-1.5 pl-6 pr-2 py-1 cursor-pointer group ${isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-gray-50 dark:hover:bg-slate-800'}`}
                          onClick={() => {
                            if (mapEntry) setSelectedMapId(mapEntry.id);
                            else void toggleTable(t.schema, t.name);
                          }}
                        >
                          <input type="checkbox" checked={included}
                            onChange={e => { e.stopPropagation(); void toggleTable(t.schema, t.name); }}
                            className="shrink-0 accent-blue-500"
                            onClick={e => e.stopPropagation()}
                          />
                          <Table2 size={10} className="text-gray-400 shrink-0" />
                          <span className={`text-xs flex-1 truncate ${isSelected ? 'text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-600 dark:text-slate-400'}`}>{t.name}</span>
                          <span className="text-[10px] text-gray-400">{t.rowCount.toLocaleString()}</span>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </aside>

          {/* ── Right panel ─────────────────────────────────────────────── */}
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden">

            {/* Tab bar */}
            <div className="shrink-0 flex border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4">
              {([
                { key: 'mapping', label: 'Column Mapping', Icon: Settings2 },
                { key: 'jobs',    label: 'Jobs',           Icon: Save },
                { key: 'execute', label: 'Execute',        Icon: Play },
              ] as { key: ActiveTab; label: string; Icon: React.FC<any> }[]).map(({ key, label, Icon }) => (
                <button key={key} onClick={() => setActiveTab(key)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${activeTab === key ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'}`}>
                  <Icon size={13} /> {label}
                  {key === 'execute' && currentRun && (
                    <StatusBadge status={currentRun.status} />
                  )}
                </button>
              ))}
            </div>

            {/* ── Mapping tab ──────────────────────────────────────────── */}
            {activeTab === 'mapping' && (
              <div className="flex-1 overflow-auto">
                {!selectedMap && (
                  <div className="flex flex-col items-center justify-center h-full gap-3">
                    <Network size={36} className="text-gray-200 dark:text-slate-700" />
                    <p className="text-sm text-gray-400 dark:text-slate-500">
                      {srcConnected ? 'Check a table on the left to configure its mapping' : 'Connect a source database first'}
                    </p>
                  </div>
                )}
                {loadingCols && !selectedMap && (
                  <div className="p-8 flex items-center gap-2 text-sm text-gray-400 animate-pulse">
                    <Loader2 size={14} className="animate-spin" /> Loading columns…
                  </div>
                )}

                {selectedMap && (
                  <div className="p-4 space-y-4">
                    {/* Table header */}
                    <div className="flex items-center gap-4 flex-wrap">
                      <div>
                        <label className="block text-[11px] text-gray-500 dark:text-slate-400 mb-1">Source table</label>
                        <span className="text-sm font-mono text-gray-700 dark:text-slate-300">
                          {selectedMap.source.schema}.{selectedMap.source.table}
                        </span>
                      </div>
                      <ArrowRight size={16} className="text-gray-300 dark:text-slate-600 self-end mb-1" />
                      <div className="flex items-end gap-2">
                        <div>
                          <label className="block text-[11px] text-gray-500 dark:text-slate-400 mb-1">Target schema</label>
                          <input value={selectedMap.target.schema}
                            onChange={e => updateTableMap(selectedMap.id, { target: { ...selectedMap.target, schema: e.target.value } })}
                            className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 w-24"
                          />
                        </div>
                        <span className="text-gray-400 pb-1">.</span>
                        <div>
                          <label className="block text-[11px] text-gray-500 dark:text-slate-400 mb-1">Target table</label>
                          <input value={selectedMap.target.table}
                            onChange={e => updateTableMap(selectedMap.id, { target: { ...selectedMap.target, table: e.target.value } })}
                            className="px-2 py-1 text-xs rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 w-32"
                          />
                        </div>
                      </div>
                      <label className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400 self-end mb-1 ml-auto">
                        <input type="checkbox" checked={selectedMap.truncateBeforeMigrate}
                          onChange={e => updateTableMap(selectedMap.id, { truncateBeforeMigrate: e.target.checked })}
                          className="accent-rose-500"
                        />
                        Truncate target before migrate
                      </label>
                    </div>

                    {/* Column mapping table */}
                    <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-slate-800/60">
                            {['Source Column', 'Source Type', '', 'Target Column', 'Target Type', 'Conversion', 'FK Ref', 'Include', ''].map((h, i) => (
                              <th key={i} className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                          {selectedMap.columns.map((col, idx) => (
                            <tr key={idx} className={`${col.include ? '' : 'opacity-40'} hover:bg-gray-50 dark:hover:bg-slate-800/40`}>
                              {/* Source column */}
                              <td className="px-3 py-1.5 font-mono text-gray-700 dark:text-slate-300">
                                {col.sourceCol ?? <span className="italic text-gray-400">*(new)*</span>}
                              </td>
                              {/* Source type */}
                              <td className="px-3 py-1.5 text-gray-500 dark:text-slate-400 font-mono text-[11px]">
                                {colsCache[`${selectedMap.source.schema}.${selectedMap.source.table}`]?.find(c => c.name === col.sourceCol)?.rawType ?? '—'}
                              </td>
                              {/* Arrow */}
                              <td className="px-1 py-1.5 text-gray-300">→</td>
                              {/* Target column */}
                              <td className="px-3 py-1.5">
                                <input value={col.targetCol}
                                  onChange={e => updateColumn(selectedMap.id, idx, { targetCol: e.target.value })}
                                  className="w-28 px-1.5 py-0.5 text-xs rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono"
                                />
                              </td>
                              {/* Target type */}
                              <td className="px-3 py-1.5">
                                <input value={col.targetType}
                                  onChange={e => updateColumn(selectedMap.id, idx, { targetType: e.target.value })}
                                  className="w-28 px-1.5 py-0.5 text-xs rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono uppercase"
                                />
                              </td>
                              {/* Conversion */}
                              <td className="px-3 py-1.5">
                                <select value={col.conversion}
                                  onChange={e => {
                                    const conv = e.target.value as IdConversion;
                                    const targetType = conv === 'serial_to_uuid'
                                      ? (tgtConn.type === 'postgresql' ? 'UUID' : 'VARCHAR(36)')
                                      : col.targetType;
                                    updateColumn(selectedMap.id, idx, { conversion: conv, targetType });
                                  }}
                                  className="text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 py-0.5 px-1">
                                  <option value="keep">keep</option>
                                  <option value="serial_to_uuid">serial → UUID</option>
                                </select>
                              </td>
                              {/* FK Ref */}
                              <td className="px-3 py-1.5">
                                <input
                                  value={col.fkRef ?? ''}
                                  onChange={e => updateColumn(selectedMap.id, idx, { fkRef: e.target.value || null })}
                                  placeholder={col.conversion === 'keep' ? '—' : 'schema.table'}
                                  disabled={col.conversion !== 'serial_to_uuid' && !col.fkRef}
                                  className="w-28 px-1.5 py-0.5 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 font-mono disabled:opacity-30"
                                />
                              </td>
                              {/* Include */}
                              <td className="px-3 py-1.5 text-center">
                                <input type="checkbox" checked={col.include}
                                  onChange={e => updateColumn(selectedMap.id, idx, { include: e.target.checked })}
                                  className="accent-blue-500"
                                />
                              </td>
                              {/* Remove */}
                              <td className="px-2 py-1.5">
                                {col.sourceCol === null && (
                                  <button onClick={() => removeColumn(selectedMap.id, idx)}
                                    className="p-0.5 rounded text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors">
                                    <X size={12} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-800">
                        <button onClick={() => addTargetOnlyColumn(selectedMap.id)}
                          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700">
                          <Plus size={12} /> Add target-only column
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Jobs tab ──────────────────────────────────────────────── */}
            {activeTab === 'jobs' && (
              <div className="flex-1 overflow-auto p-4">
                <div className="max-w-2xl space-y-3">
                  {jobs.length === 0 && (
                    <div className="py-12 text-center">
                      <Save size={32} className="mx-auto text-gray-200 dark:text-slate-700 mb-3" />
                      <p className="text-sm text-gray-400 dark:text-slate-500">No saved jobs yet. Save the current config using the button above.</p>
                    </div>
                  )}
                  {jobs.map(job => (
                    <div key={job.id}
                      className={`flex items-center gap-3 p-3 rounded-xl border transition-colors ${activeJobId === job.id ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/20' : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/50'}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-gray-800 dark:text-slate-200 truncate">{job.name}</p>
                          <span className="text-[10px] text-gray-400 dark:text-slate-500 shrink-0">v{job.version}</span>
                          {activeJobId === job.id && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-medium">active</span>}
                        </div>
                        {job.description && <p className="text-xs text-gray-400 dark:text-slate-500 truncate">{job.description}</p>}
                        <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">{job.tableCount} tables · updated {new Date(job.updatedAt).toLocaleDateString()}</p>
                      </div>
                      <button onClick={() => void handleLoadJob(job.id)}
                        className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-600 transition-colors">
                        Load
                      </button>
                      <button onClick={() => void handleDeleteJob(job.id)}
                        className="p-1.5 rounded-lg text-gray-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Execute tab ───────────────────────────────────────────── */}
            {activeTab === 'execute' && (
              <div className="flex-1 overflow-hidden flex flex-col">
                {!currentRun && (
                  <div className="flex flex-col items-center justify-center h-full gap-4">
                    <Play size={36} className="text-gray-200 dark:text-slate-700" />
                    <p className="text-sm text-gray-400 dark:text-slate-500">Click <strong>Migrate</strong> in the top bar to start</p>
                    {!canStart && !polling && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">
                        {!srcConnected ? 'Source not connected. ' : ''}{!tgtConnected ? 'Target not connected. ' : ''}{includedCount === 0 ? 'No tables selected.' : ''}
                      </p>
                    )}
                  </div>
                )}

                {currentRun && (
                  <div className="flex flex-col h-full overflow-hidden">
                    {/* Run meta bar */}
                    <div className="shrink-0 px-4 py-2 border-b border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900 flex items-center gap-4 flex-wrap">
                      <StatusBadge status={currentRun.status} />
                      <span className="text-xs text-gray-500 dark:text-slate-400">
                        {currentRun.migratedRows.toLocaleString()} / {currentRun.totalRows.toLocaleString()} rows
                      </span>
                      <span className="text-xs text-gray-400 dark:text-slate-500 font-mono">{currentRun.id.slice(0, 8)}</span>
                      <div className="flex-1" />
                      {(currentRun.status === 'completed' || currentRun.status === 'failed') && (
                        <button onClick={handleRollback} disabled={rollingBack}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/50 disabled:opacity-50 transition-colors">
                          {rollingBack ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                          Rollback
                        </button>
                      )}
                      <button onClick={handleExportMd}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors">
                        <FileText size={11} /> Export MD
                      </button>
                    </div>

                    {/* Per-table progress */}
                    <div className="shrink-0 px-4 py-3 border-b border-gray-100 dark:border-slate-800 space-y-2 max-h-48 overflow-auto">
                      {currentRun.tableStates.map(ts => {
                        const pct = ts.rowsSource > 0 ? Math.min(100, Math.round(ts.rowsMigrated / ts.rowsSource * 100)) : 0;
                        return (
                          <div key={ts.id}>
                            <div className="flex items-center justify-between mb-0.5">
                              <div className="flex items-center gap-2">
                                <StatusBadge status={ts.status} />
                                <span className="text-xs font-mono text-gray-700 dark:text-slate-300">{ts.sourceKey}</span>
                                <span className="text-gray-400 text-xs">→</span>
                                <span className="text-xs font-mono text-gray-500 dark:text-slate-400">{ts.targetKey}</span>
                              </div>
                              <span className="text-[11px] text-gray-400 dark:text-slate-500">
                                {ts.rowsMigrated.toLocaleString()} / {ts.rowsSource.toLocaleString()} ({pct}%)
                              </span>
                            </div>
                            <div className="h-1 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all duration-500 ${ts.status === 'completed' ? 'bg-emerald-500' : ts.status === 'failed' ? 'bg-rose-500' : ts.status === 'rolled_back' ? 'bg-amber-500' : 'bg-blue-500'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            {ts.error && <p className="text-[11px] text-rose-500 mt-0.5">{ts.error}</p>}
                          </div>
                        );
                      })}
                    </div>

                    {/* Live logs */}
                    <div className="flex-1 overflow-auto bg-gray-900 dark:bg-black p-3 font-mono text-[11px] text-gray-300 dark:text-slate-300">
                      {currentRun.logs.map((line, i) => (
                        <div key={i} className={`leading-5 ${line.includes('ERROR') ? 'text-rose-400' : line.includes('completed') ? 'text-emerald-400' : line.includes('ROLLBACK') ? 'text-amber-400' : ''}`}>
                          {line}
                        </div>
                      ))}
                      <div ref={logsEndRef} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      </div>

      {/* ── Save Job dialog ─────────────────────────────────────────────── */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-slate-200 mb-4">Save Migration Job</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Job name *</label>
                <input value={saveJobName} onChange={e => setSaveJobName(e.target.value)} placeholder="e.g. Dev → Staging"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Description</label>
                <input value={saveJobDesc} onChange={e => setSaveJobDesc(e.target.value)} placeholder="Optional"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex gap-2 mt-5">
              <button onClick={() => setShowSaveDialog(false)}
                className="flex-1 py-2 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
                Cancel
              </button>
              <button onClick={() => void handleSaveJob()} disabled={savingJob || !saveJobName.trim()}
                className="flex-1 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                {savingJob ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
