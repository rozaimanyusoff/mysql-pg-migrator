import Head from 'next/head';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import JSZip from 'jszip';
import {
  ChevronRight, UploadCloud, Download, RefreshCw, Play, CheckCircle2,
  XCircle, Loader2, Database, Server, FileCode2, ArrowRightLeft,
  AlertCircle, Table2, ChevronDown, ChevronUp, Copy, Check,
  ArrowRight, Info, FileSpreadsheet, Filter, Clock, Trash2,
  Eye, ShieldAlert, Plus,
} from 'lucide-react';
import type { ConnectionRow } from './api/connections/index';
import type { ConnCfg, ExportInclude, ConflictStrategy, TableInfo } from '../lib/sql-exporter';
import type { HistoryEntry } from './api/export-import/history';
import {
  PG_TYPES, type PgColumnType, type ParsedColumn, type ParsedTable,
  parseExcelFile, generateSeedSqlFromTables,
} from '../lib/excel-parser';

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'export' | 'import' | 'sync';
type ExportFormat = 'sql' | 'csv';

interface LogLine { step: string; ok: boolean; text: string }

interface DryRunSummary {
  total: number; creates: number; inserts: number;
  drops: number; alters: number; truncates: number; updates: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function authHeader() {
  return { Authorization: `Bearer ${localStorage.getItem('auth_token') ?? ''}` };
}

function connToCfg(conn: ConnectionRow, database?: string): ConnCfg {
  return {
    db_type: conn.db_type, host: conn.host, port: conn.port,
    user: conn.username, password: conn.password_enc ?? '',
    database: database ?? conn.database_name, ssl: conn.ssl_enabled,
  };
}

function dbTypeBadge(type: 'mysql' | 'postgres') {
  return type === 'mysql'
    ? 'bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-400'
    : 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400';
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function parseDryRun(sql: string): DryRunSummary {
  const s = sql.toUpperCase();
  return {
    total:     (sql.match(/;/g) ?? []).length,
    creates:   (s.match(/\bCREATE\s+TABLE\b/g) ?? []).length,
    inserts:   (s.match(/\bINSERT\s+(INTO|IGNORE)\b/g) ?? []).length,
    drops:     (s.match(/\bDROP\s+TABLE\b/g) ?? []).length,
    alters:    (s.match(/\bALTER\s+TABLE\b/g) ?? []).length,
    truncates: (s.match(/\bTRUNCATE\b/g) ?? []).length,
    updates:   (s.match(/\bUPDATE\b/g) ?? []).length,
  };
}

async function saveHistory(entry: Partial<HistoryEntry>) {
  try {
    await axios.post('/api/export-import/history', entry, { headers: authHeader() });
  } catch { /* non-critical */ }
}

// ── Connection picker ──────────────────────────────────────────────────────────

function ConnPicker({
  label, connections, value, onChange, filterType,
}: {
  label: string; connections: ConnectionRow[];
  value: number | ''; onChange: (id: number | '') => void;
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
            <button key={c.id} type="button" onClick={() => onChange(c.id === value ? '' : c.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all ${
                value === c.id
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-500'
                  : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 hover:border-gray-300 dark:hover:border-slate-600'
              }`}>
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

function DbSelector({ conn, value, onChange, allowCreate }: {
  conn: ConnectionRow | null; value: string; onChange: (db: string) => void;
  allowCreate?: boolean;
}) {
  const [dbs, setDbs]           = useState<string[]>([]);
  const [loading, setLoading]   = useState(false);
  const [mode, setMode]         = useState<'existing' | 'new'>('existing');
  const [newName, setNewName]   = useState('');
  const [creating, setCreating] = useState(false);
  const [createMsg, setCreateMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async (c: ConnectionRow) => {
    setLoading(true); setDbs([]);
    try {
      if (c.db_type === 'postgres') {
        const { data } = await axios.post('/api/pg-databases', {
          host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '', ssl: c.ssl_enabled,
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

  const handleCreate = async () => {
    if (!conn || !newName.trim()) return;
    setCreating(true); setCreateMsg(null);
    try {
      const { data } = await axios.post('/api/create-database', {
        db_type: conn.db_type, host: conn.host, port: conn.port,
        user: conn.username, password: conn.password_enc ?? '',
        ssl: conn.ssl_enabled, dbName: newName.trim(),
      }, { headers: authHeader() });
      setCreateMsg({ ok: true, text: (data as { message: string }).message });
      await load(conn);
      onChange(newName.trim());
      setMode('existing');
      setNewName('');
    } catch (err: unknown) {
      setCreateMsg({ ok: false, text: axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err) });
    } finally { setCreating(false); }
  };

  if (!conn) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500 dark:text-slate-400">Database</p>
        <div className="flex items-center gap-2">
          {allowCreate && (
            <div className="flex gap-1">
              {(['existing', 'new'] as const).map((m) => (
                <button key={m} type="button"
                  onClick={() => { setMode(m); setCreateMsg(null); }}
                  className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
                    mode === m
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
                      : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300'
                  }`}>
                  {m === 'existing' ? 'Existing' : 'New'}
                </button>
              ))}
            </div>
          )}
          <button type="button" onClick={() => void load(conn)}
            className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300">
            {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          </button>
        </div>
      </div>

      {mode === 'existing' ? (
        <select value={value} onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500">
          {dbs.map((db) => <option key={db} value={db}>{db}</option>)}
        </select>
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input type="text" value={newName}
              onChange={(e) => { setNewName(e.target.value); setCreateMsg(null); }}
              placeholder="new_database_name"
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button type="button" onClick={() => void handleCreate()}
              disabled={creating || !newName.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
              {creating ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              {creating ? 'Creating…' : 'Create'}
            </button>
          </div>
          {createMsg && (
            <p className={`flex items-center gap-1.5 text-xs ${createMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
              {createMsg.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
              {createMsg.text}
            </p>
          )}
          <p className="text-[10px] text-gray-400 dark:text-slate-500">Letters, digits, and underscores only.</p>
        </div>
      )}
    </div>
  );
}

// ── Table selector with row counts ────────────────────────────────────────────

function TableSelector({ conn, database, value, onChange }: {
  conn: ConnectionRow | null; database: string;
  value: string[] | 'all'; onChange: (v: string[] | 'all') => void;
}) {
  const [tableInfos, setTableInfos] = useState<TableInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!conn || !database) { setTableInfos([]); return; }
    void (async () => {
      setLoading(true);
      try {
        const { data } = await axios.post('/api/export-import/tables',
          { cfg: connToCfg(conn, database) }, { headers: authHeader() });
        setTableInfos((data as { tables: TableInfo[] }).tables);
      } catch { setTableInfos([]); }
      finally { setLoading(false); }
    })();
  }, [conn?.id, database]);

  const allSelected = value === 'all';
  const selected = allSelected ? tableInfos.map((t) => t.name) : value;
  const totalRows = tableInfos.reduce((s, t) => s + t.rowCount, 0);
  const hasLarge  = tableInfos.some((t) => t.rowCount > 50_000);

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-medium text-gray-500 dark:text-slate-400">
          Tables {loading && <Loader2 size={10} className="inline animate-spin ml-1" />}
        </p>
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-400 hover:underline">
          {expanded ? 'collapse' : `${allSelected ? tableInfos.length : selected.length} selected`}
          {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
      </div>

      <div className="flex gap-2 mb-2">
        {(['all', 'custom'] as const).map((m) => (
          <button key={m} type="button" onClick={() => onChange(m === 'all' ? 'all' : [])}
            className={`px-2.5 py-1 rounded-lg text-xs border transition-colors ${
              (m === 'all' ? allSelected : !allSelected)
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
                : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300'
            }`}>{m === 'all' ? 'All tables' : 'Custom'}</button>
        ))}
      </div>

      {hasLarge && (
        <div className="flex items-center gap-1.5 mb-2 px-2.5 py-1.5 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 text-[10px] text-amber-700 dark:text-amber-400">
          <ShieldAlert size={11} /> Some tables have &gt;50k rows — export may be slow.
        </div>
      )}

      {expanded && !allSelected && tableInfos.length > 0 && (
        <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden max-h-48 overflow-y-auto">
          {tableInfos.map((t) => (
            <label key={t.name}
              className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/50 cursor-pointer border-b border-gray-100 dark:border-slate-800 last:border-0">
              <input type="checkbox" checked={selected.includes(t.name)}
                onChange={(e) => {
                  const next = e.target.checked ? [...selected, t.name] : selected.filter((x) => x !== t.name);
                  onChange(next);
                }}
                className="accent-blue-600" />
              <Table2 size={11} className="text-gray-400 shrink-0" />
              <span className="text-xs text-gray-700 dark:text-slate-300 font-mono flex-1">{t.name}</span>
              <span className={`text-[10px] font-mono shrink-0 ${t.rowCount > 50_000 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-slate-500'}`}>
                {fmtRows(t.rowCount)}
              </span>
            </label>
          ))}
        </div>
      )}

      {tableInfos.length > 0 && (
        <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1.5">
          {tableInfos.length} table{tableInfos.length !== 1 ? 's' : ''} · {fmtRows(totalRows)} total rows
        </p>
      )}
    </div>
  );
}

// ── Include + format pickers ───────────────────────────────────────────────────

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

function FormatPicker({ value, onChange }: { value: ExportFormat; onChange: (v: ExportFormat) => void }) {
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">Format</p>
      <div className="flex gap-2">
        {([['sql', 'SQL Dump', '.sql file'], ['csv', 'CSV', '.zip with one CSV per table']] as const).map(([v, label, desc]) => (
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

// ── Conflict strategy picker ───────────────────────────────────────────────────

function ConflictPicker({ value, onChange }: { value: ConflictStrategy; onChange: (v: ConflictStrategy) => void }) {
  const opts: { v: ConflictStrategy; label: string; desc: string }[] = [
    { v: 'insert_only',      label: 'INSERT only',        desc: 'Fail if row exists' },
    { v: 'truncate_insert',  label: 'TRUNCATE + INSERT',  desc: 'Clear target tables first' },
    { v: 'upsert',           label: 'Upsert',             desc: 'Skip if row exists' },
  ];
  return (
    <div>
      <p className="text-xs font-medium text-gray-500 dark:text-slate-400 mb-2">Conflict Strategy</p>
      <div className="flex gap-2 flex-wrap">
        {opts.map(({ v, label, desc }) => (
          <button key={v} type="button" onClick={() => onChange(v)}
            className={`px-3 py-1.5 rounded-lg text-xs border transition-colors text-left ${
              value === v
                ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-400'
                : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:border-gray-300'
            }`}>
            <p className="font-medium">{label}</p>
            <p className="text-[10px] opacity-70">{desc}</p>
          </button>
        ))}
      </div>
      {value === 'truncate_insert' && (
        <p className="mt-1.5 text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
          <AlertCircle size={10} /> Target tables will be cleared before inserting.
        </p>
      )}
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
            : isRollback ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
          const Icon = l.ok ? (isInfo ? Info : CheckCircle2) : isRollback ? AlertCircle : XCircle;
          return (
            <div key={i} className={`flex items-start gap-2 ${colorCls}`}>
              <Icon size={12} className="mt-0.5 shrink-0" />
              <span><span className="opacity-50 mr-1.5">[{l.step}]</span>{l.text}</span>
            </div>
          );
        })}
        {running && <div className="flex items-center gap-2 text-gray-400"><Loader2 size={12} className="animate-spin" /> Running…</div>}
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
    setCopied(true); setTimeout(() => setCopied(false), 2000);
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
            className="px-2 py-1 text-[10px] rounded text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700">
            {expanded ? 'Collapse' : 'Preview'}
          </button>
          <button type="button" onClick={copy}
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-700">
            {copied ? <Check size={11} /> : <Copy size={11} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={download}
            className="flex items-center gap-1.5 px-3 py-1 text-[10px] rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700">
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

// ── Dry-run preview modal ──────────────────────────────────────────────────────

function DryRunModal({ sql, onConfirm, onCancel }: {
  sql: string; onConfirm: () => void; onCancel: () => void;
}) {
  const s = parseDryRun(sql);
  const hasDestructive = s.drops > 0 || s.truncates > 0;

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-xl">
        <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100 dark:border-slate-800">
          <Eye size={15} className="text-blue-500" />
          <p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Import Preview</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['Total statements', s.total],
              ['CREATE TABLE', s.creates],
              ['INSERT', s.inserts],
              ['ALTER TABLE', s.alters],
              ['DROP TABLE', s.drops],
              ['TRUNCATE', s.truncates],
            ] as [string, number][]).map(([label, count]) => (
              <div key={label} className={`flex items-center justify-between px-3 py-2 rounded-lg text-xs ${
                (label === 'DROP TABLE' || label === 'TRUNCATE') && count > 0
                  ? 'bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800'
                  : 'bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700'
              }`}>
                <span className="text-gray-600 dark:text-slate-400">{label}</span>
                <span className={`font-semibold font-mono ${count > 0 && (label === 'DROP TABLE' || label === 'TRUNCATE') ? 'text-rose-600 dark:text-rose-400' : 'text-gray-900 dark:text-slate-100'}`}>{count}</span>
              </div>
            ))}
          </div>

          {hasDestructive && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-400">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              This SQL contains destructive statements (DROP / TRUNCATE). Data may be permanently deleted.
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-slate-800">
          <button type="button" onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800">Cancel</button>
          <button type="button" onClick={onConfirm}
            className={`inline-flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium text-white ${hasDestructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
            <Play size={13} /> {hasDestructive ? 'Proceed anyway' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Excel preview modal (for Import tab) ─────────────────────────────────────

function ExcelImportModal({ tables: initial, onApply, onClose }: {
  tables: ParsedTable[];
  onApply: (sql: string) => void;
  onClose: () => void;
}) {
  const [tables, setTables] = useState(initial);
  const [activeSheet, setActive] = useState(initial[0]?.sheetName ?? '');
  const active = tables.find((t) => t.sheetName === activeSheet);

  const updateCol = (sheetName: string, idx: number, patch: Partial<ParsedColumn>) =>
    setTables((prev) => prev.map((t) =>
      t.sheetName === sheetName
        ? { ...t, columns: t.columns.map((c, i) => i === idx ? { ...c, ...patch } : c) }
        : t
    ));

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl max-h-[88vh] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet size={15} className="text-emerald-500" />
            <p className="font-semibold text-sm text-gray-900 dark:text-slate-100">Excel → INSERT Preview</p>
            <span className="text-xs text-gray-400 dark:text-slate-500">{tables.length} sheets</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><XCircle size={16} /></button>
        </div>

        <div className="flex flex-1 min-h-0">
          <nav className="w-40 shrink-0 border-r border-gray-100 dark:border-slate-800 p-2 space-y-1 overflow-y-auto">
            {tables.map((t) => (
              <button key={t.sheetName} type="button" onClick={() => setActive(t.sheetName)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                  activeSheet === t.sheetName
                    ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                }`}>
                <p className="truncate font-medium">{t.sheetName}</p>
                <p className="opacity-60 mt-0.5">{t.rowCount} rows</p>
              </button>
            ))}
          </nav>

          {active && (
            <div className="flex-1 p-4 overflow-y-auto min-w-0 space-y-3">
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Table: <code className="font-mono bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-blue-600 dark:text-blue-400">{active.name}</code>
              </p>
              <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-slate-800/50 border-b border-gray-200 dark:border-slate-700">
                      <th className="text-left px-3 py-2 font-medium text-gray-500 dark:text-slate-400">Column</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-500 dark:text-slate-400">Type</th>
                      <th className="text-center px-3 py-2 font-medium text-gray-500 dark:text-slate-400">Nullable</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                    {active.columns.map((col, i) => (
                      <tr key={i}>
                        <td className="px-3 py-2 font-mono text-gray-700 dark:text-slate-300">{col.originalName}</td>
                        <td className="px-3 py-2">
                          <select value={col.type}
                            onChange={(e) => updateCol(active.sheetName, i, { type: e.target.value as PgColumnType })}
                            className="px-2 py-1 rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-xs text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500">
                            {PG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input type="checkbox" checked={col.nullable}
                            onChange={(e) => updateCol(active.sheetName, i, { nullable: e.target.checked })}
                            className="accent-blue-600" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100 dark:border-slate-800 shrink-0">
          <p className="text-xs text-gray-400 dark:text-slate-500">
            Generates INSERT statements for {tables.reduce((s, t) => s + t.rowCount, 0)} rows
          </p>
          <div className="flex items-center gap-3">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800">Cancel</button>
            <button type="button"
              onClick={() => onApply(generateSeedSqlFromTables(tables))}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
              <CheckCircle2 size={13} /> Apply as SQL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Drag-drop SQL import field ──────────────────────────────────────────────────

function SqlImportField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => onChange(e.target?.result as string ?? '');
    reader.readAsText(file);
  };

  return (
    <div
      className={`relative rounded-xl border-2 border-dashed transition-colors ${dragging ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/20' : 'border-gray-200 dark:border-slate-700'}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) readFile(f); }}
    >
      <textarea value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="Paste SQL here or drag & drop a .sql file…" rows={10}
        className="w-full px-4 py-3 text-xs font-mono bg-transparent rounded-xl text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-y"
      />
      <div className="px-4 pb-3 flex items-center gap-2">
        <button type="button" onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800">
          <UploadCloud size={12} /> Browse .sql
        </button>
        {value && (
          <button type="button" onClick={() => onChange('')}
            className="text-[10px] text-gray-400 hover:text-rose-500">Clear</button>
        )}
        {value.trim() && (
          <span className="ml-auto text-[10px] text-gray-400 dark:text-slate-500 font-mono">
            ~{parseDryRun(value).total} statements
          </span>
        )}
        <input ref={fileRef} type="file" accept=".sql,.txt" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
      </div>
    </div>
  );
}

// ── History panel ──────────────────────────────────────────────────────────────

function HistoryPanel({ tab }: { tab: Tab }) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get('/api/export-import/history', { headers: authHeader() });
      setHistory((data as { history: HistoryEntry[] }).history);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = history.filter((h) => h.operation === tab);

  const handleDelete = async (id: number) => {
    try {
      await axios.delete(`/api/export-import/history?id=${id}`, { headers: authHeader() });
      setHistory((prev) => prev.filter((h) => h.id !== id));
    } catch { /* ignore */ }
  };

  return (
    <aside className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-800 dark:text-slate-200">History</p>
        <button type="button" onClick={() => void load()} disabled={loading}
          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800">
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>

      {filtered.length === 0 && !loading ? (
        <div className="text-center py-8 border border-dashed border-gray-200 dark:border-slate-700 rounded-xl text-xs text-gray-400 dark:text-slate-500">
          No {tab} history yet.
        </div>
      ) : (
        <div className="space-y-2 max-h-[calc(100vh-200px)] overflow-y-auto pr-0.5">
          {filtered.map((h) => (
            <div key={h.id} className={`rounded-xl border text-xs overflow-hidden ${
              h.status === 'success' ? 'border-emerald-200 dark:border-emerald-800/60'
              : h.status === 'failed' ? 'border-rose-200 dark:border-rose-800/60'
              : 'border-gray-200 dark:border-slate-700'
            }`}>
              <div className="flex items-start gap-2 px-3 py-2.5 bg-white dark:bg-slate-900/60">
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                      h.status === 'success' ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
                      : h.status === 'failed' ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400'
                      : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
                    }`}>{h.status}</span>
                    <span className="flex items-center gap-0.5 text-gray-400 dark:text-slate-500">
                      <Clock size={9} />{timeAgo(h.created_at)}
                    </span>
                  </div>

                  {h.source_db && (
                    <p className="text-gray-600 dark:text-slate-400 truncate">
                      <span className="opacity-60">from</span> <span className="font-mono">{h.source_db}</span>
                      {h.target_db && <> → <span className="font-mono">{h.target_db}</span></>}
                    </p>
                  )}

                  <div className="flex items-center gap-2 text-[10px] text-gray-400 dark:text-slate-500">
                    {h.tables_count > 0 && <span>{h.tables_count} table{h.tables_count !== 1 ? 's' : ''}</span>}
                    {h.include && <span>{h.include}</span>}
                    {h.format && h.format !== 'sql' && <span>{h.format.toUpperCase()}</span>}
                    {h.conflict && h.conflict !== 'insert_only' && <span>{h.conflict.replace('_', ' ')}</span>}
                    {h.where_clause && (
                      <span className="flex items-center gap-0.5"><Filter size={8} />filtered</span>
                    )}
                  </div>
                </div>

                <button type="button" onClick={() => void handleDelete(h.id)}
                  className="shrink-0 p-1 text-gray-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

// ── Export tab ─────────────────────────────────────────────────────────────────

function ExportTab({ connections }: { connections: ConnectionRow[] }) {
  const [connId, setConnId]     = useState<number | ''>('');
  const [database, setDatabase] = useState('');
  const [tables, setTables]     = useState<string[] | 'all'>('all');
  const [include, setInclude]   = useState<ExportInclude>('both');
  const [format, setFormat]     = useState<ExportFormat>('sql');
  const [whereClause, setWhere] = useState('');
  const [showFilter, setShowFilter] = useState(false);
  const [running, setRunning]   = useState(false);
  const [result, setResult]     = useState<{ sql: string; tables: string[] } | null>(null);
  const [error, setError]       = useState<string | null>(null);

  const conn = connections.find((c) => c.id === connId) ?? null;

  const handleExport = async () => {
    if (!conn || !database) return;
    setRunning(true); setResult(null); setError(null);
    try {
      const { data } = await axios.post('/api/export-import/export',
        { cfg: connToCfg(conn, database), tables, include, format, whereClause: whereClause.trim() || undefined },
        { headers: authHeader() });

      if (format === 'csv') {
        const csvData = data as { csvFiles: { table: string; csv: string }[]; tables: string[] };
        const zip = new JSZip();
        for (const { table, csv } of csvData.csvFiles) zip.file(`${table}.csv`, csv);
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${database}_${new Date().toISOString().slice(0, 10)}.zip`; a.click();
        URL.revokeObjectURL(url);
        await saveHistory({ operation: 'export', source_label: conn.label, source_db: database, tables_count: csvData.tables.length, include, format: 'csv', where_clause: whereClause.trim() || undefined, status: 'success' });
      } else {
        const sqlData = data as { sql: string; tables: string[] };
        setResult(sqlData);
        await saveHistory({ operation: 'export', source_label: conn.label, source_db: database, tables_count: sqlData.tables.length, include, format: 'sql', where_clause: whereClause.trim() || undefined, status: 'success' });
      }
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      setError(msg);
      await saveHistory({ operation: 'export', source_label: conn.label, source_db: database, tables_count: 0, include, format, status: 'failed' });
    } finally { setRunning(false); }
  };

  const filename = `${database}_${include}_${new Date().toISOString().slice(0, 10)}.sql`;

  return (
    <div className="grid xl:grid-cols-[1fr_280px] gap-6 items-start">
      <div className="space-y-6">
        <div className="grid xl:grid-cols-2 gap-6">
          <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Database size={15} className="text-blue-500" />
              <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Source</p>
            </div>
            <ConnPicker label="Connection" connections={connections} value={connId} onChange={setConnId} />
            <DbSelector conn={conn} value={database} onChange={setDatabase} />
            <TableSelector conn={conn} database={database} value={tables} onChange={setTables} />
          </section>

          <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Download size={15} className="text-blue-500" />
              <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Options</p>
            </div>
            <IncludePicker value={include} onChange={setInclude} />
            <FormatPicker value={format} onChange={setFormat} />

            <div>
              <button type="button" onClick={() => setShowFilter((v) => !v)}
                className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline">
                <Filter size={11} /> {showFilter ? 'Hide' : 'Add'} WHERE filter
              </button>
              {showFilter && (
                <div className="mt-2">
                  <input type="text" value={whereClause} onChange={(e) => setWhere(e.target.value)}
                    placeholder="e.g. created_at > '2025-01-01'"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                  <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">Applied to all data SELECT queries. Leave blank to export all rows.</p>
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-gray-100 dark:border-slate-800 space-y-3">
              <button type="button" onClick={() => void handleExport()} disabled={!conn || !database || running}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {running ? 'Exporting…' : `Export${format === 'csv' ? ' as CSV' : ''}`}
              </button>

              {error && (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs text-rose-700 dark:text-rose-400">
                  <XCircle size={13} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}
              {result && (
                <div className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 size={13} /> Exported {result.tables.length} table{result.tables.length !== 1 ? 's' : ''}
                </div>
              )}
            </div>
          </section>
        </div>

        {result && <SqlPreview sql={result.sql} filename={filename} />}
      </div>

      <HistoryPanel tab="export" />
    </div>
  );
}

// ── Import tab ─────────────────────────────────────────────────────────────────

function ImportTab({ connections }: { connections: ConnectionRow[] }) {
  const [connId, setConnId]         = useState<number | ''>('');
  const [database, setDatabase]     = useState('');
  const [sql, setSql]               = useState('');
  const [inputMode, setInputMode]   = useState<'sql' | 'excel'>('sql');
  const [running, setRunning]       = useState(false);
  const [log, setLog]               = useState<LogLine[]>([]);
  const [status, setStatus]         = useState<'success' | 'failed' | null>(null);
  const [showDryRun, setShowDryRun] = useState(false);
  const [excelTables, setExcelTables] = useState<ParsedTable[] | null>(null);
  const [parsingExcel, setParsingExcel] = useState(false);
  const [excelError, setExcelError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const conn = connections.find((c) => c.id === connId) ?? null;

  const doImport = async () => {
    if (!conn || !database || !sql.trim()) return;
    setRunning(true); setLog([]); setStatus(null);
    try {
      const { data } = await axios.post('/api/export-import/import',
        { cfg: connToCfg(conn, database), sql }, { headers: authHeader() });
      const d = data as { success: boolean; log?: string[] };
      setLog((d.log ?? []).map((t) => ({ step: 'import', ok: d.success, text: t })));
      setStatus(d.success ? 'success' : 'failed');
      await saveHistory({ operation: 'import', target_label: conn.label, target_db: database, status: d.success ? 'success' : 'failed' });
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: string[]; error?: string } | undefined : undefined;
      setLog((d?.log ?? [`[ERROR] ${d?.error ?? String(err)}`]).map((t) => ({ step: 'import', ok: false, text: t })));
      setStatus('failed');
      await saveHistory({ operation: 'import', target_label: conn.label, target_db: database, status: 'failed' });
    } finally { setRunning(false); }
  };

  const handleExcelFile = async (file: File) => {
    if (!/\.xlsx?$/i.test(file.name)) { setExcelError('Upload a .xlsx or .xls file.'); return; }
    setParsingExcel(true); setExcelError(null);
    try {
      const tables = await parseExcelFile(file);
      if (tables.length === 0) { setExcelError('No valid sheets found.'); return; }
      setExcelTables(tables);
    } catch { setExcelError('Failed to parse file.'); }
    finally { setParsingExcel(false); }
  };

  return (
    <div className="grid xl:grid-cols-[1fr_280px] gap-6 items-start">
      <div className="space-y-6">
        <div className="grid xl:grid-cols-2 gap-6">
          <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <UploadCloud size={15} className="text-emerald-500" />
              <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Target</p>
            </div>
            <ConnPicker label="Connection" connections={connections} value={connId} onChange={setConnId} />
            <DbSelector conn={conn} value={database} onChange={setDatabase} allowCreate />
          </section>

          <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileCode2 size={15} className="text-emerald-500" />
                <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">SQL Input</p>
              </div>
              <div className="flex gap-1 p-0.5 bg-gray-100 dark:bg-slate-800 rounded-lg">
                {(['sql', 'excel'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setInputMode(m)}
                    className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium transition-all ${
                      inputMode === m ? 'bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 shadow-sm' : 'text-gray-500 dark:text-slate-400'
                    }`}>
                    {m === 'excel' ? <FileSpreadsheet size={11} /> : <FileCode2 size={11} />}
                    {m === 'sql' ? 'SQL' : 'Excel'}
                  </button>
                ))}
              </div>
            </div>

            {inputMode === 'sql' ? (
              <SqlImportField value={sql} onChange={setSql} />
            ) : (
              <div
                className="flex flex-col items-center justify-center gap-3 py-8 rounded-xl border-2 border-dashed border-gray-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-700 cursor-pointer transition-colors"
                onClick={() => fileRef.current?.click()}>
                {parsingExcel ? (
                  <><Loader2 size={22} className="text-emerald-500 animate-spin" /><p className="text-sm text-gray-400">Parsing…</p></>
                ) : (
                  <>
                    <FileSpreadsheet size={24} className="text-gray-300 dark:text-slate-600" />
                    <p className="text-sm font-medium text-gray-600 dark:text-slate-300">Drop Excel or click to browse</p>
                    <p className="text-xs text-gray-400 dark:text-slate-500">Each sheet becomes INSERT statements</p>
                  </>
                )}
                <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleExcelFile(f); e.target.value = ''; }} />
              </div>
            )}

            {excelError && <p className="text-xs text-rose-500 flex items-center gap-1"><XCircle size={11} />{excelError}</p>}

            <div className="flex items-center gap-3 flex-wrap">
              {sql.trim() && (
                <button type="button" onClick={() => setShowDryRun(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 dark:border-slate-600 text-xs text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800">
                  <Eye size={12} /> Preview
                </button>
              )}
              <button type="button" onClick={() => void doImport()}
                disabled={!conn || !database || !sql.trim() || running}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
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

      <HistoryPanel tab="import" />

      {showDryRun && (
        <DryRunModal sql={sql} onConfirm={() => { setShowDryRun(false); void doImport(); }} onCancel={() => setShowDryRun(false)} />
      )}
      {excelTables && (
        <ExcelImportModal
          tables={excelTables}
          onApply={(s) => { setSql(s); setInputMode('sql'); setExcelTables(null); }}
          onClose={() => setExcelTables(null)}
        />
      )}
    </div>
  );
}

// ── Sync tab ───────────────────────────────────────────────────────────────────

function SyncTab({ connections }: { connections: ConnectionRow[] }) {
  const [srcConnId, setSrcConnId] = useState<number | ''>('');
  const [srcDb, setSrcDb]         = useState('');
  const [tgtConnId, setTgtConnId] = useState<number | ''>('');
  const [tgtDb, setTgtDb]         = useState('');
  const [tables, setTables]       = useState<string[] | 'all'>('all');
  const [include, setInclude]     = useState<ExportInclude>('both');
  const [conflict, setConflict]   = useState<ConflictStrategy>('insert_only');
  const [running, setRunning]     = useState(false);
  const [log, setLog]             = useState<LogLine[]>([]);
  const [status, setStatus]       = useState<'success' | 'failed' | null>(null);

  const srcConn = connections.find((c) => c.id === srcConnId) ?? null;
  const tgtConn = connections.find((c) => c.id === tgtConnId) ?? null;
  const typeMismatch = srcConn && tgtConn && srcConn.db_type !== tgtConn.db_type;

  const handleSync = async () => {
    if (!srcConn || !srcDb || !tgtConn || !tgtDb || typeMismatch) return;
    setRunning(true); setLog([]); setStatus(null);
    try {
      const { data } = await axios.post('/api/export-import/sync',
        { source: connToCfg(srcConn, srcDb), target: connToCfg(tgtConn, tgtDb), tables, include, conflict },
        { headers: authHeader() });
      const d = data as { success: boolean; log: LogLine[]; tables?: string[] };
      setLog(d.log); setStatus(d.success ? 'success' : 'failed');
      await saveHistory({ operation: 'sync', source_label: srcConn.label, source_db: srcDb, target_label: tgtConn.label, target_db: tgtDb, tables_count: d.tables?.length ?? 0, include, conflict, status: d.success ? 'success' : 'failed' });
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: LogLine[] } | undefined : undefined;
      if (d?.log) setLog(d.log);
      else setLog([{ step: 'sync', ok: false, text: `[ERROR] ${String(err)}` }]);
      setStatus('failed');
      await saveHistory({ operation: 'sync', source_label: srcConn.label, source_db: srcDb, target_label: tgtConn.label, target_db: tgtDb, status: 'failed' });
    } finally { setRunning(false); }
  };

  return (
    <div className="grid xl:grid-cols-[1fr_280px] gap-6 items-start">
      <div className="space-y-6">
        <div className="grid xl:grid-cols-[1fr_auto_1fr] gap-4 items-start">
          <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Database size={15} className="text-blue-500" />
              <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Source</p>
            </div>
            <ConnPicker label="Connection" connections={connections} value={srcConnId} onChange={setSrcConnId} />
            <DbSelector conn={srcConn} value={srcDb} onChange={setSrcDb} />
            <TableSelector conn={srcConn} database={srcDb} value={tables} onChange={setTables} />
          </section>

          <div className="flex xl:flex-col items-center justify-center xl:pt-16 gap-2 px-2">
            <ArrowRight size={20} className="text-gray-300 dark:text-slate-600 xl:rotate-0 rotate-90" />
          </div>

          <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
            <div className="flex items-center gap-2">
              <Server size={15} className="text-emerald-500" />
              <p className="font-semibold text-sm text-gray-800 dark:text-slate-200">Target</p>
            </div>
            <ConnPicker label="Connection" connections={connections} value={tgtConnId} onChange={setTgtConnId} />
            <DbSelector conn={tgtConn} value={tgtDb} onChange={setTgtDb} />
          </section>
        </div>

        <section className="rounded-2xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900/60 p-5 space-y-4">
          <IncludePicker value={include} onChange={setInclude} />
          <ConflictPicker value={conflict} onChange={setConflict} />

          {typeMismatch && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-xs text-amber-700 dark:text-amber-400">
              <AlertCircle size={13} className="mt-0.5 shrink-0" />
              Cross-DB sync (MySQL ↔ PostgreSQL) is not supported. Use the <strong className="mx-1">Migration</strong> module.
            </div>
          )}

          <div className="flex items-center gap-3">
            <button type="button" onClick={() => void handleSync()}
              disabled={!srcConn || !srcDb || !tgtConn || !tgtDb || running || !!typeMismatch}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 disabled:opacity-50">
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

      <HistoryPanel tab="sync" />
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

        <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">
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
