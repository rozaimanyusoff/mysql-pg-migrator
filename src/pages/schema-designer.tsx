'use client';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  ArrowLeft, Database, Plus, Trash2, Table2, Upload, Play, Copy,
  Check, RefreshCw, FileSpreadsheet, FileCode2, FileText, CheckCircle2,
  XCircle, Loader2, X, ChevronRight, ChevronDown, ChevronUp, Download,
  AlertCircle, Columns, Sprout, Terminal, Save, Clock,
  FolderOpen, KeyRound, Link2, Fingerprint, Hash, Layers, Info, HelpCircle, BookOpen,
} from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import type { ConnectionRow } from './api/connections/index';
import type { ExplorerConn } from '../lib/explorer-db';
import type { SchemaInfo } from './api/schema-explorer/schemas';
import type { TableInfo } from './api/schema-explorer/tables';
import type { ColumnInfo, TableColumnsResult } from './api/schema-explorer/columns';
import type { SchemaJob } from './api/schema-generator/jobs';
import { parseExcelFile } from '../lib/excel-parser';

// ─── Types ────────────────────────────────────────────────────────────────────

type DbType = 'postgresql' | 'mysql';
type ActiveTab = 'designer' | 'import' | 'execute';

interface DesignerColumn {
  id: string;
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  isPk: boolean;
  isUnique: boolean;
  isAutoIncrement: boolean;
  defaultValue: string;
  comment: string;
  fkRef: string; // "referencedTable.referencedColumn"
}

interface DesignerTable {
  id: string;
  schema: string;
  name: string;
  columns: DesignerColumn[];
}

interface ExecLogLine {
  sql: string;
  ok: boolean;
  text: string;
}

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
}

interface JobGroup { job_name: string; runs: SchemaJob[] }

// ─── Constants ────────────────────────────────────────────────────────────────

const PG_TYPES = [
  'BIGSERIAL', 'SERIAL', 'SMALLSERIAL',
  'BIGINT', 'INTEGER', 'SMALLINT',
  'BOOLEAN',
  'TEXT', 'VARCHAR', 'CHAR',
  'NUMERIC', 'FLOAT8', 'REAL',
  'UUID',
  'DATE', 'TIME', 'TIMESTAMP', 'TIMESTAMPTZ',
  'JSONB', 'JSON',
  'BYTEA',
];

const MYSQL_TYPES = [
  'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT',
  'BOOLEAN',
  'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
  'FLOAT', 'DOUBLE', 'DECIMAL',
  'DATE', 'TIME', 'DATETIME', 'TIMESTAMP',
  'JSON', 'BLOB',
];

const NEEDS_LENGTH = new Set(['VARCHAR', 'CHAR', 'NUMERIC', 'DECIMAL']);

// ─── Pure Helpers ─────────────────────────────────────────────────────────────

function getStoredToken() {
  return typeof window !== 'undefined' ? (localStorage.getItem('auth_token') ?? '') : '';
}
const authH = () => ({ Authorization: `Bearer ${getStoredToken()}` });

function sanitizeName(s: string): string {
  const c = String(s).toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  return /^\d/.test(c) ? `_${c}` : c || 'table';
}

function connToPayload(conn: ConnectionRow): { type: DbType; host: string; port: number; username: string; password: string } {
  return { type: conn.db_type === 'postgres' ? 'postgresql' : 'mysql', host: conn.host, port: conn.port, username: conn.username, password: conn.password_enc ?? '' };
}

function connToExplorerConn(conn: ConnectionRow, database: string): ExplorerConn {
  return { ...connToPayload(conn), database };
}

function mkCol(): DesignerColumn {
  return { id: crypto.randomUUID(), name: 'column_name', type: 'TEXT', length: '', nullable: true, isPk: false, isUnique: false, isAutoIncrement: false, defaultValue: '', comment: '', fkRef: '' };
}

function mkTable(name: string, schema: string, dbType: DbType): DesignerTable {
  const idCol: DesignerColumn = {
    id: crypto.randomUUID(), name: 'id',
    type: dbType === 'postgresql' ? 'BIGSERIAL' : 'BIGINT',
    length: '', nullable: false, isPk: true, isUnique: true, isAutoIncrement: true,
    defaultValue: '', comment: '', fkRef: '',
  };
  return { id: crypto.randomUUID(), schema, name, columns: [idCol] };
}

// ─── SQL Parser ───────────────────────────────────────────────────────────────

