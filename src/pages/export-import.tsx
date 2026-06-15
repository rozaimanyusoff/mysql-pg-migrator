'use client';
import Head from 'next/head';
import Link from 'next/link';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import JSZip from 'jszip';
import {
  ChevronRight, UploadCloud, Download, RefreshCw, Play, CheckCircle2,
  XCircle, Loader2, Database, Server, FileCode2, ArrowRightLeft,
  AlertCircle, Table2, Copy, Check, ChevronLeft, ChevronUp, ChevronDown,
  Info, Filter, Clock, Trash2, Save,
  Eye, ShieldAlert, Plus, HelpCircle, BookOpen, X, Replace,
} from 'lucide-react';
import { useAlert } from '../lib/alert-context';
import type { ConnectionRow } from './api/connections/index';
import type { ConnCfg, ExportInclude, ConflictStrategy } from '../lib/sql-exporter';
import type { HistoryEntry } from './api/export-import/history';
import type { AnalyseResult } from './api/export-import/analyse';
import type { ExplorerConn } from '../lib/explorer-db';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';

// ── Types ─────────────────────────────────────────────────────────────────────

type Tab = 'export' | 'import' | 'sync';
type ExportFormat = 'sql' | 'csv';
type ImportStrategy = 'import_rows' | 'replace_schema' | 'replace_db';
interface LogLine { step: string; ok: boolean; text: string; ts?: string }
interface DryRunSummary {
  total: number; creates: number; inserts: number;
  drops: number; alters: number; truncates: number; updates: number;
}
interface TableEntry { schema: string; name: string; rowCount: number; }

// ── Helpers ───────────────────────────────────────────────────────────────────


function connToCfg(conn: ConnectionRow, database?: string): ConnCfg {
  return {
    db_type: conn.db_type, host: conn.host, port: conn.port,
    user: conn.username, password: conn.password_enc ?? '',
    database: database ?? conn.database_name, ssl: conn.ssl_enabled,
  };
}

