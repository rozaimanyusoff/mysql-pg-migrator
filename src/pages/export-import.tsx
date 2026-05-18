import Head from 'next/head';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  ChevronRight, UploadCloud, Download, RefreshCw, Play, CheckCircle2,
  XCircle, Loader2, Database, Server, FileCode2, ArrowRightLeft,
  AlertCircle, Table2, ChevronDown, ChevronUp, Copy, Check,
  ArrowRight, Info,
} from 'lucide-react';
import type { ConnectionRow } from './api/connections/index';
import type { ConnCfg, ExportInclude } from '../lib/sql-exporter';

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'export' | 'import' | 'sync';

interface LogLine { step: string; ok: boolean; text: string }

interface UploadedFile { filename: string; content: string }

// ── Helpers ───────────────────────────────────────────────────────────────────

function authHeader() {
  return { Authorization: `Bearer ${localStorage.getItem('auth_token') ?? ''}` };
}

function connToCfg(conn: ConnectionRow, database?: string): ConnCfg {
  return {
    db_type: conn.db_type,
    host: conn.host,
    port: conn.port,
    user: conn.username,
    password: conn.password_enc ?? '',
    database: database ?? conn.database_name,
    ssl: conn.ssl_enabled,
  };
}

function dbTypeBadge(type: 'mysql' | 'postgres') {
  return type === 'mysql'
    ? 'bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-400'
    : 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400';
}

// ── Connection picker card ─────────────────────────────────────────────────────