function splitComma(s: string): string[] {
  const out: string[] = []; let d = 0; let cur = '';
  for (const ch of s) {
    if ('(['.includes(ch)) d++;
    else if (')]'.includes(ch)) d--;
    else if (ch === ',' && d === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseOneCol(s: string, pkSet: Set<string>, uqSet: Set<string>, fkMap: Record<string, string>): DesignerColumn | null {
  const nm = /^["`\[]?(\w+)["`\]]?\s+(.+)$/is.exec(s.trim());
  if (!nm) return null;
  const name = nm[1];
  const rest = nm[2];
  const tm = /^([\w ]+?)(?:\(([^)]+)\))?\s*(.*)/is.exec(rest);
  if (!tm) return null;
  let type = tm[1].trim().toUpperCase().replace(/\s+/g, ' ');
  const length = tm[2]?.trim() ?? '';
  const flags = (tm[3] ?? '') + ' ' + rest;
  const upper = flags.toUpperCase();
  const aliases: Record<string, string> = {
    'INT': 'INTEGER', 'INT4': 'INTEGER', 'INT8': 'BIGINT', 'INT2': 'SMALLINT',
    'BOOL': 'BOOLEAN', 'FLOAT4': 'REAL', 'DOUBLE PRECISION': 'FLOAT8',
    'CHARACTER VARYING': 'VARCHAR', 'CHARACTER': 'CHAR',
    'TIMESTAMP WITHOUT TIME ZONE': 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE': 'TIMESTAMPTZ',
  };
  type = aliases[type] ?? type;
  const notNull = /\bNOT\s+NULL\b/.test(upper);
  const isPk = /\bPRIMARY\s+KEY\b/.test(upper) || pkSet.has(name);
  const isUnique = /\bUNIQUE\b/.test(upper) || uqSet.has(name);
  const isAutoIncrement = /\bAUTO_INCREMENT\b/.test(upper) || ['SERIAL', 'BIGSERIAL', 'SMALLSERIAL'].includes(type);
  let defaultValue = '';
  const dm = /\bDEFAULT\s+('(?:[^']|'')*'|[^\s,]+)/i.exec(flags);
  if (dm) defaultValue = dm[1].replace(/^'(.*)'$/s, '$1');
  let fkRef = fkMap[name] ?? '';
  const rm = /\bREFERENCES\s+["`\[]?(\w+)["`\]]?\s*\(["`\[]?(\w+)["`\]]?\)/i.exec(flags);
  if (rm) fkRef = `${rm[1]}.${rm[2]}`;
  return { id: crypto.randomUUID(), name, type, length, nullable: !notNull && !isPk, isPk, isUnique, isAutoIncrement, defaultValue, comment: '', fkRef };
}

function parseSqlToTables(sql: string): DesignerTable[] {
  const out: DesignerTable[] = [];
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([`"[\w.][\w.`"[\]]*)\s*\(([\s\S]*?)\)\s*(?:ENGINE[^;]*)?;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const rawName = m[1].replace(/[`"[\]]/g, '');
    let schema = 'public', name = rawName;
    if (rawName.includes('.')) { [schema, name] = rawName.split('.', 2); }
    const parts = splitComma(m[2]);
    const pkSet = new Set<string>(), uqSet = new Set<string>(), fkMap: Record<string, string> = {};
    for (const p of parts) {
      const t = p.trim().toUpperCase();
      if (/^PRIMARY\s+KEY/.test(t)) { const mm = /PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(p); if (mm) mm[1].split(',').forEach(c => pkSet.add(c.trim().replace(/["`[\]]/g, ''))); }
      else if (/^UNIQUE\b/.test(t)) { const mm = /UNIQUE\s+(?:(?:KEY|INDEX)\s+\w+\s+)?\(([^)]+)\)/i.exec(p); if (mm) mm[1].split(',').forEach(c => uqSet.add(c.trim().replace(/["`[\]]/g, ''))); }
      else if (/^FOREIGN\s+KEY/.test(t)) { const mm = /FOREIGN\s+KEY\s*\([`"[\]]?(\w+)[`"[\]]?\)\s+REFERENCES\s+[`"[\]]?(\w+)[`"[\]]?\s*\([`"[\]]?(\w+)[`"[\]]?\)/i.exec(p); if (mm) fkMap[mm[1]] = `${mm[2]}.${mm[3]}`; }
    }
    const columns: DesignerColumn[] = [];
    for (const p of parts) {
      if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|KEY\s|INDEX\s|CONSTRAINT\s|CHECK\s)/.test(p.trim().toUpperCase())) continue;
      const col = parseOneCol(p.trim(), pkSet, uqSet, fkMap);
      if (col) columns.push(col);
    }
    out.push({ id: crypto.randomUUID(), schema, name, columns });
  }
  return out;
}

// ─── CSV Parser ───────────────────────────────────────────────────────────────

function inferType(vals: string[]): string {
  const v = vals.filter(x => x.trim());
  if (!v.length) return 'TEXT';
  if (v.every(x => /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x))) return 'UUID';
  if (v.every(x => new Set(['true', 'false', 'yes', 'no', '1', '0']).has(x.toLowerCase()))) return 'BOOLEAN';
  if (v.every(x => /^-?\d+$/.test(x.trim()))) return 'BIGINT';
  if (v.every(x => /^-?\d+\.\d+$/.test(x.trim()))) return 'NUMERIC';
  if (v.every(x => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(x))) return 'TIMESTAMP';
  if (v.every(x => /^\d{4}-\d{2}-\d{2}$/.test(x))) return 'DATE';
  return 'TEXT';
}

function parseCsvRow(line: string): string[] {
  const f: string[] = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inQ) { inQ = true; }
    else if (c === '"' && inQ) { if (line[i + 1] === '"') { cur += '"'; i++; } else { inQ = false; } }
    else if (c === ',' && !inQ) { f.push(cur); cur = ''; }
    else { cur += c; }
  }
  f.push(cur);
  return f;
}

function parseCsvToTable(csv: string, tableName: string): DesignerTable {
  const lines = csv.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { id: crypto.randomUUID(), schema: 'public', name: sanitizeName(tableName), columns: [] };
  const headers = parseCsvRow(lines[0]);
  const rows = lines.slice(1, 101).map(parseCsvRow);
  const columns: DesignerColumn[] = headers.map((h, i) => {
    const vals = rows.map(r => r[i]?.trim() ?? '');
    const type = inferType(vals);
    return { id: crypto.randomUUID(), name: sanitizeName(h.trim()) || `col_${i}`, type, length: type === 'VARCHAR' ? '255' : '', nullable: vals.some(v => !v), isPk: false, isUnique: false, isAutoIncrement: false, defaultValue: '', comment: '', fkRef: '' };
  });
  return { id: crypto.randomUUID(), schema: 'public', name: sanitizeName(tableName) || 'imported', columns };
}

// ─── ColumnInfo → DesignerColumn ─────────────────────────────────────────────

function colInfoToDesigner(c: ColumnInfo): DesignerColumn {
  const fkParts = c.fkRef?.split('.') ?? [];
  const fkRef = fkParts.length >= 2 ? `${fkParts[fkParts.length - 2]}.${fkParts[fkParts.length - 1]}` : '';
  const type = (c.dataType || 'TEXT').toUpperCase().replace(/\s+/g, ' ');
  return {
    id: crypto.randomUUID(), name: c.name, type, length: c.maxLength ? String(c.maxLength) : '',
    nullable: c.nullable, isPk: c.isPk, isUnique: c.isUnique,
    isAutoIncrement: /serial/i.test(c.dataType) || /nextval/i.test(c.defaultValue ?? ''),
    defaultValue: c.defaultValue?.replace(/^'(.*)'::.*$/, '$1').replace(/^nextval\(.*\)$/, '') ?? '',
    comment: c.comment ?? '', fkRef,
  };
}

// ─── DDL Generator ────────────────────────────────────────────────────────────

function qi(n: string, t: DbType) { return t === 'postgresql' ? `"${n}"` : `\`${n}\``; }

function resolveType(col: DesignerColumn, dbType: DbType): string {
  let type = col.type;
  if (dbType === 'mysql') {
    const m: Record<string, string> = { BIGSERIAL: 'BIGINT', SERIAL: 'INT', SMALLSERIAL: 'SMALLINT', INTEGER: 'INT', FLOAT8: 'DOUBLE', REAL: 'FLOAT', TIMESTAMPTZ: 'DATETIME', JSONB: 'JSON', BYTEA: 'BLOB', UUID: 'CHAR(36)', BOOLEAN: 'TINYINT(1)' };
    type = m[type] ?? type;
  } else {
    const m: Record<string, string> = { INT: 'INTEGER', TINYINT: 'SMALLINT', MEDIUMINT: 'INTEGER', DOUBLE: 'FLOAT8', DATETIME: 'TIMESTAMP', MEDIUMTEXT: 'TEXT', LONGTEXT: 'TEXT', TINYTEXT: 'TEXT' };
    type = m[type] ?? type;
  }
  if (col.length && !type.includes('(') && NEEDS_LENGTH.has(type.split('(')[0])) type = `${type}(${col.length})`;
  return type;
}

function generateDDL(tables: DesignerTable[], dbType: DbType): string[] {
  const stmts: string[] = [];
  for (const t of tables) {
    const schema = t.schema || 'public';
    if (dbType === 'postgresql' && schema !== 'public') stmts.push(`CREATE SCHEMA IF NOT EXISTS ${qi(schema, dbType)};`);
    const tq = dbType === 'postgresql' ? `${qi(schema, dbType)}.${qi(t.name, dbType)}` : qi(t.name, dbType);
    const defs: string[] = [];
    const pks: string[] = [];
    for (const c of t.columns) {
      let type = resolveType(c, dbType);
      if (dbType === 'postgresql' && c.isAutoIncrement && !['SERIAL', 'BIGSERIAL', 'SMALLSERIAL'].includes(c.type))
        type = c.type === 'BIGINT' || c.type === 'BIGSERIAL' ? 'BIGSERIAL' : 'SERIAL';
      const parts = [qi(c.name, dbType), type];
      if (!c.nullable || c.isPk) parts.push('NOT NULL');
      if (dbType === 'mysql' && c.isAutoIncrement && !['BIGSERIAL', 'SERIAL', 'SMALLSERIAL'].includes(c.type)) parts.push('AUTO_INCREMENT');
      if (c.defaultValue) {
        const d = c.defaultValue.trim();
        const raw = /^(NOW|CURRENT_TIMESTAMP|NULL|TRUE|FALSE|\d+)\b/i.test(d) || d.includes('()');
        parts.push(`DEFAULT ${raw ? d : `'${d}'`}`);
      }
      if (c.comment && dbType === 'mysql') parts.push(`COMMENT '${c.comment.replace(/'/g, "\\'")}'`);
      defs.push('  ' + parts.join(' '));
      if (c.isPk) pks.push(qi(c.name, dbType));
    }
    if (pks.length) defs.push(`  PRIMARY KEY (${pks.join(', ')})`);
    for (const c of t.columns) if (c.isUnique && !c.isPk) defs.push(`  UNIQUE (${qi(c.name, dbType)})`);
    for (const c of t.columns) {
      if (c.fkRef) {
        const [rt, rc] = c.fkRef.split('.');
        if (rt && rc) defs.push(`  FOREIGN KEY (${qi(c.name, dbType)}) REFERENCES ${qi(rt, dbType)}(${qi(rc, dbType)})`);
      }
    }
    const suffix = dbType === 'mysql' ? '\nENGINE=InnoDB DEFAULT CHARSET=utf8mb4' : '';
    stmts.push(`CREATE TABLE IF NOT EXISTS ${tq} (\n${defs.join(',\n')}\n)${suffix};`);
    if (dbType === 'postgresql') {
      for (const c of t.columns) if (c.comment) stmts.push(`COMMENT ON COLUMN ${tq}.${qi(c.name, dbType)} IS '${c.comment.replace(/'/g, "''")}';`);
    }
  }
  return stmts;
}

// ─── Merge helper ─────────────────────────────────────────────────────────────

function mergeTables(existing: DesignerTable[], incoming: DesignerTable[]): DesignerTable[] {
  const existingKeys = new Set(existing.map(t => `${t.schema}.${t.name}`));
  return [...existing, ...incoming.filter(t => !existingKeys.has(`${t.schema}.${t.name}`))];
}

// ─── SQL Analysis ────────────────────────────────────────────────────────────

function analyzeSchemaSql(sql: string): SchemaAnalysis | null {
  if (!sql.trim()) return null;
  const tables = [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi)].map(m => m[1]);
  const indexes = [...sql.matchAll(/CREATE\s+INDEX/gi)].length;
  const uniqueIndexes = [...sql.matchAll(/CREATE\s+UNIQUE\s+INDEX/gi)].length;
  const foreignKeys = [...sql.matchAll(/FOREIGN\s+KEY|REFERENCES\s+\w/gi)].length;
  const extensions = [...sql.matchAll(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map(m => m[1]);
  const enums = [...sql.matchAll(/CREATE\s+TYPE\s+"?(\w+)"?\s+AS\s+ENUM/gi)].map(m => m[1]);
  const triggers = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER/gi)].length;
  return { tables: [...new Set(tables)], indexes, uniqueIndexes, foreignKeys, extensions: [...new Set(extensions)], enums, triggers };
}

function analyzeSeedSql(sql: string): SeedAnalysis | null {
  if (!sql.trim()) return null;
  const allTables = [...sql.matchAll(/INSERT\s+INTO\s+(?:"?\w+"?\.)?"?(\w+)"?/gi)].map(m => m[1]);
  const tables = [...new Set(allTables)];
  const rowsPerTable: Record<string, number> = {};
  for (const t of tables) rowsPerTable[t] = allTables.filter(x => x.toLowerCase() === t.toLowerCase()).length;
  const hasUuid = /gen_random_uuid\(\)|uuid_generate_v4\(\)|'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i.test(sql);
  const hasSeq = /nextval\s*\(|\bserial\b|\b\d+,\s*\d+\b/i.test(sql);
  const idStrategy = hasUuid && hasSeq ? 'mixed' : hasUuid ? 'uuid' : hasSeq ? 'sequential' : 'none';
  return { tables, rowsPerTable, totalRows: allTables.length, idStrategy };
}

function timeAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function groupJobs(jobs: SchemaJob[]): JobGroup[] {
  const map = new Map<string, SchemaJob[]>();
  for (const j of jobs) {
    const list = map.get(j.job_name) ?? [];
    list.push(j);
    map.set(j.job_name, list);
  }
  return [...map.values()].map(runs => ({ job_name: runs[0].job_name, runs }));
}

// ─── Popover ──────────────────────────────────────────────────────────────────

function Popover({ trigger, children }: { trigger: React.ReactNode; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as HTMLElement)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <div onClick={() => setOpen(v => !v)} className="cursor-pointer">{trigger}</div>
      {open && (
        <div className="absolute left-0 top-full mt-1.5 z-50 w-80 max-h-80 overflow-y-auto rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl text-xs p-4 space-y-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

function SchemaAnalysisBadge({ a }: { a: SchemaAnalysis }) {
  return (
    <Popover trigger={
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30 text-xs text-blue-700 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-950/50 transition-colors select-none">
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
          <div className="flex flex-wrap gap-1">{a.tables.map(t => <span key={t} className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-300 font-mono">{t}</span>)}</div>
        </div>
      )}
      {a.indexes > 0 && <div className="flex items-center gap-1.5 text-gray-600 dark:text-slate-300"><Layers size={11} /><span>{a.indexes} index{a.indexes !== 1 ? 'es' : ''}{a.uniqueIndexes > 0 ? ` (${a.uniqueIndexes} unique)` : ''}</span></div>}
      {a.foreignKeys > 0 && <div className="flex items-center gap-1.5 text-gray-600 dark:text-slate-300"><Link2 size={11} /><span>{a.foreignKeys} foreign key reference{a.foreignKeys !== 1 ? 's' : ''}</span></div>}
      {a.enums.length > 0 && <div><p className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-slate-300 mb-1"><Hash size={11} /> Enums</p><div className="flex flex-wrap gap-1">{a.enums.map(e => <span key={e} className="px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-950/40 text-purple-700 dark:text-purple-400 font-mono">{e}</span>)}</div></div>}
      {a.extensions.length > 0 && <div><p className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-slate-300 mb-1"><KeyRound size={11} /> Extensions</p><div className="flex flex-wrap gap-1">{a.extensions.map(e => <span key={e} className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 font-mono">{e}</span>)}</div></div>}
      {a.triggers > 0 && <div className="flex items-center gap-1.5 text-gray-600 dark:text-slate-300"><AlertCircle size={11} /><span>{a.triggers} trigger{a.triggers !== 1 ? 's' : ''}</span></div>}
    </Popover>
  );
}

function SeedAnalysisBadge({ a }: { a: SeedAnalysis }) {
  const strategyColor = { uuid: 'text-violet-700 dark:text-violet-400', sequential: 'text-amber-700 dark:text-amber-400', mixed: 'text-blue-700 dark:text-blue-400', none: 'text-gray-500 dark:text-slate-400' }[a.idStrategy];
  const strategyIcon = { uuid: <Fingerprint size={11} />, sequential: <Hash size={11} />, mixed: <Layers size={11} />, none: <Info size={11} /> }[a.idStrategy];
  return (
    <Popover trigger={
      <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20 text-xs text-emerald-700 dark:text-emerald-400 hover:bg-emerald-100 dark:hover:bg-emerald-950/40 transition-colors select-none">
        <Info size={11} />
        <span className="font-medium">{a.tables.length} table{a.tables.length !== 1 ? 's' : ''}</span>
        <span className="opacity-70">· {a.totalRows} row{a.totalRows !== 1 ? 's' : ''}</span>
        <span className={`flex items-center gap-1 ${strategyColor}`}>{strategyIcon} {a.idStrategy}</span>
        <span className="opacity-50">— click for details</span>
      </div>
    }>
      <p className="text-xs font-semibold text-gray-700 dark:text-slate-200 mb-2">Seed Analysis</p>
      <div>
        <p className="flex items-center gap-1.5 font-medium text-gray-600 dark:text-slate-300 mb-1.5"><Table2 size={11} /> Rows per table</p>
        <div className="space-y-1">
          {a.tables.map(t => (
            <div key={t} className="flex items-center justify-between">
              <span className="font-mono text-gray-700 dark:text-slate-300">{t}</span>
              <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-400">{a.rowsPerTable[t]} row{a.rowsPerTable[t] !== 1 ? 's' : ''}</span>
            </div>
          ))}
        </div>
      </div>
      <div className={`flex items-center gap-2 ${strategyColor}`}>{strategyIcon}<span className="font-medium capitalize">ID strategy: {a.idStrategy}</span></div>
    </Popover>
  );
}

// ─── Job Cards ────────────────────────────────────────────────────────────────

function JobRunCard({ job, onLoad }: { job: SchemaJob; onLoad: (j: SchemaJob) => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`rounded-lg border text-xs overflow-hidden ${job.status === 'success' ? 'border-emerald-200 dark:border-emerald-800/60' : job.status === 'failed' ? 'border-rose-200 dark:border-rose-800/60' : 'border-gray-200 dark:border-slate-700'}`}>
      <div className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer" onClick={() => onLoad(job)}>
        <span className={`shrink-0 inline-flex px-1.5 py-0.5 rounded font-semibold text-[10px] ${job.status === 'success' ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' : job.status === 'failed' ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'}`}>{job.status}</span>
        <span className="flex items-center gap-1 text-gray-400 dark:text-slate-500 shrink-0"><Clock size={9} />{timeAgo(job.created_at)}</span>
        {job.target_database && <span className="text-gray-500 dark:text-slate-400 truncate flex-1">{job.target_database}</span>}
        <div className="flex items-center gap-1 ml-auto shrink-0">
          <button onClick={e => { e.stopPropagation(); onLoad(job); }} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-950/60 transition-colors">
            <FolderOpen size={9} />{job.status === 'failed' ? 'Retry' : 'Load'}
          </button>
          {job.log && job.log.length > 0 && (
            <button onClick={e => { e.stopPropagation(); setExpanded(v => !v); }} className="p-0.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors">
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
              <span className="text-[10px] leading-relaxed"><span className="opacity-50 mr-1">[{line.step}]</span>{line.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JobGroupCard({ group, onLoad }: { group: JobGroup; onLoad: (j: SchemaJob) => void }) {
  const [expanded, setExpanded] = useState(false);
  const latest = group.runs[0];
  const hasFailure = group.runs.some(r => r.status === 'failed');
  const allSuccess = group.runs.every(r => r.status === 'success');
  return (
    <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900/60">
      <button onClick={() => setExpanded(v => !v)} className="w-full flex items-center gap-2.5 px-3 py-3 text-left hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-colors">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-gray-900 dark:text-slate-100 truncate">{group.job_name}</p>
          <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-0.5">{group.runs.length} run{group.runs.length !== 1 ? 's' : ''} · latest {timeAgo(latest.created_at)}</p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${allSuccess ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' : hasFailure ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'}`}>{allSuccess ? 'success' : hasFailure ? 'has failures' : latest.status}</span>
          {expanded ? <ChevronUp size={13} className="text-gray-400" /> : <ChevronDown size={13} className="text-gray-400" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t border-gray-100 dark:border-slate-800 px-3 pb-3 pt-2 space-y-1.5">
          {group.runs.map(run => <JobRunCard key={run.id} job={run} onLoad={onLoad} />)}
        </div>
      )}
    </div>
  );
}

// ─── Save Job Modal ───────────────────────────────────────────────────────────

function SaveJobModal({ onSave, onSkip }: { onSave: (name: string, desc: string) => void; onSkip: () => void }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800">
          <div className="flex items-center gap-2"><Save size={15} className="text-blue-500" /><p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Save Job Record</p></div>
          <button onClick={onSkip} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Job Name <span className="text-rose-500">*</span></label>
            <input ref={ref} value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onSave(name.trim(), desc.trim()); }}
              placeholder="e.g. Initial schema — project_x"
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-[10px] text-gray-400 dark:text-slate-500 mt-1">Same name as a previous job groups runs together in history.</p>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Description (optional)</label>
            <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Notes about this run…" rows={2}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500 resize-none"
            />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-slate-800">
          <button onClick={onSkip} className="px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">Skip</button>
          <button onClick={() => name.trim() && onSave(name.trim(), desc.trim())} disabled={!name.trim()}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
            <Save size={13} /> Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── FK Picker Modal ─────────────────────────────────────────────────────────

function FkPickerModal({ tables, currentTableId, value, onSelect, onClose }: {
  tables: DesignerTable[];
  currentTableId: string;
  value: string;
  onSelect: (ref: string) => void;
  onClose: () => void;
}) {
  const otherTables = tables.filter(t => t.id !== currentTableId);
  const initTable = (() => {
    if (value) {
      const [tName] = value.split('.');
      const found = otherTables.find(t => t.name === tName);
      if (found) return found;
    }
    return otherTables.find(t => t.columns.some(c => c.isPk)) ?? otherTables[0] ?? null;
  })();
  const [pickedTable, setPickedTable] = useState<DesignerTable | null>(initTable);

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <Link2 size={15} className="text-blue-500" />
            <p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Set Foreign Key Reference</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={16} /></button>
        </div>
        <div className="flex overflow-hidden" style={{ height: 320 }}>
          {/* Tables list */}
          <div className="w-44 shrink-0 border-r border-gray-100 dark:border-slate-800 overflow-y-auto">
            <p className="px-3 py-2 text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider sticky top-0 bg-white dark:bg-slate-900 border-b border-gray-100 dark:border-slate-800">
              Tables ({otherTables.length})
            </p>
            {otherTables.length === 0
              ? <p className="px-3 py-4 text-[11px] text-gray-400 dark:text-slate-500 text-center">No other tables in designer</p>
              : otherTables.map(t => (
                <button key={t.id} onClick={() => setPickedTable(t)}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 text-left border-b border-gray-50 dark:border-slate-800/50 transition-colors ${pickedTable?.id === t.id ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30 text-gray-700 dark:text-slate-300'}`}>
                  <Table2 size={11} className={`shrink-0 ${pickedTable?.id === t.id ? 'text-blue-400' : 'text-gray-400 dark:text-slate-500'}`} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium truncate">{t.name}</p>
                    {t.schema && t.schema !== 'public' && <p className="text-[9px] text-gray-400 dark:text-slate-500 font-mono">{t.schema}</p>}
                  </div>
                  <span className="text-[10px] text-gray-400 dark:text-slate-600 shrink-0">{t.columns.length}</span>
                </button>
              ))
            }
          </div>
          {/* Columns list */}
          <div className="flex-1 overflow-y-auto">
            {pickedTable ? (
              <>
                <p className="px-4 py-2 text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider sticky top-0 bg-white dark:bg-slate-900 border-b border-gray-100 dark:border-slate-800">
                  {pickedTable.name} — pick column
                </p>
                {pickedTable.columns.map(col => {
                  const ref = `${pickedTable.name}.${col.name}`;
                  const selected = value === ref;
                  return (
                    <button key={col.id} onClick={() => { onSelect(ref); onClose(); }}
                      className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left border-b border-gray-50 dark:border-slate-800/50 transition-colors ${selected ? 'bg-blue-50 dark:bg-blue-900/20' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}>
                      <span className="w-4 shrink-0 flex justify-center">
                        {col.isPk ? <KeyRound size={11} className="text-amber-500" />
                          : col.isUnique ? <Fingerprint size={11} className="text-purple-400" />
                            : <span className="w-1.5 h-1.5 rounded-full bg-gray-200 dark:bg-slate-600 inline-block" />}
                      </span>
                      <span className={`flex-1 text-[11px] font-mono font-medium truncate ${selected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-700 dark:text-slate-300'}`}>{col.name}</span>
                      <span className="text-[10px] font-mono text-gray-400 dark:text-slate-500 shrink-0">{col.type}</span>
                      {selected && <Check size={11} className="text-blue-500 shrink-0" />}
                    </button>
                  );
                })}
                {pickedTable.columns.length === 0 && <p className="px-4 py-4 text-[11px] text-gray-400 dark:text-slate-500">No columns in this table.</p>}
              </>
            ) : (
              <div className="flex items-center justify-center h-full"><p className="text-[11px] text-gray-400 dark:text-slate-500">Select a table on the left</p></div>
            )}
          </div>
        </div>
        <div className="px-5 py-3 border-t border-gray-100 dark:border-slate-800 flex items-center justify-between">
          {value
            ? <button onClick={() => { onSelect(''); onClose(); }} className="inline-flex items-center gap-1.5 text-[11px] text-rose-500 hover:text-rose-600 transition-colors"><X size={11} /> Remove FK</button>
            : <span />
          }
          <button onClick={onClose} className="px-4 py-1.5 text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ─── Column Editor ────────────────────────────────────────────────────────────

function ColumnEditorPanel({ table, tables, dbType, onUpdate, onDeleteTable }: {
  table: DesignerTable;
  tables: DesignerTable[];
  dbType: DbType;
  onUpdate: (t: DesignerTable) => void;
  onDeleteTable: () => void;
}) {
  const types = dbType === 'postgresql' ? PG_TYPES : MYSQL_TYPES;
  const [fkPickerColId, setFkPickerColId] = useState<string | null>(null);

  const updateCol = (colId: string, patch: Partial<DesignerColumn>) =>
    onUpdate({ ...table, columns: table.columns.map(c => c.id === colId ? { ...c, ...patch } : c) });

  const addCol = () => onUpdate({ ...table, columns: [...table.columns, mkCol()] });
  const delCol = (colId: string) => onUpdate({ ...table, columns: table.columns.filter(c => c.id !== colId) });

  // FK relationship summaries
  const fkCols = table.columns.filter(c => c.fkRef);
  const incomingFks = tables.flatMap(t =>
    t.id !== table.id
      ? t.columns.filter(c => c.fkRef?.startsWith(`${table.name}.`)).map(c => ({ fromTable: t, fromCol: c }))
      : []
  );

  const cbClass = 'w-3.5 h-3.5 cursor-pointer accent-blue-500 rounded';
  const inputClass = 'w-full bg-transparent outline-none text-gray-900 dark:text-slate-100 font-mono text-[11px] px-1 py-0.5 rounded border border-transparent hover:bg-gray-100 dark:hover:bg-slate-700/50 focus:bg-white dark:focus:bg-slate-800 focus:border-blue-400 transition-colors';

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Table header */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <Table2 size={15} className="text-blue-500 shrink-0" />
        <input
          className="text-sm font-semibold bg-transparent border-0 outline-none text-gray-900 dark:text-slate-100 focus:ring-0 min-w-0 w-32"
          value={table.name}
          onChange={e => onUpdate({ ...table, name: e.target.value })}
          placeholder="table_name"
        />
        {dbType === 'postgresql' && (
          <>
            <span className="text-gray-300 dark:text-slate-600">·</span>
            <span className="text-[11px] text-gray-400 dark:text-slate-500">schema:</span>
            <input
              className="text-[11px] bg-transparent border-0 outline-none text-gray-500 dark:text-slate-400 font-mono w-24 focus:ring-0"
              value={table.schema}
              onChange={e => onUpdate({ ...table, schema: e.target.value })}
              placeholder="public"
            />
          </>
        )}
        <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500">{table.columns.length} column{table.columns.length !== 1 ? 's' : ''}</span>
        <button onClick={onDeleteTable} title="Delete table" className="p-1 text-gray-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
          <Trash2 size={13} />
        </button>
      </div>

      {/* Column table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] border-collapse" style={{ minWidth: 880 }}>
          <thead className="sticky top-0 z-10">
            <tr className="text-left text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider bg-gray-50 dark:bg-slate-800/60">
              <th className="px-3 py-2 w-36">Name</th>
              <th className="px-3 py-2 w-32">Type</th>
              <th className="px-3 py-2 w-20">Length</th>
              <th className="px-3 py-2 text-center w-9" title="Primary Key">PK</th>
              <th className="px-3 py-2 text-center w-9" title="Not Null">NN</th>
              <th className="px-3 py-2 text-center w-9" title="Unique">UQ</th>
              <th className="px-3 py-2 text-center w-9" title="Auto Increment">AI</th>
              <th className="px-3 py-2 w-28">Default</th>
              <th className="px-3 py-2 w-40">FK Reference</th>
              <th className="px-3 py-2 w-32">Comment</th>
              <th className="px-3 py-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map(col => (
              <tr
                key={col.id}
                className={`border-t border-gray-100 dark:border-slate-800 hover:bg-blue-50/30 dark:hover:bg-slate-800/20 ${col.isPk ? 'bg-amber-50/40 dark:bg-amber-900/10' : ''}`}
              >
                <td className="px-2 py-1"><input className={inputClass} value={col.name} onChange={e => updateCol(col.id, { name: e.target.value })} /></td>
                <td className="px-2 py-1">
                  <select
                    className="w-full bg-transparent outline-none text-gray-900 dark:text-slate-100 text-[11px] px-1 py-0.5 rounded border border-transparent hover:bg-gray-100 dark:hover:bg-slate-700/50 focus:bg-white dark:focus:bg-slate-800 focus:border-blue-400 cursor-pointer font-mono transition-colors"
                    value={col.type}
                    onChange={e => {
                      const t = e.target.value;
                      updateCol(col.id, { type: t, isAutoIncrement: ['SERIAL', 'BIGSERIAL', 'SMALLSERIAL'].includes(t) ? true : col.isAutoIncrement });
                    }}
                  >
                    {types.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td className="px-2 py-1">
                  {NEEDS_LENGTH.has(col.type)
                    ? <input className={inputClass} placeholder="255" value={col.length} onChange={e => updateCol(col.id, { length: e.target.value })} />
                    : <span className="text-gray-300 dark:text-slate-700 px-1">—</span>}
                </td>
                <td className="px-2 py-1 text-center">
                  <input type="checkbox" className={cbClass} checked={col.isPk}
                    onChange={e => updateCol(col.id, { isPk: e.target.checked, nullable: e.target.checked ? false : col.nullable, isUnique: e.target.checked ? true : col.isUnique })} />
                </td>
                <td className="px-2 py-1 text-center">
                  <input type="checkbox" className={cbClass} checked={!col.nullable}
                    onChange={e => updateCol(col.id, { nullable: !e.target.checked })} />
                </td>
                <td className="px-2 py-1 text-center">
                  <input type="checkbox" className={cbClass} checked={col.isUnique}
                    onChange={e => updateCol(col.id, { isUnique: e.target.checked })} />
                </td>
                <td className="px-2 py-1 text-center">
                  <input type="checkbox" className={cbClass} checked={col.isAutoIncrement}
                    onChange={e => updateCol(col.id, { isAutoIncrement: e.target.checked })} />
                </td>
                <td className="px-2 py-1">
                  <input className={inputClass} placeholder="NULL" value={col.defaultValue} onChange={e => updateCol(col.id, { defaultValue: e.target.value })} />
                </td>
                {/* FK Reference — visual picker instead of free text */}
                <td className="px-2 py-1">
                  {col.fkRef ? (
                    <div className="flex items-center gap-1 min-w-0">
                      <button
                        onClick={() => setFkPickerColId(col.id)}
                        title={`FK → ${col.fkRef} (click to change)`}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-[10px] font-mono text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors max-w-[100px] min-w-0"
                      >
                        <Link2 size={8} className="shrink-0" />
                        <span className="truncate">{col.fkRef}</span>
                      </button>
                      <button onClick={() => updateCol(col.id, { fkRef: '' })} title="Remove FK" className="shrink-0 p-0.5 text-gray-300 dark:text-slate-700 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setFkPickerColId(col.id)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-gray-300 dark:text-slate-600 hover:text-blue-500 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded transition-colors"
                    >
                      <Link2 size={10} /> Set FK
                    </button>
                  )}
                </td>
                <td className="px-2 py-1">
                  <input className={`${inputClass} text-gray-500 dark:text-slate-400`} placeholder="—" value={col.comment} onChange={e => updateCol(col.id, { comment: e.target.value })} />
                </td>
                <td className="px-2 py-1 text-center">
                  <button onClick={() => delCol(col.id)} className="p-0.5 text-gray-300 dark:text-slate-700 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
                    <X size={12} />
                  </button>
                </td>
              </tr>
            ))}
            {table.columns.length === 0 && (
              <tr><td colSpan={11} className="px-4 py-6 text-center text-[11px] text-gray-400 dark:text-slate-500">No columns. Click Add Column.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* FK Relationships summary */}
      {(fkCols.length > 0 || incomingFks.length > 0) && (
        <div className="shrink-0 px-5 py-3 border-t border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/40 space-y-2.5">
          {fkCols.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Link2 size={10} /> Outgoing FK{fkCols.length !== 1 ? 's' : ''} ({fkCols.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {fkCols.map(c => (
                  <div key={c.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-blue-200 dark:border-blue-800 text-[10px]">
                    <span className="font-mono font-medium text-gray-700 dark:text-slate-200">{c.name}</span>
                    <span className="text-blue-400">→</span>
                    <span className="font-mono text-blue-600 dark:text-blue-400">{c.fkRef}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {incomingFks.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <ChevronRight size={10} /> Referenced by ({incomingFks.length})
              </p>
              <div className="flex flex-wrap gap-1.5">
                {incomingFks.map(({ fromTable, fromCol }) => (
                  <div key={`${fromTable.id}-${fromCol.id}`} className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white dark:bg-slate-900 border border-purple-200 dark:border-purple-800 text-[10px]">
                    <span className="font-mono text-purple-600 dark:text-purple-400">{fromTable.name}.{fromCol.name}</span>
                    <span className="text-purple-400">→</span>
                    <span className="font-mono font-medium text-gray-600 dark:text-slate-300">this</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Add column */}
      <div className="shrink-0 px-4 py-2.5 border-t border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900">
        <button onClick={addCol} className="inline-flex items-center gap-1.5 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors">
          <Plus size={12} /> Add Column
        </button>
      </div>

      {/* FK Picker Modal */}
      {fkPickerColId && (
        <FkPickerModal
          tables={tables}
          currentTableId={table.id}
          value={table.columns.find(c => c.id === fkPickerColId)?.fkRef ?? ''}
          onSelect={ref => updateCol(fkPickerColId, { fkRef: ref })}
          onClose={() => setFkPickerColId(null)}
        />
      )}
    </div>
  );
}

// ─── Table Tree Panel ─────────────────────────────────────────────────────────

function TableTreePanel({ tables, selectedId, dbType, schemas, onSelect, onDelete, onAdd, onAddSchema, onAddTableFor }: {
  tables: DesignerTable[];
  selectedId: string | null;
  dbType: DbType;
  schemas: string[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
  onAddSchema: () => void;
  onAddTableFor: (schema: string) => void;
}) {
  const grouped = useMemo(() => {
    const m = new Map<string, DesignerTable[]>();
    if (dbType === 'postgresql') {
      for (const s of schemas) { if (!m.has(s)) m.set(s, []); }
    } else {
      m.set('', []);
    }
    for (const t of tables) {
      const key = dbType === 'postgresql' ? (t.schema || 'public') : '';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return m;
  }, [tables, dbType, schemas]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['public', '']));
  const toggleSchema = (s: string) => setExpanded(p => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">
            Tables{tables.length > 0 ? ` (${tables.length})` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {dbType === 'postgresql' && (
            <button
              onClick={onAddSchema}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 hover:border-blue-300 dark:hover:border-blue-700 transition-colors"
            >
              <Plus size={11} /> Schema
            </button>
          )}
          <button
            onClick={onAdd}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1 text-[11px] font-medium rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
          >
            <Plus size={11} /> Table
          </button>
        </div>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {tables.length === 0 && dbType === 'mysql' && (
          <div className="flex flex-col items-center justify-center gap-2 p-4 h-28">
            <Table2 size={24} className="text-gray-200 dark:text-slate-700" />
            <p className="text-[11px] text-center text-gray-400 dark:text-slate-500">No tables yet.<br />Click + to add one.</p>
          </div>
        )}

        {Array.from(grouped.entries()).map(([schema, schemaTables]) => (
          <div key={schema}>
            {/* Schema header (PG only) */}
            {dbType === 'postgresql' && (
              <div className="flex items-center group/schema">
                <button
                  onClick={() => toggleSchema(schema)}
                  className="flex-1 flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider hover:bg-gray-50 dark:hover:bg-slate-800/30 transition-colors"
                >
                  {expanded.has(schema) ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  <Layers size={10} />
                  <span>{schema || 'public'}</span>
                  {schemaTables.length > 0 && <span className="opacity-60">({schemaTables.length})</span>}
                </button>
                <button
                  onClick={() => onAddTableFor(schema)}
                  title={`Add table to ${schema}`}
                  className="opacity-0 group-hover/schema:opacity-100 p-1.5 mr-1 text-gray-400 hover:text-blue-500 dark:text-slate-500 dark:hover:text-blue-400 transition-all shrink-0"
                >
                  <Plus size={11} />
                </button>
              </div>
            )}

            {/* Tables under schema */}
            {(dbType === 'mysql' || expanded.has(schema)) && (
              <>
                {schemaTables.length === 0 && dbType === 'postgresql' && (
                  <p className="pl-8 py-1.5 text-[10px] italic text-gray-300 dark:text-slate-700">
                    Empty — hover + to add table
                  </p>
                )}
                {schemaTables.map(t => {
                  const hasFk = t.columns.some(c => c.fkRef);
                  const isReferenced = tables.some(ot => ot.id !== t.id && ot.columns.some(c => c.fkRef?.startsWith(`${t.name}.`)));
                  return (
                    <div
                      key={t.id}
                      onClick={() => onSelect(t.id)}
                      className={`group flex items-center gap-2 py-1.5 cursor-pointer transition-colors
                        ${dbType === 'postgresql' ? 'pl-7 pr-2' : 'px-3'}
                        ${selectedId === t.id
                          ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300'
                          : 'hover:bg-gray-50 dark:hover:bg-slate-800/30 text-gray-700 dark:text-slate-300'}`}
                    >
                      <Table2 size={11} className={`shrink-0 ${selectedId === t.id ? 'text-blue-500' : 'text-gray-400 dark:text-slate-500'}`} />
                      <span className="flex-1 text-[11px] font-medium truncate">{t.name}</span>
                      {hasFk && <span title="Has FK references"><Link2 size={9} className="text-blue-400 dark:text-blue-500 shrink-0" /></span>}
                      {isReferenced && <span title="Referenced by other tables"><ChevronRight size={9} className="text-purple-400 dark:text-purple-500 shrink-0 -rotate-90" /></span>}
                      <span className="text-[10px] text-gray-400 dark:text-slate-600">{t.columns.length}</span>
                      <button
                        onClick={e => { e.stopPropagation(); onDelete(t.id); }}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-rose-500 dark:hover:text-rose-400 transition-all shrink-0"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Import Panel ─────────────────────────────────────────────────────────────

function ImportPanel({ conn, selectedDb, dbType, onMerge }: {
  conn: ConnectionRow | null;
  selectedDb: string;
  dbType: DbType;
  onMerge: (tables: DesignerTable[]) => void;
}) {
  // SQL import
  const [sqlText, setSqlText] = useState('');
  const [sqlParsed, setSqlParsed] = useState<DesignerTable[]>([]);
  const sqlFileRef = useRef<HTMLInputElement>(null);

  const parseSql = () => {
    const tables = parseSqlToTables(sqlText);
    setSqlParsed(tables);
  };

  const handleSqlFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      setSqlText(text);
      setSqlParsed(parseSqlToTables(text));
    };
    reader.readAsText(file);
  };

  // XLSX import
  const [xlsxParsed, setXlsxParsed] = useState<DesignerTable[]>([]);
  const [xlsxLoading, setXlsxLoading] = useState(false);
  const xlsxRef = useRef<HTMLInputElement>(null);

  const handleXlsx = async (file: File) => {
    setXlsxLoading(true);
    try {
      const pts = await parseExcelFile(file);
      setXlsxParsed(pts.map(pt => ({
        id: crypto.randomUUID(), schema: 'public', name: pt.name,
        columns: pt.columns.map(c => ({
          id: crypto.randomUUID(), name: c.name, type: c.type, length: c.type === 'VARCHAR' ? '255' : '',
          nullable: c.nullable, isPk: false, isUnique: false, isAutoIncrement: false, defaultValue: '', comment: '', fkRef: '',
        })),
      })));
    } catch { /* ignore */ } finally { setXlsxLoading(false); }
  };

  // CSV import
  const [csvText, setCsvText] = useState('');
  const [csvName, setCsvName] = useState('');
  const [csvParsed, setCsvParsed] = useState<DesignerTable | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const handleCsvFile = (file: File) => {
    const name = csvName || file.name.replace(/\.csv$/i, '');
    setCsvName(name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      setCsvText(text);
      setCsvParsed(parseCsvToTable(text, name || 'imported'));
    };
    reader.readAsText(file);
  };

  // From DB
  const [dbSchemas, setDbSchemas] = useState<SchemaInfo[]>([]);
  const [dbTables, setDbTables] = useState<Record<string, TableInfo[]>>({});
  const [dbExpanded, setDbExpanded] = useState<Set<string>>(new Set());
  const [dbSelected, setDbSelected] = useState<Set<string>>(new Set());
  const [loadingDbSchema, setLoadingDbSchema] = useState(false);
  const [importingFromDb, setImportingFromDb] = useState(false);

  const loadDbSchemas = useCallback(async () => {
    if (!conn || !selectedDb) return;
    setLoadingDbSchema(true);
    try {
      const explorerConn = connToExplorerConn(conn, selectedDb);
      const { data } = await axios.post<{ schemas: SchemaInfo[] }>('/api/schema-explorer/schemas', explorerConn, { headers: authH() });
      setDbSchemas(data.schemas);
    } catch { /* ignore */ } finally { setLoadingDbSchema(false); }
  }, [conn, selectedDb]);

  const loadDbTables = async (schema: string) => {
    if (!conn || !selectedDb || dbTables[schema]) return;
    try {
      const explorerConn = connToExplorerConn(conn, selectedDb);
      const { data } = await axios.post<{ tables: TableInfo[] }>('/api/schema-explorer/tables', { conn: explorerConn, schemas: [schema] }, { headers: authH() });
      setDbTables(p => ({ ...p, [schema]: data.tables }));
    } catch { /* ignore */ }
  };

  const toggleDbSchema = async (schema: string) => {
    setDbExpanded(p => { const n = new Set(p); n.has(schema) ? n.delete(schema) : n.add(schema); return n; });
    await loadDbTables(schema);
  };

  const toggleDbTable = (key: string) => {
    setDbSelected(p => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  const importFromDb = async () => {
    if (!conn || !selectedDb || !dbSelected.size) return;
    setImportingFromDb(true);
    const explorerConn = connToExplorerConn(conn, selectedDb);
    const imported: DesignerTable[] = [];
    for (const key of dbSelected) {
      try {
        const { data } = await axios.post<TableColumnsResult>('/api/schema-explorer/columns', { conn: explorerConn, tableKey: key }, { headers: authH() });
        const [schema, name] = key.includes('.') ? key.split('.', 2) : ['public', key];
        imported.push({ id: crypto.randomUUID(), schema, name, columns: data.columns.map(colInfoToDesigner) });
      } catch { /* ignore */ }
    }
    if (imported.length) { onMerge(imported); setDbSelected(new Set()); }
    setImportingFromDb(false);
  };

  const sectionClass = 'rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-900';
  const sectionHeaderClass = 'flex items-center gap-3 px-5 py-3.5 bg-gray-50 dark:bg-slate-800/50 border-b border-gray-100 dark:border-slate-800';
  const applyBtn = (onClick: () => void, disabled: boolean, label: string) => (
    <button onClick={onClick} disabled={disabled}
      className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors">
      <Download size={12} /> {label}
    </button>
  );

  return (
    <div className="p-6 overflow-auto h-full space-y-5">

      {/* From DB */}
      {conn && selectedDb && (
        <div className={sectionClass}>
          <div className={sectionHeaderClass}>
            <Database size={14} className="text-blue-500" />
            <div className="flex-1">
              <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">From Connected Database</p>
              <p className="text-[11px] text-gray-400 dark:text-slate-500">{conn.label} → {selectedDb}</p>
            </div>
            <button onClick={loadDbSchemas} disabled={loadingDbSchema}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors">
              {loadingDbSchema ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Load Schemas
            </button>
          </div>
          {dbSchemas.length > 0 && (
            <div className="divide-y divide-gray-100 dark:divide-slate-800 max-h-64 overflow-auto">
              {dbSchemas.map(s => (
                <div key={s.schema}>
                  <button onClick={() => void toggleDbSchema(s.schema)}
                    className="w-full flex items-center gap-2 px-5 py-2 hover:bg-gray-50 dark:hover:bg-slate-800/30 transition-colors text-left">
                    {dbExpanded.has(s.schema) ? <ChevronDown size={11} className="text-gray-400" /> : <ChevronRight size={11} className="text-gray-400" />}
                    <span className="text-xs font-medium text-gray-700 dark:text-slate-200">{s.schema}</span>
                    <span className="text-[10px] text-gray-400 dark:text-slate-500">{s.tableCount} tables</span>
                  </button>
                  {dbExpanded.has(s.schema) && (dbTables[s.schema] ?? []).map(t => {
                    const key = `${t.schema}.${t.name}`;
                    return (
                      <label key={key} className="flex items-center gap-2.5 pl-10 pr-5 py-1.5 hover:bg-gray-50 dark:hover:bg-slate-800/20 cursor-pointer">
                        <input type="checkbox" className="w-3.5 h-3.5 accent-blue-500 rounded" checked={dbSelected.has(key)} onChange={() => toggleDbTable(key)} />
                        <Table2 size={11} className="text-gray-400 dark:text-slate-500 shrink-0" />
                        <span className="text-[11px] text-gray-700 dark:text-slate-300">{t.name}</span>
                        <span className="text-[10px] text-gray-400 dark:text-slate-500 ml-auto">{t.columnCount} cols</span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
          {dbSchemas.length > 0 && (
            <div className="px-5 py-3 border-t border-gray-100 dark:border-slate-800 flex items-center gap-3">
              {applyBtn(() => void importFromDb(), importingFromDb || !dbSelected.size, importingFromDb ? 'Importing…' : `Import Selected (${dbSelected.size})`)}
              {dbSelected.size > 0 && <button onClick={() => setDbSelected(new Set())} className="text-[11px] text-gray-400 hover:text-gray-600 dark:hover:text-slate-300">Clear</button>}
            </div>
          )}
        </div>
      )}

      {/* SQL import */}
      <div className={sectionClass}>
        <div className={sectionHeaderClass}>
          <FileCode2 size={14} className="text-emerald-500" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">From SQL</p>
            <p className="text-[11px] text-gray-400 dark:text-slate-500">Paste or upload a .sql file with CREATE TABLE statements</p>
          </div>
          <button onClick={() => sqlFileRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
            <Upload size={11} /> Upload .sql
          </button>
          <input ref={sqlFileRef} type="file" accept=".sql,.txt" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleSqlFile(f); e.target.value = ''; }} />
        </div>
        <div className="p-4 space-y-3">
          <textarea
            className="w-full h-32 text-[11px] font-mono rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 text-gray-700 dark:text-slate-300 p-3 resize-none focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20 placeholder-gray-300 dark:placeholder-slate-600"
            placeholder="-- Paste CREATE TABLE statements here…"
            value={sqlText}
            onChange={e => setSqlText(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <button onClick={parseSql} disabled={!sqlText.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors">
              <RefreshCw size={11} /> Parse
            </button>
            {sqlParsed.length > 0 && (
              <>
                <span className="text-[11px] text-emerald-600 dark:text-emerald-400">{sqlParsed.length} table{sqlParsed.length !== 1 ? 's' : ''} found</span>
                {applyBtn(() => { onMerge(sqlParsed); setSqlParsed([]); }, false, 'Add to Designer')}
              </>
            )}
          </div>
          {sqlParsed.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {sqlParsed.map(t => (
                <span key={t.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-900/20 text-[10px] text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800">
                  <Table2 size={9} /> {t.name} <span className="opacity-60">({t.columns.length})</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* XLSX import */}
      <div className={sectionClass}>
        <div className={sectionHeaderClass}>
          <FileSpreadsheet size={14} className="text-green-500" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">From XLSX / Excel</p>
            <p className="text-[11px] text-gray-400 dark:text-slate-500">Each sheet becomes a table. Column types are inferred from data.</p>
          </div>
          <button onClick={() => xlsxRef.current?.click()} disabled={xlsxLoading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors">
            {xlsxLoading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            Upload .xlsx
          </button>
          <input ref={xlsxRef} type="file" accept=".xlsx,.xls" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void handleXlsx(f); e.target.value = ''; }} />
        </div>
        {xlsxParsed.length > 0 && (
          <div className="p-4 space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {xlsxParsed.map(t => (
                <span key={t.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-green-50 dark:bg-green-900/20 text-[10px] text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800">
                  <Table2 size={9} /> {t.name} <span className="opacity-60">({t.columns.length})</span>
                </span>
              ))}
            </div>
            {applyBtn(() => { onMerge(xlsxParsed); setXlsxParsed([]); }, false, `Add ${xlsxParsed.length} Table${xlsxParsed.length !== 1 ? 's' : ''}`)}
          </div>
        )}
      </div>

      {/* CSV import */}
      <div className={sectionClass}>
        <div className={sectionHeaderClass}>
          <FileText size={14} className="text-orange-500" />
          <div className="flex-1">
            <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">From CSV</p>
            <p className="text-[11px] text-gray-400 dark:text-slate-500">First row as headers. Column types inferred from sample rows.</p>
          </div>
          <button onClick={() => csvRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
            <Upload size={11} /> Upload .csv
          </button>
          <input ref={csvRef} type="file" accept=".csv" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleCsvFile(f); e.target.value = ''; }} />
        </div>
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <label className="text-[11px] text-gray-500 dark:text-slate-400 shrink-0">Table name:</label>
            <input
              className="flex-1 text-[11px] font-mono px-2 py-1 rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/50 text-gray-700 dark:text-slate-300 focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
              placeholder="my_table"
              value={csvName}
              onChange={e => { setCsvName(e.target.value); if (csvText) setCsvParsed(parseCsvToTable(csvText, e.target.value)); }}
            />
          </div>
          {csvParsed && (
            <div className="space-y-2">
              <p className="text-[11px] text-gray-500 dark:text-slate-400">{csvParsed.columns.length} column{csvParsed.columns.length !== 1 ? 's' : ''} detected:</p>
              <div className="flex flex-wrap gap-1.5">
                {csvParsed.columns.map(c => (
                  <span key={c.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-orange-50 dark:bg-orange-900/20 text-[10px] text-orange-700 dark:text-orange-300 border border-orange-200 dark:border-orange-800">
                    {c.name} <span className="opacity-60">{c.type}</span>
                  </span>
                ))}
              </div>
              {applyBtn(() => { if (csvParsed) { onMerge([csvParsed]); setCsvParsed(null); setCsvText(''); } }, false, 'Add to Designer')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Execute Panel ────────────────────────────────────────────────────────────

function ExecutePanel({ tables, conn, selectedDb, dbType, seedSql, onSeedSqlChange, executing, execLog, onExecute, lastRunStatus, onSaveJob, jobs, loadingJobs, onLoadJob }: {
  tables: DesignerTable[];
  conn: ConnectionRow | null;
  selectedDb: string;
  dbType: DbType;
  seedSql: string;
  onSeedSqlChange: (v: string) => void;
  executing: boolean;
  execLog: ExecLogLine[];
  onExecute: () => void;
  lastRunStatus: 'success' | 'failed' | null;
  onSaveJob: () => void;
  jobs: SchemaJob[];
  loadingJobs: boolean;
  onLoadJob: (j: SchemaJob) => void;
}) {
  const ddlText = useMemo(() => generateDDL(tables, dbType).join('\n\n'), [tables, dbType]);
  const [copied, setCopied] = useState(false);
  const [copiedSeed, setCopiedSeed] = useState(false);
  const groupedJobs = useMemo(() => groupJobs(jobs), [jobs]);

  const copyDdl = async () => {
    await navigator.clipboard.writeText(ddlText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const downloadDdl = () => {
    const blob = new Blob([ddlText], { type: 'text/sql' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'schema.sql'; a.click();
    URL.revokeObjectURL(url);
  };

  const copySeed = async () => {
    await navigator.clipboard.writeText(seedSql);
    setCopiedSeed(true);
    setTimeout(() => setCopiedSeed(false), 1500);
  };

  const canRun = !!conn && !!selectedDb && tables.length > 0 && !executing;
  const successCount = execLog.filter(l => l.ok).length;
  const failCount = execLog.filter(l => !l.ok).length;
  const seedAnalysis = analyzeSeedSql(seedSql);

  return (
    <div className="h-full overflow-hidden flex flex-col xl:flex-row gap-0">

      {/* Left: DDL Preview + Seed SQL */}
      <div className="flex-1 flex flex-col overflow-hidden border-b xl:border-b-0 xl:border-r border-gray-200 dark:border-slate-800">

        {/* DDL Preview — top half */}
        <div className="flex flex-col overflow-hidden" style={{ flex: '1 1 50%' }}>
          <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <FileCode2 size={14} className="text-emerald-500" />
            <span className="text-xs font-semibold text-gray-700 dark:text-slate-200">Generated DDL</span>
            <span className="text-[11px] text-gray-400 dark:text-slate-500 ml-1">({dbType})</span>
            <div className="ml-auto flex items-center gap-2">
              <button onClick={downloadDdl} disabled={!ddlText} title="Download .sql"
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 disabled:opacity-30 transition-colors">
                <Download size={13} />
              </button>
              <button onClick={() => void copyDdl()} disabled={!ddlText}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors">
                {copied ? <><Check size={11} className="text-emerald-500" /> Copied</> : <><Copy size={11} /> Copy</>}
              </button>
            </div>
          </div>
          <div className="flex-1 overflow-auto bg-slate-950 p-4">
            {ddlText ? (
              <pre className="text-[11px] font-mono text-slate-300 leading-relaxed whitespace-pre-wrap">{ddlText}</pre>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-2">
                <FileCode2 size={28} className="text-slate-700" />
                <p className="text-xs text-slate-600">No tables in designer yet.</p>
              </div>
            )}
          </div>
        </div>

        {/* Seed SQL — bottom half */}
        <div className="flex flex-col overflow-hidden border-t border-gray-200 dark:border-slate-800" style={{ flex: '1 1 50%' }}>
          <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <Sprout size={14} className="text-emerald-500" />
            <span className="text-xs font-semibold text-gray-700 dark:text-slate-200">Seed SQL</span>
            <span className="text-[11px] text-gray-400 dark:text-slate-500">optional INSERT data</span>
            {seedAnalysis && <SeedAnalysisBadge a={seedAnalysis} />}
            <div className="ml-auto flex items-center gap-2">
              {seedSql.trim() && (
                <button onClick={() => void copySeed()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                  {copiedSeed ? <><Check size={11} className="text-emerald-500" /> Copied</> : <><Copy size={11} /> Copy</>}
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-auto bg-slate-950 p-4">
            <textarea
              className="w-full h-full min-h-[80px] text-[11px] font-mono bg-transparent text-slate-300 resize-none focus:outline-none placeholder-slate-600 leading-relaxed"
              placeholder="-- Optional: paste INSERT INTO statements here to seed data after DDL…"
              value={seedSql}
              onChange={e => onSeedSqlChange(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Right: Run Controls + Log + Job History */}
      <div className="w-full xl:w-80 shrink-0 flex flex-col overflow-hidden bg-white dark:bg-slate-900">
        <div className="shrink-0 px-5 py-4 border-b border-gray-200 dark:border-slate-800 space-y-3">
          <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">Execute Against</p>
          {conn && selectedDb ? (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-slate-800/50 border border-gray-200 dark:border-slate-700">
              <Database size={12} className="text-blue-500 shrink-0" />
              <div className="min-w-0">
                <p className="text-[11px] font-medium text-gray-700 dark:text-slate-200 truncate">{conn.label}</p>
                <p className="text-[10px] text-gray-400 dark:text-slate-500 font-mono truncate">{selectedDb}</p>
              </div>
              <span className={`ml-auto shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded ${conn.db_type === 'postgres' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'}`}>
                {conn.db_type === 'postgres' ? 'PG' : 'MySQL'}
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertCircle size={12} /> Select a connection and database above
            </div>
          )}
          <button onClick={onExecute} disabled={!canRun}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors">
            {executing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {executing ? 'Executing…' : `Execute (${tables.length} table${tables.length !== 1 ? 's' : ''}${seedSql.trim() ? ' + seed' : ''})`}
          </button>
          {lastRunStatus && (
            <div className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[11px] font-medium ${lastRunStatus === 'success' ? 'bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400' : 'bg-rose-50 dark:bg-rose-900/10 border border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-400'}`}>
              <div className="flex items-center gap-1.5">
                {lastRunStatus === 'success' ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                {lastRunStatus === 'success' ? 'Execution succeeded' : 'Execution had errors'}
              </div>
              <button onClick={onSaveJob}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-white/60 dark:bg-slate-800/60 border border-current/20 hover:bg-white/90 dark:hover:bg-slate-700/60 transition-colors">
                <Save size={9} /> Save Job
              </button>
            </div>
          )}
        </div>

        {/* Log + Job History */}
        <div className="flex-1 overflow-auto">
          {execLog.length > 0 ? (
            <>
              <div className="flex items-center gap-3 px-5 py-2.5 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/30">
                <span className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider">Execution Log</span>
                {successCount > 0 && <span className="text-[10px] text-emerald-600 dark:text-emerald-400">{successCount} ok</span>}
                {failCount > 0 && <span className="text-[10px] text-rose-600 dark:text-rose-400">{failCount} failed</span>}
              </div>
              <div className="p-3 space-y-1.5 font-mono">
                {execLog.map((line, i) => (
                  <div key={i} className={`flex items-start gap-2 text-[10px] leading-relaxed ${line.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {line.ok ? <CheckCircle2 size={10} className="mt-0.5 shrink-0" /> : <XCircle size={10} className="mt-0.5 shrink-0" />}
                    <span className="break-all">{line.text}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 gap-2 px-6">
              <Terminal size={22} className="text-gray-200 dark:text-slate-700" />
              <p className="text-[11px] text-center text-gray-400 dark:text-slate-500">Execution log appears here after running.</p>
            </div>
          )}

          {/* Job History */}
          <div className="border-t border-gray-100 dark:border-slate-800 px-4 py-3">
            <div className="flex items-center gap-2 mb-3">
              <Clock size={12} className="text-gray-400 dark:text-slate-500" />
              <span className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider">Job History</span>
              {loadingJobs && <Loader2 size={10} className="animate-spin text-gray-400" />}
            </div>
            {groupedJobs.length === 0 && !loadingJobs && (
              <p className="text-[10px] text-gray-400 dark:text-slate-500 text-center py-2">No saved jobs yet.</p>
            )}
            <div className="space-y-2">
              {groupedJobs.map(g => <JobGroupCard key={g.job_name} group={g} onLoad={onLoadJob} />)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── New Table Dialog ─────────────────────────────────────────────────────────

function NewTableDialog({ dbType, defaultSchema, onConfirm, onClose }: {
  dbType: DbType;
  defaultSchema?: string;
  onConfirm: (name: string, schema: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [schema, setSchema] = useState(defaultSchema ?? 'public');
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); }, []);

  const submit = () => {
    const n = sanitizeName(name.trim());
    if (!n) return;
    onConfirm(n, schema || 'public');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-80 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">New Table</h3>
        {dbType === 'postgresql' && (
          <div className="space-y-1">
            <label className="text-[11px] text-gray-500 dark:text-slate-400">Schema</label>
            <input
              className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
              value={schema} onChange={e => setSchema(e.target.value)} placeholder="public"
            />
          </div>
        )}
        <div className="space-y-1">
          <label className="text-[11px] text-gray-500 dark:text-slate-400">Table name</label>
          <input
            ref={nameRef}
            className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
            value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
            placeholder="my_table"
          />
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={submit} disabled={!name.trim()}
            className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors">
            Create
          </button>
          <button onClick={onClose} className="flex-1 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── New DB Dialog ────────────────────────────────────────────────────────────

function NewDbDialog({ dbType, onConfirm, onClose, creating, error }: {
  dbType: DbType;
  onConfirm: (name: string) => void;
  onClose: () => void;
  creating: boolean;
  error: string;
}) {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-80 p-6 space-y-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Create New Database</h3>
        <div className="space-y-1">
          <label className="text-[11px] text-gray-500 dark:text-slate-400">Database name ({dbType === 'postgresql' ? 'PostgreSQL' : 'MySQL'})</label>
          <input
            ref={ref}
            className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
            value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && name.trim()) onConfirm(name.trim()); if (e.key === 'Escape') onClose(); }}
            placeholder="my_database"
          />
        </div>
        {error && <p className="text-[11px] text-rose-500">{error}</p>}
        <div className="flex gap-2 pt-1">
          <button onClick={() => onConfirm(name.trim())} disabled={!name.trim() || creating}
            className="flex-1 inline-flex items-center justify-center gap-2 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors">
            {creating && <Loader2 size={13} className="animate-spin" />}
            {creating ? 'Creating…' : 'Create'}
          </button>
          <button onClick={onClose} className="flex-1 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Guide Popover ────────────────────────────────────────────────────────────

function GuidePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const pill = (text: string) => (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200 border border-gray-200 dark:border-slate-700">{text}</span>
  );
  const h3 = 'flex items-center gap-1.5 text-xs font-semibold text-gray-800 dark:text-slate-100';
  const sec = 'mt-2 space-y-1.5 text-[11px] text-gray-600 dark:text-slate-300 leading-relaxed';
  const div = 'border-t border-gray-100 dark:border-slate-800';

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
        <div className="absolute right-0 top-full mt-2 z-50 w-[430px] max-h-[74vh] flex flex-col bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-2xl overflow-hidden">

          {/* Header */}
          <div className="shrink-0 flex items-center gap-2.5 px-4 py-3 border-b border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900">
            <BookOpen size={14} className="text-blue-500" />
            <p className="flex-1 font-semibold text-sm text-gray-900 dark:text-slate-100">Schema Designer Guide</p>
            <button onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300 transition-colors"><X size={14} /></button>
          </div>

          {/* Scrollable body */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 text-[11px]">

            {/* Workflow */}
            <div>
              <p className={h3}><Info size={12} className="text-blue-500" /> Workflow</p>
              <div className={sec}>
                <p>Pick a <strong>connection</strong> → pick a <strong>database</strong> → design tables → click <strong>Execute</strong>.</p>
                <p>All changes are <strong>local</strong> until Execute — nothing is written to the database beforehand.</p>
              </div>
            </div>

            <div className={div} />

            {/* Navbar */}
            <div>
              <p className={h3}><Database size={12} className="text-purple-500" /> Navbar</p>
              <div className={sec}>
                <p><strong>Connection dropdown</strong> — select a saved connection. {pill('+ New Connection →')} navigates to the Connections page.</p>
                <p><strong>Database dropdown</strong> — select a database. {pill('+ New Database…')} creates one inline without leaving this page.</p>
                <p><span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">PostgreSQL</span> badge only appears for PostgreSQL connections.</p>
              </div>
            </div>

            <div className={div} />

            {/* Designer tab */}
            <div>
              <p className={h3}><Table2 size={12} className="text-blue-500" /> Designer Tab</p>
              <div className={sec}>
                <p><strong>Object tree (left panel)</strong></p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li>{pill('New Schema')} (PostgreSQL only) — adds a schema node; generates <code className="text-[10px]">CREATE SCHEMA IF NOT EXISTS</code> at execute time.</li>
                  <li>{pill('New Table')} — creates a table. For PG, schema is pre-filled from the selected schema node.</li>
                  <li>Hover a schema header → {pill('+')} appears to add a table directly under that schema.</li>
                  <li>Hover a table row → {pill('×')} appears to delete it.</li>
                  <li>Blue link icon on a table = has outgoing FKs. Purple arrow = referenced by other tables.</li>
                </ul>
                <p className="mt-2"><strong>Column editor (right panel)</strong></p>
                <p>Click any table in the tree to edit its columns. Table name and schema are editable inline in the editor header.</p>
              </div>
            </div>

            <div className={div} />

            {/* Column flags */}
            <div>
              <p className={h3}><Columns size={12} className="text-teal-500" /> Column Properties</p>
              <div className="mt-2 space-y-1.5">
                {[
                  ['PK', 'Primary Key', 'Auto-sets NOT NULL + UNIQUE. Row highlighted amber.'],
                  ['NN', 'Not Null', 'Column cannot be NULL.'],
                  ['UQ', 'Unique', 'Adds a UNIQUE constraint.'],
                  ['AI', 'Auto Increment', 'PG: SERIAL/BIGSERIAL. MySQL: AUTO_INCREMENT. Auto-enabled for SERIAL types.'],
                  ['Default', 'Default value', 'Expressions (NOW(), NULL, TRUE) used as-is. Plain strings are quoted.'],
                  ['FK Ref', 'Foreign Key', 'Click "Set FK" to open the relationship picker.'],
                  ['Comment', 'Column comment', 'PG: COMMENT ON COLUMN. MySQL: inline COMMENT in DDL.'],
                ].map(([flag, name, note]) => (
                  <div key={flag} className="flex items-start gap-2">
                    <span className="shrink-0 w-11 text-center inline-block px-1 py-0.5 rounded font-mono text-[10px] font-semibold bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200 border border-gray-200 dark:border-slate-700">{flag}</span>
                    <span className="text-[11px] text-gray-600 dark:text-slate-300"><span className="font-medium text-gray-700 dark:text-slate-200">{name}</span> — {note}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={div} />

            {/* FK Picker */}
            <div>
              <p className={h3}><Link2 size={12} className="text-blue-500" /> FK Relationship Picker</p>
              <div className={sec}>
                <p>Click {pill('Set FK')} in the FK column to open the two-panel picker:</p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li><strong>Left panel</strong> — all other tables in the designer. Click to select one.</li>
                  <li><strong>Right panel</strong> — columns of the selected table. Amber key = PK, purple = Unique.</li>
                  <li>Click a column → FK set as {pill('table.column')}; picker closes automatically.</li>
                  <li>Click the blue FK badge to reopen and change. Click {pill('×')} to remove the FK.</li>
                </ul>
                <p className="mt-1.5">A <strong>Relationship Summary</strong> below the column table shows all outgoing FKs and tables that reference this one.</p>
              </div>
            </div>

            <div className={div} />

            {/* Import */}
            <div>
              <p className={h3}><Upload size={12} className="text-emerald-500" /> Import Tab</p>
              <div className={sec}>
                <ul className="space-y-1.5">
                  <li>{pill('From Database')} — load live schema; expand schemas, check tables, click Import Selected.</li>
                  <li>{pill('From SQL')} — paste or upload a .sql file; parser previews found tables before merging.</li>
                  <li>{pill('From XLSX')} — each sheet becomes one table; column types inferred from data.</li>
                  <li>{pill('From CSV')} — header row = column names; types inferred from sample rows.</li>
                </ul>
                <p className="text-gray-400 dark:text-slate-500 text-[10px] mt-1">Tables with the same schema.name are skipped (merge strategy).</p>
              </div>
            </div>

            <div className={div} />

            {/* Execute */}
            <div>
              <p className={h3}><Play size={12} className="text-rose-500" /> Execute Tab</p>
              <div className={sec}>
                <ul className="space-y-1.5">
                  <li><strong>DDL Preview</strong> — auto-generated CREATE TABLE SQL. Copy or download as .sql.</li>
                  <li><strong>Seed SQL</strong> — optional INSERT statements run after DDL.</li>
                  <li><strong>Execute</strong> — applies DDL + Seed to the selected database. Per-statement log shows results.</li>
                  <li><strong>Save Job</strong> — saves the run as a named job. Load from Job History to restore the full design.</li>
                </ul>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

// ─── New Schema Dialog ────────────────────────────────────────────────────────

function NewSchemaDialog({ onConfirm, onClose }: {
  onConfirm: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const sanitized = name.toLowerCase().replace(/[^a-z0-9_]/g, '');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-80 p-6 space-y-4">
        <div className="flex items-center gap-2">
          <Layers size={15} className="text-blue-500" />
          <h3 className="text-sm font-semibold text-gray-900 dark:text-slate-100">Add Schema</h3>
        </div>
        <div className="space-y-1">
          <label className="text-[11px] text-gray-500 dark:text-slate-400">Schema name (PostgreSQL)</label>
          <input
            ref={ref}
            className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && sanitized) onConfirm(sanitized); if (e.key === 'Escape') onClose(); }}
            placeholder="my_schema"
          />
          {name && name !== sanitized && (
            <p className="text-[10px] text-gray-400 dark:text-slate-500">Will be saved as: <span className="font-mono">{sanitized || '—'}</span></p>
          )}
        </div>
        <div className="flex gap-2 pt-1">
          <button onClick={() => sanitized && onConfirm(sanitized)} disabled={!sanitized}
            className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors">
            Add Schema
          </button>
          <button onClick={onClose} className="flex-1 py-2 rounded-xl border border-gray-200 dark:border-slate-700 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function SchemaDesignerInner() {
  const { authenticated, loading: authLoading } = useAuth();
  const router = useRouter();

  // Connections
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState('');
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [dbError, setDbError] = useState('');

  // New DB dialog
  const [showNewDb, setShowNewDb] = useState(false);
  const [creatingDb, setCreatingDb] = useState(false);
  const [newDbError, setNewDbError] = useState('');

  // Designer state
  const [tables, setTables] = useState<DesignerTable[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('designer');
  const [showNewTable, setShowNewTable] = useState(false);
  const [newTableDefaultSchema, setNewTableDefaultSchema] = useState<string | undefined>(undefined);

  // Schema tree (PG only)
  const [designerSchemas, setDesignerSchemas] = useState<string[]>(['public']);
  const [showNewSchema, setShowNewSchema] = useState(false);

  // Seed + execute state
  const [seedSql, setSeedSql] = useState('');
  const [executing, setExecuting] = useState(false);
  const [execLog, setExecLog] = useState<ExecLogLine[]>([]);
  const [lastRunStatus, setLastRunStatus] = useState<'success' | 'failed' | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);

  // Job history
  const [jobs, setJobs] = useState<SchemaJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const selectedConn = useMemo(() => connections.find(c => c.id === selectedConnId) ?? null, [connections, selectedConnId]);
  const dbType: DbType = selectedConn?.db_type === 'postgres' ? 'postgresql' : 'mysql';
  const selectedTable = tables.find(t => t.id === selectedTableId) ?? null;

  // Load connections
  useEffect(() => {
    if (!authenticated) return;
    axios.get<{ success: boolean; connections: ConnectionRow[] }>('/api/connections', { headers: authH() })
      .then(r => {
        setConnections(r.data.connections);
        if (r.data.connections.length === 1) setSelectedConnId(r.data.connections[0].id);
      })
      .catch(() => { });
  }, [authenticated]);

  // Load databases when connection changes
  const loadDatabases = useCallback(async (conn: ConnectionRow) => {
    setLoadingDbs(true);
    setDbError('');
    setDatabases([]);
    setSelectedDb('');
    try {
      const payload = connToPayload(conn);
      const { data } = await axios.post<{ databases: string[] }>('/api/schema-designer/databases', payload, { headers: authH() });
      setDatabases(data.databases);
      if (data.databases.includes(conn.database_name)) setSelectedDb(conn.database_name);
      else if (data.databases.length) setSelectedDb(data.databases[0]);
    } catch (err) {
      setDbError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to load databases') : 'Failed to load databases');
    } finally {
      setLoadingDbs(false);
    }
  }, []);

  useEffect(() => {
    if (selectedConn) void loadDatabases(selectedConn);
  }, [selectedConn, loadDatabases]);

  const handleCreateDb = async (name: string) => {
    if (!selectedConn) return;
    setCreatingDb(true);
    setNewDbError('');
    try {
      const payload = { ...connToPayload(selectedConn), dbName: name };
      const { data } = await axios.post<{ dbName: string }>('/api/schema-designer/create-db', payload, { headers: authH() });
      await loadDatabases(selectedConn);
      setSelectedDb(data.dbName);
      setShowNewDb(false);
    } catch (err) {
      setNewDbError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to create database') : 'Failed to create database');
    } finally {
      setCreatingDb(false);
    }
  };

  const handleAddSchema = (name: string) => {
    setDesignerSchemas(p => p.includes(name) ? p : [...p, name]);
    setShowNewSchema(false);
  };

  const handleAddTableFor = (schema: string) => {
    setNewTableDefaultSchema(schema);
    setShowNewTable(true);
  };

  const handleAddTable = (name: string, schema: string) => {
    const t = mkTable(name, schema, dbType);
    setTables(p => [...p, t]);
    setSelectedTableId(t.id);
    setShowNewTable(false);
    setNewTableDefaultSchema(undefined);
    if (dbType === 'postgresql') {
      setDesignerSchemas(p => p.includes(schema) ? p : [...p, schema]);
    }
  };

  const handleDeleteTable = (id: string) => {
    setTables(p => p.filter(t => t.id !== id));
    if (selectedTableId === id) setSelectedTableId(null);
  };

  const handleUpdateTable = (updated: DesignerTable) => {
    setTables(p => p.map(t => t.id === updated.id ? updated : t));
  };

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const { data } = await axios.get<{ jobs: SchemaJob[] }>('/api/schema-generator/jobs', { headers: authH() });
      setJobs(data.jobs ?? []);
    } catch { /* ignore */ } finally { setLoadingJobs(false); }
  }, []);

  useEffect(() => { if (authenticated) void loadJobs(); }, [authenticated, loadJobs]);

  const handleExecute = async () => {
    if (!selectedConn || !selectedDb || !tables.length) return;
    setExecuting(true);
    setExecLog([]);
    setLastRunStatus(null);
    const explorerConn = connToExplorerConn(selectedConn, selectedDb);
    const ddlStmts = generateDDL(tables, dbType);
    const seedStmts = seedSql.trim()
      ? seedSql.split(/;\s*(?=\n|$)/).map(s => s.trim()).filter(s => s.length > 0).map(s => s.endsWith(';') ? s : s + ';')
      : [];
    const statements = [...ddlStmts, ...seedStmts];
    try {
      const { data } = await axios.post<{ log: ExecLogLine[] }>('/api/schema-designer/execute', { conn: explorerConn, statements }, { headers: authH() });
      setExecLog(data.log);
      setLastRunStatus(data.log.every(l => l.ok) ? 'success' : 'failed');
      setShowSaveModal(true);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      setExecLog([{ sql: '', ok: false, text: msg }]);
      setLastRunStatus('failed');
      setShowSaveModal(true);
    } finally {
      setExecuting(false);
    }
  };

  const handleSaveJob = async (name: string, desc: string) => {
    const schemaSql = generateDDL(tables, dbType).join('\n\n');
    try {
      await axios.post('/api/schema-generator/jobs', {
        job_name: name,
        description: desc,
        schema_sql: schemaSql,
        seed_sql: seedSql,
        target_database: selectedDb,
        status: lastRunStatus === 'success' ? 'success' : 'failed',
        log: execLog.map((l, i) => ({ step: i + 1, ok: l.ok, text: l.text })),
      }, { headers: authH() });
      void loadJobs();
    } catch { /* ignore */ } finally { setShowSaveModal(false); }
  };

  const handleLoadJob = (job: SchemaJob) => {
    if (job.schema_sql) {
      const parsed = parseSqlToTables(job.schema_sql);
      if (parsed.length) { setTables(parsed); setSelectedTableId(parsed[0].id); }
    }
    setSeedSql(job.seed_sql ?? '');
    setExecLog([]);
    setLastRunStatus(null);
    setActiveTab('designer');
  };

  if (authLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-slate-950">
        <Loader2 size={24} className="animate-spin text-blue-500" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-50 dark:bg-slate-950">
        <div className="text-center space-y-3">
          <p className="text-sm text-gray-500 dark:text-slate-400">Please log in to use Schema Designer.</p>
          <Link href="/" className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors">
            <ArrowLeft size={14} /> Go to Login
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 overflow-hidden">
      <Head><title>Schema Designer — DB Tools</title></Head>

      {/* ── Header ── */}
      <header className="shrink-0 sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-3 flex items-center gap-4">

        {/* Title */}
        <div className="flex items-center gap-3 shrink-0">
          <Columns size={18} className="text-blue-600" />
          <div>
            <h1 className="font-bold text-sm text-gray-900 dark:text-slate-100">Schema Designer</h1>
            <p className="text-xs text-gray-500 dark:text-slate-400">Design tables, import from SQL / XLSX / CSV, and execute DDL</p>
          </div>
        </div>

        <div className="h-8 w-px bg-gray-200 dark:bg-slate-700 shrink-0" />

        {/* Connection selector */}
        <select
          className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 min-w-[200px] focus:outline-none focus:border-blue-400 cursor-pointer"
          value={selectedConnId ?? ''}
          onChange={e => {
            if (e.target.value === '__new_conn__') { void router.push('/connections'); return; }
            setSelectedConnId(e.target.value ? Number(e.target.value) : null);
          }}
        >
          <option value="">— select connection —</option>
          {(['postgres', 'mysql'] as const).map(type => {
            const group = connections.filter(c => c.db_type === type);
            if (!group.length) return null;
            return (
              <optgroup key={type} label={type === 'postgres' ? 'PostgreSQL' : 'MySQL'}>
                {group.map(c => <option key={c.id} value={c.id}>{c.label} ({c.database_name})</option>)}
              </optgroup>
            );
          })}
          <option value="__new_conn__">+ New Connection →</option>
        </select>

        {/* Database selector — includes New Database option */}
        {selectedConn && (
          loadingDbs
            ? <span className="text-xs text-gray-400 dark:text-slate-500 animate-pulse">Loading databases…</span>
            : (
              <select
                className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 min-w-[140px] focus:outline-none focus:border-blue-400 cursor-pointer font-mono"
                value={selectedDb}
                onChange={e => {
                  if (e.target.value === '__new_db__') { setShowNewDb(true); return; }
                  setSelectedDb(e.target.value);
                }}
              >
                {!selectedDb && <option value="">— select db —</option>}
                {databases.map(d => <option key={d} value={d}>{d}</option>)}
                <option value="__new_db__">+ New Database…</option>
              </select>
            )
        )}

        {/* PostgreSQL badge — only shown when connected to PostgreSQL */}
        {selectedConn?.db_type === 'postgres' && (
          <span className="shrink-0 inline-flex items-center px-2 py-1 rounded-md text-[11px] font-medium border bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-900">
            PostgreSQL
          </span>
        )}

        {dbError && <span className="text-xs text-rose-500">{dbError}</span>}

        {/* Breadcrumb */}
        <nav className="ml-auto flex items-center gap-1 text-sm shrink-0">
          <Link href="/" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Home</Link>
          <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
          <span className="px-3 py-1 rounded-lg bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold">Schema Designer</span>
        </nav>
      </header>

      {/* ── Tab bar ── */}
      <div className="shrink-0 flex items-center border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5">
        {([
          { key: 'designer' as ActiveTab, label: 'Designer', Icon: Table2 },
          { key: 'import' as ActiveTab, label: 'Import', Icon: Upload },
          { key: 'execute' as ActiveTab, label: 'Execute', Icon: Play },
        ]).map(({ key, label, Icon }) => (
          <button key={key} onClick={() => setActiveTab(key)}
            className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${activeTab === key ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'}`}>
            <Icon size={13} /> {label}
            {key === 'designer' && tables.length > 0 && (
              <span className="ml-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400">{tables.length}</span>
            )}
          </button>
        ))}
        <div className="ml-auto pr-1 flex items-center">
          <GuidePopover />
        </div>
      </div>

      {/* ── Tab Content ── */}
      <div className="flex-1 overflow-hidden">

        {/* Designer */}
        {activeTab === 'designer' && (
          <div className="flex h-full">
            {/* Table tree */}
            <div className="w-56 shrink-0 border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col">
              <TableTreePanel
                tables={tables}
                selectedId={selectedTableId}
                dbType={dbType}
                schemas={designerSchemas}
                onSelect={setSelectedTableId}
                onDelete={handleDeleteTable}
                onAdd={() => { setNewTableDefaultSchema(undefined); setShowNewTable(true); }}
                onAddSchema={() => setShowNewSchema(true)}
                onAddTableFor={handleAddTableFor}
              />
            </div>

            {/* Column editor */}
            <div className="flex-1 overflow-hidden bg-white dark:bg-slate-900">
              {selectedTable ? (
                <ColumnEditorPanel
                  table={selectedTable}
                  tables={tables}
                  dbType={dbType}
                  onUpdate={handleUpdateTable}
                  onDeleteTable={() => handleDeleteTable(selectedTable.id)}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-3">
                  <Columns size={36} className="text-gray-200 dark:text-slate-700" />
                  <p className="text-sm text-gray-400 dark:text-slate-500">
                    {tables.length === 0 ? 'Add a table to get started.' : 'Select a table to edit its columns.'}
                  </p>
                  <button onClick={() => setShowNewTable(true)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 transition-colors">
                    <Plus size={13} /> Add Table
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Import */}
        {activeTab === 'import' && (
          <ImportPanel
            conn={selectedConn}
            selectedDb={selectedDb}
            dbType={dbType}
            onMerge={incoming => setTables(p => mergeTables(p, incoming))}
          />
        )}

        {/* Execute */}
        {activeTab === 'execute' && (
          <ExecutePanel
            tables={tables}
            conn={selectedConn}
            selectedDb={selectedDb}
            dbType={dbType}
            seedSql={seedSql}
            onSeedSqlChange={setSeedSql}
            executing={executing}
            execLog={execLog}
            onExecute={() => void handleExecute()}
            lastRunStatus={lastRunStatus}
            onSaveJob={() => setShowSaveModal(true)}
            jobs={jobs}
            loadingJobs={loadingJobs}
            onLoadJob={handleLoadJob}
          />
        )}
      </div>

      {/* Dialogs */}
      {showNewTable && (
        <NewTableDialog
          dbType={dbType}
          defaultSchema={newTableDefaultSchema}
          onConfirm={handleAddTable}
          onClose={() => { setShowNewTable(false); setNewTableDefaultSchema(undefined); }}
        />
      )}
      {showNewSchema && (
        <NewSchemaDialog
          onConfirm={handleAddSchema}
          onClose={() => setShowNewSchema(false)}
        />
      )}
      {showNewDb && (
        <NewDbDialog
          dbType={dbType}
          onConfirm={handleCreateDb}
          onClose={() => { setShowNewDb(false); setNewDbError(''); }}
          creating={creatingDb}
          error={newDbError}
        />
      )}
      {showSaveModal && (
        <SaveJobModal
          onSave={(name, desc) => void handleSaveJob(name, desc)}
          onSkip={() => setShowSaveModal(false)}
        />
      )}
    </div>
  );
}

export default function SchemaDesigner() {
  return <SchemaDesignerInner />;
}
