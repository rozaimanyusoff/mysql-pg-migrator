import Head from 'next/head';
import Link from 'next/link';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  ChevronRight, Database, Plus, RefreshCw, Upload, Play, CheckCircle2,
  XCircle, Terminal, Loader2, Server, FileCode2, Sprout, Info,
  Clock, ChevronDown, ChevronUp, X, Save, FolderOpen, Table2,
  KeyRound, Link2, Layers, Hash, Fingerprint, AlertCircle,
  FileSpreadsheet, Eye,
} from 'lucide-react';
import type { ConnectionRow } from './api/connections/index';
import type { SchemaJob } from './api/schema-generator/jobs';
import { useAuth } from '../lib/auth-context';
import {
  PG_TYPES, type PgColumnType, type ParsedColumn, type ParsedTable,
  parseExcelFile, generateSchemaSqlFromTables, generateSeedSqlFromTables,
} from '../lib/excel-parser';

// ── Types ─────────────────────────────────────────────────────────────────────

type DbMode  = 'existing' | 'new';
type RunStep = 'schema' | 'seed';
interface LogLine   { step: RunStep; ok: boolean; text: string }
interface UploadedFile { filename: string; filePath: string }

interface SchemaAnalysis {
  tables: string[];
  indexes: number;
  uniqueIndexes: number;
  foreignKeys: number;
  extensions: string[];
  enums: string[];
  triggers: number;
}

interface SeedAnalysis {
  tables: string[];
  rowsPerTable: Record<string, number>;
  totalRows: number;
  idStrategy: 'uuid' | 'sequential' | 'mixed' | 'none';
  usesPublicSchema: boolean;
}

interface JobGroup { job_name: string; runs: SchemaJob[] }

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function authHeader() { return { Authorization: `Bearer ${localStorage.getItem('auth_token') ?? ''}` }; }

function groupJobs(jobs: SchemaJob[]): JobGroup[] {
  const map = new Map<string, SchemaJob[]>();
  for (const j of jobs) {
    const list = map.get(j.job_name) ?? [];
    list.push(j);
    map.set(j.job_name, list);
  }
  return [...map.values()].map((runs) => ({ job_name: runs[0].job_name, runs }));
}

// ── SQL analysis ──────────────────────────────────────────────────────────────