function connToExplorerConn(conn: ConnectionRow, database: string): ExplorerConn {
  return {
    type: conn.db_type === 'postgres' ? 'postgresql' : 'mysql',
    host: conn.host, port: conn.port,
    username: conn.username, password: conn.password_enc ?? '',
    database,
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
    await axios.post('/api/export-import/history', entry);
  } catch { /* non-critical */ }
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
          <Eye size={17} className="text-blue-500" />
          <p className="font-semibold text-gray-900 dark:text-slate-100 text-base">Import Preview</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['Total statements', s.total], ['CREATE TABLE', s.creates],
              ['INSERT', s.inserts], ['ALTER TABLE', s.alters],
              ['DROP TABLE', s.drops], ['TRUNCATE', s.truncates],
            ] as [string, number][]).map(([label, count]) => (
              <div key={label} className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm ${
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
            <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-sm text-rose-700 dark:text-rose-400">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              This SQL contains destructive statements (DROP / TRUNCATE). Data may be permanently deleted.
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-slate-800">
          <button type="button" onClick={onCancel}
            className="px-4 py-2 rounded-lg text-base text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800">Cancel</button>
          <button type="button" onClick={onConfirm}
            className={`inline-flex items-center gap-2 px-5 py-2 rounded-lg text-base font-medium text-white ${hasDestructive ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
            <Play size={15} /> {hasDestructive ? 'Proceed anyway' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── SQL / dump file drop zone ──────────────────────────────────────────────────

function SqlFileDropZone({ file, onFile, onClear }: {
  file: File | null;
  onFile: (file: File, content: string) => void;
  onClear: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const readFile = (f: File) => {
    const reader = new FileReader();
    reader.onload = (e) => onFile(f, e.target?.result as string ?? '');
    reader.readAsText(f);
  };
  if (file) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-emerald-300 dark:border-emerald-700 bg-emerald-50/50 dark:bg-emerald-950/20">
        <FileCode2 size={22} className="text-emerald-500" />
        <div className="text-center">
          <p className="text-[13px] font-semibold text-gray-800 dark:text-slate-200">{file.name}</p>
          <p className="text-[12px] text-gray-400 dark:text-slate-500 mt-0.5">
            {file.size >= 1024 * 1024
              ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
              : `${(file.size / 1024).toFixed(1)} KB`}
          </p>
        </div>
        <button type="button" onClick={onClear}
          className="flex items-center gap-1.5 px-3 py-1 text-[12px] rounded-lg border border-rose-200 dark:border-rose-800 text-rose-500 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors">
          <X size={11} /> Remove
        </button>
      </div>
    );
  }
  return (
    <div
      className={`h-full flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
        dragging ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/20' : 'border-gray-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-700'
      }`}
      onClick={() => fileRef.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) readFile(f); }}
    >
      <UploadCloud size={22} className={dragging ? 'text-emerald-500' : 'text-slate-400 dark:text-slate-500'} />
      <div className="text-center">
        <p className="text-[13px] font-medium text-gray-600 dark:text-slate-300">Drop .sql or .dump file here</p>
        <p className="text-[12px] text-gray-400 dark:text-slate-500 mt-0.5">or click to browse</p>
      </div>
      <input ref={fileRef} type="file" accept=".sql,.dump,.txt" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ''; }} />
    </div>
  );
}

// ── Log panel ──────────────────────────────────────────────────────────────────

function LogPanel({ lines, running, focusRange }: {
  lines: LogLine[];
  running: boolean;
  focusRange?: [number, number] | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusRange || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-li="${focusRange[0]}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusRange]);

  if (lines.length === 0 && !running) return null;
  return (
    <div className="shrink-0 border-t border-gray-200 dark:border-slate-800">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
        <FileCode2 size={14} className="text-slate-500 dark:text-slate-400" />
        <p className="text-[13px] font-medium text-gray-500 dark:text-slate-400">Execution Log</p>
        {focusRange && (
          <span className="ml-auto text-[12px] text-amber-600 dark:text-amber-400 font-medium">
            showing lines {focusRange[0] + 1}–{focusRange[1]}
          </span>
        )}
      </div>
      <div ref={scrollRef} className="p-3 space-y-1 font-mono text-[12px] max-h-44 sidebar-scroll overflow-y-auto">
        {lines.map((l, i) => {
          const isRollback  = l.text.startsWith('[ROLLBACK]');
          const isInfo      = l.text.startsWith('[START]') || l.text.startsWith('[DONE]') || l.text.startsWith('[INFO]');
          const highlighted = focusRange && i >= focusRange[0] && i < focusRange[1];
          const colorCls    = l.ok
            ? isInfo ? 'text-gray-400 dark:text-slate-500' : 'text-emerald-600 dark:text-emerald-400'
            : isRollback ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
          const Icon = l.ok ? (isInfo ? Info : CheckCircle2) : isRollback ? AlertCircle : XCircle;
          return (
            <div key={i} data-li={i}
              className={`flex items-start gap-1.5 rounded px-1 -mx-1 ${colorCls} ${highlighted ? 'bg-amber-50 dark:bg-amber-950/25 ring-1 ring-amber-300 dark:ring-amber-800' : ''}`}>
              <Icon size={12} className="mt-0.5 shrink-0" />
              <span>
                {l.ts && <span className="opacity-40 mr-1.5 font-mono text-[11px]">{l.ts}</span>}
                <span className="opacity-50 mr-1">[{l.step}]</span>{l.text}
              </span>
            </div>
          );
        })}
        {running && <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400"><Loader2 size={12} className="animate-spin" /> Running…</div>}
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
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="shrink-0 border-t border-gray-200 dark:border-slate-800">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
        <FileCode2 size={14} className="text-emerald-500" />
        <p className="text-[13px] font-medium text-gray-500 dark:text-slate-400">
          SQL Output <span className="opacity-60">({(sql.length / 1024).toFixed(1)} KB)</span>
        </p>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setExpanded(v => !v)}
            className="px-2 py-0.5 text-[12px] rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700">
            {expanded ? 'Collapse' : 'Preview'}
          </button>
          <button type="button" onClick={copy}
            className="flex items-center gap-1 px-2 py-0.5 text-[12px] rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700">
            {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={download}
            className="flex items-center gap-1 px-2.5 py-0.5 text-[12px] rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700">
            <Download size={12} /> Download
          </button>
        </div>
      </div>
      {expanded && (
        <pre className="px-4 py-3 text-[12px] font-mono text-gray-600 dark:text-slate-300 max-h-52 sidebar-scroll overflow-y-auto whitespace-pre-wrap break-words">
          {sql.slice(0, 8000)}{sql.length > 8000 ? '\n… (truncated)' : ''}
        </pre>
      )}
    </div>
  );
}

// ── Cross-DB alert modal ───────────────────────────────────────────────────────

function CrossDbAlertModal({ srcType, tgtType, onClose }: {
  srcType: 'mysql' | 'postgres'; tgtType: 'mysql' | 'postgres'; onClose: () => void;
}) {
  const label = (t: 'mysql' | 'postgres') => t === 'mysql' ? 'MySQL' : 'PostgreSQL';
  return (
    <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 border border-rose-200 dark:border-rose-800 rounded-2xl shadow-2xl">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-rose-100 dark:border-rose-900">
          <AlertCircle size={17} className="text-rose-500 shrink-0" />
          <p className="font-semibold text-base text-gray-900 dark:text-slate-100">Cross-DB Sync Not Supported</p>
        </div>
        <div className="px-5 py-4 space-y-3 text-base text-gray-600 dark:text-slate-300">
          <p>Source and target are different database types:</p>
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-sm font-semibold">
            <span className={srcType === 'mysql' ? 'text-orange-600 dark:text-orange-400' : 'text-blue-600 dark:text-blue-400'}>{label(srcType)}</span>
            <ArrowRightLeft size={14} className="text-rose-400 shrink-0" />
            <span className={tgtType === 'mysql' ? 'text-orange-600 dark:text-orange-400' : 'text-blue-600 dark:text-blue-400'}>{label(tgtType)}</span>
          </div>
          <p className="text-[13px] text-gray-400 dark:text-slate-500">
            Use the <strong className="text-gray-600 dark:text-slate-300">Migration</strong> module to move data between MySQL and PostgreSQL.
          </p>
        </div>
        <div className="px-5 py-4 border-t border-gray-100 dark:border-slate-800 flex justify-end">
          <button onClick={onClose}
            className="px-5 py-2 rounded-lg text-base font-medium bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors">
            OK, understood
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Guide Popover ──────────────────────────────────────────────────────────────

function GuidePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as HTMLElement)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const pill = (text: string) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[12px] font-semibold bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200 border border-gray-200 dark:border-slate-700">{text}</span>
  );
  const h3 = 'flex items-center gap-1.5 text-sm font-semibold text-gray-800 dark:text-slate-100';
  const sec = 'mt-2 space-y-1.5 text-[13px] text-gray-600 dark:text-slate-300 leading-relaxed';
  const sep = 'border-t border-gray-100 dark:border-slate-800';

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors border ${open
          ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
          : 'text-gray-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 border-transparent hover:border-blue-200 dark:hover:border-blue-800'}`}
      >
        <HelpCircle size={15} /> Guide
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[420px] max-h-[74vh] flex flex-col bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="shrink-0 flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 dark:border-slate-800">
            <BookOpen size={16} className="text-blue-500" />
            <p className="flex-1 font-semibold text-base text-gray-900 dark:text-slate-100">Data Maintenance Guide</p>
            <button onClick={() => setOpen(false)} className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={16} /></button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-[13px]">

            <div>
              <p className={h3}><Info size={14} className="text-blue-500" /> Navigation</p>
              <div className={sec}>
                <p>Use the <strong>5-panel flow</strong> left to right: pick a connection → database → schema → tables. Then click the action button in the toolbar.</p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li><strong>Panel 1</strong> — saved connections. Click to select one.</li>
                  <li><strong>Panel 2</strong> — databases for the selected connection. Auto-loads on connection select.</li>
                  <li><strong>Panel 3</strong> — schemas (PostgreSQL only). Filters the table list. "All" shows every table.</li>
                  <li><strong>Panel 4</strong> — table selection + action workspace (input / result / log).</li>
                  <li><strong>Saved Jobs</strong> (right, collapsible) — history of past operations.</li>
                </ul>
              </div>
            </div>

            <div className={sep} />

            <div>
              <p className={h3}><Download size={14} className="text-blue-500" /> Export</p>
              <div className={sec}>
                <p>Select connection → database → schema → tables, then configure options in the toolbar and click {pill('Export')}.</p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li><strong>Include</strong> — Schema+Data (DDL + rows), Schema only (DDL), Data only (INSERTs).</li>
                  <li><strong>Format</strong> — SQL (.sql file) or CSV (.zip, one file per table).</li>
                  <li><strong>WHERE filter</strong> — optional clause applied to all data SELECT queries.</li>
                </ul>
                <p>SQL output appears below the table list with Copy and Download options.</p>
              </div>
            </div>

            <div className={sep} />

            <div>
              <p className={h3}><UploadCloud size={14} className="text-emerald-500" /> Import</p>
              <div className={sec}>
                <p>Select <strong>target</strong> connection → database, then drop or browse a file. Click {pill('Import')} (or {pill('Preview')} first).</p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li>Accepts <strong>.sql</strong> and <strong>.dump</strong> files — drag & drop or click to browse.</li>
                  <li>{pill('Import Rows')} — execute SQL as-is (default, safest).</li>
                  <li>{pill('Replace Schema')} — wipe the schema first (PG: DROP/CREATE public, MySQL: drop all tables), then import.</li>
                  <li>{pill('Replace DB')} — drop and recreate the entire database, then import.</li>
                  <li>{pill('Preview')} — shows a dry-run breakdown (CREATE/INSERT/DROP counts) before executing.</li>
                </ul>
                <p className="text-[12px] text-gray-400 dark:text-slate-500">Panels 3 (Schema) and 4 (Tables) are not applicable for Import — table selection comes from the SQL file itself.</p>
              </div>
            </div>

            <div className={sep} />

            <div>
              <p className={h3}><ArrowRightLeft size={14} className="text-violet-500" /> Sync</p>
              <div className={sec}>
                <p>Copy data from a source database to a target database of the <strong>same type</strong> (MySQL→MySQL or PG→PG).</p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li>Source — select in panels 1–4 as usual.</li>
                  <li>Target — pick connection and database in the target section of Panel 4.</li>
                  <li><strong>Conflict Strategy</strong>: INSERT only (fail if row exists), TRUNCATE+INSERT (clear first), Upsert (skip duplicates).</li>
                  <li>Cross-DB sync (MySQL ↔ PostgreSQL) is not supported — use the Migration module instead.</li>
                </ul>
              </div>
            </div>

            <div className={sep} />

            <div>
              <p className={h3}><Clock size={14} className="text-slate-500 dark:text-slate-400" /> Saved Jobs</p>
              <div className={sec}>
                <p>Every completed Export, Import, or Sync operation is saved automatically. Click the chevron notch on the right edge to collapse/expand the panel.</p>
                <p>Each entry shows status, timestamp, source/target databases, table count, format, and conflict strategy. Click {pill('×')} to delete an entry.</p>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

// ── Panel 1: Connections ───────────────────────────────────────────────────────

function ConnectionsPanel({ connections, value, onChange, label, tgtValue, onTgtChange }: {
  connections: ConnectionRow[];
  value: number | '';
  onChange: (id: number | '') => void;
  label?: string;
  tgtValue?: number | '';
  onTgtChange?: (id: number | '') => void;
}) {
  const isDual = tgtValue !== undefined && onTgtChange !== undefined;

  const renderList = (
    selected: number | '',
    onSelect: (id: number | '') => void,
    accent: 'blue' | 'violet',
  ) => (
    <div className="flex-1 sidebar-scroll overflow-y-auto p-2 space-y-1">
      {connections.length === 0 ? (
        <p className="text-[13px] text-gray-400 dark:text-slate-500 text-center py-6 italic">
          No saved connections.<br />
          <Link href="/settings" className="text-blue-500 hover:underline not-italic">Add one →</Link>
        </p>
      ) : (
        connections.map((c) => {
          const active = selected === c.id;
          const sel = accent === 'blue'
            ? 'border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950/30'
            : 'border-violet-400 dark:border-violet-600 bg-violet-50 dark:bg-violet-950/30';
          const selIcon = accent === 'blue' ? 'text-blue-500' : 'text-violet-500';
          const selText = accent === 'blue' ? 'text-blue-700 dark:text-blue-300' : 'text-violet-700 dark:text-violet-300';
          return (
            <button key={c.id} type="button"
              onClick={() => onSelect(c.id === selected ? '' : c.id)}
              className={`w-full flex items-start gap-2 px-2.5 py-2 rounded-lg text-left transition-all border ${
                active ? sel : 'border-transparent hover:bg-gray-50 dark:hover:bg-slate-800/60'
              }`}>
              <Database size={14} className={`mt-0.5 shrink-0 ${active ? selIcon : 'text-slate-500 dark:text-slate-400'}`} />
              <div className="flex-1 min-w-0">
                <p className={`text-[13px] font-medium truncate ${active ? selText : 'text-gray-800 dark:text-slate-200'}`}>{c.label}</p>
                <p className="text-[12px] text-gray-400 dark:text-slate-500 truncate font-mono">{c.host}:{c.port}</p>
              </div>
              <span className={`text-[11px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${dbTypeBadge(c.db_type)}`}>
                {c.db_type === 'mysql' ? 'MySQL' : 'PG'}
              </span>
            </button>
          );
        })
      )}
    </div>
  );

  return (
    <div className="w-52 shrink-0 border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
      {isDual ? (
        <>
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-gray-200 dark:border-slate-800">
            <Server size={14} className="text-blue-500 shrink-0" />
            <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-200">Source</span>
          </div>
          {renderList(value, onChange, 'blue')}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/30">
            <Server size={14} className="text-violet-500 shrink-0" />
            <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-200">Target</span>
          </div>
          {renderList(tgtValue!, onTgtChange!, 'violet')}
        </>
      ) : (
        <>
          <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800">
            <Server size={14} className="text-blue-500 shrink-0" />
            <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-200">{label ?? 'Connection'}</span>
            {connections.length > 0 && (
              <span className="ml-auto text-[12px] font-mono text-gray-400 dark:text-slate-500">{connections.length}</span>
            )}
          </div>
          {renderList(value, onChange, 'blue')}
        </>
      )}
    </div>
  );
}

// ── Panel 2: Databases ─────────────────────────────────────────────────────────

function DatabasePanel({ conn, value, onChange, allowCreate, syncProgress, tgtConn, tgtValue, onTgtChange, onItemContextMenu }: {
  conn: ConnectionRow | null;
  value: string;
  onChange: (db: string) => void;
  allowCreate?: boolean;
  syncProgress?: { current: number; total: number; label: string } | null;
  tgtConn?: ConnectionRow | null;
  tgtValue?: string;
  onTgtChange?: (db: string) => void;
  onItemContextMenu?: (e: React.MouseEvent, dbName: string) => void;
}) {
  const [dbs, setDbs]           = useState<string[]>([]);
  const [loading, setLoading]   = useState(false);
  const [tgtDbs, setTgtDbs]     = useState<string[]>([]);
  const [tgtLoading, setTgtLoading] = useState(false);
  const [showNew, setShowNew]   = useState(false);
  const [newName, setNewName]   = useState('');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState<string | null>(null);

  const load = useCallback(async (c: ConnectionRow) => {
    setLoading(true); setDbs([]);
    try {
      if (c.db_type === 'postgres') {
        const { data } = await axios.post('/api/pg-databases',
          { host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '', ssl: c.ssl_enabled });
        setDbs((data as { databases: string[] }).databases);
      } else {
        const { data } = await axios.post('/api/list-databases',
          { host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '' });
        setDbs((data as { databases: string[] }).databases);
      }
    } catch { setDbs([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (conn) void load(conn); else { setDbs([]); onChange(''); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id]);

  useEffect(() => {
    if (dbs.length > 0 && !value) onChange(dbs[0]);
  }, [dbs, value, onChange]);

  const loadTgt = useCallback(async (c: ConnectionRow) => {
    setTgtLoading(true); setTgtDbs([]);
    try {
      if (c.db_type === 'postgres') {
        const { data } = await axios.post('/api/pg-databases',
          { host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '', ssl: c.ssl_enabled });
        setTgtDbs((data as { databases: string[] }).databases);
      } else {
        const { data } = await axios.post('/api/list-databases',
          { host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '' });
        setTgtDbs((data as { databases: string[] }).databases);
      }
    } catch { setTgtDbs([]); }
    finally { setTgtLoading(false); }
  }, []);

  useEffect(() => {
    if (tgtConn) void loadTgt(tgtConn); else setTgtDbs([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgtConn?.id]);

  useEffect(() => {
    if (tgtDbs.length > 0 && onTgtChange && !tgtValue) onTgtChange(tgtDbs[0]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgtDbs]);

  const handleCreate = async () => {
    if (!conn || !newName.trim()) return;
    setCreating(true); setCreateErr(null);
    try {
      await axios.post('/api/create-database', {
        db_type: conn.db_type, host: conn.host, port: conn.port,
        user: conn.username, password: conn.password_enc ?? '', ssl: conn.ssl_enabled, dbName: newName.trim(),
      });
      await load(conn); onChange(newName.trim()); setShowNew(false); setNewName('');
    } catch (err: unknown) {
      setCreateErr(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally { setCreating(false); }
  };

  const pct = syncProgress
    ? Math.round((syncProgress.current / Math.max(syncProgress.total, 1)) * 100)
    : null;

  return (
    <div className="w-full h-full bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800">
        <Database size={14} className="text-purple-500 shrink-0" />
        <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-200">Database</span>
        {conn && (
          <button type="button" onClick={() => void load(conn)} title="Refresh"
            className="ml-auto p-0.5 text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300">
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
          </button>
        )}
      </div>
      <div className="flex-1 sidebar-scroll overflow-y-auto">
        {!conn ? (
          <p className="text-[13px] text-gray-400 dark:text-slate-500 text-center py-8 italic px-2">Select a connection first</p>
        ) : (
          <div className="p-2 space-y-0.5">
            {dbs.map(db => {
              const active = value === db;
              return (
                <div key={db}>
                  <button type="button" onClick={() => onChange(db)}
                    onContextMenu={onItemContextMenu ? e => { e.preventDefault(); e.stopPropagation(); onItemContextMenu(e, db); } : undefined}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                      active
                        ? 'bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300'
                        : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800/60'
                    }`}>
                    <Database size={12} className={active ? 'text-purple-400 shrink-0' : 'text-slate-400 dark:text-slate-500 shrink-0'} />
                    <span className="text-[13px] font-mono truncate flex-1">{db}</span>
                    {active && pct !== null && (
                      <span className="text-[11px] font-mono text-violet-500 dark:text-violet-400 shrink-0">{pct}%</span>
                    )}
                  </button>
                  {active && pct !== null && (
                    <div className="mx-2.5 mt-0.5 h-1 rounded-full bg-gray-100 dark:bg-slate-800 overflow-hidden">
                      <div className="h-full bg-violet-500 rounded-full transition-all duration-300" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Target database list (sync tab only) */}
      {tgtConn && onTgtChange && (
        <>
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/30">
            <Database size={13} className="text-violet-500 shrink-0" />
            <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-200">Target DB</span>
            <button type="button" onClick={() => void loadTgt(tgtConn)} title="Refresh"
              className="ml-auto p-0.5 text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300">
              {tgtLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            </button>
          </div>
          <div className="flex-1 sidebar-scroll overflow-y-auto">
            {tgtDbs.length === 0 && !tgtLoading ? (
              <p className="text-[13px] text-gray-400 dark:text-slate-500 text-center py-6 italic px-2">
                {tgtConn ? 'No databases found' : 'Select target connection'}
              </p>
            ) : (
              <div className="p-2 space-y-0.5">
                {tgtDbs.map(db => {
                  const active = tgtValue === db;
                  return (
                    <button key={db} type="button" onClick={() => onTgtChange(db)}
                      className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                        active
                          ? 'bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300'
                          : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800/60'
                      }`}>
                      <Database size={12} className={active ? 'text-violet-400 shrink-0' : 'text-slate-400 dark:text-slate-500 shrink-0'} />
                      <span className="text-[13px] font-mono truncate flex-1">{db}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {allowCreate && conn && (
        <div className="shrink-0 border-t border-gray-100 dark:border-slate-800 p-2">
          {showNew ? (
            <div className="space-y-1.5">
              <input type="text" value={newName} onChange={e => { setNewName(e.target.value); setCreateErr(null); }}
                placeholder="new_db_name" autoFocus
                className="w-full px-2 py-1.5 text-[13px] font-mono rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              {createErr && <p className="text-[12px] text-rose-500">{createErr}</p>}
              <div className="flex gap-1">
                <button type="button" onClick={() => void handleCreate()} disabled={creating || !newName.trim()}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[12px] rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                  {creating ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Create
                </button>
                <button type="button" onClick={() => { setShowNew(false); setCreateErr(null); setNewName(''); }}
                  className="px-2 py-1.5 text-[12px] rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setShowNew(true)}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[13px] text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
              <Plus size={13} /> New Database…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Panel 3: Schemas ───────────────────────────────────────────────────────────

function SchemaPanel({ conn, database, value, onChange, tgtConn, tgtDatabase, tgtValue, onTgtChange, onItemContextMenu }: {
  conn: ConnectionRow | null;
  database: string;
  value: string;
  onChange: (s: string) => void;
  tgtConn?: ConnectionRow | null;
  tgtDatabase?: string;
  tgtValue?: string;
  onTgtChange?: (s: string) => void;
  onItemContextMenu?: (e: React.MouseEvent, schemaName: string) => void;
}) {
  const [schemas,    setSchemas]    = useState<{ schema: string; tableCount: number }[]>([]);
  const [loading,    setLoading]    = useState(false);
  const [tgtSchemas, setTgtSchemas] = useState<{ schema: string; tableCount: number }[]>([]);
  const [tgtLoading, setTgtLoading] = useState(false);

  const load = useCallback(async (c: ConnectionRow, db: string) => {
    setLoading(true); setSchemas([]);
    try {
      const { data } = await axios.post('/api/schema-explorer/schemas', connToExplorerConn(c, db));
      setSchemas((data as { schemas: { schema: string; tableCount: number }[] }).schemas);
    } catch { setSchemas([]); }
    finally { setLoading(false); }
  }, []);

  const loadTgt = useCallback(async (c: ConnectionRow, db: string) => {
    setTgtLoading(true); setTgtSchemas([]);
    try {
      const { data } = await axios.post('/api/schema-explorer/schemas', connToExplorerConn(c, db));
      setTgtSchemas((data as { schemas: { schema: string; tableCount: number }[] }).schemas);
    } catch { setTgtSchemas([]); }
    finally { setTgtLoading(false); }
  }, []);

  useEffect(() => {
    if (conn && database) void load(conn, database);
    else { setSchemas([]); onChange(''); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, database]);

  useEffect(() => {
    if (tgtConn && tgtDatabase) void loadTgt(tgtConn, tgtDatabase);
    else { setTgtSchemas([]); onTgtChange?.(''); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tgtConn?.id, tgtDatabase]);

  const isPg    = conn?.db_type    === 'postgres';
  const isTgtPg = tgtConn?.db_type === 'postgres';
  const isDual  = !!(tgtConn && onTgtChange);

  const renderList = (
    items: { schema: string; tableCount: number }[],
    selected: string,
    onSelect: (s: string) => void,
    accent: 'teal' | 'violet',
    isLoading: boolean,
    onCtx?: (e: React.MouseEvent, schemaName: string) => void,
  ) => (
    <div className="flex-1 sidebar-scroll overflow-y-auto">
      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 size={14} className="animate-spin text-slate-500 dark:text-slate-400" /></div>
      ) : items.length === 0 ? (
        <p className="text-[12px] text-gray-400 dark:text-slate-500 text-center py-6 italic px-2">No schemas found</p>
      ) : (
        <div className="p-2 space-y-0.5">
          {items.map(s => {
            const active = selected === s.schema;
            const cls = accent === 'teal'
              ? 'bg-teal-50 dark:bg-teal-950/30 text-teal-700 dark:text-teal-300'
              : 'bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300';
            return (
              <button key={s.schema} type="button" onClick={() => onSelect(s.schema)}
                onContextMenu={onCtx ? e => { e.preventDefault(); e.stopPropagation(); onCtx(e, s.schema); } : undefined}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                  active ? cls : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800/60'
                }`}>
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-mono truncate">{s.schema}</p>
                  <p className="text-[11px] text-gray-400 dark:text-slate-500">{s.tableCount} tables</p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="w-full h-full bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
      {/* Source schema header */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800">
        <Server size={14} className={isPg ? 'text-teal-500 shrink-0' : 'text-slate-400 dark:text-slate-500 shrink-0'} />
        <span className={`text-[13px] font-semibold ${isPg ? 'text-gray-700 dark:text-slate-200' : 'text-gray-400 dark:text-slate-600'}`}>
          {isDual ? 'Source Schema' : 'Schema'}
        </span>
        {loading && <Loader2 size={12} className="animate-spin text-slate-500 dark:text-slate-400 ml-auto" />}
      </div>

      {!isPg ? (
        <p className="text-[12px] text-gray-400 dark:text-slate-600 text-center py-8 px-2 italic">PostgreSQL only</p>
      ) : !conn || !database ? (
        <p className="text-[12px] text-gray-400 dark:text-slate-500 text-center py-8 italic px-2">Select a DB first</p>
      ) : renderList(schemas, value, onChange, 'teal', loading, onItemContextMenu)}

      {/* Target schema section (sync only) */}
      {isDual && (
        <>
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/30">
            <Server size={13} className="text-violet-500 shrink-0" />
            <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-200">Target Schema</span>
            {tgtLoading && <Loader2 size={12} className="animate-spin text-slate-500 dark:text-slate-400 ml-auto" />}
          </div>
          {!isTgtPg ? (
            <p className="text-[12px] text-gray-400 dark:text-slate-600 text-center py-6 px-2 italic">PostgreSQL only</p>
          ) : !tgtConn || !tgtDatabase ? (
            <p className="text-[12px] text-gray-400 dark:text-slate-500 text-center py-6 italic px-2">Select target DB first</p>
          ) : renderList(tgtSchemas, tgtValue ?? '', onTgtChange, 'violet', tgtLoading)}
        </>
      )}
    </div>
  );
}

// ── Panel 5: Saved Jobs (collapsible) ─────────────────────────────────────────

const OP_BADGE: Record<string, string> = {
  export:  'bg-blue-100 dark:bg-blue-950/60 text-blue-700 dark:text-blue-400',
  import:  'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400',
  sync:    'bg-violet-100 dark:bg-violet-950/60 text-violet-700 dark:text-violet-400',
  replace: 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400',
};

function HistoryCard({ h, onDelete }: { h: HistoryEntry; onDelete: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const connLabel = h.source_label ?? h.target_label;
  const db = h.source_db ?? h.target_db;
  const statusCls = h.status === 'success'
    ? 'text-emerald-600 dark:text-emerald-400'
    : h.status === 'failed'
    ? 'text-rose-500 dark:text-rose-400'
    : 'text-gray-400 dark:text-slate-500';

  return (
    <div className={`rounded-lg border p-2 transition-colors bg-white dark:bg-slate-800/50 ${
      h.status === 'success' ? 'border-emerald-200 dark:border-emerald-800/50'
      : h.status === 'failed' ? 'border-rose-200 dark:border-rose-800/50'
      : 'border-gray-200 dark:border-slate-700'
    }`}>
      {/* Row 1: operation badge + status icon */}
      <div className="flex items-center gap-1 mb-0.5">
        <span className={`shrink-0 inline-flex px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide ${OP_BADGE[h.operation] ?? OP_BADGE.export}`}>
          {h.operation}
        </span>
        <p className="text-[13px] font-medium text-gray-800 dark:text-slate-200 flex-1 truncate">
          {connLabel}
        </p>
        <span className={`shrink-0 text-[12px] font-semibold ${statusCls}`}>
          {h.status === 'success' ? <CheckCircle2 size={13} /> : h.status === 'failed' ? <XCircle size={13} /> : null}
        </span>
      </div>
      {/* Row 2: db path */}
      {db && (
        <p className="text-[12px] font-mono text-gray-400 dark:text-slate-500 truncate mb-0.5">
          {db}{h.target_db && h.source_db ? <> → {h.target_db}</> : null}
        </p>
      )}
      {/* Row 3: count + date + expand */}
      <div className="flex items-center gap-1 mb-1">
        <p className="text-[12px] text-gray-400 dark:text-slate-500 flex-1">
          {h.tables_count > 0 ? `${h.tables_count} table${h.tables_count !== 1 ? 's' : ''}` : '—'}
          {' · '}{timeAgo(h.created_at)}
        </p>
        <button onClick={() => setExpanded(v => !v)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors">
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </div>
      {/* Expanded: meta detail */}
      {expanded && (
        <div className="mb-1.5 border border-gray-100 dark:border-slate-700 rounded px-2 py-1.5 space-y-0.5">
          {h.format && <p className="text-[12px] text-gray-500 dark:text-slate-400">Format: <span className="font-medium uppercase">{h.format}</span></p>}
          {h.include && <p className="text-[12px] text-gray-500 dark:text-slate-400">Include: {h.include.replace(/_/g, ' ')}</p>}
          {h.conflict && h.conflict !== 'insert_only' && <p className="text-[12px] text-gray-500 dark:text-slate-400">Conflict: {h.conflict.replace(/_/g, ' ')}</p>}
          {h.where_clause && <p className="text-[12px] font-mono text-gray-500 dark:text-slate-400 truncate" title={h.where_clause}>WHERE {h.where_clause}</p>}
        </div>
      )}
      {/* Row 4: actions */}
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onDelete(h.id)}
          className="ml-auto p-1 rounded text-gray-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function SavedJobsPanel({ collapsed, onToggle, refreshKey }: {
  collapsed: boolean; onToggle: () => void; refreshKey: number;
}) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<string>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get('/api/export-import/history');
      setHistory((data as { history: HistoryEntry[] }).history);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const handleDelete = async (id: number) => {
    try {
      await axios.delete(`/api/export-import/history?id=${id}`);
      setHistory(prev => prev.filter(h => h.id !== id));
    } catch { /* ignore */ }
  };

  const visible = filter === 'all' ? history : history.filter(h => h.operation === filter);

  return (
    <div className={`shrink-0 flex flex-col border-l border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden transition-[width] duration-200 ease-in-out ${collapsed ? 'w-9' : 'w-80'}`}>
      {/* Header — always visible */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-2.5 border-b border-gray-200 dark:border-slate-800">
        {!collapsed && <Save size={13} className="text-slate-500 dark:text-slate-400 shrink-0" />}
        {!collapsed && <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-300 flex-1 truncate">Saved Jobs</span>}
        {!collapsed && history.length > 0 && <span className="text-[12px] text-gray-400 shrink-0">{visible.length}/{history.length}</span>}
        <button onClick={onToggle}
          className="shrink-0 p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 transition-colors ml-auto">
          {collapsed ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Filter chips */}
          <div className="shrink-0 flex items-center gap-1 px-2 py-1.5 border-b border-gray-100 dark:border-slate-800">
            {(['all', 'export', 'import', 'sync', 'replace'] as const).map(op => (
              <button key={op} onClick={() => setFilter(op)}
                className={`px-1.5 py-0.5 rounded text-[11px] font-medium uppercase tracking-wide transition-colors ${
                  filter === op
                    ? (op === 'all' ? 'bg-gray-200 dark:bg-slate-700 text-gray-700 dark:text-slate-200'
                      : OP_BADGE[op])
                    : 'text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300'
                }`}>
                {op}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-auto panel-scroll p-2 space-y-1.5">
            {loading ? (
              <div className="flex justify-center py-6"><Loader2 size={14} className="animate-spin text-slate-400 dark:text-slate-500" /></div>
            ) : visible.length === 0 ? (
              <div className="py-8 text-center">
                <Save size={24} className="mx-auto text-slate-400 dark:text-slate-500 mb-2" />
                <p className="text-[13px] text-gray-400 dark:text-slate-500">No {filter === 'all' ? '' : filter + ' '}jobs yet.</p>
              </div>
            ) : visible.map(h => (
              <HistoryCard key={h.id} h={h} onDelete={id => void handleDelete(id)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function ExportImportPage() {
  const [tab, setTab] = useState<Tab>('export');
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [loadingConns, setLoadingConns] = useState(true);

  // Source (Export / Sync source / Import target)
  const [connId, setConnId]     = useState<number | ''>('');
  const [database, setDatabase] = useState('');
  const [schema, setSchema]     = useState('');

  // Tables
  const [tableList, setTableList]       = useState<TableEntry[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [selectedTables, setSelectedTables] = useState<string[] | 'all'>('all');

  // Sync target
  const [tgtConnId, setTgtConnId]     = useState<number | ''>('');
  const [tgtDatabase, setTgtDatabase] = useState('');
  const [tgtSchema, setTgtSchema]     = useState('');
  const [analyseResult, setAnalyseResult] = useState<AnalyseResult | null>(null);
  const [analysing, setAnalysing]     = useState(false);

  // Export options
  const [exportInclude, setExportInclude]   = useState<ExportInclude>('both');
  const [syncInclude, setSyncInclude]       = useState<ExportInclude>('both');
  const [replaceInclude, setReplaceInclude] = useState<ExportInclude>('both');
  const [format, setFormat]         = useState<ExportFormat>('sql');
  const [whereClause, setWhere]     = useState('');
  const [showFilter, setShowFilter] = useState(false);

  // Import
  const [importSql, setImportSql]           = useState('');
  const [importFile, setImportFile]         = useState<File | null>(null);
  const [importStrategy, setImportStrategy] = useState<ImportStrategy>('import_rows');
  const [showDryRun, setShowDryRun]         = useState(false);

  // Sync
  const [conflict, setConflict] = useState<ConflictStrategy>('insert_only');
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [showCrossDbAlert, setShowCrossDbAlert] = useState(false);
  const [tableSyncStatus, setTableSyncStatus] = useState<Record<string, 'syncing' | 'done' | 'error'>>({});
  const [tableLogRanges, setTableLogRanges] = useState<Record<string, [number, number]>>({});
  const [focusRange, setFocusRange] = useState<[number, number] | null>(null);

  // Execution state
  const [running, setRunning]       = useState(false);
  const [log, setLog]               = useState<LogLine[]>([]);
  const [runStatus, setRunStatus]   = useState<'success' | 'failed' | null>(null);
  const [exportResult, setExportResult] = useState<{ sql: string; tables: string[] } | null>(null);
  const [error, setError]           = useState<string | null>(null);

  // Saved Jobs panel
  const [jobsCollapsed, setJobsCollapsed] = useState(false);
  const [jobsRefreshKey, setJobsRefreshKey] = useState(0);
  const [pendingJobEntry, setPendingJobEntry] = useState<Partial<HistoryEntry> | null>(null);
  const [jobSaved, setJobSaved] = useState(false);

  // Context menu (right-click on table rows)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; scope: 'table' | 'schema' | 'db' | null; name: string | null } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  const conn    = connections.find(c => c.id === connId) ?? null;
  const tgtConn = connections.find(c => c.id === tgtConnId) ?? null;

  const { showConfirm } = useAlert();

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtxMenu(null); };
    const onDown = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) setCtxMenu(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
  }, [ctxMenu]);

  // Show alert when sync source/target DB types differ
  const typeMismatchRef = useRef(false);
  useEffect(() => {
    const mismatch = !!(tab === 'sync' && conn && tgtConn && conn.db_type !== tgtConn.db_type);
    if (mismatch && !typeMismatchRef.current) setShowCrossDbAlert(true);
    typeMismatchRef.current = mismatch;
  }, [tab, conn?.db_type, tgtConn?.db_type]);

  // Load connections
  useEffect(() => {
    void (async () => {
      setLoadingConns(true);
      try {
        const { data } = await axios.get('/api/connections');
        const conns = (data as { connections: ConnectionRow[] }).connections;
        setConnections(conns);
        setConnId(prev => prev !== '' ? prev : (conns.find(c => c.is_active)?.id ?? ''));
      } catch { /* ignore */ }
      finally { setLoadingConns(false); }
    })();
  }, []);

  // Load table list when conn/db/schema changes
  useEffect(() => {
    if (!conn || !database) { setTableList([]); return; }
    void (async () => {
      setTablesLoading(true);
      try {
        const explorerConn = connToExplorerConn(conn, database);
        const { data } = await axios.post('/api/schema-explorer/tables',
          { conn: explorerConn, schemas: schema ? [schema] : undefined });
        setTableList((data as { tables: TableEntry[] }).tables);
      } catch { setTableList([]); }
      finally { setTablesLoading(false); }
    })();
  }, [conn?.id, database, schema]);

  // Auto-switch import strategy when schema selection changes
  useEffect(() => {
    if (tab !== 'import') return;
    if (importStrategy === 'replace_db' && schema) setImportStrategy('replace_schema');
    else if (importStrategy === 'replace_schema' && !schema) setImportStrategy('replace_db');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, schema]);

  // Reset results when switching tabs
  const handleTabChange = (t: Tab) => {
    setTab(t); setLog([]); setRunStatus(null); setExportResult(null); setError(null);
    setTableSyncStatus({}); setTableLogRanges({}); setFocusRange(null);
    setPendingJobEntry(null); setJobSaved(false);
  };

  const handleSaveJob = async () => {
    if (!pendingJobEntry) return;
    await saveHistory(pendingJobEntry);
    setJobSaved(true);
    setJobsRefreshKey(k => k + 1);
  };

  // Export
  const handleExport = async () => {
    if (!conn || !database) return;
    setRunning(true); setExportResult(null); setError(null); setLog([]);
    setPendingJobEntry(null); setJobSaved(false);
    const tablesToExport = selectedTables === 'all' ? 'all' : selectedTables.map(t => t.split('.').pop() ?? t);
    try {
      const { data } = await axios.post('/api/export-import/export',
        { cfg: connToCfg(conn, database), tables: tablesToExport, include: exportInclude, format, whereClause: whereClause.trim() || undefined });

      if (format === 'csv') {
        const csvData = data as { csvFiles: { table: string; csv: string }[]; tables: string[] };
        const zip = new JSZip();
        for (const { table, csv } of csvData.csvFiles) zip.file(`${table}.csv`, csv);
        const blob = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${database}_${new Date().toISOString().slice(0, 10)}.zip`; a.click();
        URL.revokeObjectURL(url);
        setRunStatus('success');
        setPendingJobEntry({ operation: 'export', source_label: conn.label, source_db: database, tables_count: csvData.tables.length, include: exportInclude, format: 'csv', where_clause: whereClause.trim() || undefined, status: 'success' });
      } else {
        const sqlData = data as { sql: string; tables: string[] };
        setExportResult(sqlData); setRunStatus('success');
        const blob = new Blob([sqlData.sql], { type: 'text/sql' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${database}_${schema || 'public'}_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.sql`; a.click();
        URL.revokeObjectURL(url);
        setPendingJobEntry({ operation: 'export', source_label: conn.label, source_db: database, tables_count: sqlData.tables.length, include: exportInclude, format: 'sql', where_clause: whereClause.trim() || undefined, status: 'success' });
      }
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      setError(msg); setRunStatus('failed');
    } finally { setRunning(false); }
  };

  // Import
  const doImport = async () => {
    if (!conn || !database || !importSql.trim()) return;
    setRunning(true); setLog([]); setRunStatus(null); setError(null);
    setPendingJobEntry(null); setJobSaved(false);
    try {
      const { data } = await axios.post('/api/export-import/import',
        { cfg: connToCfg(conn, database), sql: importSql, strategy: importStrategy });
      const d = data as { success: boolean; log?: string[] };
      setLog((d.log ?? []).map(t => ({ step: 'import', ok: d.success, text: t })));
      setRunStatus(d.success ? 'success' : 'failed');
      if (d.success) setPendingJobEntry({ operation: 'import', target_label: conn.label, target_db: database, status: 'success' });
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: string[]; error?: string } | undefined : undefined;
      setLog((d?.log ?? [`[ERROR] ${d?.error ?? String(err)}`]).map(t => ({ step: 'import', ok: false, text: t })));
      setRunStatus('failed');
    } finally { setRunning(false); }
  };

  // Core per-table sync call — pure, no state side effects
  const doSyncTable = async (table: string): Promise<{ ok: boolean; logs: LogLine[] }> => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    try {
      const { data } = await axios.post('/api/export-import/sync', {
        source: connToCfg(conn!, database),
        target: connToCfg(tgtConn!, tgtDatabase || database),
        tables: [table], include: syncInclude, conflict,
      });
      const d = data as { success: boolean; log: LogLine[] };
      return { ok: d.success, logs: d.log.map(l => ({ ...l, ts })) };
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: LogLine[] } | undefined : undefined;
      const logs = (d?.log ?? [{ step: 'sync', ok: false, text: `[ERROR] ${table}: ${String(err)}` }]).map(l => ({ ...l, ts }));
      return { ok: false, logs };
    }
  };

  // Sync all selected tables in sequence (overrideTables bypasses selectedTables state)
  const handleSync = async (overrideTables?: string[]) => {
    if (!conn || !database || !tgtConn) return;
    setRunning(true); setLog([]); setRunStatus(null); setError(null); setSyncProgress(null);
    setTableSyncStatus({}); setTableLogRanges({}); setFocusRange(null);
    setPendingJobEntry(null); setJobSaved(false);
    const tables = overrideTables ?? (selectedTables === 'all'
      ? tableList.map(t => t.name)
      : selectedTables.map(t => t.split('.').pop() ?? t));

    if (tables.length === 0) {
      setLog([{ step: 'sync', ok: false, text: '[ERROR] No tables available to sync — load the table list first, or select at least one table.' }]);
      setRunStatus('failed'); setRunning(false); return;
    }

    let allLogs: LogLine[] = [];
    const ranges: Record<string, [number, number]> = {};
    let allOk = true;

    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      setSyncProgress({ current: i, total: tables.length, label: table });
      setTableSyncStatus(prev => ({ ...prev, [table]: 'syncing' }));

      const startIdx = allLogs.length;
      const { ok, logs } = await doSyncTable(table);
      allLogs = [...allLogs, ...logs];
      ranges[table] = [startIdx, allLogs.length];

      setTableSyncStatus(prev => ({ ...prev, [table]: ok ? 'done' : 'error' }));
      setTableLogRanges({ ...ranges });
      setLog([...allLogs]);
      if (!ok) allOk = false;
      setSyncProgress({ current: i + 1, total: tables.length, label: table });
    }

    setRunStatus(allOk ? 'success' : 'failed');
    setSyncProgress(null);
    if (allOk) {
      setPendingJobEntry({ operation: 'sync', source_label: conn.label, source_db: database, target_label: tgtConn.label, target_db: tgtDatabase || database, tables_count: tables.length, include: syncInclude, conflict, status: 'success' });
    }
    setRunning(false);
    // Refresh analyse diff panel after batch sync so row counts reflect reality
    if (analyseResult) void refreshAnalyseSilent(conn, tgtConn);
  };

  // Sync a single table — called from per-table button
  const handleSyncSingle = async (tableName: string) => {
    if (!conn || !database || !tgtConn || running) return;
    setRunning(true); setRunStatus(null);
    setTableSyncStatus(prev => ({ ...prev, [tableName]: 'syncing' }));

    const { ok, logs } = await doSyncTable(tableName);

    setLog(prev => {
      const startIdx = prev.length;
      const next = [...prev, ...logs];
      setTableLogRanges(r => ({ ...r, [tableName]: [startIdx, next.length] }));
      return next;
    });
    setTableSyncStatus(prev => ({ ...prev, [tableName]: ok ? 'done' : 'error' }));
    setRunStatus(ok ? 'success' : 'failed');
    setRunning(false);
    // Refresh analyse diff so inline row counts update after per-table sync
    if (ok && analyseResult) void refreshAnalyseSilent(conn, tgtConn);
  };

  // Replace — per-table call (drop + recreate on target from source)
  const doReplaceTable = async (table: string): Promise<{ ok: boolean; logs: LogLine[] }> => {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    try {
      const { data } = await axios.post('/api/export-import/replace', {
        source: connToCfg(conn!, database),
        target: connToCfg(tgtConn!, tgtDatabase || database),
        tables: [table], include: replaceInclude,
      });
      const d = data as { success: boolean; log: LogLine[] };
      return { ok: d.success, logs: d.log.map(l => ({ ...l, ts })) };
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: LogLine[] } | undefined : undefined;
      const logs = (d?.log ?? [{ step: 'replace', ok: false, text: `[ERROR] ${table}: ${String(err)}` }]).map(l => ({ ...l, ts }));
      return { ok: false, logs };
    }
  };

  const handleReplace = async (overrideTables?: string[]) => {
    if (!conn || !database || !tgtConn) return;
    const tables = overrideTables ?? (selectedTables === 'all'
      ? tableList.map(t => t.name)
      : selectedTables.map(t => t.split('.').pop() ?? t));

    if (tables.length === 0) {
      setLog([{ step: 'replace', ok: false, text: '[ERROR] No tables available to replace — load the table list first.' }]);
      setRunStatus('failed'); return;
    }

    showConfirm({
      title: 'Replace target tables?',
      description: `This will DROP and recreate ${tables.length} table(s) in "${tgtDatabase || database}" from source "${database}". All existing target data in these tables will be lost.`,
      confirmLabel: 'Replace',
      onConfirm: async () => {
        setRunning(true); setLog([]); setRunStatus(null); setError(null);
        setTableSyncStatus({}); setTableLogRanges({}); setFocusRange(null);

        let allLogs: LogLine[] = [];
        const ranges: Record<string, [number, number]> = {};
        let allOk = true;

        for (let i = 0; i < tables.length; i++) {
          const table = tables[i];
          setSyncProgress({ current: i, total: tables.length, label: table });
          setTableSyncStatus(prev => ({ ...prev, [table]: 'syncing' }));

          const startIdx = allLogs.length;
          const { ok, logs } = await doReplaceTable(table);
          allLogs = [...allLogs, ...logs];
          ranges[table] = [startIdx, allLogs.length];

          setTableSyncStatus(prev => ({ ...prev, [table]: ok ? 'done' : 'error' }));
          setTableLogRanges({ ...ranges });
          setLog([...allLogs]);
          if (!ok) allOk = false;
          setSyncProgress({ current: i + 1, total: tables.length, label: table });
        }

        setRunStatus(allOk ? 'success' : 'failed');
        setSyncProgress(null);
        if (allOk) {
          await saveHistory({ operation: 'replace', source_label: conn!.label, source_db: database, target_label: tgtConn!.label, target_db: tgtDatabase || database, tables_count: tables.length, include: replaceInclude, status: 'success' });
          setJobsRefreshKey(k => k + 1);
        }
        setRunning(false);
        if (analyseResult) void refreshAnalyseSilent(conn, tgtConn);
      },
    });
  };

  // Analyse — compare source vs target schema before sync
  const handleAnalyse = async () => {
    if (!conn || !database || !tgtConn || !(tgtDatabase || database)) return;
    setAnalysing(true); setAnalyseResult(null);
    try {
      const { data } = await axios.post('/api/export-import/analyse', {
        source: connToCfg(conn, database),
        target: connToCfg(tgtConn, tgtDatabase || database),
        sourceSchema: schema || 'public',
        targetSchema: tgtSchema || 'public',
      });
      setAnalyseResult(data as AnalyseResult);
    } catch { /* ignore */ }
    finally { setAnalysing(false); }
  };

  // Silent analyse refresh — updates row counts without clearing the panel
  const refreshAnalyseSilent = async (connRef: typeof conn, tgtConnRef: typeof tgtConn) => {
    if (!connRef || !database || !tgtConnRef || !(tgtDatabase || database)) return;
    try {
      const { data } = await axios.post('/api/export-import/analyse', {
        source: connToCfg(connRef, database),
        target: connToCfg(tgtConnRef, tgtDatabase || database),
        sourceSchema: schema || 'public',
        targetSchema: tgtSchema || 'public',
      });
      setAnalyseResult(data as AnalyseResult);
    } catch { /* ignore */ }
  };

  // Toolbar run
  const handleRun = () => {
    if (tab === 'export') void handleExport();
    else if (tab === 'import') { if (importSql.trim()) setShowDryRun(true); }
    else if (tab === 'sync') void handleSync();
  };

  const canRun = !running && conn && database && (
    tab === 'import' ? importSql.trim() :
    tab === 'sync'   ? tgtConn && conn.db_type === tgtConn.db_type :
    true
  );

  const canAnalyse = !running && !analysing && tab === 'sync' && conn && database && tgtConn && (tgtDatabase || database);

  // Table list rendering helpers
  const allSelected = selectedTables === 'all';
  const selectedArr = allSelected ? tableList.map(t => `${t.schema}.${t.name}`) : selectedTables;
  const hasLarge = tableList.some(t => t.rowCount > 50_000);

  const exportFilename = `${database}_${schema || 'public'}_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.sql`;

  // Segmented control style
  const seg = (active: boolean) =>
    `px-2 py-1 text-[12px] rounded border transition-colors ${active ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`;

  // Tooltip wrapper for toolbar seg buttons
  const BtnTip = ({ tip, children }: { tip: string; children: React.ReactNode }) => {
    const [show, setShow] = useState(false);
    return (
      <span className="relative inline-flex"
        onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
        {children}
        {show && (
          <span className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-[100] whitespace-nowrap bg-gray-900 dark:bg-slate-700 text-white text-[12px] leading-snug px-2 py-1 rounded shadow-lg pointer-events-none">
            {tip}
          </span>
        )}
      </span>
    );
  };

  return (
    <>
      <Head><title>Data Maintenance — DB Maintenance Tools</title></Head>
      <div className="h-[calc(100vh-48px)] flex flex-col bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* ── Toolbar ── */}
        <div className="shrink-0 flex items-center gap-2 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-1.5 flex-wrap">

          {/* Module identity (compact, replaces separate header) */}
          <div className="flex items-center gap-1.5 mr-1 shrink-0">
            <UploadCloud size={15} className="text-emerald-500 shrink-0" />
            <div className="leading-none">
              <p className="text-[13px] font-bold text-gray-800 dark:text-slate-100 leading-none">Data Maintenance</p>
              <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-0.5 leading-none">Backup · Import · Sync · Copy</p>
            </div>
          </div>

          <div className="w-px h-6 bg-gray-200 dark:bg-slate-700 mx-1 shrink-0" />

          {/* Tab buttons */}
          {([
            { key: 'export' as Tab, label: 'Export', Icon: Download },
            { key: 'import' as Tab, label: 'Import', Icon: UploadCloud },
            { key: 'sync'   as Tab, label: 'Sync',   Icon: ArrowRightLeft },
          ]).map(({ key, label, Icon }) => (
            <button key={key} type="button" onClick={() => handleTabChange(key)}
              className={`self-stretch inline-flex items-center gap-1.5 px-3 text-[13px] font-medium border-b-2 transition-colors ${
                tab === key
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
              }`}>
              <Icon size={13} /> {label}
            </button>
          ))}

          <div className="w-px h-4 bg-gray-200 dark:bg-slate-700 mx-0.5 shrink-0" />

          {/* Export options */}
          {tab === 'export' && (
            <>
              <div className="flex items-center gap-1">
                <span className="text-[12px] text-gray-400 dark:text-slate-500 mr-0.5">Include</span>
                {([
                  { v: 'both'   as ExportInclude, label: 'Schema+Data' },
                  { v: 'schema' as ExportInclude, label: 'Schema'      },
                  { v: 'data'   as ExportInclude, label: 'Data'        },
                ]).map(({ v, label }) => (
                  <button key={v} onClick={() => setExportInclude(v)} className={seg(exportInclude === v)}>{label}</button>
                ))}
              </div>
              <div className="w-px h-4 bg-gray-200 dark:bg-slate-700 mx-0.5 shrink-0" />
              <div className="flex items-center gap-1">
                <span className="text-[12px] text-gray-400 dark:text-slate-500 mr-0.5">Format</span>
                {(['sql', 'csv'] as ExportFormat[]).map(v => (
                  <button key={v} onClick={() => setFormat(v)} className={`${seg(format === v)} uppercase`}>{v}</button>
                ))}
              </div>
              <BtnTip tip="WHERE filter — applies a WHERE clause to all data SELECT queries">
                <button onClick={() => setShowFilter(v => !v)}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[12px] rounded border transition-colors ${showFilter ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400' : 'border-gray-200 dark:border-slate-700 text-gray-400 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
                  <Filter size={12} /> Filter
                </button>
              </BtnTip>
            </>
          )}

          {/* Import options — file accepted shown as static hint */}
          {tab === 'import' && (
            <span className="text-[12px] text-gray-400 dark:text-slate-500 italic select-none">.sql · .dump</span>
          )}

          {/* Sync options — removed from toolbar; use right-click context menu on tables instead */}
          {tab === 'sync' && (
            <BtnTip tip="Right-click any table to set conflict strategy and copy/replace options">
              <span className="text-[12px] text-gray-400 dark:text-slate-500 cursor-default select-none italic">right-click table for options</span>
            </BtnTip>
          )}

          {/* Run button */}
          <div className="ml-auto flex items-center gap-2">
            {tab === 'import' && importSql.trim() && (
              <button type="button" onClick={() => setShowDryRun(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[13px] rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                <Eye size={13} /> Preview
              </button>
            )}
            {tab === 'sync' && (
              <button type="button" onClick={() => void handleAnalyse()} disabled={!canAnalyse}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[13px] rounded-lg border border-teal-400 dark:border-teal-700 text-teal-700 dark:text-teal-400 bg-transparent hover:bg-teal-50 dark:hover:bg-teal-900/20 disabled:opacity-40 transition-colors">
                {analysing ? <Loader2 size={13} className="animate-spin" /> : <ShieldAlert size={13} />}
                {analysing ? 'Analysing…' : 'Analyse'}
              </button>
            )}
            {runStatus && (
              <span className={`inline-flex items-center gap-1 text-[13px] font-medium ${runStatus === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                {runStatus === 'success' ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                {runStatus === 'success'
                  ? (tab === 'export' ? 'Exported' : tab === 'import' ? 'Imported' : 'Synced')
                  : 'Failed'}
              </span>
            )}
            {/* Optional save — only offered after success */}
            {runStatus === 'success' && pendingJobEntry && !jobSaved && (
              <button type="button" onClick={() => void handleSaveJob()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[13px] rounded-lg border border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition-colors">
                <Save size={13} /> Save Job
              </button>
            )}
            {runStatus === 'success' && jobSaved && (
              <span className="inline-flex items-center gap-1 text-[13px] text-gray-400 dark:text-slate-500">
                <CheckCircle2 size={13} /> Saved
              </span>
            )}
            <button type="button" onClick={handleRun} disabled={!canRun}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors disabled:opacity-40 ${
                tab === 'export' ? 'border border-blue-500 text-blue-600 dark:text-blue-400 bg-transparent hover:bg-blue-50 dark:hover:bg-blue-900/20' :
                tab === 'import' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' :
                'border border-violet-500 text-violet-600 dark:text-violet-400 bg-transparent hover:bg-violet-50 dark:hover:bg-violet-900/20'
              }`}>
              {running
                ? <Loader2 size={13} className="animate-spin" />
                : tab === 'export' ? <Download size={13} /> : tab === 'import' ? <UploadCloud size={13} /> : <ArrowRightLeft size={13} />}
              {running
                ? (tab === 'export' ? 'Exporting…' : tab === 'import' ? 'Importing…' : 'Syncing…')
                : (tab === 'export' ? `Export${format === 'csv' ? ' CSV' : ''}` : tab === 'import' ? 'Import' : 'Sync')}
            </button>
            <GuidePopover />
          </div>
        </div>

        {/* ── WHERE filter row (Export only) ── */}
        {tab === 'export' && showFilter && (
          <div className="shrink-0 flex items-center gap-2 border-b border-gray-200 dark:border-slate-800 bg-amber-50 dark:bg-amber-950/10 px-4 py-2">
            <Filter size={13} className="text-amber-500 shrink-0" />
            <input type="text" value={whereClause} onChange={e => setWhere(e.target.value)}
              placeholder="WHERE clause applied to all SELECT queries  (e.g.  created_at > '2025-01-01')"
              className="flex-1 text-[13px] font-mono bg-transparent text-gray-800 dark:text-slate-200 placeholder-gray-400 dark:placeholder-slate-600 focus:outline-none" />
            <button onClick={() => { setShowFilter(false); setWhere(''); }}
              className="text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={14} /></button>
          </div>
        )}

        {/* ── 5-Panel Content ── */}
        {loadingConns ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-base text-gray-400 dark:text-slate-500">
            <Loader2 size={16} className="animate-spin" /> Loading connections…
          </div>
        ) : (
          <div className="flex flex-1 overflow-hidden">

            {/* Panel 1: Connections */}
            <ConnectionsPanel
              connections={connections}
              value={connId}
              onChange={id => { setConnId(id); setDatabase(''); setSchema(''); setSelectedTables('all'); }}
              label={tab === 'import' ? 'Target Conn' : 'Connection'}
              tgtValue={tab === 'sync' ? tgtConnId : undefined}
              onTgtChange={tab === 'sync' ? (id) => { setTgtConnId(id); setTgtDatabase(''); setTgtSchema(''); setAnalyseResult(null); } : undefined}
            />

            {/* Panels 2, 3, 4: Resizable group */}
            <div className="flex-1 h-full overflow-hidden">
              <PanelGroup orientation="horizontal" className="h-full">
                <Panel defaultSize={24} minSize={12}>
                  <div className="h-full" onContextMenu={e => { if (tab !== 'import') { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, scope: null, name: null }); } }}>
                    <DatabasePanel
                      conn={conn}
                      value={database}
                      onChange={db => { setDatabase(db); setSchema(''); setSelectedTables('all'); }}
                      allowCreate={tab === 'import'}
                      syncProgress={syncProgress}
                      tgtConn={tab === 'sync' ? tgtConn : undefined}
                      tgtValue={tab === 'sync' ? tgtDatabase : undefined}
                      onTgtChange={tab === 'sync' ? setTgtDatabase : undefined}
                      onItemContextMenu={tab === 'sync' ? (e, dbName) => setCtxMenu({ x: e.clientX, y: e.clientY, scope: 'db', name: dbName }) : undefined}
                    />
                  </div>
                </Panel>
                <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors" />
                <Panel defaultSize={18} minSize={8}>
                  <div className="h-full" onContextMenu={e => { if (tab !== 'import') { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, scope: null, name: null }); } }}>
                    <SchemaPanel
                      conn={conn}
                      database={database}
                      value={schema}
                      onChange={s => { setSchema(s); setSelectedTables('all'); setAnalyseResult(null); }}
                      tgtConn={tab === 'sync' ? tgtConn : undefined}
                      tgtDatabase={tab === 'sync' ? tgtDatabase : undefined}
                      tgtValue={tab === 'sync' ? tgtSchema : undefined}
                      onTgtChange={tab === 'sync' ? (s) => { setTgtSchema(s); setAnalyseResult(null); } : undefined}
                      onItemContextMenu={tab === 'sync' ? (e, schemaName) => setCtxMenu({ x: e.clientX, y: e.clientY, scope: 'schema', name: schemaName }) : undefined}
                    />
                  </div>
                </Panel>
                <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors" />
                <Panel defaultSize={58} minSize={30}>

            {/* Panel 4: Tables + Workspace */}
            <div className="h-full flex flex-col overflow-hidden min-w-0 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-800">

              {/* Panel 4 header */}
              <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800">
                <Table2 size={14} className="text-blue-500 shrink-0" />
                <span className="text-[13px] font-semibold text-gray-700 dark:text-slate-200">
                  {tab === 'import' ? 'Import' : 'Tables'}
                </span>
                {tab !== 'import' && tableList.length > 0 && (
                  <span className="text-[12px] text-gray-400 dark:text-slate-500">{tableList.length} tables</span>
                )}
                {tablesLoading && <Loader2 size={12} className="animate-spin text-slate-500 dark:text-slate-400 ml-1" />}
                {tab !== 'import' && tableList.length > 0 && !tablesLoading && (
                  <div className="ml-auto flex items-center gap-1">
                    {tab === 'sync' && analyseResult && (
                      <button type="button"
                        onClick={() => {
                          const diffKeys = analyseResult.rows
                            .filter(r => r.status !== 'match' && r.status !== 'target_only')
                            .map(r => { const t = tableList.find(tl => tl.name === r.name); return t ? `${t.schema}.${t.name}` : null; })
                            .filter(Boolean) as string[];
                          setSelectedTables(diffKeys);
                        }}
                        className="px-2 py-0.5 text-[12px] rounded border border-amber-400 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition-colors">
                        Select diff
                      </button>
                    )}
                    {(['all', 'custom'] as const).map(m => (
                      <button key={m} type="button"
                        onClick={() => setSelectedTables(m === 'all' ? 'all' : [])}
                        className={`px-2 py-0.5 text-[12px] rounded border transition-colors ${
                          (m === 'all' ? allSelected : !allSelected)
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                            : 'border-gray-200 dark:border-slate-700 text-gray-400 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800'
                        }`}>{m === 'all' ? 'All' : 'Custom'}</button>
                    ))}
                  </div>
                )}
              </div>


              {/* Table list (Export/Sync) */}
              {tab !== 'import' && (
                <>
                  {hasLarge && (
                    <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 text-[12px] text-amber-700 dark:text-amber-400">
                      <ShieldAlert size={12} /> Some tables have &gt;50k rows — export may be slow.
                    </div>
                  )}
                  {!conn || !database ? (
                    <div className="flex-1 flex items-center justify-center text-[13px] text-gray-400 dark:text-slate-500 italic">
                      Select a connection and database to load tables
                    </div>
                  ) : tableList.length === 0 && !tablesLoading ? (
                    <div className="flex-1 flex items-center justify-center text-[13px] text-gray-400 dark:text-slate-500 italic">
                      No tables found{schema ? ` in schema "${schema}"` : ''}
                    </div>
                  ) : (
                    <div className="flex-1 sidebar-scroll overflow-y-auto">
                      <div className="divide-y divide-gray-100 dark:divide-slate-800">
                        {/* Normal table rows — with optional analyse diff columns in sync tab */}
                        {tableList.map(t => {
                          const key = `${t.schema}.${t.name}`;
                          const isChecked = allSelected || selectedArr.includes(key);
                          const diff = tab === 'sync' && analyseResult
                            ? analyseResult.rows.find(r => r.name === t.name)
                            : null;
                          const syncSt = tab === 'sync' ? tableSyncStatus[t.name] : undefined;
                          const hasError = syncSt === 'error';
                          const logRange = tableLogRanges[t.name];
                          return (
                            <label key={key}
                              className={`group flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/50 cursor-pointer ${hasError ? 'bg-rose-50/50 dark:bg-rose-950/10' : ''}`}
                              onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, scope: 'table', name: t.name }); }}>

                              {/* Sync status indicator (replaces checkbox area when status is set) */}
                              {syncSt === 'syncing' && <Loader2 size={12} className="animate-spin text-violet-500 shrink-0" />}
                              {syncSt === 'done'    && <CheckCircle2 size={12} className="text-emerald-500 shrink-0" />}
                              {syncSt === 'error'   && (
                                <button type="button"
                                  title="Click to see error in log"
                                  onClick={e => { e.preventDefault(); if (logRange) { setFocusRange(logRange); } }}
                                  className="shrink-0">
                                  <XCircle size={12} className="text-rose-500" />
                                </button>
                              )}
                              {!syncSt && (
                                <input type="checkbox" checked={isChecked} className="accent-blue-600 shrink-0"
                                  onChange={e => {
                                    if (allSelected) {
                                      const all = tableList.map(x => `${x.schema}.${x.name}`);
                                      setSelectedTables(e.target.checked ? all : all.filter(x => x !== key));
                                    } else {
                                      const next = e.target.checked ? [...selectedArr, key] : selectedArr.filter(x => x !== key);
                                      setSelectedTables(next);
                                    }
                                  }} />
                              )}

                              <Table2 size={12} className={`shrink-0 ${hasError ? 'text-rose-400' : 'text-slate-500 dark:text-slate-400'}`} />
                              <span className={`text-[13px] font-mono flex-1 truncate ${hasError ? 'text-rose-600 dark:text-rose-400' : 'text-gray-700 dark:text-slate-300'}`}>{t.name}</span>
                              {t.schema !== 'public' && (
                                <span className="text-[11px] text-gray-400 dark:text-slate-500 font-mono shrink-0">{t.schema}</span>
                              )}

                              {/* Diff columns from analyse */}
                              {diff ? (
                                <span className="flex items-center gap-1 shrink-0">
                                  <span className="text-[12px] font-mono text-gray-400 dark:text-slate-500">{fmtRows(t.rowCount)}</span>
                                  <span className="text-[11px] text-gray-300 dark:text-slate-600">→</span>
                                  <span className={`text-[12px] font-mono ${diff.targetRows === null ? 'text-rose-400' : 'text-gray-400 dark:text-slate-500'}`}>
                                    {diff.targetRows !== null ? fmtRows(diff.targetRows) : '—'}
                                  </span>
                                  {diff.status === 'match'
                                    ? <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                                    : diff.status === 'diff'
                                    ? <AlertCircle size={11} className="text-amber-500 shrink-0" />
                                    : <Info size={11} className="text-blue-400 shrink-0" />}
                                </span>
                              ) : (
                                <span className={`text-[12px] font-mono shrink-0 ${t.rowCount > 50_000 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-slate-500'}`}>
                                  {fmtRows(t.rowCount)}
                                </span>
                              )}

                              {/* Per-table sync button (sync tab, hover, not while running) */}
                              {tab === 'sync' && !running && (
                                <button type="button"
                                  title="Sync this table"
                                  onClick={e => { e.preventDefault(); void handleSyncSingle(t.name); }}
                                  className="opacity-0 group-hover:opacity-100 ml-0.5 p-0.5 rounded text-violet-500 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-opacity shrink-0">
                                  <ArrowRightLeft size={11} />
                                </button>
                              )}
                            </label>
                          );
                        })}
                        {/* Target-only tables (exist in target but not source) */}
                        {tab === 'sync' && analyseResult && analyseResult.rows
                          .filter(r => r.status === 'target_only')
                          .map(r => (
                            <div key={`tgt:${r.name}`} className="flex items-center gap-2.5 px-3 py-2 opacity-50">
                              <div className="w-3.5 h-3.5 shrink-0" />
                              <Table2 size={12} className="text-violet-400 shrink-0" />
                              <span className="text-[13px] font-mono text-violet-500 dark:text-violet-400 flex-1 truncate">{r.name}</span>
                              <span className="text-[11px] font-medium text-violet-400 shrink-0">target only</span>
                              <span className="text-[12px] font-mono text-gray-400 dark:text-slate-500 shrink-0">
                                {r.targetRows !== null ? fmtRows(r.targetRows) : '—'}
                              </span>
                            </div>
                          ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Import: file drop zone + contextual action selector */}
              {tab === 'import' && (() => {
                const secondAction = schema
                  ? { v: 'replace_schema' as ImportStrategy, label: 'Replace Schema', desc: `Wipe schema "${schema || 'public'}" first`, Icon: AlertCircle, activeClass: 'border-amber-500 bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-300', iconClass: 'text-amber-500' }
                  : { v: 'replace_db'     as ImportStrategy, label: 'Replace DB',     desc: `Drop & recreate "${database || '—'}"`,      Icon: ShieldAlert, activeClass: 'border-rose-500 bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-300',     iconClass: 'text-rose-500'   };
                return (
                  <div className="flex-1 flex flex-col overflow-hidden p-3 gap-3">
                    {/* Drop zone — fixed compact height */}
                    <div className="shrink-0 h-28">
                      <SqlFileDropZone
                        file={importFile}
                        onFile={(f, content) => { setImportFile(f); setImportSql(content); setRunStatus(null); setLog([]); }}
                        onClear={() => { setImportFile(null); setImportSql(''); setRunStatus(null); setLog([]); }}
                      />
                    </div>
                    {/* Contextual action selector */}
                    <div className="shrink-0 space-y-1.5">
                      <p className="text-[12px] font-medium text-gray-500 dark:text-slate-400">Action</p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {([
                          { v: 'import_rows' as ImportStrategy, label: 'Import Rows', desc: 'Execute SQL as-is', Icon: UploadCloud, activeClass: 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300', iconClass: 'text-emerald-500' },
                          secondAction,
                        ]).map(({ v, label, desc, Icon, activeClass, iconClass }) => {
                          const active = importStrategy === v;
                          return (
                            <button key={v} type="button" onClick={() => setImportStrategy(v)}
                              className={`flex flex-col items-start gap-1 px-3 py-2.5 rounded-xl border-2 transition-colors ${
                                active ? activeClass : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                              }`}>
                              <Icon size={13} className={active ? iconClass : 'text-gray-400 dark:text-slate-500'} />
                              <p className="text-[12px] font-semibold leading-none mt-0.5">{label}</p>
                              <p className="text-[11px] opacity-60 leading-none mt-0.5 truncate max-w-full">{desc}</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Error */}
              {error && (
                <div className="shrink-0 flex items-start gap-2 mx-3 mb-2 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-[13px] text-rose-700 dark:text-rose-400">
                  <XCircle size={14} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}

              {/* SQL result (Export) */}
              {tab === 'export' && exportResult && (
                <SqlPreview sql={exportResult.sql} filename={exportFilename} />
              )}

              {/* Log (Import/Sync) */}
              {tab !== 'export' && <LogPanel lines={log} running={running} focusRange={tab === 'sync' ? focusRange : null} />}
            </div>
                </Panel>
              </PanelGroup>
            </div>

            {/* Panel 5: Saved Jobs */}
            <SavedJobsPanel
              collapsed={jobsCollapsed}
              onToggle={() => setJobsCollapsed(v => !v)}
              refreshKey={jobsRefreshKey}
            />
          </div>
        )}

        {/* Modals */}
        {showCrossDbAlert && conn && tgtConn && (
          <CrossDbAlertModal
            srcType={conn.db_type}
            tgtType={tgtConn.db_type}
            onClose={() => setShowCrossDbAlert(false)}
          />
        )}
        {showDryRun && (
          <DryRunModal sql={importSql}
            onConfirm={() => { setShowDryRun(false); void doImport(); }}
            onCancel={() => setShowDryRun(false)} />
        )}


        {/* Right-click context menu on table rows */}
        {ctxMenu && (
          <div ref={ctxMenuRef}
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            className="fixed z-[200] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl py-1.5 min-w-[220px]"
            onContextMenu={e => e.preventDefault()}>

            {/* ── Sync tab context menu ── */}
            {tab === 'sync' && (
              <>
                {/* Scoped Copy/Replace actions — table, schema, or db */}
                {ctxMenu.scope && ctxMenu.name && (() => {
                  const scopeLabel =
                    ctxMenu.scope === 'table'  ? `table "${ctxMenu.name}"` :
                    ctxMenu.scope === 'schema' ? `schema "${ctxMenu.name}"` :
                    `database "${ctxMenu.name}"`;
                  const tables =
                    ctxMenu.scope === 'table'  ? [ctxMenu.name] :
                    ctxMenu.scope === 'schema' ? tableList.filter(t => t.schema === ctxMenu.name).map(t => t.name) :
                    tableList.map(t => t.name);
                  const noTgt = !tgtConn;
                  const noTables = tables.length === 0;

                  return (
                    <>
                      <p className="px-3 pt-1 pb-1 text-[12px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide truncate max-w-[220px]">
                        {ctxMenu.scope === 'table' ? '' : ctxMenu.scope + ' · '}{ctxMenu.name}
                        {tables.length > 1 && <span className="ml-1 normal-case font-normal text-gray-300 dark:text-slate-600">({tables.length} tables)</span>}
                      </p>

                      {/* Copy */}
                      <button type="button"
                        disabled={noTgt || running || noTables}
                        onClick={() => {
                          const t = [...tables]; setCtxMenu(null);
                          if (ctxMenu.scope === 'table') void handleSyncSingle(t[0]);
                          else void handleSync(t);
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-violet-50 dark:hover:bg-violet-900/20 text-gray-700 dark:text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        <ArrowRightLeft size={15} className="text-violet-500 shrink-0" />
                        <div>
                          <p className="text-[13px] font-medium">Copy to target</p>
                          <p className="text-[12px] text-gray-400 dark:text-slate-500">
                            {noTgt ? 'Select a target connection first' : noTables ? 'No tables loaded yet' : `Sync ${scopeLabel} using current conflict strategy`}
                          </p>
                        </div>
                      </button>

                      {/* Replace */}
                      <button type="button"
                        disabled={noTgt || running || noTables}
                        onClick={() => {
                          const t = [...tables]; setCtxMenu(null);
                          if (ctxMenu.scope === 'table') {
                            const name = t[0];
                            showConfirm({
                              title: `Replace "${name}"?`,
                              description: `DROP and recreate "${name}" in target "${tgtDatabase || database}". All existing data will be lost.`,
                              confirmLabel: 'Replace',
                              onConfirm: async () => {
                                setRunning(true); setRunStatus(null);
                                setTableSyncStatus(prev => ({ ...prev, [name]: 'syncing' }));
                                const { ok, logs } = await doReplaceTable(name);
                                setLog(prev => {
                                  const startIdx = prev.length;
                                  const next = [...prev, ...logs];
                                  setTableLogRanges(r => ({ ...r, [name]: [startIdx, next.length] }));
                                  return next;
                                });
                                setTableSyncStatus(prev => ({ ...prev, [name]: ok ? 'done' : 'error' }));
                                setRunStatus(ok ? 'success' : 'failed');
                                setRunning(false);
                                if (ok && analyseResult) void refreshAnalyseSilent(conn, tgtConn);
                              },
                            });
                          } else {
                            void handleReplace(t);
                          }
                        }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-rose-50 dark:hover:bg-rose-900/20 text-gray-700 dark:text-slate-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                        <Replace size={15} className="text-rose-500 shrink-0" />
                        <div>
                          <p className="text-[13px] font-medium">Replace on target</p>
                          <p className="text-[12px] text-gray-400 dark:text-slate-500">
                            {noTgt ? 'Select a target connection first' : noTables ? 'No tables loaded yet' : `DROP + recreate ${scopeLabel}, then copy all data`}
                          </p>
                        </div>
                      </button>
                      <div className="my-1 border-t border-gray-100 dark:border-slate-800" />
                    </>
                  );
                })()}

                {/* Conflict strategy — always shown in sync context menu */}
                <p className="px-3 pt-1 pb-1 text-[12px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide">Conflict</p>
                {([
                  { v: 'insert_only'     as ConflictStrategy, label: 'Insert only',       desc: 'Fail if row exists'   },
                  { v: 'truncate_insert' as ConflictStrategy, label: 'Truncate + Insert', desc: 'Clear table first'    },
                  { v: 'upsert'          as ConflictStrategy, label: 'Upsert',            desc: 'Skip duplicates'      },
                ]).map(({ v, label, desc }) => {
                  const active = conflict === v;
                  return (
                    <button key={v} type="button" onClick={() => { setConflict(v); setCtxMenu(null); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors ${active ? 'text-violet-600 dark:text-violet-400' : 'text-gray-700 dark:text-slate-300'}`}>
                      <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${active ? 'border-violet-500' : 'border-gray-300 dark:border-slate-600'}`}>
                        {active && <div className="w-1.5 h-1.5 rounded-full bg-violet-500" />}
                      </div>
                      <div>
                        <p className="text-[13px] font-medium">{label}</p>
                        <p className="text-[12px] text-gray-400 dark:text-slate-500">{desc}</p>
                      </div>
                    </button>
                  );
                })}
              </>
            )}

            {/* ── Export tab context menu — Include only ── */}
            {tab !== 'sync' && (
              <>
                <p className="px-3 pt-1 pb-1 text-[12px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide">Include</p>
                {([
                  { v: 'both'   as ExportInclude, label: 'Schema + Data', desc: 'DDL and all rows'  },
                  { v: 'schema' as ExportInclude, label: 'Schema only',   desc: 'DDL, no row data'  },
                  { v: 'data'   as ExportInclude, label: 'Data only',     desc: 'INSERTs, no DDL'   },
                ]).map(({ v, label, desc }) => {
                  const active = exportInclude === v;
                  return (
                    <button key={v} type="button" onClick={() => { setExportInclude(v); setCtxMenu(null); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors ${active ? 'text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-slate-300'}`}>
                      <div className={`w-3.5 h-3.5 rounded-full border-2 flex items-center justify-center shrink-0 ${active ? 'border-blue-500' : 'border-gray-300 dark:border-slate-600'}`}>
                        {active && <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                      </div>
                      <div>
                        <p className="text-[13px] font-medium">{label}</p>
                        <p className="text-[12px] text-gray-400 dark:text-slate-500">{desc}</p>
                      </div>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

