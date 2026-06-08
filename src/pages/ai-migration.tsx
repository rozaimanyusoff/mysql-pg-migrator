import Head from 'next/head';
import { useState, useEffect, useRef } from 'react';
import {
  Brain, Loader2, Play, RefreshCw, AlertTriangle,
  CheckCircle2, ChevronDown, Zap, Bug, Columns,
  ArrowRight, Database, Info, Sparkles, ExternalLink,
} from 'lucide-react';
import type { ConnectionRow } from './api/connections/index';
import type { MigTableInfo } from './api/migv2/tables';
import type { SuggestColumnsResponse, ColumnSuggestion } from './api/ai-migration/suggest-columns';
import type { ExplainResponse } from './api/ai-migration/explain';

interface ExplorerConn {
  type: 'postgresql' | 'mysql';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

function connFromRow(row: ConnectionRow): ExplorerConn {
  return {
    type: row.db_type === 'postgres' ? 'postgresql' : 'mysql',
    host: row.host,
    port: row.port,
    database: row.database_name,
    username: row.username,
    password: row.password_enc ?? '',
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

function DbSelect({
  value, onChange, options, loading, placeholder,
}: {
  value: string; onChange: (v: string) => void;
  options: string[]; loading: boolean; placeholder: string;
}) {
  if (loading) {
    return (
      <div className="w-full flex items-center justify-center h-9 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3">
        <Loader2 size={13} className="animate-spin text-gray-400" />
      </div>
    );
  }
  if (options.length > 0) {
    return (
      <div className="relative w-full">
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="w-full appearance-none bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 pr-8 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {options.map(o => <option key={o} value={o}>{o}</option>)}
        </select>
        <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
      </div>
    );
  }
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
    />
  );
}

// ── Shared: Connection + DB/Schema Panel ──────────────────────────────────────

function ConnPanel({
  label,
  connections,
  filter,
  connId,
  onConnChange,
  dbValue,
  onDbChange,
  schemaValue,
  onSchemaChange,
}: {
  label: string;
  connections: ConnectionRow[];
  filter: 'mysql' | 'postgres';
  connId: number | null;
  onConnChange: (id: number | null) => void;
  dbValue: string;
  onDbChange: (v: string) => void;
  schemaValue?: string;       // PG only
  onSchemaChange?: (v: string) => void; // PG only
}) {
  const filtered = connections.filter(c => c.db_type === filter);
  const conn = filtered.find(c => c.id === connId) ?? null;
  const [dbOptions, setDbOptions] = useState<string[]>([]);
  const [schemaOptions, setSchemaOptions] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [loadingSchemas, setLoadingSchemas] = useState(false);

  // Load databases when connection changes
  useEffect(() => {
    if (!conn) { setDbOptions([]); setSchemaOptions([]); return; }
    setLoadingDbs(true);
    fetch('/api/ai-migration/databases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connFromRow(conn)),
    })
      .then(r => r.json())
      .then(data => {
        const list: string[] = data.databases ?? [];
        setDbOptions(list);
        if (list.length > 0) {
          const def = conn.database_name;
          const pick = list.includes(def) ? def : list[0];
          onDbChange(pick);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingDbs(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId]);

  // For PG: load schemas when selected database changes
  useEffect(() => {
    if (filter !== 'postgres' || !conn || !dbValue) { setSchemaOptions([]); return; }
    setLoadingSchemas(true);
    fetch('/api/ai-migration/schemas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conn: connFromRow(conn), database: dbValue }),
    })
      .then(r => r.json())
      .then(data => {
        const list: string[] = data.schemas ?? [];
        setSchemaOptions(list);
        if (list.length > 0 && onSchemaChange) {
          const def = schemaValue && list.includes(schemaValue) ? schemaValue : (list.includes('public') ? 'public' : list[0]);
          onSchemaChange(def);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingSchemas(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, dbValue, filter]);

  return (
    <div className="flex-1 min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-slate-500 mb-1.5">{label}</p>
      <div className="flex gap-2">
        {/* Connection selector */}
        <div className="flex-1 relative min-w-0">
          <select
            value={connId ?? ''}
            onChange={e => {
              onConnChange(e.target.value ? Number(e.target.value) : null);
              onDbChange('');
              onSchemaChange?.('');
            }}
            className="w-full appearance-none bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 pr-8 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 truncate"
          >
            <option value="">Select connection…</option>
            {filtered.map(c => (
              <option key={c.id} value={c.id}>{c.label} — {c.host}/{c.database_name}</option>
            ))}
          </select>
          <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        </div>

        {/* Database selector */}
        {conn && (
          <div className="w-32 shrink-0">
            <DbSelect
              value={dbValue}
              onChange={v => { onDbChange(v); onSchemaChange?.(''); }}
              options={dbOptions}
              loading={loadingDbs}
              placeholder="database"
            />
          </div>
        )}

        {/* Schema selector — PG only */}
        {conn && filter === 'postgres' && onSchemaChange && (
          <div className="w-28 shrink-0">
            <DbSelect
              value={schemaValue ?? ''}
              onChange={onSchemaChange}
              options={schemaOptions}
              loading={loadingSchemas}
              placeholder="schema"
            />
          </div>
        )}
      </div>

      {conn && dbValue && (
        <p className="mt-1 text-[11px] text-gray-400 dark:text-slate-500">
          {conn.host}:{conn.port} / <span className="font-medium text-gray-600 dark:text-slate-300">{dbValue}</span>
          {filter === 'postgres' && schemaValue && (
            <span> / <span className="font-medium text-blue-600 dark:text-blue-400">{schemaValue}</span></span>
          )}
        </p>
      )}
    </div>
  );
}

// ── Tab: Generate Job ──────────────────────────────────────────────────────────

function GenerateJobTab({
  sourceConn, sourceDb,
  targetConn, targetDb, targetSchema,
}: {
  sourceConn: ConnectionRow | null; sourceDb: string;
  targetConn: ConnectionRow | null; targetDb: string; targetSchema: string;
}) {
  const defaultName = () =>
    `${sourceDb || 'source'} → ${targetDb || 'target'}${targetSchema ? '.' + targetSchema : ''} (${new Date().toLocaleDateString('en-GB')})`;

  const [jobName, setJobName] = useState('');
  const [tables, setTables] = useState<MigTableInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingTables, setLoadingTables] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ jobId: string; jobName: string; tableCount: number } | null>(null);

  useEffect(() => {
    setTables([]); setSelected(new Set()); setResult(null); setError('');
    setJobName(defaultName());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceConn?.id, sourceDb, targetConn?.id, targetDb, targetSchema]);

  function buildSourceConn() {
    if (!sourceConn) return null;
    return { ...connFromRow(sourceConn), database: sourceDb || sourceConn.database_name };
  }
  function buildTargetConn() {
    if (!targetConn) return null;
    return { ...connFromRow(targetConn), database: targetDb || targetConn.database_name };
  }

  async function loadTables() {
    const ec = buildSourceConn();
    if (!ec) return;
    setLoadingTables(true); setError(''); setTables([]); setSelected(new Set());
    try {
      const res = await fetch('/api/migv2/tables', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ec),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load tables');
      const list: MigTableInfo[] = data.tables ?? [];
      setTables(list);
      setSelected(new Set(list.map(t => `${t.schema}.${t.name}`)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingTables(false);
    }
  }

  function toggleTable(key: string) {
    setSelected(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  }
  function toggleAll() {
    setSelected(selected.size === tables.length ? new Set() : new Set(tables.map(t => `${t.schema}.${t.name}`)));
  }

  async function generate() {
    const sc = buildSourceConn();
    const tc = buildTargetConn();
    if (!sc || !tc || !jobName.trim() || selected.size === 0) return;

    setGenerating(true); setStatusMsg(''); setError(''); setResult(null);

    const tableList = tables
      .filter(t => selected.has(`${t.schema}.${t.name}`))
      .map(t => ({ schema: t.schema, name: t.name, rowCount: t.rowCount }));

    try {
      const res = await fetch('/api/ai-migration/generate-job', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceConn: sc, sourceDb,
          targetConn: tc, targetDb, targetSchema,
          jobName, tables: tableList,
        }),
      });

      if (!res.ok || !res.body) throw new Error('Failed to start generation');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const lines = part.split('\n');
          let evtType = ''; let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
          }
          if (!dataStr) continue;
          try {
            const payload = JSON.parse(dataStr);
            if (evtType === 'status') setStatusMsg(payload.message ?? '');
            else if (evtType === 'done') { setResult(payload); setStatusMsg(''); }
            else if (evtType === 'error') { setError(payload.message ?? 'Unknown error'); setStatusMsg(''); }
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  const ready = !!sourceConn && !!sourceDb && !!targetConn && !!targetDb && !!targetSchema;

  return (
    <div className="space-y-5">
      {/* Info banner */}
      <div className="flex items-start gap-3 p-3.5 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
        <Info size={15} className="text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
        <p className="text-xs text-blue-700 dark:text-blue-400 leading-relaxed">
          AI will scan your MySQL schema and generate a complete migration job — table order, column type mappings, and conversion settings — ready to run in the <span className="font-semibold">Migration</span> module.
        </p>
      </div>

      {!ready && (
        <div className="p-4 rounded-xl border-2 border-dashed border-gray-200 dark:border-slate-700 text-center text-sm text-gray-400 dark:text-slate-500">
          Select source and target connections above to get started.
        </div>
      )}

      {ready && (
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
          {/* Left: controls */}
          <div className="space-y-3">
            {/* Job name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1.5">Job Name</label>
              <input
                value={jobName}
                onChange={e => setJobName(e.target.value)}
                placeholder="Migration job name…"
                className="w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Load tables */}
            <button
              onClick={loadTables}
              disabled={loadingTables}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loadingTables ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              Load Tables from Source
            </button>

            {/* Table list */}
            {tables.length > 0 && (
              <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-700">
                  <span className="text-xs font-medium text-gray-600 dark:text-slate-400">
                    {selected.size} / {tables.length} selected
                  </span>
                  <button onClick={toggleAll} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                    {selected.size === tables.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>
                <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-800">
                  {tables.map(t => {
                    const key = `${t.schema}.${t.name}`;
                    return (
                      <label key={key} className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/40 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected.has(key)}
                          onChange={() => toggleTable(key)}
                          className="rounded border-gray-300 dark:border-slate-600 text-blue-600"
                        />
                        <span className="text-xs text-gray-700 dark:text-slate-300 flex-1 truncate">{t.name}</span>
                        <span className="text-[10px] text-gray-400 dark:text-slate-500 shrink-0">{t.rowCount.toLocaleString()}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Generate button */}
            {tables.length > 0 && (
              <button
                onClick={generate}
                disabled={generating || selected.size === 0 || !jobName.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                {generating ? 'Generating…' : `Generate Job (${selected.size} tables)`}
              </button>
            )}

            {error && (
              <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-400">
                {error}
              </div>
            )}
          </div>

          {/* Right: status + result */}
          <div className="flex flex-col gap-4">
            {statusMsg && (
              <div className="flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
                <Loader2 size={12} className="animate-spin shrink-0" />
                {statusMsg}
              </div>
            )}

            {result ? (
              <div className="p-6 rounded-2xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 space-y-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-green-100 dark:bg-green-900/40 flex items-center justify-center">
                    <CheckCircle2 size={22} className="text-green-600 dark:text-green-400" />
                  </div>
                  <div>
                    <p className="font-semibold text-green-800 dark:text-green-300">Job created successfully</p>
                    <p className="text-xs text-green-600 dark:text-green-500 mt-0.5">{result.tableCount} table{result.tableCount !== 1 ? 's' : ''} configured</p>
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-800/60 rounded-xl border border-green-200 dark:border-green-800 px-4 py-3 space-y-1">
                  <p className="text-xs text-gray-500 dark:text-slate-400">Job name</p>
                  <p className="font-medium text-gray-900 dark:text-slate-100">{result.jobName}</p>
                  <p className="text-[11px] font-mono text-gray-400 dark:text-slate-500">ID: {result.jobId}</p>
                </div>

                <div className="space-y-2">
                  <a
                    href="/migration"
                    className="flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                  >
                    Open Migration Module
                    <ExternalLink size={13} />
                  </a>
                  <p className="text-[11px] text-center text-gray-400 dark:text-slate-500">
                    Load job <span className="font-mono">{result.jobName}</span> from the sidebar, review mappings, then run.
                  </p>
                </div>
              </div>
            ) : !generating && tables.length > 0 && (
              <div className="flex-1 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 dark:border-slate-700 py-14 text-center">
                <Sparkles size={30} className="text-gray-300 dark:text-slate-600 mb-3" />
                <p className="text-sm text-gray-400 dark:text-slate-500">Select tables and click Generate Job.</p>
                <p className="text-xs text-gray-300 dark:text-slate-600 mt-1">AI will map all columns and order tables by FK dependency.</p>
              </div>
            )}

            {!tables.length && !generating && (
              <div className="flex-1 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 dark:border-slate-700 py-14 text-center">
                <Database size={30} className="text-gray-300 dark:text-slate-600 mb-3" />
                <p className="text-sm text-gray-400 dark:text-slate-500">Load tables from source to begin.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Tab 1: Pre-flight Analyzer ─────────────────────────────────────────────────

function PreflightTab({
  sourceConn,
  sourceDb,
  targetConn,
  targetDb,
  targetSchema,
}: {
  sourceConn: ConnectionRow | null;
  sourceDb: string;
  targetConn: ConnectionRow | null;
  targetDb: string;
  targetSchema: string;
}) {
  const [tables, setTables] = useState<MigTableInfo[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingTables, setLoadingTables] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [analysisText, setAnalysisText] = useState('');
  const [error, setError] = useState('');
  const outputRef = useRef<HTMLDivElement>(null);

  // Reset when source changes
  useEffect(() => {
    setTables([]);
    setSelected(new Set());
    setAnalysisText('');
    setError('');
  }, [sourceConn?.id, sourceDb]);

  function buildSourceConn(): ExplorerConn | null {
    if (!sourceConn) return null;
    return { ...connFromRow(sourceConn), database: sourceDb || sourceConn.database_name };
  }

  async function loadTables() {
    const ec = buildSourceConn();
    if (!ec) return;
    setLoadingTables(true);
    setError('');
    setTables([]);
    setSelected(new Set());
    try {
      const res = await fetch('/api/migv2/tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ec),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load tables');
      setTables(data.tables ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingTables(false);
    }
  }

  function toggleTable(key: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function toggleAll() {
    setSelected(selected.size === tables.length ? new Set() : new Set(tables.map(t => `${t.schema}.${t.name}`)));
  }

  async function runAnalysis() {
    const ec = buildSourceConn();
    if (!ec || selected.size === 0) return;
    setAnalyzing(true);
    setAnalysisText('');
    setStatusMsg('');
    setError('');

    const conn = ec;
    const tableList = tables
      .filter(t => selected.has(`${t.schema}.${t.name}`))
      .map(t => ({ schema: t.schema, name: t.name, rowCount: t.rowCount }));

    try {
      const res = await fetch('/api/ai-migration/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conn,
          tables: tableList,
          targetType: targetConn ? 'postgresql' : undefined,
        }),
      });

      if (!res.ok || !res.body) throw new Error('Failed to start analysis');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          const lines = part.split('\n');
          let evtType = '';
          let dataStr = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) evtType = line.slice(7).trim();
            if (line.startsWith('data: ')) dataStr = line.slice(6).trim();
          }
          if (!dataStr) continue;
          try {
            const payload = JSON.parse(dataStr);
            if (evtType === 'text') setAnalysisText(prev => prev + payload.text);
            else if (evtType === 'status') setStatusMsg(payload.message ?? '');
            else if (evtType === 'error') setError(payload.message ?? 'Unknown error');
            else if (evtType === 'done') setStatusMsg('');
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAnalyzing(false);
      setStatusMsg('');
    }
  }

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [analysisText]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-6">
      {/* Controls */}
      <div className="space-y-3">
        <button
          onClick={loadTables}
          disabled={!sourceConn || !sourceDb || loadingTables}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loadingTables ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Load Tables from Source
        </button>

        {!sourceConn && (
          <p className="text-xs text-gray-400 dark:text-slate-500 text-center">Select a source connection above first.</p>
        )}

        {tables.length > 0 && (
          <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-700">
              <span className="text-xs font-medium text-gray-600 dark:text-slate-400">{tables.length} tables</span>
              <button onClick={toggleAll} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                {selected.size === tables.length ? 'Deselect all' : 'Select all'}
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto divide-y divide-gray-100 dark:divide-slate-800">
              {tables.map(t => {
                const key = `${t.schema}.${t.name}`;
                return (
                  <label key={key} className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/40 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => toggleTable(key)}
                      className="rounded border-gray-300 dark:border-slate-600 text-blue-600"
                    />
                    <span className="text-xs text-gray-700 dark:text-slate-300 flex-1 truncate">{t.name}</span>
                    <span className="text-[10px] text-gray-400 dark:text-slate-500 shrink-0">{t.rowCount.toLocaleString()}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {selected.size > 0 && (
          <button
            onClick={runAnalysis}
            disabled={analyzing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {analyzing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {analyzing ? 'Analyzing…' : `Analyze ${selected.size} table${selected.size > 1 ? 's' : ''}`}
          </button>
        )}

        {error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-400">
            {error}
          </div>
        )}
      </div>

      {/* Output */}
      <div className="flex flex-col min-h-[420px]">
        {statusMsg && (
          <div className="mb-2 flex items-center gap-2 text-xs text-blue-600 dark:text-blue-400">
            <Loader2 size={12} className="animate-spin" />
            {statusMsg}
          </div>
        )}
        {analysisText ? (
          <div ref={outputRef} className="flex-1 overflow-y-auto bg-gray-900 dark:bg-slate-950 rounded-xl p-5 font-mono text-[13px] leading-relaxed text-gray-100">
            <AnalysisRenderer text={analysisText} />
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 dark:border-slate-700 text-center p-8">
            <Brain size={32} className="text-gray-300 dark:text-slate-600 mb-3" />
            <p className="text-sm text-gray-400 dark:text-slate-500">Load tables from source, select which to analyze, then run.</p>
            <p className="text-xs text-gray-300 dark:text-slate-600 mt-1">AI will flag ENUM types, unsigned integers, missing PKs, FK ordering, and more.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function AnalysisRenderer({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        if (line.startsWith('## ')) {
          return (
            <div key={i} className="mt-5 mb-2 first:mt-0 text-blue-400 font-bold text-sm border-b border-slate-700 pb-1">
              {line.slice(3)}
            </div>
          );
        }
        if (line.startsWith('### ')) {
          return <div key={i} className="mt-3 mb-1 text-slate-300 font-semibold text-xs uppercase tracking-wide">{line.slice(4)}</div>;
        }
        if (line.startsWith('- ') || line.startsWith('* ')) {
          const content = line.slice(2);
          const cls = /critical|error|fail|CRITICAL/i.test(content)
            ? 'text-red-400'
            : /warn|may|WARNING/i.test(content)
            ? 'text-amber-400'
            : 'text-gray-300';
          return (
            <div key={i} className={`flex gap-2 py-0.5 ${cls}`}>
              <span className="shrink-0 mt-px">•</span><span>{content}</span>
            </div>
          );
        }
        if (/^\d+\./.test(line)) return <div key={i} className="text-slate-300 py-0.5">{line}</div>;
        if (!line.trim()) return <div key={i} className="h-2" />;
        return <div key={i} className="text-gray-400 py-0.5">{line}</div>;
      })}
    </>
  );
}

// ── Tab 2: Column Suggestions ──────────────────────────────────────────────────

function ColumnsTab({
  sourceConn,
  sourceDb,
  targetConn,
  targetDb,
  targetSchema,
}: {
  sourceConn: ConnectionRow | null;
  sourceDb: string;
  targetConn: ConnectionRow | null;
  targetDb: string;
  targetSchema: string;
}) {
  const [tables, setTables] = useState<MigTableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState('');
  const [loadingTables, setLoadingTables] = useState(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<ColumnSuggestion[] | null>(null);
  const [error, setError] = useState('');

  function buildSourceConn(): ExplorerConn | null {
    if (!sourceConn) return null;
    return { ...connFromRow(sourceConn), database: sourceDb || sourceConn.database_name };
  }

  useEffect(() => {
    setTables([]);
    setSelectedTable('');
    setSuggestions(null);
    setError('');
  }, [sourceConn?.id, sourceDb]);

  async function loadTables() {
    const ec = buildSourceConn();
    if (!ec) return;
    setLoadingTables(true);
    setError('');
    try {
      const res = await fetch('/api/migv2/tables', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ec),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load tables');
      setTables(data.tables ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingTables(false);
    }
  }

  async function getSuggestions() {
    const ec = buildSourceConn();
    if (!ec || !selectedTable) return;
    const [schema, table] = selectedTable.split('.');
    setLoading(true);
    setError('');
    setSuggestions(null);
    try {
      const res = await fetch('/api/ai-migration/suggest-columns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conn: ec, schema, table }),
      });
      const data: SuggestColumnsResponse = await res.json();
      if (!res.ok) throw new Error((data as any).error ?? 'Failed to get suggestions');
      setSuggestions(data.suggestions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const conversionBadge: Record<string, string> = {
    keep: 'bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-400',
    serial_to_uuid: 'bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400',
    to_boolean: 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400',
    to_jsonb: 'bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-400',
    to_timestamptz: 'bg-cyan-100 dark:bg-cyan-950/40 text-cyan-700 dark:text-cyan-400',
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <button
          onClick={loadTables}
          disabled={!sourceConn || !sourceDb || loadingTables}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loadingTables ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Load Tables
        </button>

        {tables.length > 0 && (
          <div className="relative min-w-56">
            <select
              value={selectedTable}
              onChange={e => { setSelectedTable(e.target.value); setSuggestions(null); }}
              className="w-full appearance-none bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 pr-8 text-sm text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select table…</option>
              {tables.map(t => (
                <option key={`${t.schema}.${t.name}`} value={`${t.schema}.${t.name}`}>
                  {t.schema}.{t.name}
                </option>
              ))}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
          </div>
        )}

        {selectedTable && (
          <button
            onClick={getSuggestions}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
            {loading ? 'Analyzing…' : 'Get AI Suggestions'}
          </button>
        )}

        {!sourceConn && (
          <p className="text-xs text-gray-400 dark:text-slate-500">Select a source connection above first.</p>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {suggestions ? (
        <>
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Suggested PostgreSQL types for <span className="font-semibold text-gray-700 dark:text-slate-300">{selectedTable}</span>
            {targetConn && (
              <span> → <span className="font-semibold">{targetConn.label}</span>
                {targetDb && <span className="text-blue-600 dark:text-blue-400"> / {targetDb}</span>}
                {targetSchema && <span className="text-blue-600 dark:text-blue-400">.{targetSchema}</span>}
              </span>
            )}
          </p>
          <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-700">
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-slate-400">Column</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-slate-400">MySQL Type</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-slate-400">→ PG Type</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-slate-400">Conversion</th>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 dark:text-slate-400">Notes / Warnings</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s, i) => (
                  <tr
                    key={s.sourceCol}
                    className={`border-b border-gray-100 dark:border-slate-800 last:border-0 ${i % 2 ? 'bg-gray-50/40 dark:bg-slate-800/20' : ''} ${s.warnings ? 'bg-amber-50/40 dark:bg-amber-950/10' : ''}`}
                  >
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-800 dark:text-slate-200 font-medium">{s.sourceCol}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500 dark:text-slate-400">{s.sourceMysqlType}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-blue-700 dark:text-blue-300 font-medium">{s.suggestedPgType}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${conversionBadge[s.conversion] ?? 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'}`}>
                        {s.conversion}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-slate-400">
                      {s.notes}
                      {s.warnings && (
                        <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          <AlertTriangle size={11} />{s.warnings}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : !loading && (
        <div className="flex flex-col items-center justify-center rounded-xl border-2 border-dashed border-gray-200 dark:border-slate-700 py-14 text-center">
          <Columns size={30} className="text-gray-300 dark:text-slate-600 mb-3" />
          <p className="text-sm text-gray-400 dark:text-slate-500">Load tables, select one, then get AI column type suggestions.</p>
        </div>
      )}
    </div>
  );
}

// ── Tab 3: Error Explainer ─────────────────────────────────────────────────────

function ExplainTab() {
  const [errorText, setErrorText] = useState('');
  const [contextText, setContextText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExplainResponse | null>(null);
  const [error, setError] = useState('');

  async function explain() {
    if (!errorText.trim()) return;
    setLoading(true);
    setResult(null);
    setError('');
    try {
      const res = await fetch('/api/ai-migration/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: errorText, context: contextText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Request failed');
      setResult(data as ExplainResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1.5">
          PostgreSQL Error Message
        </label>
        <textarea
          value={errorText}
          onChange={e => setErrorText(e.target.value)}
          rows={5}
          placeholder={`Paste the error from your migration run…\n\ne.g. ERROR: invalid input syntax for type uuid: "42"`}
          className="w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2.5 text-sm font-mono text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-600 dark:text-slate-400 mb-1.5">
          Context <span className="font-normal text-gray-400 dark:text-slate-500">(optional)</span>
        </label>
        <textarea
          value={contextText}
          onChange={e => setContextText(e.target.value)}
          rows={3}
          placeholder="e.g. Migrating users table — id column is int AUTO_INCREMENT in MySQL, UUID in PG"
          className="w-full bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2.5 text-sm text-gray-900 dark:text-slate-100 placeholder:text-gray-400 dark:placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
        />
      </div>

      <button
        onClick={explain}
        disabled={!errorText.trim() || loading}
        className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Bug size={14} />}
        {loading ? 'Analyzing…' : 'Explain Error'}
      </button>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="p-4 rounded-xl bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
            <div className="flex items-start gap-2.5">
              <Info size={16} className="text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-blue-800 dark:text-blue-300 mb-0.5">Summary</p>
                <p className="text-sm text-blue-700 dark:text-blue-400">{result.summary}</p>
              </div>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
            <div className="flex items-start gap-2.5">
              <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-0.5">Root Cause</p>
                <p className="text-sm text-amber-700 dark:text-amber-400">{result.rootCause}</p>
              </div>
            </div>
          </div>

          <div className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 bg-gray-50 dark:bg-slate-800/60 border-b border-gray-200 dark:border-slate-700">
              <p className="text-xs font-semibold text-gray-600 dark:text-slate-400">Fixes</p>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-slate-800">
              {result.fixes.map((fix, i) => (
                <div key={i} className="p-4">
                  <div className="flex items-start gap-2 mb-2">
                    <CheckCircle2 size={14} className="text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
                    <p className="text-sm text-gray-800 dark:text-slate-200">{fix.action}</p>
                  </div>
                  {fix.code && (
                    <pre className="mt-2 px-3 py-2.5 bg-gray-900 dark:bg-slate-950 rounded-lg text-xs font-mono text-green-300 overflow-x-auto whitespace-pre-wrap">
                      {fix.code}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-gray-50 dark:bg-slate-800/40 border border-gray-200 dark:border-slate-700 flex items-start gap-2.5">
            <Zap size={14} className="text-gray-500 dark:text-slate-400 mt-0.5 shrink-0" />
            <p className="text-xs text-gray-600 dark:text-slate-400">
              <span className="font-semibold text-gray-700 dark:text-slate-300">Prevention: </span>
              {result.preventionTip}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────────

type Tab = 'generate' | 'preflight' | 'columns' | 'explain';

const TABS: Array<{ id: Tab; label: string; Icon: React.ElementType }> = [
  { id: 'generate',  label: 'Generate Job',       Icon: Sparkles },
  { id: 'preflight', label: 'Pre-flight Analyzer', Icon: Brain },
  { id: 'columns',   label: 'Column Suggestions',  Icon: Columns },
  { id: 'explain',   label: 'Error Explainer',     Icon: Bug },
];

export default function AiMigrationPage() {
  const [activeTab, setActiveTab] = useState<Tab>('preflight');
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [sourceId, setSourceId] = useState<number | null>(null);
  const [sourceDb, setSourceDb] = useState('');
  const [targetId, setTargetId] = useState<number | null>(null);
  const [targetDb, setTargetDb] = useState('');
  const [targetSchema, setTargetSchema] = useState('public');

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/connections');
        const data = await res.json();
        setConnections(data.connections ?? []);
      } catch { /* ignore */ }
    })();
  }, []);

  const sourceConn = connections.find(c => c.id === sourceId) ?? null;
  const targetConn = connections.find(c => c.id === targetId) ?? null;

  return (
    <>
      <Head><title>AI Migration — DB Maintenance</title></Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900 pt-12">
        <div className="max-w-6xl mx-auto px-6 py-8">

          {/* Page header */}
          <div className="mb-6">
            <div className="flex items-center gap-2.5 mb-1">
              <Brain size={20} className="text-blue-600 dark:text-blue-400" />
              <h1 className="text-lg font-semibold text-gray-900 dark:text-slate-100">AI Migration Assistant</h1>
            </div>
            <p className="text-sm text-gray-500 dark:text-slate-400">
              AI-powered analysis for MySQL → PostgreSQL migrations.
            </p>
          </div>

          {/* Source / Target connection bar */}
          <div className="mb-6 p-4 bg-white dark:bg-slate-800/50 rounded-xl border border-gray-200 dark:border-slate-700">
            <div className="flex flex-wrap items-start gap-4">
              <ConnPanel
                label="Source (MySQL)"
                connections={connections}
                filter="mysql"
                connId={sourceId}
                onConnChange={id => { setSourceId(id); setSourceDb(''); }}
                dbValue={sourceDb}
                onDbChange={setSourceDb}
              />

              <div className="flex items-center pt-7">
                <ArrowRight size={16} className="text-gray-300 dark:text-slate-600" />
              </div>

              <ConnPanel
                label="Target (PostgreSQL)"
                connections={connections}
                filter="postgres"
                connId={targetId}
                onConnChange={id => { setTargetId(id); setTargetDb(''); setTargetSchema(''); }}
                dbValue={targetDb}
                onDbChange={setTargetDb}
                schemaValue={targetSchema}
                onSchemaChange={setTargetSchema}
              />
            </div>
          </div>

          {/* Tab strip */}
          <div className="flex gap-1 mb-5 p-1 bg-gray-100 dark:bg-slate-800 rounded-xl w-fit">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setActiveTab(id)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === id
                    ? 'bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 shadow-sm'
                    : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="bg-white dark:bg-slate-800/50 rounded-2xl border border-gray-200 dark:border-slate-700 p-6">
            {activeTab === 'generate'  && <GenerateJobTab sourceConn={sourceConn} sourceDb={sourceDb} targetConn={targetConn} targetDb={targetDb} targetSchema={targetSchema} />}
            {activeTab === 'preflight' && <PreflightTab sourceConn={sourceConn} sourceDb={sourceDb} targetConn={targetConn} targetDb={targetDb} targetSchema={targetSchema} />}
            {activeTab === 'columns'   && <ColumnsTab sourceConn={sourceConn} sourceDb={sourceDb} targetConn={targetConn} targetDb={targetDb} targetSchema={targetSchema} />}
            {activeTab === 'explain'   && <ExplainTab />}
          </div>
        </div>
      </div>
    </>
  );
}
