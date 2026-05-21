'use client';
import Head from 'next/head';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Upload, FileSpreadsheet, FileText, FileJson,
  ChevronRight, ChevronLeft, Check, X, Download, RefreshCw, Loader2,
  Table2, Wand2, Database, AlertTriangle, Info,
  BarChart2, Hash, Layers, Save, Trash2, Clock,
} from 'lucide-react';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import { useAuth } from '../lib/auth-context';

function getToken() {
  return typeof window !== 'undefined' ? (localStorage.getItem('auth_token') ?? '') : '';
}
const authH = () => ({ Authorization: `Bearer ${getToken()}` });

// ── Types ─────────────────────────────────────────────────────────────────────

interface ColProfile {
  name: string;
  index: number;
  total: number;
  nullCount: number;
  distinctCount: number;
  topValues: { value: string; count: number }[];
  inferredType: string;
  fkCandidate: boolean;
}

interface FkSuggestion {
  colName: string;
  colIndex: number;
  distinctValues: string[];
  suggestedLookupTable: string;
}

interface SheetResult {
  sheetName: string;
  tableName: string;
  headers: string[];
  previewRows: string[][];
  allRows: string[][];
  rowCount: number;
  columns: ColProfile[];
  fkSuggestions: FkSuggestion[];
}

interface ConfirmedLookup {
  colName: string;
  colIndex: number;
  lookupTable: string;
  distinctValues: string[];
}

interface NormalizerJob {
  id: string;
  name: string;
  savedAt: string;
  step: Step;
  sheets: SheetResult[];
  activeSheet: string;
  dismissedSuggestions: number[];
  confirmedLookups: ConfirmedLookup[];
}

type Step = 1 | 2 | 3 | 4;
type ExportMode = 'sql' | 'csv' | 'json';

// Columns to auto-exclude from duplicate comparison (overrideable by the user)
const DUP_SKIP_TYPES = new Set(['TIMESTAMP', 'DATE', 'UUID']);

