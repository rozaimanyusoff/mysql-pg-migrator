'use client';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  ArrowRight, Check, ChevronLeft, ChevronRight,
  Database, FileText, Layers, Loader2,
  Play, Plus, RotateCcw, Save, Search,
  Table2, Trash2, X, AlertTriangle, CheckCircle2, Clock,
  Network,
} from 'lucide-react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { useAuth } from '../lib/auth-context';
import { suggestTargetType, isPkLikeSerial } from '../lib/migv2/type-map';
import type { MigConn, TableMap, ColumnMap, MigJob, MigJobSummary, MigRun, IdConversion } from '../lib/migv2/types';
import type { MigTableInfo } from './api/migv2/tables';
import type { MigColumnInfo } from './api/migv2/columns';
import type { ConnectionRow } from './api/connections/index';

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
    : status === 'rolled_back' ? RotateCcw
    : Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${map[status] ?? map.pending}`}>
      <Icon size={9} className={status === 'running' ? 'animate-spin' : ''} />
      {status}
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

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Migration() {
  useAuth();
  const router = useRouter();

  const [connections, setConnections] = useState<ConnectionRow[]>([]);

  // ── Source ────────────────────────────────────────────────────────────────────
  const [srcConnId, setSrcConnId] = useState<number | null>(null);
  const [srcDbs, setSrcDbs] = useState<string[]>([]);
  const [srcDb, setSrcDb] = useState('');
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
  const [dirty, setDirty] = useState(false);

  // ── Jobs ──────────────────────────────────────────────────────────────────────
  const [jobs, setJobs] = useState<MigJobSummary[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [saveJobName, setSaveJobName] = useState('');
  const [saveJobDesc, setSaveJobDesc] = useState('');
  const [savingJob, setSavingJob] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(true);

  // ── Run ───────────────────────────────────────────────────────────────────────
  const [currentRun, setCurrentRun] = useState<MigRun | null>(null);
  const [polling, setPolling] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
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
    void axios.get<{ connections: ConnectionRow[] }>('/api/connections', { headers: authHeaders() })
      .then(r => setConnections(r.data.connections))
      .catch(() => {});
  }, []);

  // ── Source DB loading ─────────────────────────────────────────────────────────
  const loadSrcDbs = useCallback(async (connId: number) => {
    const row = connections.find(c => c.id === connId);
    if (!row) return;
    const isRestore = !!pendingRestoreRef.current;
    setSrcLoadingDbs(true); setSrcDbs([]); setSrcDb(''); setSrcDbError(''); setSrcSchema('');
    setSrcConnected(false); setSrcTables([]);
    if (!isRestore) { setTableMaps([]); setColsCache({}); setSelectedMapId(null); }
    try {
      const { data } = await axios.post<{ databases: string[] }>(
        '/api/schema-designer/databases',
        { type: row.db_type === 'postgres' ? 'postgresql' : 'mysql', host: row.host, port: row.port, username: row.username, password: row.password_enc ?? '' },
        { headers: authHeaders() }
      );
      setSrcDbs(data.databases);
      const def = data.databases.includes(row.database_name) ? row.database_name : data.databases[0] ?? '';
      setSrcDb((isRestore && pendingRestoreRef.current?.sourceMeta.database) || def);
    } catch (err) {
      setSrcDbError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed') : 'Failed');
    } finally { setSrcLoadingDbs(false); }
  }, [connections]);

  useEffect(() => {
    if (srcConnId) void loadSrcDbs(srcConnId);
    else { setSrcDbs([]); setSrcDb(''); setSrcSchema(''); setSrcConnected(false); setSrcTables([]); }
  }, [srcConnId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!srcConnId || !srcDb) { setSrcConnected(false); return; }
    const row = connections.find(c => c.id === srcConnId);
    if (!row) return;
    const conn = connRowToMigConn(row, srcDb);
    setSrcConn(conn);
    setSrcConnecting(true); setSrcError(''); setSrcConnected(false);
    setSrcTables([]);
    if (!pendingRestoreRef.current) { setTableMaps([]); setColsCache({}); setSelectedMapId(null); setSrcSchema(''); }
    void axios.post<{ tables: MigTableInfo[] }>('/api/migv2/tables', conn, { headers: authHeaders() })
      .then(({ data }) => {
        setSrcTables(data.tables);
        setSrcConnected(true);
        if (pendingRestoreRef.current) {
          const job = pendingRestoreRef.current;
          const firstIncluded = job.tables.find(m => m.include);
          setTableMaps(job.tables);
          setSelectedMapId(firstIncluded?.id ?? null);
          setSrcSchema(firstIncluded?.source.schema ?? (data.tables[0]?.schema ?? ''));
          pendingRestoreRef.current = null;
          // Populate colsCache for the selected map so the columns panel doesn't stay in "Loading" state
          if (firstIncluded) {
            const key = `${firstIncluded.source.schema}.${firstIncluded.source.table}`;
            void axios.post<{ columns: MigColumnInfo[] }>(
              '/api/migv2/columns', { conn, tableKey: key }, { headers: authHeaders() }
            ).then(({ data: colData }) => setColsCache(prev => ({ ...prev, [key]: colData.columns })))
             .catch(() => {});
          }
        } else {
          const first = data.tables[0]?.schema;
          if (first) setSrcSchema(first);
        }
      })
      .catch(err => setSrcError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Connection failed') : 'Connection failed'))
      .finally(() => setSrcConnecting(false));
  }, [srcDb]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Target DB loading ─────────────────────────────────────────────────────────
  const loadTgtDbs = useCallback(async (connId: number) => {
    const row = connections.find(c => c.id === connId);
    if (!row) return;
    setTgtLoadingDbs(true); setTgtDbs([]); setTgtDb(''); setTgtDbError('');
    setTgtConnected(false);
    try {
      const { data } = await axios.post<{ databases: string[] }>(
        '/api/schema-designer/databases',
        { type: row.db_type === 'postgres' ? 'postgresql' : 'mysql', host: row.host, port: row.port, username: row.username, password: row.password_enc ?? '' },
        { headers: authHeaders() }
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
    else { setTgtDbs([]); setTgtDb(''); setTgtConnected(false); }
  }, [tgtConnId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!tgtConnId || !tgtDb) { setTgtConnected(false); setTgtSchemas([]); return; }
    const row = connections.find(c => c.id === tgtConnId);
    if (!row) return;
    const conn = connRowToMigConn(row, tgtDb);
    setTgtConn(conn);
    setTgtConnecting(true); setTgtError(''); setTgtConnected(false); setTgtSchemas([]); setTgtTables([]);
    void axios.post<{ tables: MigTableInfo[] }>('/api/migv2/tables', conn, { headers: authHeaders() })
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

  // ── Table toggle ──────────────────────────────────────────────────────────────
  const isTableIncluded = (schema: string, table: string) =>
    tableMaps.some(m => m.source.schema === schema && m.source.table === table && m.include);

  const toggleTable = async (schema: string, table: string) => {
    const existing = tableMaps.find(m => m.source.schema === schema && m.source.table === table);
    if (existing) {
      setTableMaps(prev => prev.map(m =>
        m.source.schema === schema && m.source.table === table ? { ...m, include: !m.include } : m
      ));
      setDirty(true);
      return;
    }
    const key = `${schema}.${table}`;
    const mapId = newId();
    // Create placeholder map immediately so preview fires right away
    setTableMaps(prev => [...prev, {
      id: mapId, include: true,
      source: { schema, table },
      target: { schema: tgtDefaultSchema || '', table: '' },
      columns: [], truncateBeforeMigrate: false,
    }]);
    setSelectedMapId(mapId);
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
        const isSerial = c.isPk && (c.isAutoIncrement || isPkLikeSerial(c.rawType));
        return {
          sourceCol: c.name,
          targetCol: c.name,
          targetType: suggestTargetType(c.rawType, srcConn.type, tgtConn.type),
          nullable: c.nullable,
          defaultValue: c.defaultValue,
          include: true,
          conversion: isSerial ? 'serial_to_uuid' : 'keep',
          fkRef: c.isFk && c.fkRef ? c.fkRef.split('.').slice(0, 2).join('.') : null,
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
        sourceCol: null, targetCol: 'new_column',
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
    ? (colsCache[`${selectedMap.source.schema}.${selectedMap.source.table}`] ?? [])
    : [];

  const tgtColsForSelected = selectedMap
    ? (tgtColsCache[`${selectedMap.target.schema}.${selectedMap.target.table}`] ?? [])
    : [];

  const includedCount = tableMaps.filter(m => m.include).length;
  const canStart = srcConnected && tgtConnected && includedCount > 0 && !polling;

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
      const payload: Partial<MigJob> = {
        id: activeJobId ?? undefined,
        name: saveJobName.trim(), description: saveJobDesc.trim(),
        sourceMeta: { type: srcConn.type, host: srcConn.host, port: srcConn.port, database: srcConn.database, username: srcConn.username },
        targetMeta: { type: tgtConn.type, host: tgtConn.host, port: tgtConn.port, database: tgtConn.database, username: tgtConn.username },
        tables: tableMaps,
      };
      const { data } = await axios.post<{ job: MigJob }>('/api/migv2/jobs', payload, { headers: authHeaders() });
      setActiveJobId(data.job.id);
      setDirty(false); setShowSaveDialog(false);
      await loadJobs();
    } catch { /* ignore */ } finally { setSavingJob(false); }
  };

  const handleLoadJob = async (id: string) => {
    try {
      const { data } = await axios.get<{ job: MigJob }>(`/api/migv2/jobs/${id}`, { headers: authHeaders() });
      const job = data.job;
      setActiveJobId(id);
      setSaveJobName(job.name); setSaveJobDesc(job.description); setDirty(false);

      const srcMatch = connections.find(c =>
        c.host === job.sourceMeta.host && c.username === job.sourceMeta.username &&
        c.db_type === (job.sourceMeta.type === 'postgresql' ? 'postgres' : 'mysql')
      );
      const tgtMatch = connections.find(c =>
        c.host === job.targetMeta.host && c.username === job.targetMeta.username &&
        c.db_type === (job.targetMeta.type === 'postgresql' ? 'postgres' : 'mysql')
      );

      const firstIncluded = job.tables.find(m => m.include);

      // Source: if same connection+db already active, restore directly; otherwise use ref cascade
      const sameSrcConn = srcMatch && srcMatch.id === srcConnId && job.sourceMeta.database === srcDb;
      if (sameSrcConn) {
        setTableMaps(job.tables);
        setSelectedMapId(firstIncluded?.id ?? null);
        if (firstIncluded) setSrcSchema(firstIncluded.source.schema);
      } else {
        pendingRestoreRef.current = job;
        if (srcMatch) setSrcConnId(srcMatch.id);
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

  const handleExportJobMd = () => {
    if (tableMaps.length === 0) return;
    const jobName = saveJobName || 'Migration Job';
    const lines: string[] = [
      `# ${jobName}`,
      saveJobDesc ? `\n${saveJobDesc}` : '',
      `\n_Generated: ${new Date().toISOString()}_`,
      '',
      '## Source',
      `- **Type**: ${srcConn.type}`,
      `- **Host**: ${srcConn.host}:${srcConn.port}`,
      `- **Database**: ${srcConn.database}`,
      `- **Username**: ${srcConn.username}`,
      '',
      '## Target',
      `- **Type**: ${tgtConn.type}`,
      `- **Host**: ${tgtConn.host}:${tgtConn.port}`,
      `- **Database**: ${tgtConn.database}`,
      `- **Username**: ${tgtConn.username}`,
      '',
      `## Table Mappings (${tableMaps.filter(m => m.include).length} of ${tableMaps.length} included)`,
      '',
    ];
    tableMaps.forEach((map, i) => {
      const status = map.include ? '✓' : '✗';
      const tgtTable = map.target.table ? `${map.target.schema}.${map.target.table}` : '(unassigned)';
      lines.push(`### ${i + 1}. \`${map.source.schema}.${map.source.table}\` → \`${tgtTable}\` [${status}]`);
      if (map.truncateBeforeMigrate) lines.push('> ⚠ Truncate target before migrate');
      lines.push('');
      if (map.columns.length > 0) {
        lines.push('| Source Column | Source Type | Target Column | Target Type | Conversion | Include |');
        lines.push('|---|---|---|---|---|:---:|');
        const srcKey = `${map.source.schema}.${map.source.table}`;
        map.columns.forEach(col => {
          const srcType = colsCache[srcKey]?.find(c => c.name === col.sourceCol)?.rawType ?? '—';
          lines.push(`| ${col.sourceCol ?? '*(new)*'} | ${srcType} | ${col.targetCol || '—'} | ${col.targetType} | ${col.conversion} | ${col.include ? '✓' : '✗'} |`);
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
    a.download = `${jobName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDeleteJob = async (id: string) => {
    try {
      await axios.delete(`/api/migv2/jobs/${id}`, { headers: authHeaders() });
      await loadJobs();
      if (activeJobId === id) { setActiveJobId(null); setSaveJobName(''); setSaveJobDesc(''); }
    } catch { /* ignore */ }
  };

  // ── Run ───────────────────────────────────────────────────────────────────────
  const startMigration = async () => {
    const included = tableMaps.filter(t => t.include);
    if (!included.length) return;
    setPolling(true);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/start', {
        source: srcConn, target: tgtConn, tables: included,
        jobId: activeJobId, jobName: saveJobName || 'Migration',
      }, { headers: authHeaders() });
      setCurrentRun(data.run);
      if (data.run.status === 'running' || data.run.status === 'pending') scheduleAdvance(data.run.id);
      else setPolling(false);
    } catch { setPolling(false); }
  };

  const scheduleAdvance = (runId: string) => setTimeout(() => void advanceMigration(runId), 1000);

  const advanceMigration = async (runId: string) => {
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/advance',
        { runId, source: srcConn, target: tgtConn }, { headers: authHeaders() });
      setCurrentRun(data.run);
      if (data.run.status === 'running') scheduleAdvance(runId);
      else setPolling(false);
    } catch { setPolling(false); }
  };

  const handleRollback = async () => {
    if (!currentRun) return;
    setRollingBack(true);
    try {
      const { data } = await axios.post<{ run: MigRun }>('/api/migv2/run/rollback',
        { runId: currentRun.id, target: tgtConn }, { headers: authHeaders() });
      setCurrentRun(data.run);
    } catch { /* ignore */ } finally { setRollingBack(false); }
  };

  const handleExportMd = () => {
    if (!currentRun) return;
    void (async () => {
      const res = await fetch(`/api/migv2/export-md?id=${currentRun.id}`, { headers: authHeaders() });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `migration-${currentRun.id.slice(0, 8)}.md`;
      a.click(); URL.revokeObjectURL(url);
    })();
  };

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentRun?.logs.length]);

  // ── Auto-fetch inline records on table selection ──────────────────────────────
  useEffect(() => {
    if (!selectedMap || !srcConnected) {
      setSrcPreviewCols([]); setSrcPreviewRows([]); return;
    }
    setSrcPreviewLoading(true); setSrcPreviewCols([]); setSrcPreviewRows([]);
    void axios.post<{ columns: string[]; rows: Record<string, unknown>[] }>(
      '/api/migv2/preview',
      { conn: srcConn, tableKey: `${selectedMap.source.schema}.${selectedMap.source.table}` },
      { headers: authHeaders() }
    ).then(({ data }) => { setSrcPreviewCols(data.columns); setSrcPreviewRows(data.rows); })
     .catch(() => {}).finally(() => setSrcPreviewLoading(false));
  }, [selectedMapId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedMap || !tgtConnected || !selectedMap.target.table) {
      setTgtPreviewCols([]); setTgtPreviewRows([]); return;
    }
    const tgtKey = `${selectedMap.target.schema}.${selectedMap.target.table}`;
    // Fetch target columns if not cached
    if (!tgtColsCache[tgtKey]) {
      void axios.post<{ columns: MigColumnInfo[] }>(
        '/api/migv2/columns', { conn: tgtConn, tableKey: tgtKey }, { headers: authHeaders() }
      ).then(({ data }) => setTgtColsCache(prev => ({ ...prev, [tgtKey]: data.columns })))
       .catch(() => {});
    }
    // Fetch target preview
    setTgtPreviewLoading(true); setTgtPreviewCols([]); setTgtPreviewRows([]);
    void axios.post<{ columns: string[]; rows: Record<string, unknown>[] }>(
      '/api/migv2/preview', { conn: tgtConn, tableKey: tgtKey }, { headers: authHeaders() }
    ).then(({ data }) => { setTgtPreviewCols(data.columns); setTgtPreviewRows(data.rows); })
     .catch(() => {}).finally(() => setTgtPreviewLoading(false));
  }, [selectedMapId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Select target table for current mapping ───────────────────────────────────
  const selectTargetTable = async (schema: string, table: string) => {
    if (!selectedMapId) return;
    updateTableMap(selectedMapId, { target: { schema, table } });
    const key = `${schema}.${table}`;
    if (tgtConnected) {
      // Fetch cols if not cached
      if (!tgtColsCache[key]) {
        void axios.post<{ columns: MigColumnInfo[] }>(
          '/api/migv2/columns', { conn: tgtConn, tableKey: key }, { headers: authHeaders() }
        ).then(({ data }) => setTgtColsCache(prev => ({ ...prev, [key]: data.columns })))
         .catch(() => {});
      }
      // Refresh preview
      setTgtPreviewLoading(true); setTgtPreviewCols([]); setTgtPreviewRows([]);
      void axios.post<{ columns: string[]; rows: Record<string, unknown>[] }>(
        '/api/migv2/preview', { conn: tgtConn, tableKey: key }, { headers: authHeaders() }
      ).then(({ data }) => { setTgtPreviewCols(data.columns); setTgtPreviewRows(data.rows); })
       .catch(() => {}).finally(() => setTgtPreviewLoading(false));
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <>
      <Head><title>Migration</title></Head>
      <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 overflow-hidden">

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
            <button onClick={() => { setSaveJobName(saveJobName || 'New Job'); setShowSaveDialog(true); }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors">
              <Save size={12} /> Save Job
            </button>
            <button onClick={handleExportJobMd} disabled={tableMaps.length === 0}
              title="Export mapping configuration as Markdown"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors">
              <FileText size={12} /> Export MD
            </button>
            <button onClick={() => void startMigration()} disabled={!canStart}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-blue-500 text-blue-600 dark:text-blue-400 bg-transparent hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-50 transition-colors">
              {polling ? <><Loader2 size={12} className="animate-spin" /> Running…</> : <><Play size={12} /> Migrate</>}
            </button>
            <div className="h-8 w-px bg-gray-200 dark:bg-slate-700" />
            <nav className="flex items-center gap-1 text-sm">
              <Link href="/" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Home</Link>
              <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
              <span className="px-3 py-1 rounded-lg bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold">Migration</span>
            </nav>
          </div>
        </header>

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* Source + Target resizable */}
          <PanelGroup orientation="horizontal" className="flex-1 min-w-0 h-full">

            {/* ── SOURCE PANEL ─────────────────────────────────────────── */}
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
                      onChange={id => setSrcConnId(id)} onNew={() => void router.push('/connections')} accent="blue" />
                    <div className="flex items-center gap-1.5">
                      {srcConnId && (srcLoadingDbs
                        ? <Loader2 size={11} className="animate-spin text-gray-400" />
                        : (
                          <select value={srcDb} onChange={e => setSrcDb(e.target.value)}
                            className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-blue-400 cursor-pointer font-mono">
                            {!srcDb && <option value="">— select db —</option>}
                            {srcDbs.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
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
                  <div className="relative">
                    <Search size={10} className="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input value={srcSearch} onChange={e => setSrcSearch(e.target.value)}
                      placeholder="Filter tables…"
                      className="w-full pl-6 pr-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  </div>
                </div>

                {/* Resizable: tables / columns */}
                <PanelGroup orientation="vertical" className="flex-1 min-h-0">
                  <Panel defaultSize={50} minSize={15}>
                    <div className="h-full overflow-y-auto panel-scroll">
                      {!srcConnected ? (
                        <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                          <Database size={28} className="text-gray-200 dark:text-slate-700" />
                          <p className="text-[11px] text-gray-400 dark:text-slate-500">Select a connection and database</p>
                        </div>
                      ) : filteredSrcTables.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">No tables found</div>
                      ) : filteredSrcTables.map(t => {
                        const included = isTableIncluded(t.schema, t.name);
                        const mapEntry = tableMaps.find(m => m.source.schema === t.schema && m.source.table === t.name);
                        const isSelected = mapEntry?.id === selectedMapId;
                        return (
                          <div key={`${t.schema}.${t.name}`}
                            className={`group flex items-center gap-2 px-3 py-1.5 cursor-pointer border-b border-gray-50 dark:border-slate-800/40 ${isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}
                            onClick={() => {
                              if (mapEntry) setSelectedMapId(mapEntry.id);
                              else void toggleTable(t.schema, t.name);
                            }}>
                            <input type="checkbox" checked={included}
                              onChange={e => { e.stopPropagation(); void toggleTable(t.schema, t.name); }}
                              onClick={e => e.stopPropagation()}
                              className="shrink-0 accent-blue-500" />
                            <Table2 size={10} className="text-gray-400 shrink-0" />
                            <span className={`text-[11px] font-mono flex-1 truncate ${isSelected ? 'text-blue-700 dark:text-blue-400 font-medium' : 'text-gray-700 dark:text-slate-300'}`}>
                              {t.name}
                            </span>
                            <span className="text-[10px] text-gray-400 shrink-0">{t.rowCount.toLocaleString()}</span>
                          </div>
                        );
                      })}
                    </div>
                  </Panel>

                  <PanelResizeHandle className="h-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-row-resize transition-colors" />

                  <Panel defaultSize={50} minSize={15}>
                    <div className="flex flex-col h-full overflow-hidden">
                      {/* Columns header */}
                      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60">
                        <Layers size={10} className="text-gray-400 shrink-0" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 flex-1">Columns</span>
                        {selectedMap && (
                          <span className="text-[10px] text-gray-400 font-mono truncate max-w-[120px]">
                            {selectedMap.source.schema}.{selectedMap.source.table}
                          </span>
                        )}
                      </div>
                      <div className="flex-[2] min-h-0 overflow-y-auto panel-scroll">
                        {!selectedMap ? (
                          <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">
                            Select a table to view columns
                          </div>
                        ) : srcColsForSelected.length === 0 ? (
                          <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 animate-pulse">
                            Loading columns…
                          </div>
                        ) : srcColsForSelected.map(col => (
                          <div key={col.name} className="flex items-center gap-2 px-3 py-1.5 border-b border-gray-50 dark:border-slate-800/40 hover:bg-gray-50 dark:hover:bg-slate-800/20">
                            <span className="text-[11px] font-mono text-gray-700 dark:text-slate-300 flex-1 truncate">{col.name}</span>
                            <span className="text-[10px] font-mono text-gray-400 dark:text-slate-500 shrink-0">{col.rawType}</span>
                            <div className="flex items-center gap-0.5 shrink-0">
                              {col.isPk && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 font-semibold">PK</span>}
                              {col.isFk && <span className="text-[9px] px-1 py-0.5 rounded bg-blue-100 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 font-semibold">FK</span>}
                              {!col.nullable && <span className="text-[9px] px-1 py-0.5 rounded bg-rose-100 dark:bg-rose-950/40 text-rose-500 dark:text-rose-400 font-semibold">NN</span>}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Records header */}
                      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60">
                        <Database size={10} className="text-gray-400 shrink-0" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 flex-1">Records</span>
                        {srcPreviewLoading && <Loader2 size={10} className="animate-spin text-gray-400" />}
                        {!srcPreviewLoading && srcPreviewRows.length > 0 && (
                          <span className="text-[10px] text-gray-400">{srcPreviewRows.length}</span>
                        )}
                      </div>
                      <div className="flex-[3] min-h-0 overflow-auto panel-scroll">
                        {srcPreviewLoading ? (
                          <div className="flex items-center justify-center h-12 gap-1.5 text-[11px] text-gray-400">
                            <Loader2 size={11} className="animate-spin" /> Loading…
                          </div>
                        ) : srcPreviewCols.length === 0 ? (
                          <div className="flex items-center justify-center h-12 text-[11px] text-gray-400 dark:text-slate-500 italic">
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
              </div>
            </Panel>

            <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors" />

            {/* ── TARGET PANEL ─────────────────────────────────────────── */}
            <Panel defaultSize={50} minSize={22}>
              <div className="flex flex-col h-full overflow-hidden bg-white dark:bg-slate-900">

                {/* Target header */}
                <div className="shrink-0 p-3 border-b border-gray-200 dark:border-slate-800 bg-violet-50/50 dark:bg-violet-950/10">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full bg-violet-500 shrink-0" />
                    <span className="text-[11px] font-bold uppercase tracking-wider text-violet-600 dark:text-violet-400 flex-1">Target</span>
                    {tgtConnecting && <Loader2 size={10} className="animate-spin text-gray-400" />}
                    {tgtConnected && !tgtConnecting && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-emerald-600 dark:text-emerald-400 font-medium">
                        <Check size={9} /> Connected
                      </span>
                    )}
                    {tgtError && !tgtConnecting && (
                      <span className="text-[10px] text-rose-500 truncate max-w-[100px]" title={tgtError}>{tgtError}</span>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <ConnSelect connections={connections} value={tgtConnId}
                      onChange={id => setTgtConnId(id)} onNew={() => void router.push('/connections')} accent="violet" />
                    <div className="flex items-center gap-1.5">
                      {tgtConnId && (tgtLoadingDbs
                        ? <Loader2 size={11} className="animate-spin text-gray-400" />
                        : (
                          <select value={tgtDb} onChange={e => setTgtDb(e.target.value)}
                            className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-violet-400 cursor-pointer font-mono">
                            {!tgtDb && <option value="">— select db —</option>}
                            {tgtDbs.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                        )
                      )}
                      {tgtConnected && tgtSchemas.length > 0 && (
                        <select value={tgtDefaultSchema} onChange={e => setTgtDefaultSchema(e.target.value)}
                          title="Default target schema"
                          className="w-24 shrink-0 px-2 py-1 text-[11px] rounded border border-violet-200 dark:border-violet-800 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 focus:outline-none cursor-pointer font-mono">
                          {tgtSchemas.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      )}
                    </div>
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

                {/* Resizable: tables / column mapping */}
                <PanelGroup orientation="vertical" className="flex-1 min-h-0">
                  <Panel defaultSize={50} minSize={15}>
                    <div className="h-full overflow-y-auto panel-scroll">
                      {!tgtConnected ? (
                        <div className="flex flex-col items-center justify-center h-full gap-2 px-4 text-center">
                          <Database size={28} className="text-gray-200 dark:text-slate-700" />
                          <p className="text-[11px] text-gray-400 dark:text-slate-500">Select a connection and database</p>
                        </div>
                      ) : filteredTgtTables.length === 0 ? (
                        <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">No tables found</div>
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
                  </Panel>

                  <PanelResizeHandle className="h-px bg-gray-200 dark:bg-slate-700 hover:bg-violet-400 dark:hover:bg-violet-500 cursor-row-resize transition-colors" />

                  <Panel defaultSize={50} minSize={15}>
                    <div className="flex flex-col h-full overflow-hidden">
                      {/* Separator: Column Mapping */}
                      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60">
                        <Layers size={10} className="text-gray-400 shrink-0" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 flex-1">Column Mapping</span>
                        {selectedMap?.target.table && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-gray-400 dark:text-slate-500 truncate max-w-[160px]">
                              {selectedMap.target.schema}.{selectedMap.target.table}
                            </span>
                            <label className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-slate-400">
                              <input type="checkbox" checked={selectedMap.truncateBeforeMigrate}
                                onChange={e => updateTableMap(selectedMap.id, { truncateBeforeMigrate: e.target.checked })}
                                className="accent-rose-500" />
                              Truncate
                            </label>
                          </div>
                        )}
                      </div>

                      {/* Column mapping editor */}
                      <div className="flex-[2] min-h-0 overflow-auto panel-scroll">
                  {!selectedMap ? (
                    <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">
                      Select a source table first
                    </div>
                  ) : !selectedMap.target.table ? (
                    <div className="flex items-center justify-center h-full text-[11px] text-gray-400 dark:text-slate-500 italic">
                      Select a target table above to map columns
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
                            {['Src Col', 'Src Type', '', 'Tgt Col', 'Tgt Type', 'Conv', 'FK Ref', '✓', ''].map((h, i) => (
                              <th key={i} className="text-left px-2 py-1.5 text-[10px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                          {selectedMap.columns.map((col, idx) => (
                            <tr key={idx} className={`${col.include ? '' : 'opacity-40'} hover:bg-gray-50 dark:hover:bg-slate-800/30`}>
                              <td className="px-2 py-1.5 font-mono text-[11px] text-gray-700 dark:text-slate-300 max-w-[80px] truncate">
                                {col.sourceCol ?? <span className="italic text-gray-400">*(new)*</span>}
                              </td>
                              <td className="px-2 py-1.5 font-mono text-[10px] text-gray-400 dark:text-slate-500">
                                {colsCache[`${selectedMap.source.schema}.${selectedMap.source.table}`]?.find(c => c.name === col.sourceCol)?.rawType ?? '—'}
                              </td>
                              <td className="px-1 text-[10px] text-gray-300">→</td>
                              <td className="px-2 py-1">
                                {tgtColsForSelected.length > 0 ? (
                                  <select value={col.targetCol}
                                    onChange={e => {
                                      const tgtCol = tgtColsForSelected.find(c => c.name === e.target.value);
                                      updateColumn(selectedMap.id, idx, {
                                        targetCol: e.target.value,
                                        ...(tgtCol ? { targetType: tgtCol.rawType.toUpperCase() } : {}),
                                      });
                                    }}
                                    className="max-w-[110px] px-1.5 py-0.5 text-[11px] rounded border border-violet-200 dark:border-violet-800 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono focus:outline-none focus:border-violet-400">
                                    {!tgtColsForSelected.find(c => c.name === col.targetCol) && col.targetCol && (
                                      <option value={col.targetCol}>{col.targetCol}</option>
                                    )}
                                    <option value="">— none —</option>
                                    {tgtColsForSelected.map(c => (
                                      <option key={c.name} value={c.name}>{c.name}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <input value={col.targetCol}
                                    onChange={e => updateColumn(selectedMap.id, idx, { targetCol: e.target.value })}
                                    className="w-24 px-1.5 py-0.5 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono" />
                                )}
                              </td>
                              <td className="px-2 py-1">
                                <input value={col.targetType}
                                  onChange={e => updateColumn(selectedMap.id, idx, { targetType: e.target.value })}
                                  className="w-24 px-1.5 py-0.5 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono uppercase" />
                              </td>
                              <td className="px-2 py-1">
                                <select value={col.conversion}
                                  onChange={e => {
                                    const conv = e.target.value as IdConversion;
                                    const targetType = conv === 'serial_to_uuid'
                                      ? (tgtConn.type === 'postgresql' ? 'UUID' : 'VARCHAR(36)')
                                      : col.targetType;
                                    updateColumn(selectedMap.id, idx, { conversion: conv, targetType });
                                  }}
                                  className="text-[10px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 py-0.5 px-1">
                                  <option value="keep">keep</option>
                                  <option value="serial_to_uuid">→UUID</option>
                                </select>
                              </td>
                              <td className="px-2 py-1">
                                <input value={col.fkRef ?? ''}
                                  onChange={e => updateColumn(selectedMap.id, idx, { fkRef: e.target.value || null })}
                                  placeholder="schema.table"
                                  disabled={col.conversion !== 'serial_to_uuid' && !col.fkRef}
                                  className="w-24 px-1.5 py-0.5 text-[10px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 font-mono disabled:opacity-30" />
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
                          ))}
                        </tbody>
                      </table>
                      <div className="px-3 py-2 border-t border-gray-100 dark:border-slate-800">
                        <button onClick={() => addTargetOnlyColumn(selectedMap.id)}
                          className="inline-flex items-center gap-1 text-[11px] text-violet-600 dark:text-violet-400 hover:text-violet-700 transition-colors">
                          <Plus size={11} /> Add target-only column
                        </button>
                      </div>
                    </div>
                  )}
                      </div>

                      {/* Records header */}
                      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-t border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-900/60">
                        <Database size={10} className="text-violet-400 shrink-0" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 flex-1">Target Records</span>
                        {tgtPreviewLoading && <Loader2 size={10} className="animate-spin text-gray-400" />}
                        {!tgtPreviewLoading && tgtPreviewRows.length > 0 && (
                          <span className="text-[10px] text-gray-400">{tgtPreviewRows.length}</span>
                        )}
                      </div>
                      <div className="flex-[3] min-h-0 overflow-auto panel-scroll">
                        {tgtPreviewLoading ? (
                          <div className="flex items-center justify-center h-12 gap-1.5 text-[11px] text-gray-400">
                            <Loader2 size={11} className="animate-spin" /> Loading…
                          </div>
                        ) : tgtPreviewCols.length === 0 ? (
                          <div className="flex items-center justify-center h-12 text-[11px] text-gray-400 dark:text-slate-500 italic">
                            {selectedMap ? 'No records' : 'Select a table'}
                          </div>
                        ) : (
                          <table className="text-xs border-collapse">
                            <thead className="sticky top-0 z-10">
                              <tr className="bg-gray-50 dark:bg-slate-800">
                                <th className="px-2 py-1 text-left text-[9px] font-semibold text-gray-400 dark:text-slate-500 border-b border-gray-200 dark:border-slate-700 w-7">#</th>
                                {tgtPreviewCols.map(col => (
                                  <th key={col} className="px-2 py-1 text-left text-[9px] font-semibold text-gray-600 dark:text-slate-300 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap font-mono">
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                              {tgtPreviewRows.map((row, i) => (
                                <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                                  <td className="px-2 py-1 text-[9px] text-gray-300 dark:text-slate-600 font-mono">{i + 1}</td>
                                  {tgtPreviewCols.map(col => {
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
                      <p className="text-[11px] font-medium text-gray-800 dark:text-slate-200 flex-1 truncate">{job.name}</p>
                      <span className="text-[10px] text-gray-400 shrink-0">v{job.version}</span>
                    </div>
                    {job.description && (
                      <p className="text-[10px] text-gray-400 dark:text-slate-500 truncate mb-1">{job.description}</p>
                    )}
                    <p className="text-[10px] text-gray-400 mb-1.5">{job.tableCount} tables · {new Date(job.updatedAt).toLocaleDateString()}</p>
                    <div className="flex items-center gap-1">
                      {activeJobId === job.id && (
                        <span className="text-[9px] px-1 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-medium">active</span>
                      )}
                      <button onClick={() => void handleLoadJob(job.id)}
                        className="ml-auto px-2 py-0.5 rounded text-[10px] font-medium bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-600 transition-colors">
                        Load
                      </button>
                      <button onClick={() => void handleDeleteJob(job.id)}
                        className="p-1 rounded text-gray-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
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
                <button onClick={handleRollback} disabled={rollingBack}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 hover:bg-amber-100 disabled:opacity-50 transition-colors">
                  {rollingBack ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />} Rollback
                </button>
              )}
              <button onClick={handleExportMd}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-50 transition-colors">
                <FileText size={11} /> Export MD
              </button>
              <button onClick={() => setCurrentRun(null)}
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
                <X size={13} />
              </button>
            </div>
            <div className="flex flex-1 min-h-0">
              {/* Per-table progress */}
              <div className="shrink-0 w-56 border-r border-gray-100 dark:border-slate-800 overflow-auto panel-scroll p-2 space-y-2">
                {currentRun.tableStates.map(ts => {
                  const pct = ts.rowsSource > 0 ? Math.min(100, Math.round(ts.rowsMigrated / ts.rowsSource * 100)) : 0;
                  return (
                    <div key={ts.id}>
                      <div className="flex items-center gap-1 mb-0.5">
                        <span className="text-[10px] font-mono text-gray-700 dark:text-slate-300 flex-1 truncate">{ts.sourceKey}</span>
                        <StatusBadge status={ts.status} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <div className="flex-1 h-1 bg-gray-100 dark:bg-slate-800 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-500 ${ts.status === 'completed' ? 'bg-emerald-500' : ts.status === 'failed' ? 'bg-rose-500' : ts.status === 'rolled_back' ? 'bg-amber-500' : 'bg-blue-500'}`}
                            style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-[10px] text-gray-400 shrink-0">{pct}%</span>
                      </div>
                      {ts.error && <p className="text-[10px] text-rose-500 mt-0.5 truncate">{ts.error}</p>}
                    </div>
                  );
                })}
              </div>
              {/* Live logs */}
              <div className="flex-1 overflow-auto panel-scroll bg-gray-900 dark:bg-black p-3 font-mono text-[11px] text-gray-300">
                {currentRun.logs.map((line, i) => (
                  <div key={i} className={`leading-5 ${line.includes('ERROR') ? 'text-rose-400' : line.includes('completed') ? 'text-emerald-400' : line.includes('ROLLBACK') ? 'text-amber-400' : ''}`}>
                    {line}
                  </div>
                ))}
                <div ref={logsEndRef} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Save Job dialog */}
      {showSaveDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-800 rounded-2xl border border-gray-200 dark:border-slate-700 p-6 w-full max-w-sm shadow-xl">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-slate-200 mb-4">Save Migration Job</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Job name *</label>
                <input value={saveJobName} onChange={e => setSaveJobName(e.target.value)} placeholder="e.g. Dev → Staging"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Description</label>
                <input value={saveJobDesc} onChange={e => setSaveJobDesc(e.target.value)} placeholder="Optional"
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
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
