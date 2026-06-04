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
  Info, FileSpreadsheet, Filter, Clock, Trash2, Save,
  Eye, ShieldAlert, Plus, HelpCircle, BookOpen, X,
} from 'lucide-react';
import type { ConnectionRow } from './api/connections/index';
import type { ConnCfg, ExportInclude, ConflictStrategy } from '../lib/sql-exporter';
import type { HistoryEntry } from './api/export-import/history';
import type { ExplorerConn } from '../lib/explorer-db';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
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
          <Eye size={15} className="text-blue-500" />
          <p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Import Preview</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {([
              ['Total statements', s.total], ['CREATE TABLE', s.creates],
              ['INSERT', s.inserts], ['ALTER TABLE', s.alters],
              ['DROP TABLE', s.drops], ['TRUNCATE', s.truncates],
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

// ── Excel preview modal ────────────────────────────────────────────────────────

function ExcelImportModal({ tables: initial, onApply, onClose }: {
  tables: ParsedTable[]; onApply: (sql: string) => void; onClose: () => void;
}) {
  const [tables, setTables] = useState(initial);
  const [activeSheet, setActive] = useState(initial[0]?.sheetName ?? '');
  const active = tables.find((t) => t.sheetName === activeSheet);

  const updateCol = (sheetName: string, idx: number, patch: Partial<ParsedColumn>) =>
    setTables((prev) => prev.map((t) =>
      t.sheetName === sheetName ? { ...t, columns: t.columns.map((c, i) => i === idx ? { ...c, ...patch } : c) } : t
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
            <button type="button" onClick={() => onApply(generateSeedSqlFromTables(tables))}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700">
              <CheckCircle2 size={13} /> Apply as SQL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── SQL drag-drop import field ─────────────────────────────────────────────────

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
      className={`relative flex flex-col flex-1 rounded-xl border-2 border-dashed transition-colors ${dragging ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/20' : 'border-gray-200 dark:border-slate-700'}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) readFile(f); }}
    >
      <textarea value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="Paste SQL here or drag & drop a .sql file…"
        className="flex-1 px-4 py-3 text-xs font-mono bg-transparent text-gray-900 dark:text-slate-100 placeholder-gray-400 dark:placeholder-slate-600 focus:outline-none resize-none"
      />
      <div className="shrink-0 px-4 pb-3 flex items-center gap-2 border-t border-gray-100 dark:border-slate-800">
        <button type="button" onClick={() => fileRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800">
          <UploadCloud size={12} /> Browse .sql
        </button>
        {value && <button type="button" onClick={() => onChange('')} className="text-[10px] text-gray-400 hover:text-rose-500">Clear</button>}
        {value.trim() && (
          <span className="ml-auto text-[10px] text-gray-400 dark:text-slate-500 font-mono">~{parseDryRun(value).total} statements</span>
        )}
        <input ref={fileRef} type="file" accept=".sql,.txt" className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }} />
      </div>
    </div>
  );
}

// ── Log panel ──────────────────────────────────────────────────────────────────

function LogPanel({ lines, running }: { lines: LogLine[]; running: boolean }) {
  if (lines.length === 0 && !running) return null;
  return (
    <div className="shrink-0 border-t border-gray-200 dark:border-slate-800">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
        <FileCode2 size={12} className="text-gray-400" />
        <p className="text-[11px] font-medium text-gray-500 dark:text-slate-400">Execution Log</p>
      </div>
      <div className="p-3 space-y-1 font-mono text-[10px] max-h-44 sidebar-scroll overflow-y-auto">
        {lines.map((l, i) => {
          const isRollback = l.text.startsWith('[ROLLBACK]');
          const isInfo     = l.text.startsWith('[START]') || l.text.startsWith('[DONE]');
          const colorCls   = l.ok
            ? isInfo ? 'text-gray-400 dark:text-slate-500' : 'text-emerald-600 dark:text-emerald-400'
            : isRollback ? 'text-amber-600 dark:text-amber-400' : 'text-rose-600 dark:text-rose-400';
          const Icon = l.ok ? (isInfo ? Info : CheckCircle2) : isRollback ? AlertCircle : XCircle;
          return (
            <div key={i} className={`flex items-start gap-1.5 ${colorCls}`}>
              <Icon size={10} className="mt-0.5 shrink-0" />
              <span><span className="opacity-50 mr-1">[{l.step}]</span>{l.text}</span>
            </div>
          );
        })}
        {running && <div className="flex items-center gap-1.5 text-gray-400"><Loader2 size={10} className="animate-spin" /> Running…</div>}
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
        <FileCode2 size={12} className="text-emerald-500" />
        <p className="text-[11px] font-medium text-gray-500 dark:text-slate-400">
          SQL Output <span className="opacity-60">({(sql.length / 1024).toFixed(1)} KB)</span>
        </p>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setExpanded(v => !v)}
            className="px-2 py-0.5 text-[10px] rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700">
            {expanded ? 'Collapse' : 'Preview'}
          </button>
          <button type="button" onClick={copy}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-700">
            {copied ? <Check size={10} /> : <Copy size={10} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={download}
            className="flex items-center gap-1 px-2.5 py-0.5 text-[10px] rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700">
            <Download size={10} /> Download
          </button>
        </div>
      </div>
      {expanded && (
        <pre className="px-4 py-3 text-[10px] font-mono text-gray-600 dark:text-slate-300 max-h-52 sidebar-scroll overflow-y-auto whitespace-pre-wrap break-words">
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
          <AlertCircle size={15} className="text-rose-500 shrink-0" />
          <p className="font-semibold text-sm text-gray-900 dark:text-slate-100">Cross-DB Sync Not Supported</p>
        </div>
        <div className="px-5 py-4 space-y-3 text-sm text-gray-600 dark:text-slate-300">
          <p>Source and target are different database types:</p>
          <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-xs font-semibold">
            <span className={srcType === 'mysql' ? 'text-orange-600 dark:text-orange-400' : 'text-blue-600 dark:text-blue-400'}>{label(srcType)}</span>
            <ArrowRightLeft size={12} className="text-rose-400 shrink-0" />
            <span className={tgtType === 'mysql' ? 'text-orange-600 dark:text-orange-400' : 'text-blue-600 dark:text-blue-400'}>{label(tgtType)}</span>
          </div>
          <p className="text-[11px] text-gray-400 dark:text-slate-500">
            Use the <strong className="text-gray-600 dark:text-slate-300">Migration</strong> module to move data between MySQL and PostgreSQL.
          </p>
        </div>
        <div className="px-5 py-4 border-t border-gray-100 dark:border-slate-800 flex justify-end">
          <button onClick={onClose}
            className="px-5 py-2 rounded-lg text-sm font-medium bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200 hover:bg-gray-200 dark:hover:bg-slate-700 transition-colors">
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
    <span className="inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200 border border-gray-200 dark:border-slate-700">{text}</span>
  );
  const h3 = 'flex items-center gap-1.5 text-xs font-semibold text-gray-800 dark:text-slate-100';
  const sec = 'mt-2 space-y-1.5 text-[11px] text-gray-600 dark:text-slate-300 leading-relaxed';
  const sep = 'border-t border-gray-100 dark:border-slate-800';

  return (
    <div ref={ref} className="relative flex items-center">
      <button
        onClick={() => setOpen(v => !v)}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors border ${open
          ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800'
          : 'text-gray-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 border-transparent hover:border-blue-200 dark:hover:border-blue-800'}`}
      >
        <HelpCircle size={13} /> Guide
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[420px] max-h-[74vh] flex flex-col bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden">
          <div className="shrink-0 flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 dark:border-slate-800">
            <BookOpen size={14} className="text-blue-500" />
            <p className="flex-1 font-semibold text-sm text-gray-900 dark:text-slate-100">Export & Import Guide</p>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={14} /></button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-[11px]">

            <div>
              <p className={h3}><Info size={12} className="text-blue-500" /> Navigation</p>
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
              <p className={h3}><Download size={12} className="text-blue-500" /> Export</p>
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
              <p className={h3}><UploadCloud size={12} className="text-emerald-500" /> Import</p>
              <div className={sec}>
                <p>Select <strong>target</strong> connection → database, then paste or upload SQL. Click {pill('Import')} (or {pill('Preview')} first).</p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li>{pill('SQL')} — paste SQL directly or drag a .sql file into the text area.</li>
                  <li>{pill('Excel')} — upload .xlsx/.xls; each sheet becomes INSERT statements.</li>
                  <li>{pill('Preview')} — shows a dry-run breakdown (CREATE/INSERT/DROP counts) before executing.</li>
                  <li>Import runs with per-statement rollback — a failed statement rolls back only that statement.</li>
                </ul>
                <p className="text-[10px] text-gray-400 dark:text-slate-500">Panels 3 (Schema) and 4 (Tables) are not applicable for Import — table selection comes from the SQL input itself.</p>
              </div>
            </div>

            <div className={sep} />

            <div>
              <p className={h3}><ArrowRightLeft size={12} className="text-violet-500" /> Sync</p>
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
              <p className={h3}><Clock size={12} className="text-gray-500" /> Saved Jobs</p>
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
        <p className="text-[11px] text-gray-400 dark:text-slate-500 text-center py-6 italic">
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
              <Database size={12} className={`mt-0.5 shrink-0 ${active ? selIcon : 'text-gray-400 dark:text-slate-500'}`} />
              <div className="flex-1 min-w-0">
                <p className={`text-[11px] font-medium truncate ${active ? selText : 'text-gray-800 dark:text-slate-200'}`}>{c.label}</p>
                <p className="text-[10px] text-gray-400 dark:text-slate-500 truncate font-mono">{c.host}:{c.port}</p>
              </div>
              <span className={`text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${dbTypeBadge(c.db_type)}`}>
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
            <Server size={12} className="text-blue-500 shrink-0" />
            <span className="text-[11px] font-semibold text-gray-700 dark:text-slate-200">Source</span>
          </div>
          {renderList(value, onChange, 'blue')}
          <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-b border-gray-200 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/30">
            <Server size={12} className="text-violet-500 shrink-0" />
            <span className="text-[11px] font-semibold text-gray-700 dark:text-slate-200">Target</span>
          </div>
          {renderList(tgtValue!, onTgtChange!, 'violet')}
        </>
      ) : (
        <>
          <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800">
            <Server size={12} className="text-blue-500 shrink-0" />
            <span className="text-[11px] font-semibold text-gray-700 dark:text-slate-200">{label ?? 'Connection'}</span>
            {connections.length > 0 && (
              <span className="ml-auto text-[10px] font-mono text-gray-400 dark:text-slate-500">{connections.length}</span>
            )}
          </div>
          {renderList(value, onChange, 'blue')}
        </>
      )}
    </div>
  );
}

// ── Panel 2: Databases ─────────────────────────────────────────────────────────

function DatabasePanel({ conn, value, onChange, allowCreate, syncProgress }: {
  conn: ConnectionRow | null;
  value: string;
  onChange: (db: string) => void;
  allowCreate?: boolean;
  syncProgress?: { current: number; total: number; label: string } | null;
}) {
  const [dbs, setDbs]           = useState<string[]>([]);
  const [loading, setLoading]   = useState(false);
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
        <Database size={12} className="text-purple-500 shrink-0" />
        <span className="text-[11px] font-semibold text-gray-700 dark:text-slate-200">Database</span>
        {conn && (
          <button type="button" onClick={() => void load(conn)} title="Refresh"
            className="ml-auto p-0.5 text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300">
            {loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
          </button>
        )}
      </div>
      <div className="flex-1 sidebar-scroll overflow-y-auto">
        {!conn ? (
          <p className="text-[11px] text-gray-400 dark:text-slate-500 text-center py-8 italic px-2">Select a connection first</p>
        ) : (
          <div className="p-2 space-y-0.5">
            {dbs.map(db => {
              const active = value === db;
              return (
                <div key={db}>
                  <button type="button" onClick={() => onChange(db)}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                      active
                        ? 'bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-300'
                        : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800/60'
                    }`}>
                    <Database size={10} className={active ? 'text-purple-400 shrink-0' : 'text-gray-300 dark:text-slate-600 shrink-0'} />
                    <span className="text-[11px] font-mono truncate flex-1">{db}</span>
                    {active && pct !== null && (
                      <span className="text-[9px] font-mono text-violet-500 dark:text-violet-400 shrink-0">{pct}%</span>
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
      {allowCreate && conn && (
        <div className="shrink-0 border-t border-gray-100 dark:border-slate-800 p-2">
          {showNew ? (
            <div className="space-y-1.5">
              <input type="text" value={newName} onChange={e => { setNewName(e.target.value); setCreateErr(null); }}
                placeholder="new_db_name" autoFocus
                className="w-full px-2 py-1.5 text-[11px] font-mono rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              {createErr && <p className="text-[10px] text-rose-500">{createErr}</p>}
              <div className="flex gap-1">
                <button type="button" onClick={() => void handleCreate()} disabled={creating || !newName.trim()}
                  className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 text-[10px] rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
                  {creating ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />} Create
                </button>
                <button type="button" onClick={() => { setShowNew(false); setCreateErr(null); setNewName(''); }}
                  className="px-2 py-1.5 text-[10px] rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setShowNew(true)}
              className="w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors">
              <Plus size={11} /> New Database…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Panel 3: Schemas ───────────────────────────────────────────────────────────

function SchemaPanel({ conn, database, value, onChange }: {
  conn: ConnectionRow | null;
  database: string;
  value: string;
  onChange: (s: string) => void;
}) {
  const [schemas, setSchemas] = useState<{ schema: string; tableCount: number }[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (c: ConnectionRow, db: string) => {
    setLoading(true); setSchemas([]);
    try {
      const { data } = await axios.post('/api/schema-explorer/schemas',
        connToExplorerConn(c, db));
      setSchemas((data as { schemas: { schema: string; tableCount: number }[] }).schemas);
    } catch { setSchemas([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (conn && database) void load(conn, database);
    else { setSchemas([]); onChange(''); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn?.id, database]);

  const isPg = conn?.db_type === 'postgres';

  return (
    <div className="w-full h-full bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800">
        <Server size={12} className={isPg ? 'text-teal-500 shrink-0' : 'text-gray-300 dark:text-slate-600 shrink-0'} />
        <span className={`text-[11px] font-semibold ${isPg ? 'text-gray-700 dark:text-slate-200' : 'text-gray-400 dark:text-slate-600'}`}>Schema</span>
        {loading && <Loader2 size={10} className="animate-spin text-gray-400 ml-auto" />}
      </div>
      <div className="flex-1 sidebar-scroll overflow-y-auto">
        {!isPg ? (
          <p className="text-[10px] text-gray-400 dark:text-slate-600 text-center py-8 px-2 italic">PostgreSQL only</p>
        ) : !conn || !database ? (
          <p className="text-[10px] text-gray-400 dark:text-slate-500 text-center py-8 italic px-2">Select a DB first</p>
        ) : (
          <div className="p-2 space-y-0.5">
            <button type="button" onClick={() => onChange('')}
              className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                value === '' ? 'bg-teal-50 dark:bg-teal-950/30 text-teal-700 dark:text-teal-300' : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800/60'
              }`}>
              <span className="text-[11px]">All schemas</span>
            </button>
            {schemas.map(s => (
              <button key={s.schema} type="button" onClick={() => onChange(s.schema)}
                className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                  value === s.schema ? 'bg-teal-50 dark:bg-teal-950/30 text-teal-700 dark:text-teal-300' : 'text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800/60'
                }`}>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-mono truncate">{s.schema}</p>
                  <p className="text-[9px] text-gray-400 dark:text-slate-500">{s.tableCount} tables</p>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Panel 5: Saved Jobs (collapsible) ─────────────────────────────────────────

function HistoryCard({ h, onDelete }: { h: HistoryEntry; onDelete: (id: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const connLabel = h.source_label ?? h.target_label;
  const db = h.source_db ?? h.target_db;
  const statusCls = h.status === 'success'
    ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
    : h.status === 'failed'
    ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400'
    : 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400';

  return (
    <div className={`rounded-lg border p-2 transition-colors bg-white dark:bg-slate-800/50 ${
      h.status === 'success' ? 'border-emerald-200 dark:border-emerald-800/50'
      : h.status === 'failed' ? 'border-rose-200 dark:border-rose-800/50'
      : 'border-gray-200 dark:border-slate-700'
    }`}>
      {/* Row 1: name + status */}
      <div className="flex items-start gap-1 mb-0.5">
        <p className="text-[11px] font-medium text-gray-800 dark:text-slate-200 flex-1 truncate">
          {connLabel ?? h.operation}
        </p>
        <span className={`shrink-0 inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold ${statusCls}`}>{h.status}</span>
      </div>
      {/* Row 2: db path */}
      {db && (
        <p className="text-[10px] font-mono text-gray-400 dark:text-slate-500 truncate mb-0.5">
          {db}{h.target_db && h.source_db ? <> → {h.target_db}</> : null}
        </p>
      )}
      {/* Row 3: count + date + expand */}
      <div className="flex items-center gap-1 mb-1">
        <p className="text-[10px] text-gray-400 dark:text-slate-500 flex-1">
          {h.tables_count > 0 ? `${h.tables_count} table${h.tables_count !== 1 ? 's' : ''}` : h.operation}
          {' · '}{timeAgo(h.created_at)}
        </p>
        <button onClick={() => setExpanded(v => !v)}
          className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors">
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>
      {/* Expanded: meta detail */}
      {expanded && (
        <div className="mb-1.5 border border-gray-100 dark:border-slate-700 rounded px-2 py-1.5 space-y-0.5">
          {h.format && <p className="text-[10px] text-gray-500 dark:text-slate-400">Format: <span className="font-medium uppercase">{h.format}</span></p>}
          {h.include && <p className="text-[10px] text-gray-500 dark:text-slate-400">Include: {h.include.replace(/_/g, ' ')}</p>}
          {h.conflict && h.conflict !== 'insert_only' && <p className="text-[10px] text-gray-500 dark:text-slate-400">Conflict: {h.conflict.replace(/_/g, ' ')}</p>}
          {h.where_clause && <p className="text-[10px] font-mono text-gray-500 dark:text-slate-400 truncate" title={h.where_clause}>WHERE {h.where_clause}</p>}
        </div>
      )}
      {/* Row 4: actions */}
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onDelete(h.id)}
          className="ml-auto p-1 rounded text-gray-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
          <Trash2 size={11} />
        </button>
      </div>
    </div>
  );
}

function SavedJobsPanel({ tab, collapsed, onToggle, refreshKey }: {
  tab: Tab; collapsed: boolean; onToggle: () => void; refreshKey: number;
}) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

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

  const filtered = history.filter(h => h.operation === tab);

  return (
    <div className={`shrink-0 flex flex-col border-l border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden transition-[width] duration-200 ease-in-out ${collapsed ? 'w-9' : 'w-60'}`}>
      {/* Header — always visible */}
      <div className="shrink-0 flex items-center gap-1.5 px-2 py-2.5 border-b border-gray-200 dark:border-slate-800">
        {!collapsed && <Save size={11} className="text-gray-400 shrink-0" />}
        {!collapsed && <span className="text-[11px] font-semibold text-gray-700 dark:text-slate-300 flex-1 truncate">Saved Jobs</span>}
        {!collapsed && filtered.length > 0 && <span className="text-[10px] text-gray-400 shrink-0">{filtered.length}</span>}
        <button onClick={onToggle}
          className="shrink-0 p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 transition-colors ml-auto">
          {collapsed ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
        </button>
      </div>

      {!collapsed && (
        <div className="flex-1 overflow-auto panel-scroll p-2 space-y-1.5">
          {filtered.length === 0 && !loading ? (
            <div className="py-8 text-center">
              <Save size={22} className="mx-auto text-gray-200 dark:text-slate-700 mb-2" />
              <p className="text-[11px] text-gray-400 dark:text-slate-500">No {tab} jobs yet.</p>
            </div>
          ) : filtered.map(h => (
            <HistoryCard key={h.id} h={h} onDelete={id => void handleDelete(id)} />
          ))}
        </div>
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
  const [tgtConnId, setTgtConnId] = useState<number | ''>('');

  // Export options
  const [include, setInclude]       = useState<ExportInclude>('both');
  const [format, setFormat]         = useState<ExportFormat>('sql');
  const [whereClause, setWhere]     = useState('');
  const [showFilter, setShowFilter] = useState(false);

  // Import
  const [importSql, setImportSql]       = useState('');
  const [importMode, setImportMode]     = useState<'sql' | 'excel'>('sql');
  const [excelTables, setExcelTables]   = useState<ParsedTable[] | null>(null);
  const [parsingExcel, setParsingExcel] = useState(false);
  const [showDryRun, setShowDryRun]     = useState(false);
  const excelFileRef = useRef<HTMLInputElement>(null);

  // Sync
  const [conflict, setConflict] = useState<ConflictStrategy>('insert_only');
  const [syncProgress, setSyncProgress] = useState<{ current: number; total: number; label: string } | null>(null);
  const [showCrossDbAlert, setShowCrossDbAlert] = useState(false);

  // Execution state
  const [running, setRunning]       = useState(false);
  const [log, setLog]               = useState<LogLine[]>([]);
  const [runStatus, setRunStatus]   = useState<'success' | 'failed' | null>(null);
  const [exportResult, setExportResult] = useState<{ sql: string; tables: string[] } | null>(null);
  const [error, setError]           = useState<string | null>(null);

  // Saved Jobs panel
  const [jobsCollapsed, setJobsCollapsed] = useState(false);
  const [jobsRefreshKey, setJobsRefreshKey] = useState(0);

  const conn    = connections.find(c => c.id === connId) ?? null;
  const tgtConn = connections.find(c => c.id === tgtConnId) ?? null;

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

  // Reset results when switching tabs
  const handleTabChange = (t: Tab) => {
    setTab(t); setLog([]); setRunStatus(null); setExportResult(null); setError(null);
  };

  // Export
  const handleExport = async () => {
    if (!conn || !database) return;
    setRunning(true); setExportResult(null); setError(null); setLog([]);
    const tablesToExport = selectedTables === 'all' ? 'all' : selectedTables.map(t => t.split('.').pop() ?? t);
    try {
      const { data } = await axios.post('/api/export-import/export',
        { cfg: connToCfg(conn, database), tables: tablesToExport, include, format, whereClause: whereClause.trim() || undefined });

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
        await saveHistory({ operation: 'export', source_label: conn.label, source_db: database, tables_count: csvData.tables.length, include, format: 'csv', where_clause: whereClause.trim() || undefined, status: 'success' });
      } else {
        const sqlData = data as { sql: string; tables: string[] };
        setExportResult(sqlData); setRunStatus('success');
        // Auto-download immediately
        const blob = new Blob([sqlData.sql], { type: 'text/sql' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${database}_${schema || 'public'}_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.sql`; a.click();
        URL.revokeObjectURL(url);
        await saveHistory({ operation: 'export', source_label: conn.label, source_db: database, tables_count: sqlData.tables.length, include, format: 'sql', where_clause: whereClause.trim() || undefined, status: 'success' });
      }
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      setError(msg); setRunStatus('failed');
      await saveHistory({ operation: 'export', source_label: conn.label, source_db: database, tables_count: 0, include, format, status: 'failed' });
    } finally { setRunning(false); setJobsRefreshKey(k => k + 1); }
  };

  // Import
  const doImport = async () => {
    if (!conn || !database || !importSql.trim()) return;
    setRunning(true); setLog([]); setRunStatus(null); setError(null);
    try {
      const { data } = await axios.post('/api/export-import/import',
        { cfg: connToCfg(conn, database), sql: importSql });
      const d = data as { success: boolean; log?: string[] };
      setLog((d.log ?? []).map(t => ({ step: 'import', ok: d.success, text: t })));
      setRunStatus(d.success ? 'success' : 'failed');
      await saveHistory({ operation: 'import', target_label: conn.label, target_db: database, status: d.success ? 'success' : 'failed' });
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: string[]; error?: string } | undefined : undefined;
      setLog((d?.log ?? [`[ERROR] ${d?.error ?? String(err)}`]).map(t => ({ step: 'import', ok: false, text: t })));
      setRunStatus('failed');
      await saveHistory({ operation: 'import', target_label: conn.label, target_db: database, status: 'failed' });
    } finally { setRunning(false); setJobsRefreshKey(k => k + 1); }
  };

  // Sync — per-table with progress
  const handleSync = async () => {
    if (!conn || !database || !tgtConn) return;
    setRunning(true); setLog([]); setRunStatus(null); setError(null); setSyncProgress(null);
    const tables = selectedTables === 'all'
      ? tableList.map(t => t.name)
      : selectedTables.map(t => t.split('.').pop() ?? t);
    const total = Math.max(tables.length, 1);
    const allLog: LogLine[] = [];
    let allOk = true;
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      setSyncProgress({ current: i, total, label: table });
      try {
        const { data } = await axios.post('/api/export-import/sync',
          { source: connToCfg(conn, database), target: connToCfg(tgtConn, database), tables: [table], include, conflict });
        const d = data as { success: boolean; log: LogLine[] };
        allLog.push(...d.log);
        if (!d.success) allOk = false;
      } catch (err: unknown) {
        const d = axios.isAxiosError(err) ? err.response?.data as { log?: LogLine[] } | undefined : undefined;
        allLog.push(...(d?.log ?? [{ step: 'sync', ok: false, text: `[ERROR] ${table}: ${String(err)}` }]));
        allOk = false;
      }
      setSyncProgress({ current: i + 1, total, label: table });
    }
    setLog(allLog);
    setRunStatus(allOk ? 'success' : 'failed');
    setSyncProgress(null);
    await saveHistory({ operation: 'sync', source_label: conn.label, source_db: database, target_label: tgtConn.label, target_db: database, tables_count: tables.length, include, conflict, status: allOk ? 'success' : 'failed' });
    setRunning(false);
    setJobsRefreshKey(k => k + 1);
  };

  const handleExcelFile = async (file: File) => {
    if (!/\.xlsx?$/i.test(file.name)) return;
    setParsingExcel(true);
    try {
      const tables = await parseExcelFile(file);
      if (tables.length > 0) setExcelTables(tables);
    } catch { /* ignore */ }
    finally { setParsingExcel(false); }
  };

  // Toolbar run
  const handleRun = () => {
    if (tab === 'export') void handleExport();
    else if (tab === 'import') { if (importSql.trim()) setShowDryRun(true); }
    else void handleSync();
  };

  const canRun = !running && conn && database && (
    tab === 'import' ? importSql.trim() :
    tab === 'sync'   ? tgtConn && conn.db_type === tgtConn.db_type :
    true
  );

  // Table list rendering helpers
  const allSelected = selectedTables === 'all';
  const selectedArr = allSelected ? tableList.map(t => `${t.schema}.${t.name}`) : selectedTables;
  const hasLarge = tableList.some(t => t.rowCount > 50_000);

  const exportFilename = `${database}_${schema || 'public'}_${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}.sql`;

  // Segmented control style
  const seg = (active: boolean) =>
    `px-2 py-1 text-[10px] rounded border transition-colors ${active ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`;

  // Tooltip wrapper for toolbar seg buttons
  const BtnTip = ({ tip, children }: { tip: string; children: React.ReactNode }) => {
    const [show, setShow] = useState(false);
    return (
      <span className="relative inline-flex"
        onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
        {children}
        {show && (
          <span className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-[100] whitespace-nowrap bg-gray-900 dark:bg-slate-700 text-white text-[10px] leading-snug px-2 py-1 rounded shadow-lg pointer-events-none">
            {tip}
          </span>
        )}
      </span>
    );
  };

  return (
    <>
      <Head><title>Export & Import — DB Maintenance Tools</title></Head>
      <div className="h-[calc(100vh-48px)] flex flex-col bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* ── Header ── */}
        <header className="shrink-0 sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-5 py-3 flex items-center gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <UploadCloud size={18} className="text-emerald-600 shrink-0" />
            <div className="min-w-0">
              <h1 className="font-bold text-gray-900 dark:text-slate-100 leading-none">Export & Import</h1>
              <p className="text-[11px] text-gray-500 dark:text-slate-400 mt-0.5">Export, import and sync database tables across connections</p>
            </div>
          </div>
        </header>

        {/* ── Toolbar ── */}
        <div className="shrink-0 flex items-center gap-2 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-1.5 flex-wrap">

          {/* Tab buttons */}
          {([
            { key: 'export' as Tab, label: 'Export', Icon: Download },
            { key: 'import' as Tab, label: 'Import', Icon: UploadCloud },
            { key: 'sync'   as Tab, label: 'Sync',   Icon: ArrowRightLeft },
          ]).map(({ key, label, Icon }) => (
            <button key={key} type="button" onClick={() => handleTabChange(key)}
              className={`self-stretch inline-flex items-center gap-1.5 px-3 text-[11px] font-medium border-b-2 transition-colors ${
                tab === key
                  ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                  : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
              }`}>
              <Icon size={11} /> {label}
            </button>
          ))}

          <div className="w-px h-4 bg-gray-200 dark:bg-slate-700 mx-0.5 shrink-0" />

          {/* Export options */}
          {tab === 'export' && (
            <>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-400 dark:text-slate-500 mr-0.5">Include</span>
                {([
                  { v: 'both'   as ExportInclude, label: 'S+D',   tip: 'Schema + Data — DDL and all rows'               },
                  { v: 'schema' as ExportInclude, label: 'Schema', tip: 'Schema only — DDL, no row data'                 },
                  { v: 'data'   as ExportInclude, label: 'Data',   tip: 'Data only — INSERT statements, no DDL'          },
                ]).map(({ v, label, tip }) => (
                  <BtnTip key={v} tip={tip}>
                    <button onClick={() => setInclude(v)} className={seg(include === v)}>{label}</button>
                  </BtnTip>
                ))}
              </div>
              <div className="w-px h-4 bg-gray-200 dark:bg-slate-700 mx-0.5 shrink-0" />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-400 dark:text-slate-500 mr-0.5">Format</span>
                {(['sql', 'csv'] as ExportFormat[]).map(v => (
                  <button key={v} onClick={() => setFormat(v)} className={`${seg(format === v)} uppercase`}>{v}</button>
                ))}
              </div>
              <BtnTip tip="WHERE filter — applies a WHERE clause to all data SELECT queries">
                <button onClick={() => setShowFilter(v => !v)}
                  className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] rounded border transition-colors ${showFilter ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400' : 'border-gray-200 dark:border-slate-700 text-gray-400 dark:text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
                  <Filter size={10} /> Filter
                </button>
              </BtnTip>
            </>
          )}

          {/* Import options */}
          {tab === 'import' && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400 dark:text-slate-500 mr-0.5">Input</span>
              {(['sql', 'excel'] as const).map(m => (
                <button key={m} onClick={() => setImportMode(m)}
                  className={`${seg(importMode === m)} inline-flex items-center gap-1`}>
                  {m === 'excel' ? <FileSpreadsheet size={9} /> : <FileCode2 size={9} />}
                  {m === 'sql' ? 'SQL' : 'Excel'}
                </button>
              ))}
            </div>
          )}

          {/* Sync options */}
          {tab === 'sync' && (
            <>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-400 dark:text-slate-500 mr-0.5">Include</span>
                {([
                  { v: 'both'   as ExportInclude, label: 'S+D',   tip: 'Schema + Data — DDL and all rows'      },
                  { v: 'schema' as ExportInclude, label: 'Schema', tip: 'Schema only — DDL, no row data'        },
                  { v: 'data'   as ExportInclude, label: 'Data',   tip: 'Data only — INSERT statements, no DDL' },
                ]).map(({ v, label, tip }) => (
                  <BtnTip key={v} tip={tip}>
                    <button onClick={() => setInclude(v)} className={seg(include === v)}>{label}</button>
                  </BtnTip>
                ))}
              </div>
              <div className="w-px h-4 bg-gray-200 dark:bg-slate-700 mx-0.5 shrink-0" />
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-400 dark:text-slate-500 mr-0.5">Conflict</span>
                {([
                  { v: 'insert_only'     as ConflictStrategy, label: 'Insert'   },
                  { v: 'truncate_insert' as ConflictStrategy, label: 'Truncate' },
                  { v: 'upsert'          as ConflictStrategy, label: 'Upsert'   },
                ]).map(({ v, label }) => (
                  <button key={v} onClick={() => setConflict(v)} className={seg(conflict === v)}>{label}</button>
                ))}
              </div>
            </>
          )}

          {/* Run button */}
          <div className="ml-auto flex items-center gap-2">
            {tab === 'import' && importSql.trim() && (
              <button type="button" onClick={() => setShowDryRun(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                <Eye size={11} /> Preview
              </button>
            )}
            {runStatus && (
              <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${runStatus === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                {runStatus === 'success' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {runStatus === 'success' ? (tab === 'export' ? 'Exported' : tab === 'import' ? 'Imported' : 'Synced') : 'Failed'}
              </span>
            )}
            <button type="button" onClick={handleRun} disabled={!canRun}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-40 ${
                tab === 'export' ? 'border border-blue-500 text-blue-600 dark:text-blue-400 bg-transparent hover:bg-blue-50 dark:hover:bg-blue-900/20' :
                tab === 'import' ? 'bg-emerald-600 hover:bg-emerald-700 text-white' :
                'border border-violet-500 text-violet-600 dark:text-violet-400 bg-transparent hover:bg-violet-50 dark:hover:bg-violet-900/20'
              }`}>
              {running ? <Loader2 size={11} className="animate-spin" /> : tab === 'export' ? <Download size={11} /> : tab === 'import' ? <UploadCloud size={11} /> : <ArrowRightLeft size={11} />}
              {running ? (tab === 'export' ? 'Exporting…' : tab === 'import' ? 'Importing…' : 'Syncing…')
                       : (tab === 'export' ? `Export${format === 'csv' ? ' CSV' : ''}` : tab === 'import' ? 'Import' : 'Sync')}
            </button>
            <GuidePopover />
          </div>
        </div>

        {/* ── WHERE filter row (Export only) ── */}
        {tab === 'export' && showFilter && (
          <div className="shrink-0 flex items-center gap-2 border-b border-gray-200 dark:border-slate-800 bg-amber-50 dark:bg-amber-950/10 px-4 py-2">
            <Filter size={11} className="text-amber-500 shrink-0" />
            <input type="text" value={whereClause} onChange={e => setWhere(e.target.value)}
              placeholder="WHERE clause applied to all SELECT queries  (e.g.  created_at > '2025-01-01')"
              className="flex-1 text-[11px] font-mono bg-transparent text-gray-800 dark:text-slate-200 placeholder-gray-400 dark:placeholder-slate-600 focus:outline-none" />
            <button onClick={() => { setShowFilter(false); setWhere(''); }}
              className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={12} /></button>
          </div>
        )}

        {/* ── 5-Panel Content ── */}
        {loadingConns ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-sm text-gray-400 dark:text-slate-500">
            <Loader2 size={14} className="animate-spin" /> Loading connections…
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
              onTgtChange={tab === 'sync' ? (id) => { setTgtConnId(id); } : undefined}
            />

            {/* Panels 2, 3, 4: Resizable group */}
            <div className="flex-1 h-full overflow-hidden">
              <PanelGroup orientation="horizontal" className="h-full">
                <Panel defaultSize={24} minSize={12}>
                  <DatabasePanel
                    conn={conn}
                    value={database}
                    onChange={db => { setDatabase(db); setSchema(''); setSelectedTables('all'); }}
                    allowCreate={tab === 'import'}
                    syncProgress={syncProgress}
                  />
                </Panel>
                <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors" />
                <Panel defaultSize={18} minSize={8}>
                  <SchemaPanel
                    conn={tab === 'import' ? null : conn}
                    database={database}
                    value={schema}
                    onChange={s => { setSchema(s); setSelectedTables('all'); }}
                  />
                </Panel>
                <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors" />
                <Panel defaultSize={58} minSize={30}>

            {/* Panel 4: Tables + Workspace */}
            <div className="h-full flex flex-col overflow-hidden min-w-0 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-800">

              {/* Panel 4 header */}
              <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800">
                <Table2 size={12} className="text-blue-500 shrink-0" />
                <span className="text-[11px] font-semibold text-gray-700 dark:text-slate-200">
                  {tab === 'import' ? 'SQL Input' : 'Tables'}
                </span>
                {tab !== 'import' && tableList.length > 0 && (
                  <span className="text-[10px] text-gray-400 dark:text-slate-500">{tableList.length} tables</span>
                )}
                {tablesLoading && <Loader2 size={10} className="animate-spin text-gray-400 ml-1" />}
                {tab !== 'import' && tableList.length > 0 && !tablesLoading && (
                  <div className="ml-auto flex items-center gap-1">
                    {(['all', 'custom'] as const).map(m => (
                      <button key={m} type="button"
                        onClick={() => setSelectedTables(m === 'all' ? 'all' : [])}
                        className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
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
                    <div className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-200 dark:border-amber-800 text-[10px] text-amber-700 dark:text-amber-400">
                      <ShieldAlert size={10} /> Some tables have &gt;50k rows — export may be slow.
                    </div>
                  )}
                  {!conn || !database ? (
                    <div className="flex-1 flex items-center justify-center text-[11px] text-gray-400 dark:text-slate-500 italic">
                      Select a connection and database to load tables
                    </div>
                  ) : tableList.length === 0 && !tablesLoading ? (
                    <div className="flex-1 flex items-center justify-center text-[11px] text-gray-400 dark:text-slate-500 italic">
                      No tables found{schema ? ` in schema "${schema}"` : ''}
                    </div>
                  ) : (
                    <div className="flex-1 sidebar-scroll overflow-y-auto">
                      <div className="divide-y divide-gray-100 dark:divide-slate-800">
                        {tableList.map(t => {
                          const key = `${t.schema}.${t.name}`;
                          const isChecked = allSelected || selectedArr.includes(key);
                          return (
                            <label key={key} className="flex items-center gap-2.5 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/50 cursor-pointer">
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
                              <Table2 size={10} className="text-gray-400 shrink-0" />
                              <span className="text-[11px] text-gray-700 dark:text-slate-300 font-mono flex-1 truncate">{t.name}</span>
                              {t.schema !== 'public' && (
                                <span className="text-[9px] text-gray-400 dark:text-slate-500 font-mono shrink-0">{t.schema}</span>
                              )}
                              <span className={`text-[10px] font-mono shrink-0 ${t.rowCount > 50_000 ? 'text-amber-600 dark:text-amber-400' : 'text-gray-400 dark:text-slate-500'}`}>
                                {fmtRows(t.rowCount)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Import: SQL/Excel input */}
              {tab === 'import' && (
                <div className="flex-1 flex flex-col overflow-hidden p-3 gap-2">
                  {importMode === 'sql' ? (
                    <SqlImportField value={importSql} onChange={setImportSql} />
                  ) : (
                    <div
                      className="flex-1 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-gray-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-700 cursor-pointer transition-colors"
                      onClick={() => excelFileRef.current?.click()}>
                      {parsingExcel ? (
                        <><Loader2 size={22} className="text-emerald-500 animate-spin" /><p className="text-sm text-gray-400">Parsing…</p></>
                      ) : (
                        <>
                          <FileSpreadsheet size={24} className="text-gray-300 dark:text-slate-600" />
                          <p className="text-sm font-medium text-gray-600 dark:text-slate-300">Drop Excel or click to browse</p>
                          <p className="text-xs text-gray-400 dark:text-slate-500">Each sheet becomes INSERT statements</p>
                        </>
                      )}
                      <input ref={excelFileRef} type="file" accept=".xlsx,.xls" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) void handleExcelFile(f); e.target.value = ''; }} />
                    </div>
                  )}
                </div>
              )}

              {/* Error */}
              {error && (
                <div className="shrink-0 flex items-start gap-2 mx-3 mb-2 p-2.5 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-[11px] text-rose-700 dark:text-rose-400">
                  <XCircle size={12} className="mt-0.5 shrink-0" /> {error}
                </div>
              )}

              {/* SQL result (Export) */}
              {tab === 'export' && exportResult && (
                <SqlPreview sql={exportResult.sql} filename={exportFilename} />
              )}

              {/* Log (Import/Sync) */}
              {tab !== 'export' && <LogPanel lines={log} running={running} />}
            </div>
                </Panel>
              </PanelGroup>
            </div>

            {/* Panel 5: Saved Jobs */}
            <SavedJobsPanel
              tab={tab}
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
        {excelTables && (
          <ExcelImportModal
            tables={excelTables}
            onApply={s => { setImportSql(s); setImportMode('sql'); setExcelTables(null); }}
            onClose={() => setExcelTables(null)}
          />
        )}
      </div>
    </>
  );
}