function defaultColsForDupe(sheet: SheetResult): Set<number> {
  return new Set(
    sheet.columns
      .filter(c =>
        !DUP_SKIP_TYPES.has(c.inferredType) &&
        !(c.distinctCount >= c.total - c.nullCount && c.total - c.nullCount > 0)
      )
      .map(c => c.index)
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') return <FileSpreadsheet size={16} className="text-green-600" />;
  if (ext === 'csv') return <FileText size={16} className="text-blue-600" />;
  return <FileJson size={16} className="text-amber-600" />;
}

function typeBadge(type: string) {
  const map: Record<string, string> = {
    TEXT: 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300',
    INTEGER: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300',
    BIGINT: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300',
    NUMERIC: 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300',
    BOOLEAN: 'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300',
    DATE: 'bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300',
    TIMESTAMP: 'bg-teal-50 dark:bg-teal-950/40 text-teal-700 dark:text-teal-300',
    UUID: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300',
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${map[type] ?? map.TEXT}`}>
      {type}
    </span>
  );
}

// ── Upload step ────────────────────────────────────────────────────────────────

function UploadStep({ onParsed }: { onParsed: (sheets: SheetResult[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const accept = (f: File) => {
    const ext = f.name.split('.').pop()?.toLowerCase();
    if (!['xlsx', 'xls', 'csv', 'json'].includes(ext ?? '')) {
      setError('Only XLSX, CSV, and JSON files are supported.'); return;
    }
    setFile(f); setError(null);
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false);
    const f = e.dataTransfer.files[0]; if (f) accept(f);
  }, []);

  const onParse = async () => {
    if (!file) return;
    setLoading(true); setError(null);
    try {
      const ext = file.name.split('.').pop()?.toLowerCase();
      let content: string;
      if (ext === 'xlsx' || ext === 'xls') {
        const buf = await file.arrayBuffer();
        content = Buffer.from(buf).toString('base64');
      } else {
        content = await file.text();
      }
      const { data } = await axios.post('/api/normalizer/parse', { filename: file.name, content }, { headers: authH() });
      onParsed((data as { sheets: SheetResult[] }).sheets);
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally { setLoading(false); }
  };

  return (
    <div className="h-full overflow-auto panel-scroll flex items-start justify-center py-10 px-6">
      <div className="w-full max-w-xl space-y-4">
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          className={`relative flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed cursor-pointer transition-colors min-h-[220px] p-8
            ${dragging ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/20' : 'border-gray-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-700 bg-white dark:bg-slate-900'}`}
        >
          <input ref={inputRef} type="file" className="hidden" accept=".xlsx,.xls,.csv,.json"
            onChange={e => { const f = e.target.files?.[0]; if (f) accept(f); }} />
          {file ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-slate-200">
                {fileIcon(file.name)} {file.name}
                <span className="text-xs text-gray-400">({(file.size / 1024).toFixed(1)} KB)</span>
              </div>
              <p className="text-xs text-gray-400">Click or drag to replace</p>
            </>
          ) : (
            <>
              <Upload size={36} className="text-gray-300 dark:text-slate-600" />
              <div className="text-center">
                <p className="text-sm font-medium text-gray-600 dark:text-slate-300">Drop a file here or click to browse</p>
                <p className="text-xs text-gray-400 mt-1">Supports XLSX, CSV, JSON</p>
              </div>
            </>
          )}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-4 py-3 text-xs text-red-700 dark:text-red-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-gray-600 dark:text-slate-300 flex items-center gap-1.5">
            <Info size={12} className="text-blue-500" /> What this module does
          </p>
          <ul className="text-xs text-gray-500 dark:text-slate-400 space-y-1 pl-4 list-disc">
            <li>Parses your file and profiles each column (types, null count, distinct values)</li>
            <li>Detects repetitive string columns — candidates for lookup / FK tables</li>
            <li>Lets you confirm which columns to extract into separate lookup tables</li>
            <li>Generates a normalised schema with FK relationships</li>
            <li>Exports the result as SQL (CREATE + INSERT), CSV, or JSON</li>
          </ul>
        </div>

        <div className="flex justify-end">
          <button onClick={onParse} disabled={!file || loading}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            {loading ? 'Parsing…' : 'Parse & Profile'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Profile left panel ─────────────────────────────────────────────────────────

function ProfileLeftPanel({
  sheets, activeSheet, onSheetChange, sheet, dismissedSuggestions, onToggleSuggestion,
  colsForDupe, onShowDupes,
}: {
  sheets: SheetResult[];
  activeSheet: string;
  onSheetChange: (s: string) => void;
  sheet: SheetResult;
  dismissedSuggestions: Set<number>;
  onToggleSuggestion: (idx: number) => void;
  colsForDupe: Set<number>;
  onShowDupes: () => void;
}) {
  const activeSuggestions = sheet.fkSuggestions.filter(s => !dismissedSuggestions.has(s.colIndex));

  const duplicateCount = (() => {
    const seen = new Set<string>(); let dupes = 0;
    for (const row of sheet.allRows) {
      const key = JSON.stringify(row.filter((_, i) => colsForDupe.has(i)));
      if (seen.has(key)) dupes++; else seen.add(key);
    }
    return dupes;
  })();

  const excludedCount = sheet.columns.length - colsForDupe.size;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* Sheet selector */}
      {sheets.length > 1 && (
        <>
          <div className="shrink-0 px-4 py-2 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40">
            <p className="text-[11px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">Sheet</p>
          </div>
          <div className="shrink-0 p-2.5 flex flex-col gap-1 border-b border-gray-100 dark:border-slate-800">
            {sheets.map(s => (
              <button key={s.sheetName} onClick={() => onSheetChange(s.sheetName)}
                className={`px-2.5 py-1.5 rounded text-xs font-medium text-left transition-colors
                  ${s.sheetName === activeSheet ? 'bg-blue-600 text-white' : 'text-gray-600 dark:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800'}`}>
                {s.sheetName}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Analysis Summary */}
      <div className="shrink-0 px-4 py-2 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40">
        <p className="text-[11px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">Analysis Summary</p>
      </div>
      <div className="shrink-0 divide-y divide-gray-100 dark:divide-slate-800">
        {[
          { icon: <Table2 size={13} className="text-blue-500" />, label: 'Rows', value: <span>{sheet.rowCount.toLocaleString()}</span>, sub: null },
          { icon: <Hash size={13} className="text-purple-500" />, label: 'Columns', value: <span>{sheet.columns.length}</span>, sub: null },
          { icon: <Layers size={13} className="text-amber-500" />, label: 'FK Candidates', value: <span>{sheet.fkSuggestions.length}</span>, sub: null },
          {
            icon: <AlertTriangle size={13} className={duplicateCount > 0 ? 'text-rose-500' : 'text-green-500'} />,
            label: 'Duplicate Rows',
            value: duplicateCount > 0
              ? <div className="flex items-center gap-1.5">
                  <span className="text-rose-600 dark:text-rose-400 font-bold">{duplicateCount}</span>
                  <button onClick={onShowDupes}
                    className="text-[10px] text-blue-500 hover:text-blue-700 dark:hover:text-blue-300 hover:underline font-medium transition-colors">
                    Preview
                  </button>
                </div>
              : <span className="text-green-600 dark:text-green-400">0</span>,
            sub: excludedCount > 0
              ? <span className="text-[10px] text-gray-400 dark:text-slate-500">excl. {excludedCount} col{excludedCount > 1 ? 's' : ''}</span>
              : null,
          },
        ].map(({ icon, label, value, sub }) => (
          <div key={label} className="flex items-center gap-2.5 px-4 py-2.5">
            {icon}
            <span className="text-xs text-gray-500 dark:text-slate-400 flex-1">{label}</span>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-sm font-bold text-gray-800 dark:text-slate-100">{value}</span>
              {sub}
            </div>
          </div>
        ))}
      </div>

      {/* FK / Lookup suggestions */}
      {sheet.fkSuggestions.length > 0 && (
        <>
          <div className="shrink-0 px-4 py-2 border-b border-t border-amber-100 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20 flex items-center gap-1.5">
            <Wand2 size={11} className="text-amber-600 dark:text-amber-400" />
            <p className="text-[11px] font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wider">FK / Lookup</p>
            <span className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">{activeSuggestions.length}/{sheet.fkSuggestions.length}</span>
          </div>
          <div className="flex-1 overflow-y-auto panel-scroll p-2.5 flex flex-col gap-1.5">
            {sheet.fkSuggestions.map(s => {
              const active = !dismissedSuggestions.has(s.colIndex);
              return (
                <button key={s.colIndex} onClick={() => onToggleSuggestion(s.colIndex)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-medium transition-colors text-left
                    ${active ? 'bg-amber-500 text-white' : 'text-gray-400 dark:text-slate-500 hover:bg-gray-100 dark:hover:bg-slate-800 line-through opacity-60'}`}>
                  {active ? <Check size={10} /> : <X size={10} />}
                  <span className="font-mono truncate flex-1">{s.colName}</span>
                  <span className="opacity-70 shrink-0">({s.distinctValues.length})</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      {sheet.fkSuggestions.length === 0 && <div className="flex-1" />}
    </div>
  );
}

// ── Profile right panel ────────────────────────────────────────────────────────

function ProfileRightPanel({
  sheet, dismissedSuggestions, onToggleSuggestion, colsForDupe, onToggleColForDupe,
  showDupes, onSetShowDupes,
}: {
  sheet: SheetResult;
  dismissedSuggestions: Set<number>;
  onToggleSuggestion: (idx: number) => void;
  colsForDupe: Set<number>;
  onToggleColForDupe: (idx: number) => void;
  showDupes: boolean;
  onSetShowDupes: (v: boolean) => void;
}) {
  const allChecked = sheet.columns.every(c => colsForDupe.has(c.index));
  const toggleAll = () => {
    if (allChecked) {
      sheet.columns.forEach(c => { if (colsForDupe.has(c.index)) onToggleColForDupe(c.index); });
    } else {
      sheet.columns.forEach(c => { if (!colsForDupe.has(c.index)) onToggleColForDupe(c.index); });
    }
  };

  // Compute duplicate groups when preview is active
  const dupeGroups: string[][][] = [];
  if (showDupes) {
    const seen = new Map<string, string[][]>();
    for (const row of sheet.allRows) {
      const key = JSON.stringify(row.filter((_, i) => colsForDupe.has(i)));
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key)!.push(row);
    }
    for (const rows of seen.values()) {
      if (rows.length > 1) dupeGroups.push(rows);
    }
    dupeGroups.sort((a, b) => b.length - a.length);
  }
  const dupeRowCount = dupeGroups.reduce((s, g) => s + g.length, 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tab header */}
      <div className="shrink-0 flex items-stretch border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
        <button onClick={() => onSetShowDupes(false)}
          className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${!showDupes ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'}`}>
          <BarChart2 size={12} /> Column Profile
        </button>
        <button onClick={() => onSetShowDupes(true)}
          className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${showDupes ? 'border-rose-500 text-rose-600 dark:text-rose-400' : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'}`}>
          <AlertTriangle size={12} /> Duplicate Rows
        </button>
        <span className="ml-auto flex items-center px-4 text-[11px] text-gray-400 dark:text-slate-500">
          {showDupes ? `${dupeRowCount} rows in ${dupeGroups.length} groups` : `${sheet.columns.length} columns`}
        </span>
      </div>
      {/* ── Column Profile view ── */}
      {!showDupes && (
        <div className="flex-1 min-h-0 overflow-auto panel-scroll">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/30">
                <th className="px-3 py-2 w-10">
                  <div className="flex flex-col items-center gap-0.5">
                    <input type="checkbox" checked={allChecked} onChange={toggleAll}
                      className="w-3.5 h-3.5 rounded cursor-pointer accent-blue-600" />
                    <span className="text-[9px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide">Dup</span>
                  </div>
                </th>
                {['Column', 'Type', 'Nulls', 'Distinct', 'Top Values', 'FK?'].map(h => (
                  <th key={h} className="text-left px-3 py-2 font-semibold text-gray-600 dark:text-slate-300 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-slate-800/60">
              {sheet.columns.map(col => {
                const isSuggested = sheet.fkSuggestions.some(s => s.colIndex === col.index);
                const isActive = isSuggested && !dismissedSuggestions.has(col.index);
                const inDup = colsForDupe.has(col.index);
                return (
                  <tr key={col.index} className={isActive ? 'bg-amber-50/50 dark:bg-amber-950/10' : 'hover:bg-gray-50/50 dark:hover:bg-slate-800/20'}>
                    <td className="px-3 py-2 text-center">
                      <input type="checkbox" checked={inDup} onChange={() => onToggleColForDupe(col.index)}
                        className="w-3.5 h-3.5 rounded cursor-pointer accent-blue-600" />
                    </td>
                    <td className={`px-3 py-2 font-medium max-w-[180px] truncate ${inDup ? 'text-gray-800 dark:text-slate-100' : 'text-gray-400 dark:text-slate-500'}`}>
                      {col.name}{isActive && <span className="ml-1 text-amber-500 text-[10px]">→FK</span>}
                    </td>
                    <td className="px-3 py-2">{typeBadge(col.inferredType)}</td>
                    <td className="px-3 py-2 text-gray-500 dark:text-slate-400">
                      {col.nullCount > 0
                        ? <span className="text-orange-600 dark:text-orange-400">{col.nullCount}</span>
                        : <span className="text-green-600 dark:text-green-400">0</span>}
                      <span className="text-gray-300 dark:text-slate-600 ml-1">/{col.total}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-600 dark:text-slate-300 font-mono">{col.distinctCount}</td>
                    <td className="px-3 py-2 max-w-[260px]">
                      <div className="flex flex-wrap gap-1">
                        {col.topValues.slice(0, 4).map(tv => (
                          <span key={tv.value} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300 text-[10px] truncate max-w-[80px]" title={tv.value}>
                            {tv.value || <span className="italic text-gray-400">empty</span>}
                            <span className="text-gray-400 ml-0.5">×{tv.count}</span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      {isSuggested && (
                        <button onClick={() => onToggleSuggestion(col.index)}
                          className={`px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${isActive ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 hover:bg-amber-200' : 'bg-gray-100 dark:bg-slate-800 text-gray-400 line-through hover:bg-gray-200'}`}>
                          {isActive ? 'yes' : 'off'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Duplicate Rows view ── */}
      {showDupes && (
        <div className="flex-1 min-h-0 overflow-auto panel-scroll">
          {dupeGroups.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-[11px] text-gray-400 dark:text-slate-500">
              No duplicate rows found with current column selection.
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/30">
                  <th className="px-3 py-2 w-8 text-center font-semibold text-gray-400 dark:text-slate-500">#</th>
                  {sheet.headers.map((h, i) => (
                    <th key={i} className={`text-left px-3 py-2 font-semibold whitespace-nowrap ${colsForDupe.has(i) ? 'text-gray-600 dark:text-slate-300' : 'text-gray-300 dark:text-slate-600'}`}>
                      {h}{!colsForDupe.has(i) && <span className="ml-1 text-[9px] italic">excl</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dupeGroups.map((group, gi) => (
                  <>
                    <tr key={`g${gi}`} className="bg-rose-50 dark:bg-rose-950/20 border-t border-rose-200 dark:border-rose-800">
                      <td colSpan={sheet.headers.length + 1} className="px-3 py-1">
                        <span className="text-[10px] font-semibold text-rose-600 dark:text-rose-400">
                          × {group.length} copies
                        </span>
                      </td>
                    </tr>
                    {group.map((row, ri) => (
                      <tr key={`g${gi}r${ri}`} className="border-b border-gray-100 dark:border-slate-800/60 hover:bg-gray-50/50 dark:hover:bg-slate-800/20">
                        <td className="px-3 py-1.5 text-center text-gray-300 dark:text-slate-600 font-mono">{ri + 1}</td>
                        {row.map((v, ci) => (
                          <td key={ci} className={`px-3 py-1.5 max-w-[160px] truncate ${colsForDupe.has(ci) ? 'text-gray-700 dark:text-slate-200' : 'text-gray-300 dark:text-slate-600 italic'}`} title={v}>
                            {v || <span className="text-gray-300 dark:text-slate-600">—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ── Schema left panel (lookup tables) ─────────────────────────────────────────

function SchemaLeftPanel({ confirmedLookups }: { confirmedLookups: ConfirmedLookup[] }) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
        <Database size={13} className="text-amber-500" />
        <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">Lookup Tables</p>
        {confirmedLookups.length > 0 && (
          <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500">{confirmedLookups.length}</span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto panel-scroll">
        {confirmedLookups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[11px] text-gray-400 dark:text-slate-500 px-4 text-center">
            <Layers size={20} className="text-gray-200 dark:text-slate-700" />
            No lookup tables configured
          </div>
        ) : (
          <div className="p-3 space-y-2.5">
            {confirmedLookups.map(lk => (
              <div key={lk.colIndex} className="border border-amber-200 dark:border-amber-800 overflow-hidden">
                <div className="flex items-center gap-1.5 px-3 py-2 bg-amber-50 dark:bg-amber-950/20 border-b border-amber-100 dark:border-amber-900">
                  <Table2 size={11} className="text-amber-600 shrink-0" />
                  <span className="text-[11px] font-semibold font-mono text-amber-800 dark:text-amber-300 truncate flex-1">{lk.lookupTable}</span>
                  <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">{lk.distinctValues.length}r</span>
                </div>
                <div className="px-3 py-2 bg-white dark:bg-slate-900 text-[10px] space-y-0.5">
                  <div className="flex gap-2 text-gray-400 dark:text-slate-500 font-mono pb-1 border-b border-gray-100 dark:border-slate-800">
                    <span className="w-5">id</span><span>SERIAL PK</span>
                  </div>
                  <div className="flex gap-2 text-gray-400 dark:text-slate-500 font-mono">
                    <span className="w-5">val</span><span>TEXT UNIQUE</span>
                  </div>
                  <div className="pt-1 flex flex-wrap gap-1">
                    {lk.distinctValues.slice(0, 5).map(v => (
                      <span key={v} className="px-1 py-0.5 bg-gray-100 dark:bg-slate-800 text-[10px] text-gray-500 dark:text-slate-400 truncate max-w-[80px]" title={v}>{v}</span>
                    ))}
                    {lk.distinctValues.length > 5 && (
                      <span className="text-[10px] text-gray-400">+{lk.distinctValues.length - 5}</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Schema main panel (main table) ────────────────────────────────────────────

function SchemaMainPanel({ sheet, confirmedLookups }: { sheet: SheetResult; confirmedLookups: ConfirmedLookup[] }) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40">
        <Table2 size={13} className="text-blue-500" />
        <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">Main Table —</p>
        <span className="text-xs font-mono text-blue-600 dark:text-blue-400">{sheet.tableName}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto panel-scroll">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/30">
              {['Column', 'Type', 'Notes'].map(h => (
                <th key={h} className="text-left px-4 py-2 font-semibold text-gray-600 dark:text-slate-300">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-slate-800/60">
            <tr className="bg-blue-50/30 dark:bg-blue-950/10">
              <td className="px-4 py-2 font-mono text-gray-700 dark:text-slate-200">id</td>
              <td className="px-4 py-2">{typeBadge('INTEGER')}</td>
              <td className="px-4 py-2 text-gray-400 dark:text-slate-500">SERIAL PRIMARY KEY</td>
            </tr>
            {sheet.columns.map(col => {
              const lk = confirmedLookups.find(l => l.colIndex === col.index);
              return (
                <tr key={col.index} className={lk ? 'bg-amber-50/20 dark:bg-amber-950/10' : ''}>
                  <td className="px-4 py-2 font-mono text-gray-700 dark:text-slate-200">
                    {lk ? `${col.name.toLowerCase().replace(/\s+/g, '_')}_id` : col.name.toLowerCase().replace(/\s+/g, '_')}
                  </td>
                  <td className="px-4 py-2">{typeBadge(lk ? 'INTEGER' : col.inferredType)}</td>
                  <td className="px-4 py-2 text-gray-400 dark:text-slate-500 text-[10px]">
                    {lk ? `FK → ${lk.lookupTable}(id)` : col.nullCount > 0 ? 'nullable' : 'not null'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Schema data preview (full-width bottom strip) ─────────────────────────────

function SchemaPreview({ sheet, confirmedLookups }: { sheet: SheetResult; confirmedLookups: ConfirmedLookup[] }) {
  const lookupSet = new Set(confirmedLookups.map(l => l.colIndex));
  return (
    <div className="flex flex-col overflow-hidden border-t border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-gray-50 dark:bg-slate-800/40 border-b border-gray-200 dark:border-slate-700">
        <Table2 size={12} className="text-gray-400" />
        <p className="text-xs font-semibold text-gray-600 dark:text-slate-300">Data Preview</p>
        <span className="text-[11px] text-gray-400 dark:text-slate-500 ml-1">(first 10 rows)</span>
      </div>
      <div className="overflow-auto panel-scroll max-h-52">
        <table className="text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/30">
              {sheet.headers.map((h, i) => (
                <th key={i} className={`text-left px-3 py-1.5 font-medium whitespace-nowrap ${lookupSet.has(i) ? 'text-amber-600 dark:text-amber-400' : 'text-gray-600 dark:text-slate-300'}`}>
                  {h}{lookupSet.has(i) ? ' →FK' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50 dark:divide-slate-800/50">
            {sheet.previewRows.map((row, ri) => (
              <tr key={ri} className="hover:bg-gray-50/50 dark:hover:bg-slate-800/20">
                {row.map((v, ci) => (
                  <td key={ci} className="px-3 py-1.5 text-gray-600 dark:text-slate-300 max-w-[160px] truncate" title={v}>
                    {v || <span className="text-gray-300 dark:text-slate-600 italic">null</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Export step ────────────────────────────────────────────────────────────────

function ExportStep({ sheet, confirmedLookups }: { sheet: SheetResult; confirmedLookups: ConfirmedLookup[] }) {
  const [mode, setMode] = useState<ExportMode>('sql');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setLoading(true); setError(null);
    try {
      const resp = await axios.post(
        '/api/normalizer/export',
        { mode, sheet: { tableName: sheet.tableName, headers: sheet.headers, allRows: sheet.allRows }, confirmedLookups },
        { headers: { ...authH(), 'Content-Type': 'application/json' }, responseType: 'blob' },
      );
      const ext = mode === 'sql' ? 'sql' : mode === 'csv' ? 'csv' : 'json';
      const url = URL.createObjectURL(new Blob([resp.data as BlobPart]));
      const a = document.createElement('a'); a.href = url;
      a.download = `${sheet.tableName}_normalized.${ext}`; a.click();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally { setLoading(false); }
  };

  const modeOptions: { key: ExportMode; label: string; desc: string }[] = [
    { key: 'sql', label: 'SQL', desc: 'CREATE TABLE + INSERT statements (PostgreSQL)' },
    { key: 'csv', label: 'CSV', desc: 'Normalised flat file with FK id columns' },
    { key: 'json', label: 'JSON', desc: 'All tables as JSON arrays in a single file' },
  ];

  return (
    <div className="h-full overflow-auto panel-scroll flex items-start justify-center py-10 px-6">
      <div className="w-full max-w-xl space-y-5">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold text-gray-700 dark:text-slate-200 flex items-center gap-1.5">
            <Check size={12} className="text-green-500" /> Schema Summary
          </p>
          {[
            `Main table: ${sheet.tableName} (${sheet.rowCount.toLocaleString()} rows, ${sheet.columns.length} columns)`,
            ...(confirmedLookups.length ? [`Lookup tables: ${confirmedLookups.map(l => l.lookupTable).join(', ')}`] : []),
          ].map(s => (
            <p key={s} className="text-xs text-gray-500 dark:text-slate-400 pl-4">• {s}</p>
          ))}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">Export Format</p>
          <div className="grid grid-cols-3 gap-2">
            {modeOptions.map(opt => (
              <button key={opt.key} onClick={() => setMode(opt.key)}
                className={`p-3 rounded-xl border text-left transition-colors space-y-1
                  ${mode === opt.key ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30' : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-blue-300'}`}>
                <p className={`text-sm font-bold ${mode === opt.key ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-slate-200'}`}>{opt.label}</p>
                <p className="text-[10px] text-gray-400 dark:text-slate-500 leading-relaxed">{opt.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 px-4 py-3 text-xs text-red-700 dark:text-red-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <div className="flex justify-end">
          <button onClick={download} disabled={loading}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-green-600 hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            {loading ? 'Generating…' : `Download .${mode.toUpperCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Guide popover ─────────────────────────────────────────────────────────────

const GUIDE_SECTIONS = [
  {
    title: 'How it works',
    icon: '①',
    color: 'text-blue-600 dark:text-blue-400',
    body: [
      'Upload a file (XLSX, CSV, JSON) or load a table directly from a saved database connection.',
      'Profile — review per-column statistics and decide which columns should become lookup (FK) tables.',
      'Schema — inspect the generated table structure, lookup tables, and FK relationships.',
      'Export — download the normalised schema as SQL (CREATE + INSERT), CSV, or JSON.',
    ],
  },
  {
    title: 'When to apply',
    icon: '②',
    color: 'text-amber-600 dark:text-amber-400',
    body: [
      'Apply normalisation when a column holds repetitive string values — department names, country codes, product categories, status labels.',
      'Normalisation extracts those values into a separate lookup table (id SERIAL PK, value TEXT UNIQUE) and replaces the original column with an integer foreign key.',
      'This reduces redundancy, enforces consistency, and is the standard form for relational databases (1NF → 3NF).',
    ],
  },
  {
    title: 'Profile step',
    icon: '③',
    color: 'text-purple-600 dark:text-purple-400',
    body: [
      'Each column is analysed for: inferred data type, null count, distinct value count, and top recurring values.',
      'FK Candidate — a column is flagged when its distinct count is low relative to the total row count (≤ 50 distinct values or ≤ 20% of rows). These are strong normalisation candidates.',
      'Toggle the FK? button on any column to include or exclude it from the schema. The left panel mirrors all active selections.',
      'Click Build Schema in the toolbar when you are happy with your FK selections.',
    ],
  },
  {
    title: 'Schema step',
    icon: '④',
    color: 'text-teal-600 dark:text-teal-400',
    body: [
      'Left panel — each confirmed lookup table is shown with its two columns: id (SERIAL PRIMARY KEY) and value (TEXT UNIQUE), plus a sample of distinct values.',
      'Center panel — the main table with all FK columns replaced by integer reference columns (e.g. department_id INTEGER → FK → departments(id)).',
      'Data Preview — the first 10 rows of the original data are shown below both panels for cross-reference.',
      'Click Save & Export in the toolbar to save your session and proceed to the export step.',
    ],
  },
  {
    title: 'Saved Jobs',
    icon: '⑤',
    color: 'text-gray-500 dark:text-slate-400',
    body: [
      'Your sessions are saved in the browser\'s localStorage (right panel). Each job stores the full dataset, FK selections, confirmed schema, and the step you were on.',
      'Load a saved job to resume exactly where you left off. Jobs are capped at 10 to stay within browser storage limits.',
      'Save current session at any time using the button in the right panel, or automatically when you click Save & Export.',
    ],
  },
] as const;

function GuidePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', handler); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium border transition-colors
          ${open
            ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-600 dark:bg-blue-950/40 dark:text-blue-300'
            : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-blue-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50/60 dark:hover:bg-blue-950/20'}`}
      >
        <span className="font-bold">?</span> Guide
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-[420px] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
            <div className="flex items-center gap-2">
              <Wand2 size={13} className="text-blue-500" />
              <p className="text-sm font-semibold text-gray-800 dark:text-slate-100">Data Normalizer — Guide</p>
            </div>
            <button onClick={() => setOpen(false)} className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-200">
              <X size={13} />
            </button>
          </div>

          {/* Sections */}
          <div className="overflow-y-auto max-h-[70vh] panel-scroll divide-y divide-gray-100 dark:divide-slate-800">
            {GUIDE_SECTIONS.map(sec => (
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

// ── Types for DB picker ────────────────────────────────────────────────────────

interface ConnRow {
  id: number; label: string; host: string; port: number;
  username: string; password_enc: string | null;
  database_name: string; ssl_enabled: boolean; db_type: string;
}

// ── Saved jobs panel ───────────────────────────────────────────────────────────

function SavedJobsPanel({
  open, onToggle, jobs, hasData, onSave, onLoad, onDelete, saveError,
}: {
  open: boolean;
  onToggle: () => void;
  jobs: NormalizerJob[];
  hasData: boolean;
  onSave: () => void;
  onLoad: (job: NormalizerJob) => void;
  onDelete: (id: string) => void;
  saveError: string | null;
}) {
  return (
    <div className={`shrink-0 border-l border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 flex flex-col overflow-hidden transition-[width] duration-200 ${open ? 'w-60' : 'w-8'}`}>

      {/* Header / toggle */}
      <div className="shrink-0 flex items-center border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40 min-h-[41px]">
        {open ? (
          <>
            <span className="flex-1 px-3 text-[11px] font-semibold text-gray-600 dark:text-slate-300 uppercase tracking-wider">Saved Jobs</span>
            <button onClick={onToggle}
              className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
              <ChevronRight size={13} />
            </button>
          </>
        ) : (
          <button onClick={onToggle} className="w-full h-full flex items-center justify-center py-3">
            <ChevronLeft size={13} className="text-gray-400" />
          </button>
        )}
      </div>

      {open && (
        <>
          {/* Save button */}
          {hasData && (
            <div className="shrink-0 px-2.5 py-2.5 border-b border-gray-100 dark:border-slate-800">
              <button onClick={onSave}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] font-medium border border-blue-300 dark:border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 rounded transition-colors">
                <Save size={10} /> Save current session
              </button>
              {saveError && <p className="text-[10px] text-rose-500 mt-1 text-center">{saveError}</p>}
            </div>
          )}

          {/* Jobs list */}
          <div className="flex-1 min-h-0 overflow-y-auto panel-scroll">
            {jobs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-24 gap-1.5 text-[11px] text-gray-400 dark:text-slate-500">
                <Clock size={16} className="text-gray-200 dark:text-slate-700" />
                No saved jobs
              </div>
            ) : (
              <div className="p-2 space-y-1.5">
                {jobs.map(job => (
                  <div key={job.id} className="border border-gray-100 dark:border-slate-800 rounded p-2 hover:border-gray-200 dark:hover:border-slate-700 transition-colors">
                    <p className="text-[11px] font-medium text-gray-700 dark:text-slate-200 truncate" title={job.name}>{job.name}</p>
                    <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">
                      {new Date(job.savedAt).toLocaleDateString()} · Step {job.step}
                    </p>
                    <div className="flex items-center gap-1 mt-1.5">
                      <button onClick={() => onLoad(job)}
                        className="flex-1 px-2 py-1 text-[10px] font-medium bg-blue-600 hover:bg-blue-700 text-white rounded transition-colors">
                        Load
                      </button>
                      <button onClick={() => onDelete(job.id)}
                        className="p-1 rounded text-gray-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors">
                        <Trash2 size={10} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Collapsed: vertical label */}
      {!open && (
        <div className="flex-1 flex items-center justify-center overflow-hidden">
          <span className="text-[9px] font-bold text-gray-300 dark:text-slate-700 uppercase tracking-widest whitespace-nowrap"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}>
            Saved Jobs
          </span>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function NormalizerPage() {
  const { authenticated, loading: authLoading } = useAuth();

  const [step, setStep] = useState<Step>(1);
  const [sheets, setSheets] = useState<SheetResult[]>([]);
  const [activeSheet, setActiveSheet] = useState('');
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<number>>(new Set());
  const [confirmedLookups, setConfirmedLookups] = useState<ConfirmedLookup[]>([]);

  const [connections, setConnections] = useState<ConnRow[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [dbSchemas, setDbSchemas] = useState<string[]>([]);
  const [dbSchema, setDbSchema] = useState('');
  const [dbTables, setDbTables] = useState<{ name: string; rowCount: number }[]>([]);
  const [dbTable, setDbTable] = useState('');
  const [dbLoading, setDbLoading] = useState(false);

  const [colsForDupe, setColsForDupe] = useState<Set<number>>(new Set());
  const [showDupes, setShowDupes] = useState(false);

  const [savedJobs, setSavedJobs] = useState<NormalizerJob[]>([]);
  const [savedJobsOpen, setSavedJobsOpen] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);

  const selectedConn = connections.find(c => c.id === selectedConnId) ?? null;
  const currentSheet = sheets.find(s => s.sheetName === activeSheet) ?? sheets[0];

  // Load saved jobs from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem('normalizer_jobs');
      if (raw) setSavedJobs(JSON.parse(raw) as NormalizerJob[]);
    } catch { /* ignore */ }
  }, []);

  const connPayload = (conn: ConnRow) => ({
    type: conn.db_type === 'postgres' ? 'postgresql' : 'mysql',
    host: conn.host, port: conn.port,
    username: conn.username, password: conn.password_enc ?? '',
    database: conn.database_name, ssl: conn.ssl_enabled,
  });

  useEffect(() => {
    axios.get<{ connections: ConnRow[] }>('/api/connections', { headers: authH() })
      .then(r => setConnections(r.data.connections))
      .catch(() => {});
  }, []);

  const loadSchemas = useCallback(async (conn: ConnRow) => {
    setDbSchemas([]); setDbSchema(''); setDbTables([]); setDbTable('');
    try {
      const { data } = await axios.post<{ schemas: { schema: string }[] }>(
        '/api/schema-explorer/schemas', connPayload(conn), { headers: authH() });
      const names = data.schemas.map(s => s.schema);
      setDbSchemas(names);
      if (names.includes('public')) setDbSchema('public');
      else if (names.length) setDbSchema(names[0]);
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTables = useCallback(async (conn: ConnRow, schema: string) => {
    setDbTables([]); setDbTable('');
    if (!schema) return;
    try {
      const { data } = await axios.post<{ tables: { schema: string; name: string; rowCount: number }[] }>(
        '/api/schema-explorer/tables',
        { conn: connPayload(conn), schemas: [schema] },
        { headers: authH() });
      setDbTables(data.tables.map(t => ({ name: t.name, rowCount: t.rowCount })));
    } catch { /* ignore */ }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleConnChange = (id: number | null) => {
    setSelectedConnId(id);
    setDbSchemas([]); setDbSchema(''); setDbTables([]); setDbTable('');
    if (!id) return;
    const conn = connections.find(c => c.id === id);
    if (conn) void loadSchemas(conn);
  };

  const handleSchemaChange = (schema: string) => {
    setDbSchema(schema); setDbTable('');
    if (selectedConn) void loadTables(selectedConn, schema);
  };

  const handleLoadTable = async () => {
    if (!selectedConn || !dbSchema || !dbTable) return;
    setDbLoading(true);
    try {
      const { data } = await axios.post<{ rows: Record<string, unknown>[] }>(
        '/api/schema-explorer/records',
        { conn: connPayload(selectedConn), tableKey: `${dbSchema}.${dbTable}`, limit: 5000 },
        { headers: authH() },
      );
      const rows = data.rows;
      if (!rows.length) return;
      const { data: parsed } = await axios.post<{ sheets: SheetResult[] }>(
        '/api/normalizer/parse',
        { filename: `${dbTable}.json`, content: JSON.stringify(rows) },
        { headers: authH() },
      );
      handleParsed(parsed.sheets);
    } catch (err) { console.error(err); }
    finally { setDbLoading(false); }
  };

  const handleParsed = (parsed: SheetResult[]) => {
    setSheets(parsed);
    setActiveSheet(parsed[0]?.sheetName ?? '');
    setDismissedSuggestions(new Set());
    if (parsed[0]) setColsForDupe(defaultColsForDupe(parsed[0]));
    setShowDupes(false);
    setStep(2);
  };

  const handleSheetChange = (name: string) => {
    setActiveSheet(name); setDismissedSuggestions(new Set());
    const s = sheets.find(sh => sh.sheetName === name);
    if (s) setColsForDupe(defaultColsForDupe(s));
    setShowDupes(false);
  };

  const handleToggleColForDupe = (idx: number) => {
    setColsForDupe(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const handleToggleSuggestion = (colIdx: number) => {
    setDismissedSuggestions(prev => {
      const next = new Set(prev);
      if (next.has(colIdx)) next.delete(colIdx); else next.add(colIdx);
      return next;
    });
  };

  const handleConfirmSchema = () => {
    if (!currentSheet) return;
    const lookups: ConfirmedLookup[] = currentSheet.fkSuggestions
      .filter(s => !dismissedSuggestions.has(s.colIndex))
      .map(s => ({ colName: s.colName, colIndex: s.colIndex, lookupTable: s.suggestedLookupTable, distinctValues: s.distinctValues }));
    setConfirmedLookups(lookups);
    setStep(3);
  };

  const handleSaveJob = () => {
    if (!sheets.length) return;
    const job: NormalizerJob = {
      id: Math.random().toString(36).slice(2, 10),
      name: currentSheet?.tableName ?? 'session',
      savedAt: new Date().toISOString(),
      step,
      sheets,
      activeSheet,
      dismissedSuggestions: Array.from(dismissedSuggestions),
      confirmedLookups,
    };
    const updated = [job, ...savedJobs.slice(0, 9)];
    try {
      localStorage.setItem('normalizer_jobs', JSON.stringify(updated));
      setSavedJobs(updated);
      setSaveError(null);
    } catch {
      setSaveError('Storage full — delete a job first');
    }
  };

  const handleLoadJob = (job: NormalizerJob) => {
    setSheets(job.sheets);
    setActiveSheet(job.activeSheet);
    setDismissedSuggestions(new Set(job.dismissedSuggestions));
    setConfirmedLookups(job.confirmedLookups);
    setStep(job.step);
    const s = job.sheets.find(sh => sh.sheetName === job.activeSheet) ?? job.sheets[0];
    if (s) setColsForDupe(defaultColsForDupe(s));
  };

  const handleDeleteJob = (id: string) => {
    const updated = savedJobs.filter(j => j.id !== id);
    localStorage.setItem('normalizer_jobs', JSON.stringify(updated));
    setSavedJobs(updated);
  };

  const handleSaveAndExport = () => {
    handleSaveJob();
    setStep(4);
  };

  const reset = () => {
    setStep(1); setSheets([]); setActiveSheet('');
    setDismissedSuggestions(new Set()); setConfirmedLookups([]);
    setColsForDupe(new Set()); setShowDupes(false);
  };

  if (authLoading) {
    return <div className="min-h-screen bg-gray-50 dark:bg-slate-900 flex items-center justify-center"><Loader2 size={24} className="animate-spin text-blue-500" /></div>;
  }
  if (!authenticated) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900 flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-sm text-gray-600 dark:text-slate-300">Login required</p>
          <Link href="/" className="text-blue-600 hover:underline text-sm">← Back to Module Home</Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <Head><title>Data Normalizer</title></Head>
      <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* ── Navbar ───────────────────────────────────────────────────────── */}
        <header className="shrink-0 sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2.5 shrink-0">
            <Wand2 size={16} className="text-blue-600 shrink-0" />
            <div>
              <h1 className="font-bold text-sm text-gray-900 dark:text-slate-100 leading-tight">Data Normalizer</h1>
              <p className="text-[11px] text-gray-500 dark:text-slate-400 leading-tight">Profile, normalise and export</p>
            </div>
          </div>
          <div className="flex-1" />
          <GuidePopover />
          <div className="h-7 w-px bg-gray-200 dark:bg-slate-700 ml-4" />
          <nav className="flex items-center gap-1">
            <Link href="/" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200 text-sm">Home</Link>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <span className="px-3 py-1 rounded-lg bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold text-sm">Normalizer</span>
          </nav>
        </header>

        {/* ── Sub-header: DB picker + step tabs + contextual actions ────────── */}
        <div className="shrink-0 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 px-4 flex items-stretch">

          {/* DB picker */}
          <div className="flex items-center gap-1.5 py-2 pr-4 border-r border-gray-200 dark:border-slate-700">
            <Database size={11} className="text-gray-400 shrink-0" />
            <select value={selectedConnId ?? ''} onChange={e => handleConnChange(e.target.value ? Number(e.target.value) : null)}
              className="px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-blue-400 min-w-[140px]">
              <option value="">— connection —</option>
              {(['postgres', 'mysql'] as const).map(type => {
                const group = connections.filter(c => c.db_type === type);
                if (!group.length) return null;
                return (
                  <optgroup key={type} label={type === 'postgres' ? 'PostgreSQL' : 'MySQL'}>
                    {group.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </optgroup>
                );
              })}
            </select>
            {dbSchemas.length > 0 && (
              <select value={dbSchema} onChange={e => handleSchemaChange(e.target.value)}
                className="px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-blue-400 min-w-[90px]">
                <option value="">— schema —</option>
                {dbSchemas.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            )}
            {dbTables.length > 0 && (
              <select value={dbTable} onChange={e => setDbTable(e.target.value)}
                className="px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-blue-400 min-w-[120px]">
                <option value="">— table —</option>
                {dbTables.map(t => <option key={t.name} value={t.name}>{t.name} ({t.rowCount.toLocaleString()})</option>)}
              </select>
            )}
            {dbTable && (
              <button onClick={handleLoadTable} disabled={dbLoading}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors">
                {dbLoading ? <Loader2 size={10} className="animate-spin" /> : <Database size={10} />}
                {dbLoading ? 'Loading…' : 'Load'}
              </button>
            )}
            {step > 1 && (
              <button onClick={reset}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-medium border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
                <RefreshCw size={10} /> Reset
              </button>
            )}
          </div>

          {/* Step tabs */}
          <div className="flex items-stretch ml-2">
            {([
              { n: 1 as Step, label: 'Upload',  icon: <Upload size={12} /> },
              { n: 2 as Step, label: 'Profile',  icon: <BarChart2 size={12} /> },
              { n: 3 as Step, label: 'Schema',   icon: <Layers size={12} /> },
              { n: 4 as Step, label: 'Export',   icon: <Download size={12} /> },
            ]).map(({ n, label, icon }) => {
              const accessible = n === 1 || (n === 2 && sheets.length > 0) || (n === 3 && sheets.length > 0 && step >= 3) || (n === 4 && step >= 4);
              const active = step === n; const done = step > n;
              return (
                <button key={n} onClick={() => accessible ? setStep(n) : undefined} disabled={!accessible}
                  className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    active ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : done ? 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300 hover:border-gray-300'
                    : 'border-transparent text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-400'}`}>
                  {done ? <Check size={12} className="text-blue-500" /> : icon}
                  {label}
                </button>
              );
            })}
          </div>

          {/* Contextual action buttons */}
          <div className="flex items-center gap-2 ml-3">
            {step === 2 && sheets.length > 0 && (
              <button onClick={handleConfirmSchema}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-blue-300 dark:border-blue-600 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                Build Schema <ChevronRight size={11} />
              </button>
            )}
            {step === 3 && currentSheet && (
              <button onClick={handleSaveAndExport}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border border-green-400 dark:border-green-600 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors">
                <Download size={11} /> Save & Export
              </button>
            )}
          </div>

          {/* Active source info — right side */}
          {step > 1 && currentSheet && (
            <div className="ml-auto flex items-center gap-1.5 py-2 px-4 border-l border-gray-200 dark:border-slate-700 text-[11px] text-gray-400 dark:text-slate-500">
              {fileIcon(currentSheet.sheetName + '.xlsx')}
              <span className="font-medium text-gray-600 dark:text-slate-300">{currentSheet.sheetName}</span>
              <span>·</span>
              <span>{currentSheet.rowCount.toLocaleString()} rows</span>
            </div>
          )}
        </div>

        {/* ── Main area ────────────────────────────────────────────────────── */}
        <div className="flex-1 min-h-0 flex overflow-hidden">

          {/* Left + Center content area */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">

            {/* Step 1: Upload */}
            {step === 1 && <UploadStep onParsed={handleParsed} />}

            {/* Step 2: Profile — PanelGroup H */}
            {step === 2 && sheets.length > 0 && currentSheet && (
              <PanelGroup orientation="horizontal" className="flex-1 min-h-0">
                <Panel defaultSize="280px" minSize="200px" className="flex flex-col overflow-hidden bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-700">
                  <ProfileLeftPanel
                    sheets={sheets} activeSheet={activeSheet} onSheetChange={handleSheetChange}
                    sheet={currentSheet} dismissedSuggestions={dismissedSuggestions}
                    onToggleSuggestion={handleToggleSuggestion}
                    colsForDupe={colsForDupe}
                    onShowDupes={() => setShowDupes(true)}
                  />
                </Panel>
                <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors" />
                <Panel className="flex flex-col overflow-hidden bg-white dark:bg-slate-900">
                  <ProfileRightPanel
                    sheet={currentSheet} dismissedSuggestions={dismissedSuggestions}
                    onToggleSuggestion={handleToggleSuggestion}
                    colsForDupe={colsForDupe} onToggleColForDupe={handleToggleColForDupe}
                    showDupes={showDupes} onSetShowDupes={setShowDupes}
                  />
                </Panel>
              </PanelGroup>
            )}

            {/* Step 3: Schema — PanelGroup H (top) + Data Preview (bottom) */}
            {step === 3 && currentSheet && (
              <>
                <PanelGroup orientation="horizontal" className="flex-1 min-h-0">
                  <Panel defaultSize="280px" minSize="200px" className="flex flex-col overflow-hidden bg-white dark:bg-slate-900 border-r border-gray-200 dark:border-slate-700">
                    <SchemaLeftPanel confirmedLookups={confirmedLookups} />
                  </Panel>
                  <PanelResizeHandle className="w-px bg-gray-200 dark:bg-slate-700 hover:bg-blue-400 dark:hover:bg-blue-500 cursor-col-resize transition-colors" />
                  <Panel className="flex flex-col overflow-hidden bg-white dark:bg-slate-900">
                    <SchemaMainPanel sheet={currentSheet} confirmedLookups={confirmedLookups} />
                  </Panel>
                </PanelGroup>
                {/* Data Preview spans full width of left + center */}
                <SchemaPreview sheet={currentSheet} confirmedLookups={confirmedLookups} />
              </>
            )}

            {/* Step 4: Export */}
            {step === 4 && currentSheet && (
              <ExportStep sheet={currentSheet} confirmedLookups={confirmedLookups} />
            )}
          </div>

          {/* ── Right collapsible: Saved Jobs ─────────────────────────────── */}
          <SavedJobsPanel
            open={savedJobsOpen}
            onToggle={() => setSavedJobsOpen(o => !o)}
            jobs={savedJobs}
            hasData={sheets.length > 0}
            onSave={handleSaveJob}
            onLoad={handleLoadJob}
            onDelete={handleDeleteJob}
            saveError={saveError}
          />
        </div>
      </div>
    </>
  );
}