function analyzeSchemaSql(sql: string): SchemaAnalysis | null {
  if (!sql.trim()) return null;
  const tables = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"\w+"\.)?["']?(\w+)["']?/gi)].map((m) => m[1]);
  const indexes = [...sql.matchAll(/CREATE\s+INDEX/gi)].length;
  const uniqueIndexes = [...sql.matchAll(/CREATE\s+UNIQUE\s+INDEX/gi)].length;
  const foreignKeys = [...sql.matchAll(/FOREIGN\s+KEY|REFERENCES\s+\w/gi)].length;
  const extensions = [...sql.matchAll(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi)].map((m) => m[1]);
  const enums = [...sql.matchAll(/CREATE\s+TYPE\s+["']?(\w+)["']?\s+AS\s+ENUM/gi)].map((m) => m[1]);
  const triggers = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER/gi)].length;
  return { tables: [...new Set(tables)], indexes, uniqueIndexes, foreignKeys, extensions: [...new Set(extensions)], enums, triggers };
}

function analyzeSeedSql(sql: string): SeedAnalysis | null {
  if (!sql.trim()) return null;
  const allTables = [...sql.matchAll(/INSERT\s+INTO\s+(?:["']?\w+["']?\.)?["']?(\w+)["']?/gi)].map((m) => m[1]);
  const tables = [...new Set(allTables)];
  const rowsPerTable: Record<string, number> = {};
  for (const t of tables) rowsPerTable[t] = allTables.filter((x) => x.toLowerCase() === t.toLowerCase()).length;
  const hasUuid = /gen_random_uuid\(\)|uuid_generate_v4\(\)|'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i.test(sql);
  const hasSeq  = /nextval\s*\(|\bserial\b|\b\d+,\s*\d+\b/i.test(sql);
  const idStrategy = hasUuid && hasSeq ? 'mixed' : hasUuid ? 'uuid' : hasSeq ? 'sequential' : 'none';
  const usesPublicSchema = /\bpublic\.\w/i.test(sql);
  return { tables, rowsPerTable, totalRows: allTables.length, idStrategy, usesPublicSchema };
}

// ── Popover ───────────────────────────────────────────────────────────────────

function Popover({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen((v) => !v)} className="cursor-pointer">{trigger}</div>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-80 max-h-80 overflow-y-auto rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl text-xs p-4 space-y-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Schema analysis badge ─────────────────────────────────────────────────────

function SchemaAnalysisBadge({ a }: { a: SchemaAnalysis }) {
  return (
    <div className="px-4 pb-3">
      <Popover trigger={
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 text-xs text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors cursor-pointer select-none">
          <Info size={11} />
          <span className="font-medium">{a.tables.length} table{a.tables.length !== 1 ? 's' : ''}</span>
          {a.indexes > 0 && <span className="opacity-70">· {a.indexes} index{a.indexes !== 1 ? 'es' : ''}</span>}
          {a.foreignKeys > 0 && <span className="opacity-70">· {a.foreignKeys} FK{a.foreignKeys !== 1 ? 's' : ''}</span>}
          {a.extensions.length > 0 && <span className="opacity-70">· {a.extensions.length} ext</span>}
          <span className="opacity-50">— click for details</span>
        </div>
      }>
        <p className="text-xs font-semibold text-gray-700 dark:text-slate-200 mb-2">Schema Summary</p>

        {a.tables.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-slate-300 mb-1"><Table2 size={11} /> Tables ({a.tables.length})</p>
            <div className="flex flex-wrap gap-1">
              {a.tables.map((t) => <span key={t} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 font-mono">{t}</span>)}
            </div>
          </div>
        )}

        {a.indexes > 0 && (
          <div className="flex items-center gap-1.5 text-gray-600 dark:text-slate-300">
            <Layers size={11} />
            <span>{a.indexes} index{a.indexes !== 1 ? 'es' : ''}</span>
            {a.uniqueIndexes > 0 && <span className="opacity-60">({a.uniqueIndexes} unique)</span>}
          </div>
        )}

        {a.foreignKeys > 0 && (
          <div className="flex items-center gap-1.5 text-gray-600 dark:text-slate-300">
            <Link2 size={11} /><span>{a.foreignKeys} foreign key reference{a.foreignKeys !== 1 ? 's' : ''}</span>
          </div>
        )}

        {a.enums.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-slate-300 mb-1"><Hash size={11} /> Enums</p>
            <div className="flex flex-wrap gap-1">
              {a.enums.map((e) => <span key={e} className="px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400 font-mono">{e}</span>)}
            </div>
          </div>
        )}

        {a.extensions.length > 0 && (
          <div>
            <p className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-slate-300 mb-1"><KeyRound size={11} /> Extensions</p>
            <div className="flex flex-wrap gap-1">
              {a.extensions.map((e) => <span key={e} className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 font-mono">{e}</span>)}
            </div>
          </div>
        )}

        {a.triggers > 0 && (
          <div className="flex items-center gap-1.5 text-gray-600 dark:text-slate-300">
            <AlertCircle size={11} /><span>{a.triggers} trigger{a.triggers !== 1 ? 's' : ''}</span>
          </div>
        )}
      </Popover>
    </div>
  );
}

// ── Seed analysis badge ───────────────────────────────────────────────────────

function SeedAnalysisBadge({ a }: { a: SeedAnalysis }) {
  const strategyColor = {
    uuid:       'text-violet-700 dark:text-violet-400',
    sequential: 'text-amber-700 dark:text-amber-400',
    mixed:      'text-blue-700 dark:text-blue-400',
    none:       'text-gray-500 dark:text-slate-400',
  }[a.idStrategy];

  const strategyIcon = {
    uuid:       <Fingerprint size={11} />,
    sequential: <Hash size={11} />,
    mixed:      <Layers size={11} />,
    none:       <Info size={11} />,
  }[a.idStrategy];

  return (
    <div className="px-4 pb-3">
      <Popover trigger={
        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 text-xs text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 transition-colors cursor-pointer select-none">
          <Info size={11} />
          <span className="font-medium">{a.tables.length} table{a.tables.length !== 1 ? 's' : ''}</span>
          <span className="opacity-70">· {a.totalRows} row{a.totalRows !== 1 ? 's' : ''}</span>
          <span className={`flex items-center gap-1 ${strategyColor}`}>{strategyIcon} {a.idStrategy}</span>
          {a.usesPublicSchema && <span className="opacity-70">· public schema</span>}
          <span className="opacity-50">— click for details</span>
        </div>
      }>
        <p className="text-xs font-semibold text-gray-700 dark:text-slate-200 mb-2">Seed Analysis</p>

        <div>
          <p className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-slate-300 mb-1.5"><Table2 size={11} /> Rows per table</p>
          <div className="space-y-1">
            {a.tables.map((t) => (
              <div key={t} className="flex items-center justify-between">
                <span className="font-mono text-gray-700 dark:text-slate-300">{t}</span>
                <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400">{a.rowsPerTable[t]} row{a.rowsPerTable[t] !== 1 ? 's' : ''}</span>
              </div>
            ))}
          </div>
        </div>

        <div className={`flex items-center gap-2 ${strategyColor}`}>
          {strategyIcon}
          <span className="font-medium capitalize">ID strategy: {a.idStrategy}</span>
        </div>

        {a.usesPublicSchema && (
          <div className="flex items-center gap-1.5 text-gray-500 dark:text-slate-400">
            <Database size={11} /> Uses <code className="font-mono">public.</code> schema prefix
          </div>
        )}
      </Popover>
    </div>
  );
}

// ── Drag-drop SQL field ───────────────────────────────────────────────────────

function DragDropSqlField({
  label, icon: Icon, description, value, onChange, placeholder,
  uploadedFile, onFileUploaded, footer,
}: {
  label: string; icon: React.ElementType; description: string;
  value: string; onChange: (v: string) => void; placeholder: string;
  uploadedFile: UploadedFile | null;
  onFileUploaded: (f: UploadedFile | null) => void;
  footer?: React.ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);

  const processFile = useCallback(async (file: File) => {
    const content = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = (ev) => resolve((ev.target?.result as string) ?? '');
      reader.readAsText(file);
    });
    onChange(content);
    setUploading(true);
    try {
      const { data } = await axios.post('/api/schema-generator/upload',
        { filename: file.name, content }, { headers: authHeader() });
      const d = data as { storedFilename: string; filePath: string };
      onFileUploaded({ filename: d.storedFilename, filePath: d.filePath });
    } catch { onFileUploaded(null); }
    finally { setUploading(false); }
  }, [onChange, onFileUploaded]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void processFile(file);
  };

  return (
    <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
        <div className="flex items-center gap-2.5">
          <Icon size={15} className="text-blue-500" />
          <div>
            <p className="text-sm font-semibold text-gray-900 dark:text-slate-100">{label}</p>
            <p className="text-xs text-gray-400 dark:text-slate-500">{description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {uploading && <Loader2 size={13} className="animate-spin text-blue-400" />}
          {uploadedFile && !uploading && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400 font-medium truncate max-w-[140px]">
              {uploadedFile.filename}
            </span>
          )}
          {value && (
            <button type="button" onClick={() => { onChange(''); onFileUploaded(null); }}
              className="text-xs text-gray-400 hover:text-rose-500 dark:text-slate-500 dark:hover:text-rose-400 transition-colors">
              Clear
            </button>
          )}
          <button type="button" onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-xs font-medium text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
            <Upload size={12} /> Browse
          </button>
          <input ref={fileRef} type="file" accept=".sql,.txt" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void processFile(f); e.target.value = ''; }} />
        </div>
      </div>

      <div className="p-4 relative"
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        {dragging && (
          <div className="absolute inset-4 z-10 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-blue-500 bg-blue-50/90 dark:bg-blue-950/60 pointer-events-none">
            <Upload size={28} className="text-blue-500" />
            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">Drop .sql file here</p>
          </div>
        )}
        <textarea value={value} onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder} rows={10} spellCheck={false}
          className="w-full font-mono text-xs bg-gray-950 dark:bg-slate-950 text-green-300 border border-gray-700 dark:border-slate-700 rounded-lg p-3 resize-y focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-gray-600"
        />
      </div>

      {footer}
    </section>
  );
}

// ── Job run card (sub-item) ───────────────────────────────────────────────────

function JobRunCard({ job, onLoad }: { job: SchemaJob; onLoad: (job: SchemaJob) => void }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`rounded-lg border text-xs overflow-hidden ${
      job.status === 'success' ? 'border-emerald-200 dark:border-emerald-800/60'
      : job.status === 'failed' ? 'border-rose-200 dark:border-rose-800/60'
      : 'border-gray-200 dark:border-slate-700'
    }`}>
      <div
        className={`flex items-center gap-2 px-3 py-2 ${
          job.status === 'failed'
            ? 'cursor-pointer hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors'
            : 'hover:bg-gray-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer'
        }`}
        onClick={() => onLoad(job)}
        title="Click to load this configuration"
      >
        <span className={`shrink-0 inline-flex px-1.5 py-0.5 rounded font-semibold text-[10px] ${
          job.status === 'success' ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
          : job.status === 'failed' ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400'
          : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
        }`}>{job.status}</span>

        <span className="flex items-center gap-1 text-gray-400 dark:text-slate-500 shrink-0">
          <Clock size={9} />{timeAgo(job.created_at)}
        </span>

        {job.target_database && (
          <span className="text-gray-500 dark:text-slate-400 truncate flex-1">{job.target_database}</span>
        )}

        <div className="flex items-center gap-1 ml-auto shrink-0">
          <button type="button"
            onClick={(e) => { e.stopPropagation(); onLoad(job); }}
            title={job.status === 'failed' ? 'Load config to retry' : 'Load config'}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-950/60 transition-colors">
            <FolderOpen size={9} />
            {job.status === 'failed' ? 'Retry' : 'Load'}
          </button>
          {job.log && job.log.length > 0 && (
            <button type="button" onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
              className="p-0.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors">
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          )}
        </div>
      </div>

      {expanded && job.log && (
        <div className="border-t border-gray-100 dark:border-slate-800 px-3 py-2 space-y-1 font-mono bg-gray-950/90 dark:bg-slate-950/80 max-h-32 overflow-y-auto">
          {job.log.map((line, i) => (
            <div key={i} className={`flex items-start gap-1.5 ${line.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
              {line.ok ? <CheckCircle2 size={10} className="mt-0.5 shrink-0" /> : <XCircle size={10} className="mt-0.5 shrink-0" />}
              <span className="text-[10px] leading-relaxed">
                <span className="opacity-50 mr-1">[{line.step}]</span>{line.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Job group card ────────────────────────────────────────────────────────────

function JobGroupCard({ group, onLoad }: { group: JobGroup; onLoad: (job: SchemaJob) => void }) {
  const [expanded, setExpanded] = useState(false);
  const latest = group.runs[0];
  const hasFailure = group.runs.some((r) => r.status === 'failed');
  const allSuccess = group.runs.every((r) => r.status === 'success');

  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/60">
      <button type="button" onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-gray-900 dark:text-slate-100 truncate">{group.job_name}</p>
          <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">
            {group.runs.length} run{group.runs.length !== 1 ? 's' : ''} · latest {timeAgo(latest.created_at)}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
            allSuccess ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
            : hasFailure ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400'
            : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'
          }`}>{allSuccess ? 'success' : hasFailure ? 'has failures' : latest.status}</span>
          {expanded ? <ChevronUp size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-gray-100 dark:border-slate-800 px-3 pb-3 pt-2 space-y-1.5">
          {group.runs.map((run) => (
            <JobRunCard key={run.id} job={run} onLoad={onLoad} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Excel import card ─────────────────────────────────────────────────────────

function ExcelImportCard({ onParsed }: { onParsed: (tables: ParsedTable[]) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError]   = useState<string | null>(null);

  const process = async (file: File) => {
    if (!/\.xlsx?$/i.test(file.name)) { setError('Upload a .xlsx or .xls file.'); return; }
    setParsing(true); setError(null);
    try {
      const tables = await parseExcelFile(file);
      if (tables.length === 0) { setError('No valid sheets found — each sheet needs a header row + at least one data row.'); return; }
      onParsed(tables);
    } catch { setError('Failed to parse file.'); }
    finally { setParsing(false); }
  };

  return (
    <section className="bg-white dark:bg-slate-900/70 border border-emerald-200 dark:border-emerald-800/60 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-emerald-100 dark:border-emerald-800/40 bg-emerald-50/60 dark:bg-emerald-950/20">
        <FileSpreadsheet size={15} className="text-emerald-500" />
        <div>
          <p className="text-sm font-semibold text-gray-900 dark:text-slate-100">
            Import from Excel
            <span className="ml-2 text-xs font-normal text-gray-400 dark:text-slate-500">optional — alternative to pasting SQL</span>
          </p>
          <p className="text-xs text-gray-400 dark:text-slate-500">Each sheet becomes a table. Auto-generates Schema + Seed SQL into Steps 3 &amp; 4.</p>
        </div>
      </div>

      <div className="p-4">
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files?.[0]; if (f) void process(f); }}
          onClick={() => fileRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-3 py-8 rounded-xl border-2 border-dashed cursor-pointer transition-colors ${
            dragging ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30'
                     : 'border-gray-200 dark:border-slate-700 hover:border-emerald-400 dark:hover:border-emerald-700 hover:bg-emerald-50/40 dark:hover:bg-emerald-950/10'
          }`}
        >
          {parsing ? (
            <><Loader2 size={22} className="text-emerald-500 animate-spin" /><p className="text-sm text-gray-400 dark:text-slate-500">Parsing…</p></>
          ) : (
            <>
              <FileSpreadsheet size={24} className="text-gray-300 dark:text-slate-600" />
              <div className="text-center">
                <p className="text-sm font-medium text-gray-600 dark:text-slate-300">Drop Excel file here or click to browse</p>
                <p className="text-xs text-gray-400 dark:text-slate-500 mt-1">.xlsx · .xls &nbsp;·&nbsp; row 1 = headers, row 2+ = data</p>
              </div>
            </>
          )}
          <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void process(f); e.target.value = ''; }} />
        </div>

        {error && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-rose-600 dark:text-rose-400">
            <XCircle size={11} /> {error}
          </p>
        )}
      </div>
    </section>
  );
}

// ── Excel preview modal ────────────────────────────────────────────────────────

function ExcelPreviewModal({
  tables: initial, onApply, onClose,
}: {
  tables: ParsedTable[];
  onApply: (schema: string, seed: string) => void;
  onClose: () => void;
}) {
  const [tables, setTables]       = useState<ParsedTable[]>(initial);
  const [activeSheet, setActive]  = useState(initial[0]?.sheetName ?? '');
  const [showSample, setShowSample] = useState(false);

  const active = tables.find((t) => t.sheetName === activeSheet);

  const updateCol = (sheetName: string, idx: number, patch: Partial<ParsedColumn>) =>
    setTables((prev) => prev.map((t) =>
      t.sheetName === sheetName
        ? { ...t, columns: t.columns.map((c, i) => i === idx ? { ...c, ...patch } : c) }
        : t
    ));

  const totalRows = tables.reduce((s, t) => s + t.rowCount, 0);

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl max-h-[90vh] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-xl flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <FileSpreadsheet size={15} className="text-emerald-500" />
            <p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Excel Import Preview</p>
            <span className="text-xs text-gray-400 dark:text-slate-500">{tables.length} sheet{tables.length !== 1 ? 's' : ''} · {totalRows} rows</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-300"><X size={16} /></button>
        </div>

        {/* Body */}
        <div className="flex flex-1 min-h-0">

          {/* Left — sheet list */}
          <nav className="w-44 shrink-0 border-r border-gray-100 dark:border-slate-800 p-2 space-y-1 overflow-y-auto">
            {tables.map((t) => (
              <button key={t.sheetName} type="button" onClick={() => setActive(t.sheetName)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs transition-colors ${
                  activeSheet === t.sheetName
                    ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                }`}>
                <p className="truncate font-medium">{t.sheetName}</p>
                <p className="opacity-60 mt-0.5">{t.rowCount} rows · {t.columns.length} cols</p>
              </button>
            ))}
          </nav>

          {/* Right — column editor */}
          {active && (
            <div className="flex-1 p-4 overflow-y-auto space-y-4 min-w-0">

              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs text-gray-500 dark:text-slate-400">
                  Table:&nbsp;
                  <code className="font-mono bg-gray-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-blue-600 dark:text-blue-400">{active.name}</code>
                </p>
                <span className="text-[10px] text-gray-400 dark:text-slate-500">(sheet &quot;{active.sheetName}&quot;)</span>
                <button type="button" onClick={() => setShowSample((v) => !v)}
                  className="ml-auto inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-lg border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                  <Eye size={10} /> {showSample ? 'Hide' : 'Show'} sample data
                </button>
              </div>

              {/* Column type table */}
              <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-gray-50 dark:bg-slate-800/50 border-b border-gray-200 dark:border-slate-700">
                      <th className="text-left px-3 py-2 font-medium text-gray-500 dark:text-slate-400">Excel Column</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-500 dark:text-slate-400">PG Name</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-500 dark:text-slate-400">Type</th>
                      <th className="text-center px-3 py-2 font-medium text-gray-500 dark:text-slate-400">Nullable</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                    {active.columns.map((col, i) => (
                      <tr key={i} className="hover:bg-gray-50/50 dark:hover:bg-slate-800/20">
                        <td className="px-3 py-2 font-mono text-gray-600 dark:text-slate-400">{col.originalName}</td>
                        <td className="px-3 py-2 font-mono text-blue-600 dark:text-blue-400">{col.name}</td>
                        <td className="px-3 py-2">
                          <select value={col.type}
                            onChange={(e) => updateCol(active.sheetName, i, { type: e.target.value as PgColumnType })}
                            className="px-2 py-1 rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500">
                            {PG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input type="checkbox" checked={col.nullable}
                            onChange={(e) => updateCol(active.sheetName, i, { nullable: e.target.checked })}
                            className="rounded border-gray-300 dark:border-slate-600 accent-blue-600" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Sample data */}
              {showSample && active.sampleRows.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 mb-2">
                    Sample data (first {active.sampleRows.length} rows)
                  </p>
                  <div className="overflow-x-auto rounded-xl border border-gray-200 dark:border-slate-700">
                    <table className="text-[10px] font-mono w-full">
                      <thead>
                        <tr className="bg-gray-50 dark:bg-slate-800/50 border-b border-gray-100 dark:border-slate-800">
                          {active.columns.map((c, i) => (
                            <th key={i} className="text-left px-2 py-1.5 font-medium text-gray-500 dark:text-slate-400 whitespace-nowrap">{c.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                        {active.sampleRows.map((row, ri) => (
                          <tr key={ri}>
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-2 py-1.5 text-gray-600 dark:text-slate-400 max-w-[120px] truncate">
                                {cell.trim() !== '' ? cell : <span className="opacity-30 italic">null</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-gray-100 dark:border-slate-800 shrink-0">
          <p className="text-xs text-gray-400 dark:text-slate-500">
            Will generate <span className="font-semibold text-gray-700 dark:text-slate-300">{tables.length} CREATE TABLE</span> + <span className="font-semibold text-gray-700 dark:text-slate-300">{totalRows} INSERT</span> rows
          </p>
          <div className="flex items-center gap-3">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
              Cancel
            </button>
            <button type="button"
              onClick={() => onApply(generateSchemaSqlFromTables(tables), generateSeedSqlFromTables(tables))}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors">
              <CheckCircle2 size={13} /> Apply to Schema + Seed
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ── Save job modal ─────────────────────────────────────────────────────────────

function SaveJobModal({ onSave, onSkip }: { onSave: (name: string, desc: string) => void; onSkip: () => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Save size={15} className="text-blue-500" />
            <p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Save Job Record</p>
          </div>
          <button type="button" onClick={onSkip} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Job Name <span className="text-rose-500">*</span></label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Initial schema — project_x"
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">Use the same name as a previous job to group them as alter/patch runs under one history entry.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Description (optional)</label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)}
              placeholder="Notes about this run…" rows={3}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-slate-800">
          <button type="button" onClick={onSkip} className="px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">Skip</button>
          <button type="button" onClick={() => name.trim() && onSave(name.trim(), desc.trim())}
            disabled={!name.trim()}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
            <Save size={13} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SchemaGeneratorPage() {
  const { username } = useAuth();

  const [pgConnections, setPgConnections] = useState<ConnectionRow[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<number | ''>('');
  const [loadingConns, setLoadingConns] = useState(true);

  const [dbMode, setDbMode] = useState<DbMode>('existing');
  const [databases, setDatabases] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [selectedDb, setSelectedDb] = useState('');
  const [newDbName, setNewDbName] = useState('');
  const [creatingDb, setCreatingDb] = useState(false);
  const [createDbMsg, setCreateDbMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [schemaSql, setSchemaSql] = useState('');
  const [seedSql, setSeedSql] = useState('');
  const [schemaFile, setSchemaFile] = useState<UploadedFile | null>(null);
  const [seedFile, setSeedFile] = useState<UploadedFile | null>(null);

  const [running, setRunning] = useState(false);
  const [runLog, setRunLog] = useState<LogLine[]>([]);
  const [lastRunStatus, setLastRunStatus] = useState<'success' | 'failed' | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);

  const [jobs, setJobs] = useState<SchemaJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const [excelTables, setExcelTables]       = useState<ParsedTable[] | null>(null);
  const [showExcelPreview, setShowExcelPreview] = useState(false);

  // Derived analysis
  const schemaAnalysis = useMemo(() => analyzeSchemaSql(schemaSql), [schemaSql]);
  const seedAnalysis   = useMemo(() => analyzeSeedSql(seedSql),   [seedSql]);
  const jobGroups      = useMemo(() => groupJobs(jobs), [jobs]);

  // Load connections
  useEffect(() => {
    void (async () => {
      setLoadingConns(true);
      try {
        const { data } = await axios.get('/api/connections');
        const pgOnly = (data as { connections: ConnectionRow[] }).connections.filter((c) => c.db_type === 'postgres');
        setPgConnections(pgOnly);
        const active = pgOnly.find((c) => c.is_active) ?? pgOnly[0];
        if (active) setSelectedConnId(active.id);
      } catch { /* ignore */ }
      finally { setLoadingConns(false); }
    })();
  }, []);

  const selectedConn = pgConnections.find((c) => c.id === selectedConnId) ?? null;

  const loadDatabases = useCallback(async (conn: ConnectionRow, preselectDb?: string) => {
    setLoadingDbs(true); setDatabases([]); setSelectedDb('');
    try {
      const { data } = await axios.post('/api/pg-databases', {
        host: conn.host, port: conn.port,
        user: conn.username, password: conn.password_enc ?? '',
        ssl: conn.ssl_enabled,
      });
      const list = (data as { databases: string[] }).databases;
      setDatabases(list);
      const pick = preselectDb && list.includes(preselectDb)
        ? preselectDb
        : conn.database_name && list.includes(conn.database_name)
        ? conn.database_name
        : (list[0] ?? '');
      setSelectedDb(pick);
    } catch { setDatabases([]); }
    finally { setLoadingDbs(false); }
  }, []);

  useEffect(() => {
    setCreateDbMsg(null); setNewDbName('');
    if (selectedConn) void loadDatabases(selectedConn);
  }, [selectedConnId, selectedConn, loadDatabases]);

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const { data } = await axios.get('/api/schema-generator/jobs', { headers: authHeader() });
      setJobs((data as { jobs: SchemaJob[] }).jobs);
    } catch { /* ignore */ }
    finally { setLoadingJobs(false); }
  }, []);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const handleCreateDb = async () => {
    if (!selectedConn || !newDbName.trim()) return;
    setCreatingDb(true); setCreateDbMsg(null);
    try {
      const { data } = await axios.post('/api/pg-create-db', {
        host: selectedConn.host, port: selectedConn.port,
        user: selectedConn.username, password: selectedConn.password_enc ?? '',
        ssl: selectedConn.ssl_enabled, dbName: newDbName.trim(),
      });
      setCreateDbMsg({ ok: true, text: (data as { message: string }).message });
      await loadDatabases(selectedConn, newDbName.trim());
      setDbMode('existing');
    } catch (err: unknown) {
      setCreateDbMsg({ ok: false, text: axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err) });
    } finally { setCreatingDb(false); }
  };

  const targetDatabase = dbMode === 'existing' ? selectedDb : newDbName.trim();

  const handleRun = async () => {
    if (!selectedConn || !targetDatabase || !schemaSql.trim()) return;
    setRunning(true); setRunLog([]); setLastRunStatus(null);
    const cfg = { host: selectedConn.host, port: selectedConn.port, user: selectedConn.username, password: selectedConn.password_enc ?? '', database: targetDatabase, ssl: selectedConn.ssl_enabled };
    const steps: Array<{ step: RunStep; sql: string; label: string }> = [
      { step: 'schema', sql: schemaSql, label: 'Schema SQL' },
      ...(seedSql.trim() ? [{ step: 'seed' as RunStep, sql: seedSql, label: 'Seed Data SQL' }] : []),
    ];
    const log: LogLine[] = [];
    let allOk = true;
    for (const { step, sql, label } of steps) {
      try {
        const { data } = await axios.post('/api/sql-execute', { pgConfig: cfg, sql, label });
        const d = data as { success?: boolean; rolledBack?: boolean; log?: string[]; error?: string };
        // Expand all log lines returned by the API into individual entries
        const lines = d.log ?? [`[OK] ${label}`];
        for (const text of lines) log.push({ step, ok: Boolean(d.success), text });
        setRunLog([...log]);
        if (!d.success) { allOk = false; break; }
      } catch (err: unknown) {
        const errData = axios.isAxiosError(err) ? err.response?.data as { log?: string[]; error?: string } | undefined : undefined;
        const lines: string[] = errData?.log ?? [
          axios.isAxiosError(err) ? (errData?.error ?? err.message) : String(err),
        ];
        for (const text of lines) log.push({ step, ok: false, text });
        setRunLog([...log]); allOk = false; break;
      }
    }
    setLastRunStatus(allOk ? 'success' : 'failed');
    setRunning(false);
    setShowSaveModal(true);
  };

  const handleSaveJob = async (jobName: string, description: string) => {
    setShowSaveModal(false);
    try {
      await axios.post('/api/schema-generator/jobs', {
        job_name: jobName, description,
        connection_label: selectedConn?.label ?? null,
        target_database: targetDatabase,
        schema_file_path: schemaFile?.filePath ?? null,
        seed_file_path: seedFile?.filePath ?? null,
        schema_sql: schemaSql,
        seed_sql: seedSql || null,
        status: lastRunStatus,
        log: runLog,
      }, { headers: authHeader() });
      await loadJobs();
    } catch { /* ignore */ }
  };

  // Load config from a job record — used for both retry (failed) and reference (any)
  const handleLoadJob = async (job: SchemaJob) => {
    try {
      const { data } = await axios.get(`/api/schema-generator/jobs/${job.id}`, { headers: authHeader() });
      const full = (data as { job: SchemaJob & { schema_sql?: string; seed_sql?: string } }).job;

      // Restore SQL content
      if (full.schema_sql) setSchemaSql(full.schema_sql);
      if (full.seed_sql)   setSeedSql(full.seed_sql);
      else                 setSeedSql('');

      // Clear previously uploaded file badges (new run, new files if re-uploaded)
      setSchemaFile(null); setSeedFile(null);

      // Try to match connection by label
      const matchConn = pgConnections.find((c) => c.label === full.connection_label);
      if (matchConn) {
        setSelectedConnId(matchConn.id);
        // loadDatabases fires via useEffect; pass target DB as preselect
        if (full.target_database) {
          // Small delay to let useEffect run first, then override selectedDb
          setTimeout(() => setSelectedDb((prev) => full.target_database ?? prev), 300);
        }
      } else if (full.target_database) {
        // Connection not found, at least preselect the DB name in the current list
        setSelectedDb(full.target_database);
      }

      // Reset execution state so user starts fresh
      setRunLog([]); setLastRunStatus(null);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch { /* ignore */ }
  };

  const canRun = Boolean(selectedConn && targetDatabase && schemaSql.trim() && !running);

  return (
    <>
      <Head><title>Schema Generator — DB Maintenance Tools</title></Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900 pb-16">

        <header className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FileCode2 size={18} className="text-blue-600" />
            <div>
              <h1 className="font-bold text-gray-900 dark:text-slate-100">Schema Generator</h1>
              <p className="text-xs text-gray-500 dark:text-slate-400">Apply AI-generated schema and seed data to a PostgreSQL database.</p>
            </div>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Home</Link>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <span className="px-3 py-1 rounded-lg bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold">Schema Generator</span>
          </nav>
        </header>

        <div className="max-w-7xl mx-auto px-6 py-8">
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-6 items-start">

            {/* ── Left: main steps ─────────────────────────────────────────── */}
            <div className="space-y-5">

              <div className="flex items-start gap-2.5 px-4 py-3 rounded-xl bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-300">
                <Info size={14} className="shrink-0 mt-0.5" />
                Use an AI assistant to extract schema and seed data from your design documents, then paste or drag-and-drop the generated SQL below.
              </div>

              {/* Step 1 */}
              <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
                  <Server size={15} className="text-blue-500" />
                  <p className="text-sm font-semibold text-gray-900 dark:text-slate-100">Step 1 — PostgreSQL Connection</p>
                </div>
                <div className="p-5">
                  {loadingConns ? (
                    <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={14} className="animate-spin" /> Loading…</div>
                  ) : pgConnections.length === 0 ? (
                    <p className="text-sm text-amber-700 dark:text-amber-400">
                      No PostgreSQL connections saved.{' '}
                      <Link href="/settings" className="underline font-medium">Go to Settings → DB Connection</Link> to add one.
                    </p>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {pgConnections.map((c) => (
                        <button key={c.id} type="button" onClick={() => setSelectedConnId(c.id)}
                          className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-colors ${
                            selectedConnId === c.id
                              ? 'border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-950/30'
                              : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                          }`}>
                          <Database size={16} className={selectedConnId === c.id ? 'text-blue-500' : 'text-gray-400 dark:text-slate-500'} />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-gray-900 dark:text-slate-100 truncate">{c.label}</p>
                            <p className="text-xs text-gray-400 dark:text-slate-500 truncate">{c.username}@{c.host}:{c.port}</p>
                          </div>
                          {c.is_active && (
                            <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400">Active</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </section>

              {/* Step 2 */}
              {selectedConn && (
                <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
                  <div className="flex items-center gap-2.5 px-5 py-3.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
                    <Database size={15} className="text-blue-500" />
                    <p className="text-sm font-semibold text-gray-900 dark:text-slate-100">Step 2 — Target Database</p>
                  </div>
                  <div className="p-5 space-y-4">
                    <div className="flex gap-2">
                      {(['existing', 'new'] as DbMode[]).map((mode) => (
                        <button key={mode} type="button" onClick={() => { setDbMode(mode); setCreateDbMsg(null); }}
                          className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                            dbMode === mode
                              ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
                              : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                          }`}>{mode === 'existing' ? 'Use existing' : 'Create new'}</button>
                      ))}
                    </div>

                    {dbMode === 'existing' ? (
                      <div className="flex items-center gap-3">
                        {loadingDbs
                          ? <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 size={13} className="animate-spin" /> Loading databases…</div>
                          : (
                            <>
                              <select value={selectedDb} onChange={(e) => setSelectedDb(e.target.value)}
                                className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500">
                                {databases.length === 0
                                  ? <option value="">No databases found</option>
                                  : databases.map((db) => <option key={db} value={db}>{db}</option>)
                                }
                              </select>
                              <button type="button" onClick={() => void loadDatabases(selectedConn)}
                                className="p-2 rounded-lg border border-gray-300 dark:border-slate-600 text-gray-500 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                                <RefreshCw size={14} />
                              </button>
                            </>
                          )
                        }
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <input type="text" value={newDbName}
                            onChange={(e) => { setNewDbName(e.target.value); setCreateDbMsg(null); }}
                            placeholder="my_new_database"
                            className="flex-1 px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                          <button type="button" onClick={() => void handleCreateDb()}
                            disabled={creatingDb || !newDbName.trim()}
                            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                            {creatingDb ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                            {creatingDb ? 'Creating…' : 'Create'}
                          </button>
                        </div>
                        {createDbMsg && (
                          <p className={`flex items-center gap-1.5 text-xs ${createDbMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                            {createDbMsg.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                            {createDbMsg.text}
                          </p>
                        )}
                        <p className="text-xs text-gray-400 dark:text-slate-500">Letters, digits, and underscores only.</p>
                      </div>
                    )}

                    {targetDatabase && (
                      <p className="text-xs text-gray-500 dark:text-slate-400 flex items-center gap-1.5">
                        <CheckCircle2 size={11} className="text-emerald-500" />
                        Target: <span className="font-semibold text-gray-800 dark:text-slate-200">{targetDatabase}</span> on {selectedConn.host}:{selectedConn.port}
                      </p>
                    )}
                  </div>
                </section>
              )}

              {/* Excel import — optional alternative to pasting SQL */}
              {selectedConn && (
                <ExcelImportCard
                  onParsed={(tables) => { setExcelTables(tables); setShowExcelPreview(true); }}
                />
              )}

              {/* Step 3 — Schema SQL */}
              {selectedConn && (
                <DragDropSqlField
                  label="Step 3 — Schema SQL"
                  icon={FileCode2}
                  description="Drag-and-drop or browse a .sql file — or paste directly."
                  value={schemaSql} onChange={setSchemaSql}
                  uploadedFile={schemaFile} onFileUploaded={setSchemaFile}
                  placeholder={`-- Paste or drop your schema SQL here…\nCREATE TABLE users (\n  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n  email TEXT NOT NULL UNIQUE\n);`}
                  footer={schemaAnalysis ? <SchemaAnalysisBadge a={schemaAnalysis} /> : undefined}
                />
              )}

              {/* Step 4 — Seed SQL */}
              {selectedConn && (
                <DragDropSqlField
                  label="Step 4 — Seed Data SQL (optional)"
                  icon={Sprout}
                  description="Drag-and-drop or browse a .sql file — or paste directly. Executed after schema."
                  value={seedSql} onChange={setSeedSql}
                  uploadedFile={seedFile} onFileUploaded={setSeedFile}
                  placeholder={`-- Paste or drop your seed SQL here…\nINSERT INTO users (email) VALUES ('admin@example.com');`}
                  footer={seedAnalysis ? <SeedAnalysisBadge a={seedAnalysis} /> : undefined}
                />
              )}

              {/* Step 5 — Execute */}
              {selectedConn && (
                <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
                    <div className="flex items-center gap-2.5">
                      <Play size={15} className="text-blue-500" />
                      <p className="text-sm font-semibold text-gray-900 dark:text-slate-100">Step 5 — Execute</p>
                    </div>
                    <button type="button" onClick={() => void handleRun()} disabled={!canRun}
                      className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 transition-colors">
                      {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                      {running ? 'Running…' : `Run Schema${seedSql.trim() ? ' + Seed' : ''}`}
                    </button>
                  </div>
                  <div className="p-5">
                    {!schemaSql.trim() && (
                      <p className="text-xs text-gray-400 dark:text-slate-500">Add Schema SQL above to enable execution.</p>
                    )}
                    {runLog.length > 0 && (
                      <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
                        <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800">
                          <Terminal size={13} className="text-gray-500" />
                          <span className="text-xs font-medium text-gray-600 dark:text-slate-400">Output</span>
                          {!running && lastRunStatus && (
                            <span className={`ml-auto text-[10px] font-semibold ${lastRunStatus === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                              {lastRunStatus === 'success' ? '✓ All steps succeeded' : '✗ Stopped on error'}
                            </span>
                          )}
                        </div>
                        <div className="p-4 space-y-2 font-mono text-xs max-h-60 overflow-y-auto">
                          {runLog.map((line, i) => {
                            const isRollback = line.text.startsWith('[ROLLBACK]');
                            const isNote     = line.text.startsWith('[NOTE]');
                            const colorCls   = line.ok
                              ? 'text-emerald-600 dark:text-emerald-400'
                              : isRollback || isNote
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-rose-600 dark:text-rose-400';
                            const Icon = line.ok ? CheckCircle2 : isRollback ? AlertCircle : XCircle;
                            return (
                              <div key={i} className={`flex items-start gap-2 ${colorCls}`}>
                                <Icon size={12} className="mt-0.5 shrink-0" />
                                <span><span className="opacity-50 mr-1.5">[{line.step}]</span>{line.text}</span>
                              </div>
                            );
                          })}
                          {running && <div className="flex items-center gap-2 text-gray-400"><Loader2 size={12} className="animate-spin" /> Executing…</div>}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>

            {/* ── Right: job history ────────────────────────────────────────── */}
            <aside className="xl:sticky xl:top-24 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-800 dark:text-slate-200">
                  Job History
                  {username && <span className="ml-1.5 text-xs font-normal text-gray-400 dark:text-slate-500">({username})</span>}
                </p>
                <button type="button" onClick={() => void loadJobs()} disabled={loadingJobs}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
                  {loadingJobs ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                </button>
              </div>

              {jobs.length === 0 && !loadingJobs ? (
                <div className="text-center py-8 border border-dashed border-gray-200 dark:border-slate-700 rounded-xl text-xs text-gray-400 dark:text-slate-500">
                  No jobs yet. Run a schema to see history here.
                </div>
              ) : (
                <div className="space-y-2 max-h-[calc(100vh-160px)] overflow-y-auto pr-0.5">
                  {jobGroups.map((group) => (
                    <JobGroupCard key={group.job_name} group={group} onLoad={(j) => void handleLoadJob(j)} />
                  ))}
                </div>
              )}
            </aside>

          </div>
        </div>

        {showExcelPreview && excelTables && (
          <ExcelPreviewModal
            tables={excelTables}
            onApply={(schema, seed) => {
              setSchemaSql(schema);
              setSeedSql(seed);
              setSchemaFile(null);
              setSeedFile(null);
              setShowExcelPreview(false);
              setExcelTables(null);
            }}
            onClose={() => { setShowExcelPreview(false); setExcelTables(null); }}
          />
        )}

        {showSaveModal && (
          <SaveJobModal
            onSave={(name, desc) => void handleSaveJob(name, desc)}
            onSkip={() => setShowSaveModal(false)}
          />
        )}

      </div>
    </>
  );
}