function ConnPicker({
  label, connections, value, onChange, filterType,
}: {
  label: string;
  connections: ConnectionRow[];
  value: number | '';
  onChange: (id: number | '') => void;
  filterType?: 'mysql' | 'postgres';
}) {
  const filtered = filterType ? connections.filter((c) => c.db_type === filterType) : connections;
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">{label}</p>
      {filtered.length === 0 ? (
        <p className="text-xs text-gray-400 dark:text-slate-500 italic">No connections saved.</p>
      ) : (
        <div className="grid gap-2">
          {filtered.map((c) => (
            <button
              key={c.id} type="button"
              onClick={() => onChange(c.id === value ? '' : c.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                value === c.id
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-500'
                  : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 hover:border-gray-300 dark:hover:border-slate-600'
              }`}
            >
              <Server size={14} className="text-gray-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-slate-100 truncate">{c.label}</p>
                <p className="text-[10px] text-gray-400 dark:text-slate-500 truncate">{c.host}:{c.port} / {c.database_name}</p>
              </div>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${dbTypeBadge(c.db_type)}`}>
                {c.db_type === 'mysql' ? 'MySQL' : 'PG'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Database selector ──────────────────────────────────────────────────────────

function DbSelector({
  conn, value, onChange,
}: {
  conn: ConnectionRow | null;
  value: string;
  onChange: (db: string) => void;
}) {
  const [dbs, setDbs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (c: ConnectionRow) => {
    setLoading(true); setDbs([]);
    try {
      if (c.db_type === 'postgres') {
        const { data } = await axios.post('/api/pg-databases', {
          host: c.host, port: c.port, user: c.username,
          password: c.password_enc ?? '', ssl: c.ssl_enabled,
        });
        setDbs((data as { databases: string[] }).databases);
      } else {
        const { data } = await axios.post('/api/list-databases', {
          host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '',
        });
        setDbs((data as { databases: string[] }).databases);
      }
    } catch { setDbs([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (conn) void load(conn);
    else { setDbs([]); onChange(''); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);

  useEffect(() => {
    if (dbs.length > 0 && !value) onChange(dbs[0]);
  }, [dbs, value, onChange]);

  if (!conn) return null;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-medium text-gray-500 dark:text-slate-400">Database</p>
        <button type="button" onClick={() => void load(conn)} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300">
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        {dbs.map((db) => <option key={db} value={db}>{db}</option>)}
      </select>
    </div>
  );
}

// ── Table selector ─────────────────────────────────────────────────────────────

function TableSelector({
  conn, database, value, onChange,
}: {
  conn: ConnectionRow | null;
  database: string;
  value: string[] | 'all';
  onChange: (v: string[] | 'all') => void;
}) {
  const [tables, setTables] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!conn || !database) { setTables([]); return; }
    void (async () => {
      setLoading(true);
      try {
        const { data } = await axios.post(
          '/api/export-import/tables',
          { cfg: connToCfg(conn, database) },
          { headers: authHeader() },
        );
        setTables((data as { tables: string[] }).tables);
      } catch { setTables([]); }
      finally { setLoading(false); }
    })();
  }, [conn?.id, database]);

  const allSelected = value === 'all';
  const selected = allSelected ? tables : value;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-medium text-gray-500 dark:text-slate-400">
          Tables {loading && <Loader2 size={10} className="inline animate-spin ml-1" />}
        </p>
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400 hover:underline">
          {expanded ? 'collapse' : `${allSelected ? tables.length : selected.length} selected`}
          {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
      </div>

      <div className="flex gap-2 mb-2">
        <button type="button" onClick={() => onChange('all')}
          className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
            allSelected ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
            : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300'
          }`}>All tables</button>
        <button type="button" onClick={() => onChange([])}
          className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
            !allSelected ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
            : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300'
          }`}>Custom</button>
      </div>

      {expanded && !allSelected && tables.length > 0 && (
        <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
          {tables.map((t) => (
            <label key={t}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/50 cursor-pointer border-b border-gray-100 dark:border-slate-800 last:border-0">
              <input type="checkbox"
                checked={selected.includes(t)}
                onChange={(e) => {
                  const next = e.target.checked ? [...selected, t] : selected.filter((x) => x !== t);
                  onChange(next);
                }}
                className="accent-blue-600"
              />
              <Table2 size={11} className="text-gray-400" />
              <span className="text-xs text-gray-700 dark:text-slate-300 font-mono">{t}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Include options ────────────────────────────────────────────────────────────

function IncludePicker({ value, onChange }: { value: ExportInclude; onChange: (v: ExportInclude) => void }) {
  const opts: { v: ExportInclude; label: string; desc: string }[] = [
    { v: 'both',   label: 'Schema + Data', desc: 'DDL and all rows' },
    { v: 'schema', label: 'Schema only',   desc: 'DDL — no data' },
    { v: 'data',   label: 'Data only',     desc: 'INSERTs — no DDL' },
  ];
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">Include</p>
      <div className="flex gap-2 flex-wrap">
        {opts.map(({ v, label, desc }) => (
          <button key={v} type="button" onClick={() => onChange(v)}
            className={`px-3 py-1.5 rounded-lg text-xs border transition-colors text-left ${
              value === v
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
                : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-300'
            }`}>
            <p className="font-medium">{label}</p>
            <p className="text-[10px] opacity-70">{desc}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Log panel ──────────────────────────────────────────────────────────────────

function LogPanel({ lines, running }: { lines: LogLine[]; running: boolean }) {
  if (lines.length === 0 && !running) return null;
  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/60">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
        <FileCode2 size={13} className="text-gray-500" />
        <p className="text-xs font-medium text-gray-600 dark:text-slate-400">Execution Log</p>
      </div>
      <div className="p-4 space-y-1.5 font-mono text-xs max-h-64 overflow-y-auto">
        {lines.map((l, i) => {
          const isRollback = l.text.startsWith('[ROLLBACK]');
          const isInfo     = l.text.startsWith('[START]') || l.text.startsWith('[DONE]');
          const colorCls   = l.ok
            ? isInfo ? 'text-gray-500 dark:text-slate-400' : 'text-emerald-600 dark:text-emerald-400'
            : isRollback ? 'text-amber-600 dark:text-amber-400'
            : 'text-rose-600 dark:text-rose-400';
          const Icon = l.ok ? (isInfo ? Info : CheckCircle2) : isRollback ? AlertCircle : XCircle;
          return (
            <div key={i} className={`flex items-start gap-2 ${colorCls}`}>
              <Icon size={12} className="mt-0.5 shrink-0" />
              <span><span className="opacity-50 mr-1.5">[{l.step}]</span>{l.text}</span>
            </div>
          );
        })}
        {running && (
          <div className="flex items-center gap-2 text-gray-400">
            <Loader2 size={12} className="animate-spin" /> Running…
          </div>
        )}
      </div>
    </div>
  );
}

// ── SQL preview + download ─────────────────────────────────────────────────────

function SqlPreview({ sql, filename }: { sql: string; filename: string }) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(sql);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    const blob = new Blob([sql], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/60">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
        <div className="flex items-center gap-2">
          <FileCode2 size={13} className="text-gray-500" />
          <p className="text-xs font-medium text-gray-600 dark:text-slate-400">
            SQL Output <span className="opacity-60">({(sql.length / 1024).toFixed(1)} KB)</span>
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={() => setExpanded((v) => !v)}
            className="px-2 py-1 text-[10px] rounded text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
            {expanded ? 'Collapse' : 'Preview'}
          </button>
          <button type="button" onClick={copy}
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors">
            {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={download}
            className="flex items-center gap-1.5 px-3 py-1 text-[10px] rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 transition-colors">
            <Download size={11} /> Download
          </button>
        </div>
      </div>
      {expanded && (
        <pre className="p-4 text-[10px] font-mono text-gray-600 dark:text-slate-300 max-h-80 overflow-y-auto whitespace-pre-wrap break-words">
          {sql.slice(0, 8000)}{sql.length > 8000 ? '\n… (truncated for preview)' : ''}
        </pre>
      )}
    </div>
  );
}

// ── Drag-drop SQL import field ──────────────────────────────────────────────────

function SqlImportField({
  value, onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => onChange(e.target?.result as string ?? '');
    reader.readAsText(file);
  };

  return (
    <div
      className={`relative rounded-xl border-2 border-dashed transition-colors ${
        dragging
          ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/20'
          : 'border-gray-200 dark:border-slate-700'
      }`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault(); setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) readFile(file);
      }}
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste SQL here or drag & drop a .sql file…"
        rows={10}
        className="w-full px-4 py-3 text-xs font-mono bg-transparent rounded-xl text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
      />
      <div className="px-4 pb-3 flex items-center gap-2">
        <button type="button" onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
          <UploadCloud size={12} /> Browse file
        </button>
        {value && (
          <button type="button" onClick={() => onChange('')}
            className="text-[10px] text-gray-400 hover:text-rose-500 transition-colors">Clear</button>
        )}
        <input ref={fileRef} type="file" accept=".sql,.txt" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
      </div>
    </div>
  );
}

// ── Export tab ─────────────────────────────────────────────────────────────────

function ExportTab({ connections }: { connections: ConnectionRow[] }) {
  const [connId, setConnId]   = useState<number | ''>('');
  const [database, setDatabase] = useState('');
  const [tables, setTables]   = useState<string[] | 'all'>('all');
  const [include, setInclude] = useState<ExportInclude>('both');
  const [running, setRunning] = useState(false);
  const [result, setResult]   = useState<{ sql: string; tables: string[] } | null>(null);
  const [error, setError]     = useState<string | null>(null);

  const conn = connections.find((c) => c.id === connId) ?? null;

  const handleExport = async () => {
    if (!conn || !database) return;
    setRunning(true); setResult(null); setError(null);
    try {
      const { data } = await axios.post(
        '/api/export-import/export',
        { cfg: connToCfg(conn, database), tables, include },
        { headers: authHeader() },
      );
      setResult(data as { sql: string; tables: string[] });
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally { setRunning(false); }
  };

  const filename = `${database}_${include}_${new Date().toISOString().slice(0, 10)}.sql`;

  return (
    <div className="space-y-6">
      <div className="grid xl:grid-cols-2 gap-6">
        {/* Source connection */}
        <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Database size={15} className="text-blue-500" />
            <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Source</p>
          </div>
          <ConnPicker label="Connection" connections={connections} value={connId} onChange={setConnId} />
          <DbSelector conn={conn} value={database} onChange={setDatabase} />
          <TableSelector conn={conn} database={database} value={tables} onChange={setTables} />
        </section>

        {/* Export options */}
        <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Download size={15} className="text-blue-500" />
            <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Options</p>
          </div>
          <IncludePicker value={include} onChange={setInclude} />

          <div className="pt-2 border-t border-gray-100 dark:border-slate-800">
            <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-slate-400 mb-3">
              <Info size={11} />
              <span>Export generates a SQL dump you can download or use for import/sync.</span>
            </div>
            <button type="button" onClick={() => void handleExport()}
              disabled={!conn || !database || running}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {running ? 'Exporting…' : 'Export'}
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-400">
              <XCircle size={13} className="mt-0.5 shrink-0" /> {error}
            </div>
          )}

          {result && (
            <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 size={13} />
              Exported {result.tables.length} table{result.tables.length !== 1 ? 's' : ''}
            </div>
          )}
        </section>
      </div>

      {result && <SqlPreview sql={result.sql} filename={filename} />}
    </div>
  );
}

// ── Import tab ─────────────────────────────────────────────────────────────────

function ImportTab({ connections }: { connections: ConnectionRow[] }) {
  const [connId, setConnId]     = useState<number | ''>('');
  const [database, setDatabase] = useState('');
  const [sql, setSql]           = useState('');
  const [running, setRunning]   = useState(false);
  const [log, setLog]           = useState<LogLine[]>([]);
  const [status, setStatus]     = useState<'success' | 'failed' | null>(null);

  const conn = connections.find((c) => c.id === connId) ?? null;

  const handleImport = async () => {
    if (!conn || !database || !sql.trim()) return;
    setRunning(true); setLog([]); setStatus(null);
    try {
      const { data } = await axios.post(
        '/api/export-import/import',
        { cfg: connToCfg(conn, database), sql },
        { headers: authHeader() },
      );
      const d = data as { success: boolean; log?: string[] };
      const lines: LogLine[] = (d.log ?? []).map((t) => ({ step: 'import', ok: d.success, text: t }));
      setLog(lines);
      setStatus(d.success ? 'success' : 'failed');
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: string[]; error?: string } | undefined : undefined;
      const lines: LogLine[] = (d?.log ?? [`[ERROR] ${d?.error ?? String(err)}`]).map((t) => ({ step: 'import', ok: false, text: t }));
      setLog(lines); setStatus('failed');
    } finally { setRunning(false); }
  };

  return (
    <div className="space-y-6">
      <div className="grid xl:grid-cols-2 gap-6">
        {/* Target connection */}
        <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <UploadCloud size={15} className="text-emerald-500" />
            <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Target</p>
          </div>
          <ConnPicker label="Connection" connections={connections} value={connId} onChange={setConnId} />
          <DbSelector conn={conn} value={database} onChange={setDatabase} />
        </section>

        {/* SQL input */}
        <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <FileCode2 size={15} className="text-emerald-500" />
            <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">SQL</p>
          </div>
          <SqlImportField value={sql} onChange={setSql} />

          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void handleImport()}
              disabled={!conn || !database || !sql.trim() || running}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 transition-colors">
              {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {running ? 'Importing…' : 'Import'}
            </button>
            {status && (
              <span className={`flex items-center gap-1.5 text-xs font-medium ${status === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                {status === 'success' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                {status === 'success' ? 'Imported successfully' : 'Import failed'}
              </span>
            )}
          </div>
        </section>
      </div>

      <LogPanel lines={log} running={running} />
    </div>
  );
}

// ── Sync tab ───────────────────────────────────────────────────────────────────

function SyncTab({ connections }: { connections: ConnectionRow[] }) {
  const [srcConnId, setSrcConnId]   = useState<number | ''>('');
  const [srcDb, setSrcDb]           = useState('');
  const [tgtConnId, setTgtConnId]   = useState<number | ''>('');
  const [tgtDb, setTgtDb]           = useState('');
  const [tables, setTables]         = useState<string[] | 'all'>('all');
  const [include, setInclude]       = useState<ExportInclude>('both');
  const [running, setRunning]       = useState(false);
  const [log, setLog]               = useState<LogLine[]>([]);
  const [status, setStatus]         = useState<'success' | 'failed' | null>(null);

  const srcConn = connections.find((c) => c.id === srcConnId) ?? null;
  const tgtConn = connections.find((c) => c.id === tgtConnId) ?? null;

  const typeMismatch = srcConn && tgtConn && srcConn.db_type !== tgtConn.db_type;

  const handleSync = async () => {
    if (!srcConn || !srcDb || !tgtConn || !tgtDb || typeMismatch) return;
    setRunning(true); setLog([]); setStatus(null);
    try {
      const { data } = await axios.post(
        '/api/export-import/sync',
        {
          source: connToCfg(srcConn, srcDb),
          target: connToCfg(tgtConn, tgtDb),
          tables, include,
        },
        { headers: authHeader() },
      );
      const d = data as { success: boolean; log: LogLine[] };
      setLog(d.log); setStatus(d.success ? 'success' : 'failed');
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: LogLine[] } | undefined : undefined;
      if (d?.log) { setLog(d.log); }
      else { setLog([{ step: 'sync', ok: false, text: `[ERROR] ${String(err)}` }]); }
      setStatus('failed');
    } finally { setRunning(false); }
  };

  return (
    <div className="space-y-6">
      {/* Source → Target layout */}
      <div className="grid xl:grid-cols-[1fr_auto_1fr] gap-4 items-start">
        {/* Source */}
        <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Database size={15} className="text-blue-500" />
            <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Source (Production)</p>
          </div>
          <ConnPicker label="Connection" connections={connections} value={srcConnId} onChange={setSrcConnId} />
          <DbSelector conn={srcConn} value={srcDb} onChange={setSrcDb} />
          <TableSelector conn={srcConn} database={srcDb} value={tables} onChange={setTables} />
        </section>

        {/* Arrow */}
        <div className="flex xl:flex-col items-center justify-center xl:pt-16 gap-2 px-2">
          <ArrowRight size={20} className="text-gray-300 dark:text-slate-600 xl:rotate-0 rotate-90" />
        </div>

        {/* Target */}
        <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Server size={15} className="text-emerald-500" />
            <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Target (Local)</p>
          </div>
          <ConnPicker label="Connection" connections={connections} value={tgtConnId} onChange={setTgtConnId} />
          <DbSelector conn={tgtConn} value={tgtDb} onChange={setTgtDb} />
        </section>
      </div>

      {/* Options + run */}
      <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
        <IncludePicker value={include} onChange={setInclude} />

        {typeMismatch && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle size={13} className="mt-0.5 shrink-0" />
            Cross-DB sync (MySQL ↔ PostgreSQL) is not supported here. Use the <strong className="mx-1">Migration</strong> module instead.
          </div>
        )}

        <div className="flex items-center gap-3">
          <button type="button" onClick={() => void handleSync()}
            disabled={!srcConn || !srcDb || !tgtConn || !tgtDb || running || !!typeMismatch}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50 transition-colors">
            {running ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}
            {running ? 'Syncing…' : 'Start Sync'}
          </button>
          {status && (
            <span className={`flex items-center gap-1.5 text-xs font-medium ${status === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {status === 'success' ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
              {status === 'success' ? 'Sync completed' : 'Sync failed'}
            </span>
          )}
        </div>
      </section>

      <LogPanel lines={log} running={running} />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ExportImportPage() {
  const [tab, setTab] = useState<Tab>('export');
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [loadingConns, setLoadingConns] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoadingConns(true);
      try {
        const { data } = await axios.get('/api/connections');
        setConnections((data as { connections: ConnectionRow[] }).connections);
      } catch { /* ignore */ }
      finally { setLoadingConns(false); }
    })();
  }, []);

  const tabs: { key: Tab; label: string; Icon: React.ElementType }[] = [
    { key: 'export', label: 'Export', Icon: Download },
    { key: 'import', label: 'Import', Icon: UploadCloud },
    { key: 'sync',   label: 'Sync',   Icon: ArrowRightLeft },
  ];

  return (
    <>
      <Head><title>Export & Import — DB Maintenance Tools</title></Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900 pb-16">

        <header className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <UploadCloud size={18} className="text-emerald-600" />
            <div>
              <h1 className="font-bold text-gray-900 dark:text-slate-100">Export & Import</h1>
              <p className="text-xs text-gray-500 dark:text-slate-400">Export, import and sync database tables across PostgreSQL and MySQL connections.</p>
            </div>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Home</Link>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <span className="px-3 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 font-semibold">Export & Import</span>
          </nav>
        </header>

        <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">

          {/* Tabs */}
          <div className="flex gap-1 p-1 bg-gray-100 dark:bg-slate-800 rounded-xl w-fit">
            {tabs.map(({ key, label, Icon }) => (
              <button key={key} type="button" onClick={() => setTab(key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                  tab === key
                    ? 'bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100 shadow-sm'
                    : 'text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
                }`}>
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>

          {loadingConns ? (
            <div className="flex items-center gap-2 text-sm text-gray-400 dark:text-slate-500">
              <Loader2 size={14} className="animate-spin" /> Loading connections…
            </div>
          ) : (
            <>
              {tab === 'export' && <ExportTab connections={connections} />}
              {tab === 'import' && <ImportTab connections={connections} />}
              {tab === 'sync'   && <SyncTab   connections={connections} />}
            </>
          )}
        </main>
      </div>
    </>
  );
}
