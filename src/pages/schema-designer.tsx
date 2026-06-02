'use client';
import Head from 'next/head';
import Link from 'next/link';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  ArrowLeft, Database, Plus, Trash2, Table2, Upload, Play, Copy,
  Check, RefreshCw, FileSpreadsheet, FileCode2, FileText, CheckCircle2,
  XCircle, Loader2, X, ChevronRight, ChevronLeft, ChevronDown, ChevronUp, Download,
  Columns, Sprout, Save, Clock,
  FolderOpen, KeyRound, Link2, Fingerprint, Hash, Layers, Info, HelpCircle, BookOpen,
  Network, Pencil,
} from 'lucide-react';
import {
  ReactFlow, Background, Controls,
  useNodesState, useEdgesState,
  BaseEdge, getSmoothStepPath,
  Handle, Position, type Node, type Edge, type EdgeProps,
  useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useAlert } from '../lib/alert-context';
import type { ConnectionRow } from './api/connections/index';
import type { ExplorerConn } from '../lib/explorer-db';
import type { SchemaInfo } from './api/schema-explorer/schemas';
import type { TableInfo } from './api/schema-explorer/tables';
import type { ColumnInfo, TableColumnsResult } from './api/schema-explorer/columns';
import type { SchemaJob } from './api/schema-generator/jobs';
import { parseExcelFile } from '../lib/excel-parser';
import { generateOrm, type OrmTarget, type OrmTableDef, type OrmColDef } from '../lib/orm-generator';

// ─── Types ────────────────────────────────────────────────────────────────────

type DbType = 'postgresql' | 'mysql';

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
  // Refactor mode: original DB name (pre-rename snapshot); constraint names for DROP
  _originalName?: string;
  _fkConstraintName?: string;
  _uniqueConstraintName?: string;
}

interface DesignerTable {
  id: string;
  schema: string;
  name: string;
  columns: DesignerColumn[];
  // Refactor mode: original DB name (pre-rename snapshot)
  _originalName?: string;
}

interface ExecLogLine {
  sql: string;
  ok: boolean;
  text: string;
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


const NEEDS_LENGTH = new Set(['VARCHAR', 'CHAR', 'NUMERIC', 'DECIMAL']);

// ─── Pure Helpers ─────────────────────────────────────────────────────────────


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

// ─── ALTER DDL diff (Refactor mode) ──────────────────────────────────────────

function generateAlterDDL(original: DesignerTable[], current: DesignerTable[], dbType: DbType): string[] {
  const stmts: string[] = [];
  const origById = new Map(original.map(t => [t.id, t]));
  const curById  = new Map(current.map(t => [t.id, t]));

  // Drop tables removed in current
  for (const orig of original) {
    if (!curById.has(orig.id)) {
      const oName = orig._originalName ?? orig.name;
      stmts.push(`DROP TABLE IF EXISTS ${qi(orig.schema || 'public', dbType)}.${qi(oName, dbType)};`);
    }
  }

  // Alter existing + create new tables
  for (const cur of current) {
    const orig = origById.get(cur.id);
    const schema = cur.schema || 'public';
    const sq = qi(schema, dbType);

    if (!orig) {
      // New table — emit full CREATE TABLE
      const ddl = generateDDL([cur], dbType);
      stmts.push(...ddl);
      continue;
    }

    const origTableName = orig._originalName ?? orig.name;
    let curTableName = cur.name; // may have been renamed

    // Rename table
    if (origTableName !== cur.name) {
      if (dbType === 'postgresql') {
        stmts.push(`ALTER TABLE ${sq}.${qi(origTableName, dbType)} RENAME TO ${qi(cur.name, dbType)};`);
      } else {
        stmts.push(`RENAME TABLE ${qi(origTableName, dbType)} TO ${qi(cur.name, dbType)};`);
      }
      curTableName = cur.name;
    }

    const tq = `${sq}.${qi(curTableName, dbType)}`;
    const origColById = new Map(orig.columns.map(c => [c.id, c]));
    const curColById  = new Map(cur.columns.map(c => [c.id, c]));

    // Drop removed columns
    for (const oc of orig.columns) {
      if (!curColById.has(oc.id)) {
        stmts.push(`ALTER TABLE ${tq} DROP COLUMN IF EXISTS ${qi(oc._originalName ?? oc.name, dbType)};`);
      }
    }

    for (const cc of cur.columns) {
      const oc = origColById.get(cc.id);

      if (!oc) {
        // New column
        const type = resolveType(cc, dbType);
        const notNull = (!cc.nullable || cc.isPk) ? ' NOT NULL' : '';
        const def = cc.defaultValue ? ` DEFAULT ${/^(NOW|CURRENT_TIMESTAMP|NULL|TRUE|FALSE|\d+)\b/i.test(cc.defaultValue) || cc.defaultValue.includes('()') ? cc.defaultValue : `'${cc.defaultValue}'`}` : '';
        stmts.push(`ALTER TABLE ${tq} ADD COLUMN ${qi(cc.name, dbType)} ${type}${notNull}${def};`);
        if (cc.isUnique && !cc.isPk) stmts.push(`ALTER TABLE ${tq} ADD UNIQUE (${qi(cc.name, dbType)});`);
        if (cc.fkRef) {
          const [rt, rc] = cc.fkRef.split('.');
          if (rt && rc) stmts.push(`ALTER TABLE ${tq} ADD FOREIGN KEY (${qi(cc.name, dbType)}) REFERENCES ${qi(rt, dbType)}(${qi(rc, dbType)});`);
        }
        continue;
      }

      const ocName = oc._originalName ?? oc.name;

      // Rename column
      if (ocName !== cc.name) {
        if (dbType === 'postgresql') {
          stmts.push(`ALTER TABLE ${tq} RENAME COLUMN ${qi(ocName, dbType)} TO ${qi(cc.name, dbType)};`);
        } else {
          stmts.push(`ALTER TABLE ${tq} CHANGE ${qi(ocName, dbType)} ${qi(cc.name, dbType)} ${resolveType(cc, dbType)};`);
        }
      }

      // Type change (PG only — MySQL uses MODIFY which needs full col spec)
      const origType = resolveType(oc, dbType);
      const curType  = resolveType(cc, dbType);
      if (origType !== curType) {
        if (dbType === 'postgresql') {
          stmts.push(`ALTER TABLE ${tq} ALTER COLUMN ${qi(cc.name, dbType)} TYPE ${curType} USING ${qi(cc.name, dbType)}::${curType};`);
        } else if (ocName === cc.name) {
          // MySQL MODIFY handles type + nullability + default in one statement
          const notNull = (!cc.nullable || cc.isPk) ? ' NOT NULL' : '';
          const def = cc.defaultValue ? ` DEFAULT ${/^(NOW|CURRENT_TIMESTAMP|NULL|TRUE|FALSE|\d+)\b/i.test(cc.defaultValue) || cc.defaultValue.includes('()') ? cc.defaultValue : `'${cc.defaultValue}'`}` : '';
          stmts.push(`ALTER TABLE ${tq} MODIFY COLUMN ${qi(cc.name, dbType)} ${curType}${notNull}${def};`);
        }
      }

      // NOT NULL toggle (PG only — MySQL handled via MODIFY above)
      if (dbType === 'postgresql' && oc.nullable !== cc.nullable && origType === curType) {
        stmts.push(`ALTER TABLE ${tq} ALTER COLUMN ${qi(cc.name, dbType)} ${cc.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'};`);
      }

      // Default change
      if (oc.defaultValue !== cc.defaultValue) {
        if (cc.defaultValue) {
          const dv = /^(NOW|CURRENT_TIMESTAMP|NULL|TRUE|FALSE|\d+)\b/i.test(cc.defaultValue) || cc.defaultValue.includes('()') ? cc.defaultValue : `'${cc.defaultValue}'`;
          stmts.push(`ALTER TABLE ${tq} ALTER COLUMN ${qi(cc.name, dbType)} SET DEFAULT ${dv};`);
        } else {
          stmts.push(`ALTER TABLE ${tq} ALTER COLUMN ${qi(cc.name, dbType)} DROP DEFAULT;`);
        }
      }

      // UNIQUE: drop if removed
      if (oc.isUnique && !cc.isUnique && !cc.isPk) {
        if (oc._uniqueConstraintName) {
          stmts.push(`ALTER TABLE ${tq} DROP CONSTRAINT ${qi(oc._uniqueConstraintName, dbType)};`);
        } else if (dbType === 'mysql') {
          stmts.push(`ALTER TABLE ${tq} DROP INDEX ${qi(cc.name, dbType)};`);
        }
      }
      // UNIQUE: add if new
      if (!oc.isUnique && cc.isUnique && !cc.isPk) {
        stmts.push(`ALTER TABLE ${tq} ADD UNIQUE (${qi(cc.name, dbType)});`);
      }

      // FK: drop if removed or changed
      if (oc.fkRef && oc.fkRef !== cc.fkRef) {
        if (oc._fkConstraintName) {
          stmts.push(`ALTER TABLE ${tq} DROP CONSTRAINT ${qi(oc._fkConstraintName, dbType)};`);
        } else if (dbType === 'mysql') {
          stmts.push(`-- DROP FOREIGN KEY on ${cc.name}: constraint name unknown, check INFORMATION_SCHEMA`);
        }
      }
      // FK: add if new or changed
      if (cc.fkRef && cc.fkRef !== oc.fkRef) {
        const [rt, rc] = cc.fkRef.split('.');
        if (rt && rc) stmts.push(`ALTER TABLE ${tq} ADD FOREIGN KEY (${qi(cc.name, dbType)}) REFERENCES ${qi(rt, dbType)}(${qi(rc, dbType)});`);
      }
    }
  }

  return stmts;
}

// ─── Merge helper ─────────────────────────────────────────────────────────────

function mergeTables(existing: DesignerTable[], incoming: DesignerTable[]): DesignerTable[] {
  const existingKeys = new Set(existing.map(t => `${t.schema}.${t.name}`));
  return [...existing, ...incoming.filter(t => !existingKeys.has(`${t.schema}.${t.name}`))];
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

function JobRunCard({ job }: { job: SchemaJob }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`rounded-lg border text-xs overflow-hidden ${job.status === 'success' ? 'border-emerald-200 dark:border-emerald-800/60' : job.status === 'failed' ? 'border-rose-200 dark:border-rose-800/60' : 'border-gray-200 dark:border-slate-700'}`}>
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={`shrink-0 inline-flex px-1.5 py-0.5 rounded font-semibold text-[10px] ${job.status === 'success' ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400' : job.status === 'failed' ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400' : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300'}`}>{job.status}</span>
        <span className="flex items-center gap-1 text-gray-400 dark:text-slate-500 shrink-0"><Clock size={9} />{timeAgo(job.created_at)}</span>
        {job.target_database && <span className="text-gray-500 dark:text-slate-400 truncate flex-1">{job.target_database}</span>}
        <div className="flex items-center gap-1 ml-auto shrink-0">
          {job.log && job.log.length > 0 && (
            <button onClick={() => setExpanded(v => !v)} className="p-0.5 text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors">
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

function JobGroupCard({ group, onLoad, onRename, onDelete, isActive }: {
  group: JobGroup;
  onLoad: (j: SchemaJob) => void;
  onRename?: (oldName: string, newName: string) => void;
  onDelete?: (jobName: string) => void;
  isActive?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const latest = group.runs[0];
  const hasFailure = group.runs.some(r => r.status === 'failed');
  const allSuccess = group.runs.every(r => r.status === 'success');

  const commitRename = () => {
    if (renameVal.trim() && renameVal.trim() !== group.job_name) onRename?.(group.job_name, renameVal.trim());
    setRenaming(false);
  };

  const statusLabel = allSuccess ? 'success' : hasFailure ? 'failed' : latest.status;
  const statusCls = allSuccess
    ? 'bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400'
    : hasFailure
    ? 'bg-rose-100 dark:bg-rose-950/60 text-rose-700 dark:text-rose-400'
    : 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300';

  return (
    <div className={`rounded-lg border p-2 transition-colors ${isActive ? 'border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/20' : 'border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800/50'}`}>
      {/* Row 1: name + run count */}
      <div className="flex items-start gap-1 mb-0.5">
        {renaming ? (
          <input
            autoFocus
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false); }}
            className="flex-1 text-[11px] font-medium bg-white dark:bg-slate-700 border border-blue-400 rounded px-1 py-0.5 text-gray-800 dark:text-slate-200 outline-none"
          />
        ) : (
          <p className="text-[11px] font-medium text-gray-800 dark:text-slate-200 flex-1 truncate">{group.job_name}</p>
        )}
        {renaming ? (
          <div className="flex items-center gap-0.5 shrink-0">
            <button onClick={commitRename} className="p-0.5 rounded text-emerald-500 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors"><Check size={11} /></button>
            <button onClick={() => setRenaming(false)} className="p-0.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-slate-700 transition-colors"><X size={11} /></button>
          </div>
        ) : (
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${statusCls}`}>{statusLabel}</span>
        )}
      </div>
      {/* Row 2: description */}
      {latest.description && (
        <p className="text-[10px] text-gray-400 dark:text-slate-500 truncate mb-0.5">{latest.description}</p>
      )}
      {/* Row 3: runs count + date + expand */}
      <div className="flex items-center gap-1 mb-1.5">
        <p className="text-[10px] text-gray-400 dark:text-slate-500 flex-1">
          {group.runs.length} run{group.runs.length !== 1 ? 's' : ''} · {timeAgo(latest.created_at)}
          {latest.target_database && <span className="ml-1 font-mono">· {latest.target_database}</span>}
        </p>
        <button
          onClick={() => setExpanded(v => !v)}
          className="flex items-center gap-0.5 text-[10px] text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
        >
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>
      {/* Expanded: run list */}
      {expanded && (
        <div className="mb-1.5 border border-gray-100 dark:border-slate-700 rounded overflow-hidden space-y-px">
          {group.runs.map(run => <JobRunCard key={run.id} job={run} />)}
        </div>
      )}
      {/* Row 4: actions */}
      <div className="flex items-center gap-1">
        {isActive && (
          <span className="text-[9px] px-1 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400 font-medium">active</span>
        )}
        <button
          onClick={() => onLoad(latest)}
          title="Load latest schema into designer"
          className="ml-auto px-2 py-0.5 rounded text-[10px] font-medium bg-white dark:bg-slate-700 border border-gray-200 dark:border-slate-600 text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-600 transition-colors"
        >
          Load
        </button>
        {onRename && (
          <button
            onClick={() => { setRenameVal(group.job_name); setRenaming(true); }}
            title="Rename job"
            className="p-1 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors"
          >
            <Pencil size={11} />
          </button>
        )}
        {onDelete && (
          <button
            onClick={() => onDelete(group.job_name)}
            title="Delete job"
            className="p-1 rounded text-gray-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30 transition-colors"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Save Job Modal ───────────────────────────────────────────────────────────

function SaveJobModal({ onSave, onSkip, defaultName, defaultDesc }: {
  onSave: (name: string, desc: string) => void;
  onSkip: () => void;
  defaultName?: string;
  defaultDesc?: string;
}) {
  const [name, setName] = useState(defaultName ?? '');
  const [desc, setDesc] = useState(defaultDesc ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const isUpdate = !!defaultName && name.trim() === defaultName.trim();
  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800">
          <div className="flex items-center gap-2"><Save size={15} className="text-blue-500" /><p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">Save Job Record</p></div>
          <button onClick={onSkip} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          {defaultName && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-xs text-blue-700 dark:text-blue-400">
              <FolderOpen size={12} />
              <span>Loaded from <strong>{defaultName}</strong> — saving with the same name adds a new revision.</span>
            </div>
          )}
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
            <Save size={13} /> {isUpdate ? 'Save Revision' : 'Save'}
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

// ─── Column Header Tooltip ────────────────────────────────────────────────────

function ColHeaderTip({ label, desc, example, align = 'center' }: {
  label: string; desc: string; example?: string; align?: 'left' | 'center' | 'right';
}) {
  const [show, setShow] = useState(false);
  const left = align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2';
  return (
    <span
      className="relative inline-flex items-center gap-1 cursor-default select-none"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {label}
      <Info size={8} className="text-gray-300 dark:text-slate-600 shrink-0" />
      {show && (
        <div className={`absolute top-full ${left} mt-1.5 z-[200] w-56 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-lg shadow-2xl p-2.5 text-left pointer-events-none`}>
          <p className="text-[10px] leading-relaxed text-gray-600 dark:text-slate-300">{desc}</p>
          {example && (
            <code className="mt-1.5 block text-[10px] font-mono bg-gray-50 dark:bg-slate-900 text-emerald-600 dark:text-emerald-400 px-2 py-1 rounded border border-gray-100 dark:border-slate-700 whitespace-pre">
              {example}
            </code>
          )}
        </div>
      )}
    </span>
  );
}

// ─── ERD Preview ──────────────────────────────────────────────────────────────

const ERD_ROW_H = 26, ERD_BASE_H = 52;
const ERD_COL_W = 260, ERD_H_GAP = 120, ERD_V_GAP = 48;

function erdNodeHeight(cols: number) { return ERD_BASE_H + cols * ERD_ROW_H; }

function buildDesignerErd(tables: DesignerTable[]): { nodes: Node[]; edges: Edge[] } {
  const byName = new Map(tables.map(t => [t.name, t]));
  const nodes: Node[] = tables.map(t => ({
    id: t.name,
    type: 'designerTable',
    position: { x: 0, y: 0 },
    data: { label: t.schema !== 'public' ? `${t.schema}.${t.name}` : t.name, columns: t.columns },
  }));
  const edgeSet = new Set<string>();
  const edges: Edge[] = [];
  tables.forEach(t => {
    t.columns.forEach(col => {
      if (!col.fkRef) return;
      const [targetName] = col.fkRef.split('.');
      if (!byName.has(targetName) || targetName === t.name) return;
      const eid = `${t.name}→${targetName}`;
      if (edgeSet.has(eid)) return;
      edgeSet.add(eid);
      edges.push({
        id: eid, source: t.name, target: targetName,
        type: 'designerCrowsFoot',
        data: { isOneToOne: col.isUnique },
      });
    });
  });
  return { nodes, edges };
}

function computeDesignerErdLayout(nodes: Node[], edges: Edge[]): Map<string, { x: number; y: number }> {
  const outCount = new Map(nodes.map(n => [n.id, 0]));
  edges.forEach(e => outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1));
  const roots = nodes.filter(n => outCount.get(n.id) === 0).map(n => n.id);
  if (roots.length === 0) nodes.forEach(n => roots.push(n.id));
  const revAdj = new Map(nodes.map(n => [n.id, [] as string[]]));
  edges.forEach(e => revAdj.get(e.target)?.push(e.source));
  const level = new Map<string, number>(roots.map(r => [r, 0]));
  const queue = [...roots];
  while (queue.length) {
    const curr = queue.shift()!;
    for (const next of revAdj.get(curr) ?? []) {
      if (!level.has(next)) { level.set(next, (level.get(curr) ?? 0) + 1); queue.push(next); }
    }
  }
  nodes.forEach(n => { if (!level.has(n.id)) level.set(n.id, 0); });
  const byLevel = new Map<number, string[]>();
  nodes.forEach(n => { const l = level.get(n.id)!; byLevel.set(l, [...(byLevel.get(l) ?? []), n.id]); });
  const positioned = new Map<string, { x: number; y: number }>();
  let px = 0;
  [...byLevel.keys()].sort((a, b) => a - b).forEach(l => {
    const ids = byLevel.get(l)!;
    const heights = ids.map(id => erdNodeHeight((nodes.find(n => n.id === id)?.data as { columns: DesignerColumn[] })?.columns?.length ?? 5));
    const total = heights.reduce((s, h) => s + h + ERD_V_GAP, -ERD_V_GAP);
    let py = -total / 2;
    ids.forEach((id, i) => { positioned.set(id, { x: px, y: py }); py += heights[i] + ERD_V_GAP; });
    px += ERD_COL_W + ERD_H_GAP;
  });
  return positioned;
}

function DesignerErdCrowsFoot({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [edgePath] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 12 });
  const isOneToOne = Boolean((data as Record<string, unknown>)?.isOneToOne);
  const color = '#3b82f6';
  const manyId = `dcfm-${id}`, oneId = `dcfo-${id}`;
  return (
    <g>
      <defs>
        <marker id={manyId} markerWidth="20" markerHeight="12" refX="1" refY="6" orient="auto" markerUnits="userSpaceOnUse">
          <line x1="1" y1="0" x2="1" y2="12" stroke={color} strokeWidth="1.5" />
          <path d="M3,6 L18,0 M3,6 L18,12 M3,6 L18,6" stroke={color} strokeWidth="1.5" fill="none" />
        </marker>
        <marker id={oneId} markerWidth="8" markerHeight="12" refX="0" refY="6" orient="auto" markerUnits="userSpaceOnUse">
          <line x1="2" y1="0" x2="2" y2="12" stroke={color} strokeWidth="1.5" />
        </marker>
      </defs>
      <BaseEdge id={id} path={edgePath} style={{ stroke: color, strokeWidth: 1.5 }}
        markerStart={`url(#${isOneToOne ? oneId : manyId})`} markerEnd={`url(#${oneId})`} />
    </g>
  );
}

function DesignerErdTableNode({ data }: { data: { label: string; columns: DesignerColumn[] } }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg shadow-md min-w-[220px] text-xs overflow-hidden">
      <Handle type="target" position={Position.Left} className="!bg-blue-500" />
      <Handle type="source" position={Position.Right} className="!bg-blue-500" />
      <div className="bg-blue-600 dark:bg-blue-700 text-white px-3 py-1.5 font-semibold text-[11px] tracking-wide truncate">
        {data.label}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-700">
        {data.columns.map(col => (
          <div key={col.id} className="flex items-center gap-1.5 px-3 py-1 hover:bg-gray-50 dark:hover:bg-slate-700/50">
            <span className="shrink-0 w-8 text-[10px] font-bold">
              {col.isPk ? <span className="text-amber-500">PK</span> : col.fkRef ? <span className="text-blue-500">FK</span> : <span className="text-gray-300 dark:text-slate-600">—</span>}
            </span>
            <span className="font-medium text-gray-800 dark:text-slate-200 truncate flex-1">{col.name}</span>
            <span className="text-gray-400 dark:text-slate-500 shrink-0 text-[10px]">{col.type}{col.length ? `(${col.length})` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const designerErdNodeTypes = { designerTable: DesignerErdTableNode };
const designerErdEdgeTypes = { designerCrowsFoot: DesignerErdCrowsFoot };

function ErdPreviewInner({ tables, onClose }: { tables: DesignerTable[]; onClose: () => void }) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    const { nodes: n, edges: e } = buildDesignerErd(tables);
    const pos = computeDesignerErdLayout(n, e);
    setNodes(n.map(node => ({ ...node, position: pos.get(node.id) ?? { x: 0, y: 0 } })));
    setEdges(e);
    setTimeout(() => fitView({ padding: 0.12, duration: 300 }), 80);
  }, [tables, fitView, setNodes, setEdges]);

  return (
    <div className="fixed inset-0 z-[300] flex flex-col bg-black/60 backdrop-blur-sm">
      <div className="flex items-center gap-3 px-5 py-3 bg-white dark:bg-slate-900 border-b border-gray-200 dark:border-slate-800 shrink-0">
        <Network size={15} className="text-blue-500" />
        <span className="font-semibold text-sm text-gray-800 dark:text-slate-100">ERD Preview</span>
        <span className="text-[11px] text-gray-400 dark:text-slate-500">{tables.length} table{tables.length !== 1 ? 's' : ''}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={onClose}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
          >
            <X size={12} /> Back to Designer
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        <ReactFlow
          nodes={nodes} edges={edges}
          onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
          nodeTypes={designerErdNodeTypes} edgeTypes={designerErdEdgeTypes}
          fitView minZoom={0.05} maxZoom={2}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      {tables.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-gray-400 dark:text-slate-500 text-sm">No tables to preview — add tables in the designer first.</p>
        </div>
      )}
    </div>
  );
}

function ErdPreviewModal({ tables, onClose }: { tables: DesignerTable[]; onClose: () => void }) {
  return (
    <ReactFlowProvider>
      <ErdPreviewInner tables={tables} onClose={onClose} />
    </ReactFlowProvider>
  );
}

// ─── Column Editor Panel ───────────────────────────────────────────────────────

function ColumnEditorPanel({ table, tables, onUpdate, onDeleteTable }: {
  table: DesignerTable;
  tables: DesignerTable[];
  onUpdate: (t: DesignerTable) => void;
  onDeleteTable: () => void;
}) {
  const types = PG_TYPES;
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
        <span className="ml-auto text-[11px] text-gray-400 dark:text-slate-500">{table.columns.length} column{table.columns.length !== 1 ? 's' : ''}</span>
        <button onClick={onDeleteTable} title="Delete table" className="p-1 text-gray-300 dark:text-slate-600 hover:text-rose-500 dark:hover:text-rose-400 transition-colors">
          <Trash2 size={13} />
        </button>
      </div>

      {/* Column table + Add Column + FK — all scroll together */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-[11px] border-collapse" style={{ minWidth: 880 }}>
          <thead className="sticky top-0 z-10">
            <tr className="text-left text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider bg-gray-50 dark:bg-slate-800/60">
              <th className="px-3 py-2 w-36">Name</th>
              <th className="px-3 py-2 w-32 overflow-visible">
                <ColHeaderTip label="Type" align="left"
                  desc="PostgreSQL column data type. SERIAL / BIGSERIAL / SMALLSERIAL types auto-enable Auto Increment."
                  example={"TEXT  INTEGER  UUID\nBIGSERIAL  TIMESTAMPTZ"} />
              </th>
              <th className="px-3 py-2 w-20">Length</th>
              <th className="px-3 py-2 text-center w-9 overflow-visible">
                <ColHeaderTip label="PK" align="center"
                  desc="Primary Key — uniquely identifies each row. Automatically sets Not Null + Unique. Row is highlighted amber."
                  example={"id BIGSERIAL PRIMARY KEY"} />
              </th>
              <th className="px-3 py-2 text-center w-9 overflow-visible">
                <ColHeaderTip label="NN" align="center"
                  desc="Not Null — the column must always have a value; NULL is rejected."
                  example={"name TEXT NOT NULL"} />
              </th>
              <th className="px-3 py-2 text-center w-9 overflow-visible">
                <ColHeaderTip label="UQ" align="center"
                  desc="Unique — no two rows may share the same value in this column."
                  example={"email TEXT UNIQUE"} />
              </th>
              <th className="px-3 py-2 text-center w-9 overflow-visible">
                <ColHeaderTip label="AI" align="center"
                  desc="Auto Increment — value is generated automatically on insert (SERIAL / BIGSERIAL). Usually paired with PK."
                  example={"id SERIAL  →  1, 2, 3…"} />
              </th>
              <th className="px-3 py-2 w-28">Default</th>
              <th className="px-3 py-2 w-40 overflow-visible">
                <ColHeaderTip label="FK Reference" align="right"
                  desc="Foreign Key — references a primary key column in another table. Click 'Set FK' to use the visual picker."
                  example={"user_id → users.id"} />
              </th>
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

        {/* Add Column — right-aligned, immediately after last row */}
        <div className="flex justify-end px-4 py-2.5 border-t border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900">
          <button onClick={addCol} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors">
            <Plus size={11} /> Add Column
          </button>
        </div>

        {/* FK Relationships summary */}
        {(fkCols.length > 0 || incomingFks.length > 0) && (
          <div className="px-5 py-3 border-t border-gray-100 dark:border-slate-800 bg-gray-50/50 dark:bg-slate-900/40 space-y-2.5">
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

function TableTreePanel({ tables, selectedId, schemas, onSelect, onDelete, onAddTableFor, allowAddTable = true }: {
  tables: DesignerTable[];
  selectedId: string | null;
  schemas: string[];
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onAddTableFor: (schema: string) => void;
  allowAddTable?: boolean;
}) {
  const grouped = useMemo(() => {
    const m = new Map<string, DesignerTable[]>();
    for (const s of schemas) { if (!m.has(s)) m.set(s, []); }
    for (const t of tables) {
      const key = t.schema || 'public';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(t);
    }
    return m;
  }, [tables, schemas]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['public', '']));
  const toggleSchema = (s: string) => setExpanded(p => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });

  return (
    <div className="flex flex-col h-full">
      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {Array.from(grouped.entries()).map(([schema, schemaTables]) => (
          <div key={schema}>
            {/* Schema header */}
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
              {allowAddTable && (
                <button
                  onClick={() => onAddTableFor(schema)}
                  title={`Add table to ${schema}`}
                  className="opacity-0 group-hover/schema:opacity-100 p-1.5 mr-1 text-gray-400 hover:text-blue-500 dark:text-slate-500 dark:hover:text-blue-400 transition-all shrink-0"
                >
                  <Plus size={11} />
                </button>
              )}
            </div>

            {/* Tables under schema */}
            {expanded.has(schema) && (
              <>
                {schemaTables.length === 0 && (
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
                      className={`group flex items-center gap-2 py-1.5 pl-7 pr-2 cursor-pointer transition-colors
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

function ImportPanel({ connections, onMerge }: {
  connections: ConnectionRow[];
  onMerge: (tables: DesignerTable[]) => void;
}) {
  // SQL import
  const [sqlText, setSqlText] = useState('');
  const [sqlParsed, setSqlParsed] = useState<DesignerTable[]>([]);
  const sqlFileRef = useRef<HTMLInputElement>(null);

  const parseSql = () => { setSqlParsed(parseSqlToTables(sqlText)); };

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

  // From DB — own connection/db picker
  const [importConnId, setImportConnId] = useState<number | null>(null);
  const [importDbs, setImportDbs] = useState<string[]>([]);
  const [importDb, setImportDb] = useState('');
  const [loadingImportDbs, setLoadingImportDbs] = useState(false);
  const importConn = connections.find(c => c.id === importConnId) ?? null;

  const loadImportDbs = useCallback(async (conn: ConnectionRow) => {
    setLoadingImportDbs(true);
    setImportDbs([]);
    setImportDb('');
    try {
      const { data } = await axios.post<{ databases: string[] }>('/api/schema-designer/databases', connToPayload(conn));
      setImportDbs(data.databases);
      if (data.databases.length) setImportDb(data.databases[0]);
    } catch { /* ignore */ } finally { setLoadingImportDbs(false); }
  }, []);

  useEffect(() => {
    if (importConn) void loadImportDbs(importConn);
  }, [importConn, loadImportDbs]);

  const [dbSchemas, setDbSchemas] = useState<SchemaInfo[]>([]);
  const [dbTables, setDbTables] = useState<Record<string, TableInfo[]>>({});
  const [dbExpanded, setDbExpanded] = useState<Set<string>>(new Set());
  const [dbSelected, setDbSelected] = useState<Set<string>>(new Set());
  const [loadingDbSchema, setLoadingDbSchema] = useState(false);
  const [importingFromDb, setImportingFromDb] = useState(false);

  const loadDbSchemas = useCallback(async () => {
    if (!importConn || !importDb) return;
    setLoadingDbSchema(true);
    setDbSchemas([]);
    setDbTables({});
    try {
      const explorerConn = connToExplorerConn(importConn, importDb);
      const { data } = await axios.post<{ schemas: SchemaInfo[] }>('/api/schema-explorer/schemas', explorerConn);
      setDbSchemas(data.schemas);
    } catch { /* ignore */ } finally { setLoadingDbSchema(false); }
  }, [importConn, importDb]);

  const loadDbTables = async (schema: string) => {
    if (!importConn || !importDb || dbTables[schema]) return;
    try {
      const explorerConn = connToExplorerConn(importConn, importDb);
      const { data } = await axios.post<{ tables: TableInfo[] }>('/api/schema-explorer/tables', { conn: explorerConn, schemas: [schema] });
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
    if (!importConn || !importDb || !dbSelected.size) return;
    setImportingFromDb(true);
    const explorerConn = connToExplorerConn(importConn, importDb);
    const imported: DesignerTable[] = [];
    for (const key of dbSelected) {
      try {
        const { data } = await axios.post<TableColumnsResult>('/api/schema-explorer/columns', { conn: explorerConn, tableKey: key });
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
      <div className={sectionClass}>
        <div className={sectionHeaderClass}>
          <Database size={14} className="text-blue-500" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-semibold text-gray-700 dark:text-slate-200">From Database</p>
            <p className="text-[11px] text-gray-400 dark:text-slate-500">Import existing tables as designer definitions</p>
          </div>
        </div>
        {/* Connection + DB picker */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900 flex-wrap">
          <select
            value={importConnId ?? ''}
            onChange={e => setImportConnId(e.target.value ? Number(e.target.value) : null)}
            className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 min-w-[160px] focus:outline-none focus:border-blue-400 cursor-pointer"
          >
            <option value="">— select connection —</option>
            {connections.filter(c => c.db_type === 'postgres').map(c => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          {importConn && (
            loadingImportDbs
              ? <span className="text-xs text-gray-400 animate-pulse">Loading…</span>
              : (
                <select
                  value={importDb}
                  onChange={e => { setImportDb(e.target.value); setDbSchemas([]); setDbTables({}); }}
                  className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 min-w-[120px] focus:outline-none focus:border-blue-400 cursor-pointer font-mono"
                >
                  {importDbs.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              )
          )}
          {importConn && importDb && (
            <button onClick={() => void loadDbSchemas()} disabled={loadingDbSchema}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors">
              {loadingDbSchema ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              Load Schemas
            </button>
          )}
          {!importConn && <span className="text-[11px] text-gray-400 dark:text-slate-500">Select a PostgreSQL connection to browse tables.</span>}
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

function ExecutePanel({ tables, seedSql, onSeedSqlChange, onSaveJob, jobs, loadingJobs, onLoadJob, onExecuteJob }: {
  tables: DesignerTable[];
  seedSql: string;
  onSeedSqlChange: (v: string) => void;
  onSaveJob: () => void;
  jobs: SchemaJob[];
  loadingJobs: boolean;
  onLoadJob: (j: SchemaJob) => void;
  onExecuteJob: (j: SchemaJob) => void;
}) {
  const ddlText = useMemo(() => generateDDL(tables, 'postgresql').join('\n\n'), [tables]);
  const [copied, setCopied] = useState(false);
  const [copiedSeed, setCopiedSeed] = useState(false);
  const groupedJobs = useMemo(() => groupJobs(jobs), [jobs]);
  const seedAnalysis = analyzeSeedSql(seedSql);

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

  const downloadOrm = (target: OrmTarget) => {
    const ormTables: OrmTableDef[] = tables.map(t => {
      const columns: OrmColDef[] = t.columns.map(col => {
        const fkParts = col.fkRef ? col.fkRef.split('.') : [];
        const rawType = col.type.toLowerCase();
        const lenNum = col.length ? Number(col.length.split(',')[0]) : null;
        const scaleNum = col.length?.includes(',') ? Number(col.length.split(',')[1]) : null;
        return {
          name: col.name,
          rawType,
          maxLength: ['varchar', 'char'].includes(rawType) ? lenNum : null,
          numericPrecision: rawType === 'numeric' ? lenNum : null,
          numericScale: rawType === 'numeric' ? scaleNum : null,
          fullType: col.length ? `${col.type}(${col.length})` : col.type,
          nullable: col.nullable,
          defaultValue: col.defaultValue || null,
          isPk: col.isPk,
          isUnique: col.isUnique,
          isAutoIncrement: col.isAutoIncrement,
          comment: col.comment || null,
          fkToTable: fkParts[0] ?? null,
          fkToCol: fkParts[1] ?? null,
        };
      });
      return { schema: t.schema || 'public', table: t.name, columns };
    });
    const code = generateOrm(ormTables, 'postgresql', target);
    const filename = target === 'prisma' ? 'schema.prisma' : `${target}-schema.ts`;
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const copySeed = async () => {
    await navigator.clipboard.writeText(seedSql);
    setCopiedSeed(true);
    setTimeout(() => setCopiedSeed(false), 1500);
  };

  return (
    <div className="h-full overflow-hidden flex flex-col xl:flex-row gap-0">

      {/* Left: DDL Preview + Seed SQL */}
      <div className="flex-1 flex flex-col overflow-hidden border-b xl:border-b-0 xl:border-r border-gray-200 dark:border-slate-800">

        {/* DDL Preview — top half */}
        <div className="flex flex-col overflow-hidden" style={{ flex: '1 1 50%' }}>
          <div className="shrink-0 flex items-center gap-3 px-5 py-3 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
            <FileCode2 size={14} className="text-emerald-500" />
            <span className="text-xs font-semibold text-gray-700 dark:text-slate-200">Generated DDL</span>
            <span className="text-[11px] text-gray-400 dark:text-slate-500 ml-1">(postgresql)</span>
            <div className="ml-auto flex items-center gap-2">
              {/* ORM export buttons */}
              {(['drizzle', 'prisma', 'typeorm'] as OrmTarget[]).map(target => (
                <button key={target} onClick={() => downloadOrm(target)} disabled={!ddlText} title={`Export ${target} schema`}
                  className="px-2 py-1 text-[10px] font-medium rounded-lg border border-violet-200 dark:border-violet-800 text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-950/30 disabled:opacity-30 transition-colors capitalize">
                  {target}
                </button>
              ))}
              <div className="w-px h-4 bg-gray-200 dark:bg-slate-700" />
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

      {/* Right: Job History */}
      <div className="w-full xl:w-96 shrink-0 flex flex-col overflow-hidden bg-white dark:bg-slate-900">
        <div className="shrink-0 flex items-center justify-between px-5 py-3.5 border-b border-gray-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Clock size={13} className="text-gray-400 dark:text-slate-500" />
            <span className="text-xs font-semibold text-gray-700 dark:text-slate-200">Saved Jobs</span>
            {loadingJobs && <Loader2 size={10} className="animate-spin text-gray-400" />}
          </div>
          <button
            onClick={onSaveJob}
            disabled={tables.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            <Save size={11} /> Save Current Schema
          </button>
        </div>

        <div className="flex-1 overflow-auto panel-scroll p-2 space-y-1.5">
          {groupedJobs.length === 0 && !loadingJobs ? (
            <div className="py-8 text-center">
              <Save size={22} className="mx-auto text-gray-200 dark:text-slate-700 mb-2" />
              <p className="text-[11px] text-gray-400 dark:text-slate-500">No saved jobs yet</p>
            </div>
          ) : groupedJobs.map(g => (
            <JobGroupCard key={g.job_name} group={g} onLoad={onLoadJob} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── New Table Dialog ─────────────────────────────────────────────────────────

function NewTableDialog({ defaultSchema, onConfirm, onClose }: {
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
        <div className="space-y-1">
          <label className="text-[11px] text-gray-500 dark:text-slate-400">Schema</label>
          <input
            className="w-full px-3 py-2 text-sm rounded-xl border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
            value={schema} onChange={e => setSchema(e.target.value)} placeholder="public"
          />
        </div>
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

// ─── Guide Popover ────────────────────────────────────────────────────────────

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
                <p>Design tables <strong>locally</strong> first — no connection or database required upfront.</p>
                <p>When ready, click <strong>Execute</strong> in the header → pick a connection + database in the modal → SQL runs against the database. Nothing is written until Execute.</p>
              </div>
            </div>

            <div className={div} />

            {/* Layout */}
            <div>
              <p className={h3}><Layers size={12} className="text-purple-500" /> Layout</p>
              <div className={sec}>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li><strong>Left panel</strong> — mode toggle (Create / Import SQL) + schema & table tree.</li>
                  <li><strong>Middle panel</strong> — DDL strip (selected table's SQL) + column editor.</li>
                  <li><strong>Right panel</strong> — Saved Jobs history. Click the notch on its left edge to collapse or expand.</li>
                </ul>
              </div>
            </div>

            <div className={div} />

            {/* Left Panel */}
            <div>
              <p className={h3}><Table2 size={12} className="text-blue-500" /> Left Panel</p>
              <div className={sec}>
                <p><strong>Create mode</strong></p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li>{pill('+ Schema')} — adds a schema node; generates <code className="text-[10px]">CREATE SCHEMA IF NOT EXISTS</code> at execute time.</li>
                  <li>{pill('+ Table')} — disabled until at least one schema exists. Schema is pre-filled when adding via the schema's {pill('+')} hover button.</li>
                  <li>Hover a table row → {pill('×')} appears to delete it.</li>
                  <li>Blue link icon on a table = has outgoing FKs. Purple arrow = referenced by other tables.</li>
                </ul>
                <p className="mt-2"><strong>Import SQL mode</strong></p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li>An import strip appears in the middle panel with source tabs: {pill('Paste SQL')} · {pill('.sql')} · {pill('CSV')} · {pill('XLSX')}.</li>
                  <li>After parsing, found tables appear below a dashed <em>Parsed · N</em> separator — click a row to edit its columns before merging.</li>
                  <li>{pill('Merge')} moves all parsed tables into the designer tree (duplicate schema.name skipped).</li>
                </ul>
              </div>
            </div>

            <div className={div} />

            {/* Column Editor */}
            <div>
              <p className={h3}><Columns size={12} className="text-teal-500" /> Column Editor</p>
              <div className={sec}>
                <p>Click any table in the tree to open its column editor in the middle panel. The DDL strip above auto-updates to show that table's generated SQL.</p>
                <div className="mt-2 space-y-1.5">
                  {[
                    ['PK', 'Primary Key', 'Auto-sets NOT NULL + UNIQUE. Row highlighted amber.'],
                    ['NN', 'Not Null', 'Column cannot be NULL.'],
                    ['UQ', 'Unique', 'Adds a UNIQUE constraint.'],
                    ['AI', 'Auto Increment', 'Uses SERIAL / BIGSERIAL. Auto-enabled when type is SERIAL.'],
                    ['Default', 'Default value', 'Expressions (NOW(), NULL, TRUE) used as-is. Plain strings are quoted.'],
                    ['FK Ref', 'Foreign Key', 'Click "Set FK" to open the relationship picker.'],
                    ['Comment', 'Column comment', 'Emitted as COMMENT ON COLUMN in the DDL.'],
                  ].map(([flag, name, note]) => (
                    <div key={flag} className="flex items-start gap-2">
                      <span className="shrink-0 w-11 text-center inline-block px-1 py-0.5 rounded font-mono text-[10px] font-semibold bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200 border border-gray-200 dark:border-slate-700">{flag}</span>
                      <span className="text-[11px] text-gray-600 dark:text-slate-300"><span className="font-medium text-gray-700 dark:text-slate-200">{name}</span> — {note}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-2">{pill('+ Add Column')} is at the bottom-right of the column table. FK Relationships section appears directly below it.</p>
              </div>
            </div>

            <div className={div} />

            {/* FK Picker */}
            <div>
              <p className={h3}><Link2 size={12} className="text-blue-500" /> FK Relationship Picker</p>
              <div className={sec}>
                <p>Click {pill('Set FK')} in the FK Ref column to open the two-panel picker:</p>
                <ul className="space-y-1 pl-3 border-l-2 border-gray-100 dark:border-slate-800 ml-1">
                  <li><strong>Left</strong> — all other tables in the designer. Click to select one.</li>
                  <li><strong>Right</strong> — columns of the selected table. Amber key = PK, purple = Unique.</li>
                  <li>Click a column → FK set as {pill('table.column')}; picker closes automatically.</li>
                  <li>Click the blue FK badge to reopen and change. Click {pill('×')} to clear the FK.</li>
                </ul>
                <p className="mt-1.5">The <strong>Relationship Summary</strong> below the column table lists all outgoing FKs and tables that reference this one.</p>
              </div>
            </div>

            <div className={div} />

            {/* Save & Execute */}
            <div>
              <p className={h3}><Save size={12} className="text-rose-500" /> Save & Execute</p>
              <div className={sec}>
                <p><strong>Save</strong> button (header) — appears when tables exist. Turns <span className="text-amber-500 font-semibold">amber</span> when the loaded job has unsaved changes. Label changes to <em>Save Revision</em> when saving under the same job name.</p>
                <p className="mt-1">In Import mode, a <strong>Schema Assign</strong> dialog appears before saving if any tables still have <code className="text-[10px]">schema = public</code> — pick an existing schema or type a new one.</p>
                <p className="mt-1"><strong>Execute</strong> button (header) — opens a modal to pick a saved connection + database, then runs the generated DDL. Execution log is shown inline and a new run record is saved to Job History on completion.</p>
                <p className="mt-1"><strong>Saved Jobs</strong> (right panel) — grouped by job name. The {pill('Load')} button on the group card restores the design into the designer. Run rows expand with a chevron to show the execution log.</p>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

// ─── Schema Assign Modal ──────────────────────────────────────────────────────

function SchemaAssignModal({ existingSchemas, onAssign, onSkip, onClose }: {
  existingSchemas: string[];
  onAssign: (schema: string) => void;
  onSkip: () => void;
  onClose: () => void;
}) {
  const hasExisting = existingSchemas.length > 0;
  const [mode, setMode] = useState<'existing' | 'new'>(hasExisting ? 'existing' : 'new');
  const [selected, setSelected] = useState(existingSchemas[0] ?? '');
  const [custom, setCustom] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (mode === 'new') ref.current?.focus(); }, [mode]);
  const sanitized = custom.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const value = mode === 'existing' ? selected : sanitized;

  return (
    <div className="fixed inset-0 z-[90] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Layers size={15} className="text-blue-500" />
            <p className="font-semibold text-sm text-gray-900 dark:text-slate-100">Assign Schema</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-gray-500 dark:text-slate-400">
            Imported tables without an explicit schema (defaulted to <span className="font-mono text-gray-700 dark:text-slate-200">public</span>) will be reassigned to:
          </p>
          {hasExisting && (
            <div className="flex rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden text-xs font-medium">
              <button onClick={() => setMode('existing')} className={`flex-1 py-1.5 transition-colors ${mode === 'existing' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>Use existing</button>
              <button onClick={() => setMode('new')} className={`flex-1 py-1.5 border-l border-gray-200 dark:border-slate-700 transition-colors ${mode === 'new' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>New schema</button>
            </div>
          )}
          {mode === 'existing' && hasExisting && (
            <select value={selected} onChange={e => setSelected(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 font-mono focus:outline-none focus:border-blue-400 cursor-pointer">
              {existingSchemas.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          {mode === 'new' && (
            <input ref={ref} value={custom} onChange={e => setCustom(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && sanitized) onAssign(sanitized); }}
              placeholder="schema_name"
              className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 font-mono focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-400/20"
            />
          )}
        </div>
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-slate-800">
          <button onClick={onSkip} className="px-4 py-2 text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 rounded-lg transition-colors">Keep public</button>
          <button onClick={() => value && onAssign(value)} disabled={!value}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors">
            <Layers size={13} /> Assign & Save
          </button>
        </div>
      </div>
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

// ─── Execute Job Modal ────────────────────────────────────────────────────────

function ExecuteJobModal({ job, connections, onClose, onJobDone }: {
  job: SchemaJob;
  connections: ConnectionRow[];
  onClose: () => void;
  onJobDone: () => void;
}) {
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState('');
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execLog, setExecLog] = useState<ExecLogLine[]>([]);
  const [done, setDone] = useState(false);

  const selectedConn = connections.find(c => c.id === selectedConnId) ?? null;

  const loadDatabases = useCallback(async (conn: ConnectionRow) => {
    setLoadingDbs(true);
    setDatabases([]);
    setSelectedDb('');
    try {
      const { data } = await axios.post<{ databases: string[] }>('/api/schema-designer/databases', connToPayload(conn));
      setDatabases(data.databases);
      if (data.databases.length) setSelectedDb(data.databases[0]);
    } catch { /* ignore */ } finally { setLoadingDbs(false); }
  }, []);

  useEffect(() => { if (selectedConn) void loadDatabases(selectedConn); }, [selectedConn, loadDatabases]);

  const handleExecute = async () => {
    if (!selectedConn || !selectedDb || !job.schema_sql) return;
    setExecuting(true);
    setExecLog([]);
    const explorerConn = connToExplorerConn(selectedConn, selectedDb);
    const ddlStmts = generateDDL(parseSqlToTables(job.schema_sql), 'postgresql');
    const seedStmts = job.seed_sql?.trim()
      ? job.seed_sql.split(/;\s*(?=\n|$)/).map(s => s.trim()).filter(s => s.length > 0).map(s => s.endsWith(';') ? s : s + ';')
      : [];
    try {
      const { data } = await axios.post<{ log: ExecLogLine[] }>('/api/schema-designer/execute', { conn: explorerConn, statements: [...ddlStmts, ...seedStmts] });
      setExecLog(data.log);
      const status = data.log.every(l => l.ok) ? 'success' : 'failed';
      await axios.post('/api/schema-generator/jobs', {
        job_name: job.job_name,
        description: job.description,
        schema_sql: job.schema_sql,
        seed_sql: job.seed_sql,
        target_database: selectedDb,
        connection_label: selectedConn.label,
        status,
        log: data.log.map((l, i) => ({ step: i + 1, ok: l.ok, text: l.text })),
      });
      onJobDone();
      setDone(true);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      setExecLog([{ sql: '', ok: false, text: msg }]);
    } finally { setExecuting(false); }
  };

  const canRun = !!selectedConn && !!selectedDb && !!job.schema_sql && !executing;
  const successCount = execLog.filter(l => l.ok).length;
  const failCount = execLog.filter(l => !l.ok).length;
  const allOk = execLog.length > 0 && failCount === 0;

  return (
    <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-xl bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-slate-800 shrink-0">
          <div className="flex items-center gap-2.5">
            <Play size={15} className="text-emerald-500" />
            <div>
              <p className="font-semibold text-gray-900 dark:text-slate-100 text-sm">{job.job_name}</p>
              <p className="text-[10px] text-gray-400 dark:text-slate-500">Select a connection and database to execute against</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-4">
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">Connection</label>
              <select
                value={selectedConnId ?? ''}
                onChange={e => setSelectedConnId(e.target.value ? Number(e.target.value) : null)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-blue-400 cursor-pointer"
              >
                <option value="">— select connection —</option>
                {connections.filter(c => c.db_type === 'postgres').map(c => (
                  <option key={c.id} value={c.id}>{c.label} ({c.database_name})</option>
                ))}
              </select>
            </div>
            {selectedConn && (
              <div>
                <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1.5">Database</label>
                {loadingDbs
                  ? <span className="text-xs text-gray-400 animate-pulse">Loading databases…</span>
                  : (
                    <select value={selectedDb} onChange={e => setSelectedDb(e.target.value)}
                      className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-blue-400 cursor-pointer font-mono">
                      {databases.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                  )}
              </div>
            )}
          </div>

          {execLog.length > 0 && (
            <div className="rounded-xl overflow-hidden border border-gray-200 dark:border-slate-700">
              <div className="flex items-center gap-3 px-4 py-2 bg-gray-50 dark:bg-slate-800/50 border-b border-gray-100 dark:border-slate-800">
                <span className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider">Execution Log</span>
                {successCount > 0 && <span className="text-[10px] text-emerald-600 dark:text-emerald-400">{successCount} ok</span>}
                {failCount > 0 && <span className="text-[10px] text-rose-600 dark:text-rose-400">{failCount} failed</span>}
              </div>
              <div className="bg-slate-950 p-3 max-h-52 overflow-auto space-y-1 font-mono">
                {execLog.map((line, i) => (
                  <div key={i} className={`flex items-start gap-2 text-[10px] leading-relaxed ${line.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {line.ok ? <CheckCircle2 size={10} className="mt-0.5 shrink-0" /> : <XCircle size={10} className="mt-0.5 shrink-0" />}
                    <span className="break-all">{line.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {done && allOk && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-200 dark:border-emerald-800 text-[11px] text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 size={12} /> Schema applied successfully. Run saved to Job History.
            </div>
          )}
        </div>

        <div className="shrink-0 flex items-center justify-end gap-3 px-5 py-4 border-t border-gray-100 dark:border-slate-800">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done && (
            <button onClick={() => void handleExecute()} disabled={!canRun}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-40 transition-colors">
              {executing ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {executing ? 'Executing…' : 'Execute'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

function SchemaDesignerInner() {
  const { showWarning, showError } = useAlert();

  // Connections (kept for ImportPanel + ExecuteJobModal)
  const [connections, setConnections] = useState<ConnectionRow[]>([]);

  // Designer state
  const [tables, setTables] = useState<DesignerTable[]>([]);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [showNewTable, setShowNewTable] = useState(false);
  const [newTableDefaultSchema, setNewTableDefaultSchema] = useState<string | undefined>(undefined);

  // Schema tree — start empty; user must create a schema first (PostgreSQL standard)
  const [designerSchemas, setDesignerSchemas] = useState<string[]>([]);
  const [showNewSchema, setShowNewSchema] = useState(false);

  // Seed SQL
  const [seedSql, setSeedSql] = useState('');

  // Loaded job tracking
  const [loadedJob, setLoadedJob] = useState<SchemaJob | null>(null);

  // Save modal + schema assign
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showSchemaAssign, setShowSchemaAssign] = useState(false);

  // Dirty tracking: amber Save when loaded job has unsaved changes
  const [isDirty, setIsDirty] = useState(false);

  // Execute job modal
  const [showExecModal, setShowExecModal] = useState(false);
  const [execModalJob, setExecModalJob] = useState<SchemaJob | null>(null);

  // ERD preview
  const [showErdPreview, setShowErdPreview] = useState(false);

  // Job history
  const [jobs, setJobs] = useState<SchemaJob[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

  // Right panel (collapsible)
  const [rightPanelOpen, setRightPanelOpen] = useState(true);

  // Left panel mode toggle
  const [designerMode, setDesignerMode] = useState<'create' | 'import' | 'refactor'>('create');
  const [importSource, setImportSource] = useState<'paste' | 'sql-file' | 'csv' | 'xlsx' | 'db'>('paste');
  const [importSql, setImportSql] = useState('');
  const [importCsvName, setImportCsvName] = useState('');
  const [importXlsxLoading, setImportXlsxLoading] = useState(false);
  const [importParsed, setImportParsed] = useState<DesignerTable[]>([]);
  const [selectedParsedId, setSelectedParsedId] = useState<string | null>(null);
  const importSqlFileRef = useRef<HTMLInputElement>(null);
  const importCsvFileRef = useRef<HTMLInputElement>(null);
  const importXlsxFileRef = useRef<HTMLInputElement>(null);

  // Live DB import state
  const [importDbConnId, setImportDbConnId] = useState<number | null>(null);
  const [importDbDbs, setImportDbDbs] = useState<string[]>([]);
  const [importDbDatabase, setImportDbDatabase] = useState('');
  const [importDbLoadingDbs, setImportDbLoadingDbs] = useState(false);
  const [importDbSchemas, setImportDbSchemas] = useState<SchemaInfo[]>([]);
  const [importDbTables, setImportDbTables] = useState<Record<string, TableInfo[]>>({});
  const [importDbExpanded, setImportDbExpanded] = useState<Set<string>>(new Set());
  const [importDbSelected, setImportDbSelected] = useState<Set<string>>(new Set());
  const [importDbLoadingSchemas, setImportDbLoadingSchemas] = useState(false);
  const [importDbImporting, setImportDbImporting] = useState(false);
  const importDbConn = connections.find(c => c.id === importDbConnId) ?? null;

  // ── Refactor mode state ───────────────────────────────────────────────────────
  const [originalTables, setOriginalTables] = useState<DesignerTable[]>([]);
  const [refactorConnId, setRefactorConnId] = useState<number | null>(null);
  const [refactorDbs, setRefactorDbs] = useState<string[]>([]);
  const [refactorDatabase, setRefactorDatabase] = useState('');
  const [refactorSchema, setRefactorSchema] = useState('public');
  const [refactorSchemas, setRefactorSchemas] = useState<string[]>([]);
  const [refactorLoading, setRefactorLoading] = useState(false);
  const [refactorLoadingDbs, setRefactorLoadingDbs] = useState(false);
  const [refactorLoaded, setRefactorLoaded] = useState(false);
  const [alterLog, setAlterLog] = useState<ExecLogLine[]>([]);
  const [alterApplying, setAlterApplying] = useState(false);
  const [alterCopied, setAlterCopied] = useState(false);
  const refactorConn = connections.find(c => c.id === refactorConnId) ?? null;
  const alterStmts = useMemo(
    () => (designerMode === 'refactor' && originalTables.length > 0)
      ? generateAlterDDL(originalTables, tables, (refactorConn?.db_type === 'postgres' ? 'postgresql' : 'mysql'))
      : [],
    [designerMode, originalTables, tables, refactorConn]
  );
  const alterText = alterStmts.join('\n');

  // Load databases for refactor connection
  useEffect(() => {
    if (!refactorConnId) { setRefactorDbs([]); setRefactorDatabase(''); setRefactorSchemas([]); return; }
    const row = connections.find(c => c.id === refactorConnId);
    if (!row) return;
    setRefactorLoadingDbs(true);
    void axios.post<{ databases: string[] }>(
      '/api/schema-designer/databases',
      { type: row.db_type === 'postgres' ? 'postgresql' : 'mysql', host: row.host, port: row.port, username: row.username, password: row.password_enc ?? '' }
    ).then(({ data }) => {
      setRefactorDbs(data.databases);
      setRefactorDatabase(data.databases.includes(row.database_name) ? row.database_name : data.databases[0] ?? '');
    }).catch(() => {}).finally(() => setRefactorLoadingDbs(false));
  }, [refactorConnId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load schemas when refactor database changes
  useEffect(() => {
    if (!refactorConnId || !refactorDatabase) { setRefactorSchemas([]); return; }
    const row = connections.find(c => c.id === refactorConnId);
    if (!row || row.db_type !== 'postgres') return;
    void axios.post<{ schemas: SchemaInfo[] }>(
      '/api/schema-explorer/schemas',
      connToExplorerConn(row, refactorDatabase)
    ).then(({ data }) => {
      const names = data.schemas.map((s: SchemaInfo) => s.schema);
      setRefactorSchemas(names);
      if (!names.includes(refactorSchema)) setRefactorSchema(names[0] ?? 'public');
    }).catch(() => {});
  }, [refactorConnId, refactorDatabase]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRefactorSchema = async () => {
    if (!refactorConnId || !refactorDatabase) return;
    const row = connections.find(c => c.id === refactorConnId);
    if (!row) return;
    const dbType: DbType = row.db_type === 'postgres' ? 'postgresql' : 'mysql';
    const explorerConn = connToExplorerConn(row, refactorDatabase);
    setRefactorLoading(true);
    setRefactorLoaded(false);
    setAlterLog([]);
    try {
      // 1. Fetch tables in the chosen schema
      const { data: tablesData } = await axios.post<{ tables: TableInfo[] }>(
        '/api/schema-explorer/tables', { conn: explorerConn, schema: refactorSchema }
      );
      // 2. For each table, fetch columns + constraint names in parallel
      const loaded: DesignerTable[] = await Promise.all(
        tablesData.tables.map(async (ti) => {
          const tableKey = `${refactorSchema}.${ti.name}`;
          const [colsRes, constraintsRes] = await Promise.all([
            axios.post<{ columns: ColumnInfo[] }>('/api/schema-explorer/columns', { conn: explorerConn, tableKey }),
            axios.post<import('./api/schema-designer/constraints').ColumnConstraints>(
              '/api/schema-designer/constraints', { conn: explorerConn, schema: refactorSchema, table: ti.name }
            ).catch(() => ({ data: { fkConstraints: [], uniqueConstraints: [], checkConstraints: [] } })),
          ]);
          const fkMap = new Map(constraintsRes.data.fkConstraints.map(f => [f.colName, f.constraintName]));
          const uqMap = new Map(constraintsRes.data.uniqueConstraints.map(u => [u.colName, u.constraintName]));
          const cols: DesignerColumn[] = colsRes.data.columns.map(c => {
            const rawType = c.fullType.toUpperCase().replace(/\bCHARACTER VARYING\b/, 'VARCHAR').replace(/\bINTEGER\b/, 'INTEGER');
            const typeMatch = rawType.match(/^([A-Z0-9_ ]+?)(?:\((\d+(?:,\d+)?)\))?$/);
            return {
              id: crypto.randomUUID(),
              name: c.name,
              _originalName: c.name,
              type: typeMatch?.[1]?.trim() ?? rawType,
              length: typeMatch?.[2] ?? (c.maxLength ? String(c.maxLength) : ''),
              nullable: c.nullable,
              isPk: c.isPk,
              isUnique: c.isUnique,
              isAutoIncrement: /serial|auto_increment/i.test(c.dataType) || /^nextval\(/i.test(c.defaultValue ?? ''),
              defaultValue: c.defaultValue ?? '',
              comment: c.comment ?? '',
              fkRef: c.fkRef ? c.fkRef.split('.').slice(1).join('.') : '', // "schema.table.col" → "table.col"
              _fkConstraintName: fkMap.get(c.name),
              _uniqueConstraintName: uqMap.get(c.name),
            };
          });
          const dt: DesignerTable = {
            id: crypto.randomUUID(),
            schema: refactorSchema,
            name: ti.name,
            _originalName: ti.name,
            columns: cols,
          };
          return dt;
        })
      );
      // 3. Deep clone for immutable original snapshot
      const snapshot: DesignerTable[] = JSON.parse(JSON.stringify(loaded));
      setOriginalTables(snapshot);
      setTables(loaded);
      setSelectedTableId(loaded[0]?.id ?? null);
      setRefactorLoaded(true);
    } catch (err) {
      showError('Failed to load schema', err instanceof Error ? err.message : String(err));
    } finally {
      setRefactorLoading(false);
    }
  };

  const applyAlterDDL = async () => {
    if (!refactorConn || !alterStmts.length) return;
    setAlterApplying(true);
    setAlterLog([]);
    try {
      const { data } = await axios.post<{ log: ExecLogLine[] }>(
        '/api/schema-designer/execute',
        { conn: connToExplorerConn(refactorConn, refactorDatabase), statements: alterStmts }
      );
      setAlterLog(data.log);
      // Refresh: reload the schema so originalTables updates to the new state
      if (data.log.every(l => l.ok)) {
        await loadRefactorSchema();
      }
    } catch { showError('Apply failed'); } finally { setAlterApplying(false); }
  };

  // DDL preview in middle panel
  const [ddlCopied, setDdlCopied] = useState(false);
  const ddlText = useMemo(() => generateDDL(tables, 'postgresql').join('\n\n'), [tables]);
  const groupedJobs = useMemo(() => groupJobs(jobs), [jobs]);

  useEffect(() => {
    if (!loadedJob) { setIsDirty(false); return; }
    const currentDdl = generateDDL(tables, 'postgresql').join('\n\n');
    setIsDirty(currentDdl !== (loadedJob.schema_sql ?? ''));
  }, [tables, loadedJob]);

  const downloadDdl = () => {
    if (!ddlText) return;
    const blob = new Blob([ddlText], { type: 'text/sql' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'schema.sql'; a.click();
    URL.revokeObjectURL(url);
  };

  const copyDdl = async () => {
    await navigator.clipboard.writeText(ddlText);
    setDdlCopied(true);
    setTimeout(() => setDdlCopied(false), 1500);
  };

  const handleParseImport = () => {
    const parsed = parseSqlToTables(importSql);
    setImportParsed(parsed);
  };

  const handleApplyImport = () => {
    if (!importParsed.length) return;
    setTables(p => mergeTables(p, importParsed));
    const schemas = [...new Set(importParsed.map(t => t.schema || 'public'))];
    setDesignerSchemas(p => [...new Set([...p, ...schemas])]);
    setImportParsed([]);
    setImportSql('');
    setImportCsvName('');
    setSelectedParsedId(null);
  };

  const handleUpdateParsedTable = (updated: DesignerTable) => {
    setImportParsed(p => p.map(t => t.id === updated.id ? updated : t));
  };

  const handleDeleteParsedTable = (id: string) => {
    const t = importParsed.find(x => x.id === id);
    showWarning({
      title: `Remove "${t?.name ?? 'this table'}"?`,
      description: 'The table will be removed from the import list.',
      confirmLabel: 'Remove',
      onConfirm: () => { setImportParsed(p => p.filter(x => x.id !== id)); setSelectedParsedId(null); },
    });
  };

  const handleImportSqlFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      setImportParsed(parseSqlToTables(text));
    };
    reader.readAsText(file);
  };

  const handleImportCsvFile = (file: File) => {
    const name = importCsvName || file.name.replace(/\.csv$/i, '');
    if (!importCsvName) setImportCsvName(name);
    const reader = new FileReader();
    reader.onload = e => {
      const text = e.target?.result as string;
      setImportParsed([parseCsvToTable(text, name || 'imported')]);
    };
    reader.readAsText(file);
  };

  const handleImportXlsx = async (file: File) => {
    setImportXlsxLoading(true);
    try {
      const pts = await parseExcelFile(file);
      setImportParsed(pts.map(pt => ({
        id: crypto.randomUUID(), schema: 'public', name: pt.name,
        columns: pt.columns.map(c => ({
          id: crypto.randomUUID(), name: c.name, type: c.type,
          length: c.type === 'VARCHAR' ? '255' : '',
          nullable: c.nullable, isPk: false, isUnique: false,
          isAutoIncrement: false, defaultValue: '', comment: '', fkRef: '',
        })),
      })));
    } catch { /* ignore */ } finally { setImportXlsxLoading(false); }
  };

  // ── Live DB import helpers ────────────────────────────────────────────────

  const loadImportDbDbs = useCallback(async (conn: ConnectionRow) => {
    setImportDbLoadingDbs(true);
    setImportDbDbs([]);
    setImportDbDatabase('');
    setImportDbSchemas([]);
    setImportDbTables({});
    try {
      const { data } = await axios.post<{ databases: string[] }>('/api/schema-designer/databases', connToPayload(conn));
      setImportDbDbs(data.databases);
      if (data.databases.length) setImportDbDatabase(data.databases[0]);
    } catch { /* ignore */ } finally { setImportDbLoadingDbs(false); }
  }, []);

  useEffect(() => {
    if (importDbConn) void loadImportDbDbs(importDbConn);
  }, [importDbConn, loadImportDbDbs]);

  const loadImportDbSchemas = useCallback(async () => {
    if (!importDbConn || !importDbDatabase) return;
    setImportDbLoadingSchemas(true);
    setImportDbSchemas([]);
    setImportDbTables({});
    setImportDbExpanded(new Set());
    setImportDbSelected(new Set());
    try {
      const ec = connToExplorerConn(importDbConn, importDbDatabase);
      const { data } = await axios.post<{ schemas: SchemaInfo[] }>('/api/schema-explorer/schemas', ec);
      setImportDbSchemas(data.schemas);
    } catch { /* ignore */ } finally { setImportDbLoadingSchemas(false); }
  }, [importDbConn, importDbDatabase]);

  const loadImportDbSchemaTables = async (schema: string) => {
    if (!importDbConn || !importDbDatabase || importDbTables[schema]) return;
    try {
      const ec = connToExplorerConn(importDbConn, importDbDatabase);
      const { data } = await axios.post<{ tables: TableInfo[] }>('/api/schema-explorer/tables', { conn: ec, schemas: [schema] });
      setImportDbTables(p => ({ ...p, [schema]: data.tables }));
    } catch { /* ignore */ }
  };

  const toggleImportDbSchema = async (schema: string) => {
    setImportDbExpanded(p => { const n = new Set(p); n.has(schema) ? n.delete(schema) : n.add(schema); return n; });
    await loadImportDbSchemaTables(schema);
  };

  const toggleImportDbAll = (schema: string) => {
    const schemaTables = importDbTables[schema] ?? [];
    const keys = schemaTables.map(t => `${t.schema}.${t.name}`);
    const allChecked = keys.every(k => importDbSelected.has(k));
    setImportDbSelected(prev => {
      const next = new Set(prev);
      keys.forEach(k => allChecked ? next.delete(k) : next.add(k));
      return next;
    });
  };

  const importFromLiveDb = async () => {
    if (!importDbConn || !importDbDatabase || !importDbSelected.size) return;
    setImportDbImporting(true);
    const ec = connToExplorerConn(importDbConn, importDbDatabase);
    const imported: DesignerTable[] = [];
    for (const key of importDbSelected) {
      try {
        const { data } = await axios.post<TableColumnsResult>('/api/schema-explorer/columns', { conn: ec, tableKey: key });
        const [schema, name] = key.includes('.') ? key.split('.', 2) : ['public', key];
        imported.push({ id: crypto.randomUUID(), schema, name, columns: data.columns.map(colInfoToDesigner) });
      } catch { /* ignore */ }
    }
    if (imported.length) {
      setTables(p => mergeTables(p, imported));
      const schemas = [...new Set(imported.map(t => t.schema))];
      setDesignerSchemas(p => [...new Set([...p, ...schemas])]);
      setImportDbSelected(new Set());
      setDesignerMode('create');
    }
    setImportDbImporting(false);
  };

  const selectedTable = tables.find(t => t.id === selectedTableId) ?? null;
  const activeParsedTable = designerMode === 'import'
    ? (importParsed.find(t => t.id === selectedParsedId) ?? null)
    : null;
  const activeEditTable = activeParsedTable ?? selectedTable;
  const activeEditTableDdl = activeEditTable
    ? generateDDL([activeEditTable], 'postgresql').join('\n\n')
    : '';
  const [tableDdlCopied, setTableDdlCopied] = useState(false);

  // Load connections for ImportPanel + ExecuteJobModal
  useEffect(() => {
    axios.get<{ success: boolean; connections: ConnectionRow[] }>('/api/connections')
      .then(r => setConnections(r.data.connections))
      .catch(() => { });
  }, []);

  const handleAddSchema = (name: string) => {
    setDesignerSchemas(p => p.includes(name) ? p : [...p, name]);
    setShowNewSchema(false);
  };

  const handleAddTableFor = (schema: string) => {
    setNewTableDefaultSchema(schema);
    setShowNewTable(true);
  };

  const handleAddTable = (name: string, schema: string) => {
    const t = mkTable(name, schema, 'postgresql');
    setTables(p => [...p, t]);
    setSelectedTableId(t.id);
    setShowNewTable(false);
    setNewTableDefaultSchema(undefined);
    setDesignerSchemas(p => p.includes(schema) ? p : [...p, schema]);
  };

  const handleDeleteTable = (id: string) => {
    const t = tables.find(x => x.id === id);
    showWarning({
      title: `Delete "${t?.name ?? 'this table'}"?`,
      description: 'The table and all its column definitions will be removed from the schema.',
      confirmLabel: 'Delete',
      onConfirm: () => { setTables(p => p.filter(x => x.id !== id)); if (selectedTableId === id) setSelectedTableId(null); },
    });
  };

  const handleUpdateTable = (updated: DesignerTable) => {
    setTables(p => p.map(t => t.id === updated.id ? updated : t));
  };

  const loadJobs = useCallback(async () => {
    setLoadingJobs(true);
    try {
      const { data } = await axios.get<{ jobs: SchemaJob[] }>('/api/schema-generator/jobs');
      setJobs(data.jobs ?? []);
    } catch { /* ignore */ } finally { setLoadingJobs(false); }
  }, []);

  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const handleSaveClick = () => {
    if (designerMode === 'import' && tables.some(t => t.schema === 'public')) {
      setShowSchemaAssign(true);
    } else {
      setShowSaveModal(true);
    }
  };

  const handleSchemaAssigned = (schema: string) => {
    setTables(p => p.map(t => t.schema === 'public' ? { ...t, schema } : t));
    setDesignerSchemas(p => p.includes(schema) ? p : [...p, schema]);
    setShowSchemaAssign(false);
    setShowSaveModal(true);
  };

  const handleSaveJob = async (name: string, desc: string) => {
    const schemaSql = generateDDL(tables, 'postgresql').join('\n\n');
    try {
      await axios.post('/api/schema-generator/jobs', {
        job_name: name,
        description: desc,
        schema_sql: schemaSql,
        seed_sql: seedSql,
        status: 'pending',
        log: null,
      });
      void loadJobs();
      setLoadedJob(prev => ({
        ...(prev ?? { id: Date.now(), created_at: new Date().toISOString() } as SchemaJob),
        job_name: name,
        description: desc,
        schema_sql: schemaSql,
        seed_sql: seedSql,
        status: 'pending',
        log: null,
      }));
    } catch { /* ignore */ } finally { setShowSaveModal(false); }
  };

  const handleRenameGroup = async (oldName: string, newName: string) => {
    try {
      await axios.patch('/api/schema-generator/jobs', { oldName, newName });
      void loadJobs();
    } catch { /* ignore */ }
  };

  const handleDeleteJobGroup = (jobName: string) => {
    showWarning({
      title: `Delete "${jobName}"?`,
      description: 'All runs under this job will be permanently removed and cannot be recovered.',
      confirmLabel: 'Delete Job',
      onConfirm: async () => {
        try {
          await axios.delete(`/api/schema-generator/jobs?jobName=${encodeURIComponent(jobName)}`);
          void loadJobs();
        } catch { /* ignore */ }
      },
    });
  };

  const handleLoadJob = (job: SchemaJob) => {
    const parsed = job.schema_sql ? parseSqlToTables(job.schema_sql) : [];
    const schemas = [...new Set(parsed.map(t => t.schema || 'public'))];
    setTables(parsed);
    setDesignerSchemas(schemas.length ? schemas : []);
    setSelectedTableId(parsed.length ? parsed[0].id : null);
    setImportParsed([]);
    setSelectedParsedId(null);
    setDesignerMode('create');
    setSeedSql(job.seed_sql ?? '');
    setLoadedJob(job);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-48px)] bg-gray-50 dark:bg-slate-950 overflow-hidden">
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

        <span className="shrink-0 inline-flex items-center px-2 py-1 rounded-md text-[11px] font-medium border bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-900">
          PostgreSQL
        </span>

      </header>

      {/* ── Toolbar ── */}
      <div className="shrink-0 flex items-center border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-1.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-gray-600 dark:text-slate-300">
          <Table2 size={13} className="text-blue-500" /> Designer
          {tables.length > 0 && (
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400">{tables.length}</span>
          )}
        </div>
        <div className="ml-auto pr-1 flex items-center gap-2">
          {(tables.length > 0 || importParsed.length > 0) && (
            <>
              <button
                onClick={handleSaveClick}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border transition-colors
                  ${isDirty && loadedJob
                    ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-900/40'
                    : 'border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800'}`}
              >
                <Save size={12} /> {isDirty && loadedJob ? 'Save Changes' : 'Save'}
              </button>
              <button
                onClick={() => setShowErdPreview(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium border border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
              >
                <Network size={12} /> ERD Preview
              </button>
              {loadedJob && (
                <button
                  onClick={() => { setExecModalJob(loadedJob); setShowExecModal(true); }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                >
                  <Play size={12} /> Execute
                </button>
              )}
            </>
          )}
          <GuidePopover />
        </div>
      </div>

      {/* ── Tab Content ── */}
      <div className="flex-1 overflow-hidden">

        {/* Designer */}
        <div className="flex h-full overflow-hidden">

            {/* ── Left: Schema & Table tree ── */}
            <div className="w-56 shrink-0 border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">

              {/* Mode toggle + action buttons */}
              <div className="shrink-0 border-b border-gray-200 dark:border-slate-800 p-2 space-y-2">
                <div className="flex rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
                  <button
                    onClick={() => { setDesignerMode('create'); setSelectedParsedId(null); }}
                    className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] font-medium transition-colors ${designerMode === 'create' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`}
                  >
                    <Plus size={11} /> Create
                  </button>
                  <button
                    onClick={() => setDesignerMode('import')}
                    className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] font-medium border-l border-gray-200 dark:border-slate-700 transition-colors ${designerMode === 'import' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`}
                  >
                    <Upload size={11} /> Import
                  </button>
                  <button
                    onClick={() => { setDesignerMode('refactor'); setSelectedParsedId(null); }}
                    className={`flex-1 flex items-center justify-center gap-1 py-1.5 text-[11px] font-medium border-l border-gray-200 dark:border-slate-700 transition-colors ${designerMode === 'refactor' ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`}
                  >
                    <Pencil size={11} /> Refactor
                  </button>
                </div>
                {designerMode === 'create' && (
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setShowNewSchema(true)}
                      className="flex-1 inline-flex items-center justify-center gap-1 py-1 text-[11px] rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <Layers size={10} /> Schema
                    </button>
                    <button
                      onClick={() => { setNewTableDefaultSchema(undefined); setShowNewTable(true); }}
                      disabled={designerSchemas.length === 0}
                      title={designerSchemas.length === 0 ? 'Create a schema first' : 'Add table'}
                      className="flex-1 inline-flex items-center justify-center gap-1 py-1 text-[11px] rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Table2 size={10} /> Table
                    </button>
                  </div>
                )}
              </div>

              {/* Refactor — connection + DB + schema picker */}
              {designerMode === 'refactor' && (
                <div className="shrink-0 border-b border-amber-200 dark:border-amber-800/40 bg-amber-50/40 dark:bg-amber-900/10 p-2 space-y-1.5">
                  <select
                    value={refactorConnId ?? ''}
                    onChange={e => setRefactorConnId(e.target.value ? Number(e.target.value) : null)}
                    className="w-full px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-amber-400 cursor-pointer"
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
                  </select>
                  {refactorConnId && (
                    <div className="flex gap-1">
                      {refactorLoadingDbs
                        ? <Loader2 size={11} className="animate-spin text-gray-400 self-center" />
                        : (
                          <select
                            value={refactorDatabase}
                            onChange={e => setRefactorDatabase(e.target.value)}
                            className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:border-amber-400 cursor-pointer font-mono"
                          >
                            {!refactorDatabase && <option value="">— db —</option>}
                            {refactorDbs.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                        )
                      }
                      {refactorConn?.db_type === 'postgres' && refactorSchemas.length > 0 && (
                        <select
                          value={refactorSchema}
                          onChange={e => setRefactorSchema(e.target.value)}
                          className="w-20 shrink-0 px-2 py-1 text-[11px] rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-300 focus:outline-none cursor-pointer font-mono"
                        >
                          {refactorSchemas.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                  <button
                    onClick={() => void loadRefactorSchema()}
                    disabled={!refactorConnId || !refactorDatabase || refactorLoading}
                    className="w-full flex items-center justify-center gap-1 py-1 text-[11px] font-medium rounded border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 hover:bg-amber-100 dark:hover:bg-amber-950/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {refactorLoading ? <><Loader2 size={10} className="animate-spin" /> Loading…</> : <><RefreshCw size={10} /> Load Schema</>}
                  </button>
                  {refactorLoaded && (
                    <p className="text-[9px] text-amber-600 dark:text-amber-500 text-center">
                      {tables.length} table{tables.length !== 1 ? 's' : ''} loaded · edit then Apply
                    </p>
                  )}
                </div>
              )}

              {/* Pending import — shown immediately below toggle */}
              {designerMode === 'import' && importParsed.length > 0 && (
                <div className="shrink-0 border-b border-dashed border-gray-300 dark:border-slate-700 bg-emerald-50/30 dark:bg-emerald-900/10">
                  <div className="flex items-center justify-between px-3 py-2">
                    <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 uppercase tracking-wide">
                      Parsed · {importParsed.length}
                    </span>
                    <button
                      onClick={handleApplyImport}
                      className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                    >
                      Merge
                    </button>
                  </div>
                  <div className="sidebar-scroll overflow-y-auto">
                    {importParsed.map(t => (
                      <div
                        key={t.id}
                        onClick={() => setSelectedParsedId(t.id)}
                        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors
                          ${selectedParsedId === t.id
                            ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400'
                            : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}
                      >
                        <Table2 size={11} className={`shrink-0 ${selectedParsedId === t.id ? 'text-emerald-500' : 'text-emerald-500 dark:text-emerald-700'}`} />
                        <span className="flex-1 text-[11px] font-medium truncate">
                          {t.schema !== 'public' ? `${t.schema}.` : ''}{t.name}
                        </span>
                        <span className="text-[10px] text-gray-400 dark:text-slate-600">{t.columns.length}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Tree */}
              <div className="flex-1 overflow-hidden flex flex-col min-h-0">
                <TableTreePanel
                  tables={tables}
                  selectedId={selectedTableId}
                  schemas={designerSchemas}
                  onSelect={setSelectedTableId}
                  onDelete={handleDeleteTable}
                  onAddTableFor={handleAddTableFor}
                  allowAddTable={designerMode === 'create' || designerMode === 'refactor'}
                />
              </div>
            </div>

            {/* ── Middle: DDL preview + Column editor ── */}
            <div className="flex-1 flex flex-col overflow-hidden min-w-0">

              {/* DDL Generator — shows selected table's DDL (both modes) */}
              {activeEditTable && (
                <div className="shrink-0 flex flex-col border-b border-gray-200 dark:border-slate-800" style={{ height: 200 }}>
                  <div className="shrink-0 flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-900 border-b border-gray-100 dark:border-slate-800">
                    <FileCode2 size={13} className="text-emerald-500" />
                    <span className="text-[11px] font-semibold text-gray-600 dark:text-slate-300">DDL Generator</span>
                    <span className="text-[10px] font-mono text-gray-400 dark:text-slate-500 ml-1">
                      {activeEditTable.schema}.{activeEditTable.name}
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <button
                        onClick={() => void navigator.clipboard.writeText(activeEditTableDdl).then(() => { setTableDdlCopied(true); setTimeout(() => setTableDdlCopied(false), 1500); })}
                        disabled={!activeEditTableDdl}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                      >
                        {tableDdlCopied ? <><Check size={10} className="text-emerald-500" /> Copied</> : <><Copy size={10} /> Copy</>}
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 sidebar-scroll overflow-auto bg-gray-50 dark:bg-slate-950 px-4 py-3">
                    <pre className="text-[10px] font-mono text-gray-700 dark:text-slate-300 leading-relaxed whitespace-pre-wrap">{activeEditTableDdl}</pre>
                  </div>
                </div>
              )}

              {/* SQL import area — import mode only, no table selected */}
              {!activeEditTable && designerMode === 'import' && (
                <div className="shrink-0 flex flex-col border-b border-gray-200 dark:border-slate-800" style={{ height: importSource === 'db' ? 340 : 200 }}>
                  {/* Toolbar: source tabs + action */}
                  <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-slate-900 border-b border-gray-100 dark:border-slate-800">
                    <div className="flex rounded-md border border-gray-200 dark:border-slate-700 overflow-hidden">
                      {([
                        { key: 'paste' as const, label: 'Paste SQL', Icon: FileCode2 },
                        { key: 'sql-file' as const, label: '.sql', Icon: Upload },
                        { key: 'csv' as const, label: 'CSV', Icon: FileText },
                        { key: 'xlsx' as const, label: 'XLSX', Icon: FileSpreadsheet },
                        { key: 'db' as const, label: 'Live DB', Icon: Database },
                      ]).map(({ key, label, Icon }) => (
                        <button
                          key={key}
                          onClick={() => { setImportSource(key); setImportParsed([]); }}
                          className={`flex items-center gap-1 px-2 py-1 text-[10px] font-medium border-l first:border-l-0 border-gray-200 dark:border-slate-700 transition-colors
                            ${importSource === key ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'}`}
                        >
                          <Icon size={10} /> {label}
                        </button>
                      ))}
                    </div>
                    <div className="ml-auto flex items-center gap-1.5">
                      {importSource === 'paste' && (
                        <button onClick={handleParseImport} disabled={!importSql.trim()}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors">
                          <RefreshCw size={10} /> Parse
                        </button>
                      )}
                      {importSource === 'sql-file' && (
                        <button onClick={() => importSqlFileRef.current?.click()}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                          <Upload size={10} /> Choose .sql
                        </button>
                      )}
                      {importSource === 'csv' && (
                        <button onClick={() => importCsvFileRef.current?.click()}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                          <Upload size={10} /> Choose .csv
                        </button>
                      )}
                      {importSource === 'xlsx' && (
                        <button onClick={() => importXlsxFileRef.current?.click()} disabled={importXlsxLoading}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors">
                          {importXlsxLoading ? <Loader2 size={10} className="animate-spin" /> : <Upload size={10} />} Choose .xlsx
                        </button>
                      )}
                      {importSource === 'db' && importDbSelected.size > 0 && (
                        <button onClick={() => void importFromLiveDb()} disabled={importDbImporting}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 hover:bg-emerald-100 dark:hover:bg-emerald-900/30 disabled:opacity-40 transition-colors">
                          {importDbImporting ? <Loader2 size={10} className="animate-spin" /> : <Download size={10} />}
                          Import Selected ({importDbSelected.size})
                        </button>
                      )}
                    </div>
                  </div>

                  {/* DB sub-toolbar: connection + database + load */}
                  {importSource === 'db' && (
                    <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-gray-50 dark:bg-slate-950 border-b border-gray-100 dark:border-slate-800">
                      <select
                        value={importDbConnId ?? ''}
                        onChange={e => setImportDbConnId(e.target.value ? Number(e.target.value) : null)}
                        className="text-[10px] font-mono px-2 py-1 rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:outline-none focus:border-blue-500"
                      >
                        <option value="">— connection —</option>
                        {connections.map(c => (
                          <option key={c.id} value={c.id}>{c.label} ({c.db_type})</option>
                        ))}
                      </select>
                      {importDbConn && (
                        <>
                          {importDbLoadingDbs ? (
                            <Loader2 size={10} className="animate-spin text-gray-400 dark:text-slate-500" />
                          ) : (
                            <select
                              value={importDbDatabase}
                              onChange={e => setImportDbDatabase(e.target.value)}
                              className="text-[10px] font-mono px-2 py-1 rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:outline-none focus:border-blue-500"
                            >
                              <option value="">— database —</option>
                              {importDbDbs.map(d => <option key={d} value={d}>{d}</option>)}
                            </select>
                          )}
                          <button
                            onClick={() => void loadImportDbSchemas()}
                            disabled={!importDbDatabase || importDbLoadingSchemas}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-white dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                          >
                            {importDbLoadingSchemas ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />} Load
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {/* Content area */}
                  <div className="flex-1 overflow-hidden bg-gray-50 dark:bg-slate-950">
                    {importSource === 'paste' && (
                      <textarea
                        className="w-full h-full px-4 py-3 text-[10px] font-mono text-gray-700 dark:text-slate-300 bg-transparent resize-none focus:outline-none placeholder-gray-400 dark:placeholder-slate-600 leading-relaxed"
                        placeholder={'-- Paste CREATE TABLE statements here…\n-- e.g. CREATE TABLE users (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);'}
                        value={importSql}
                        onChange={e => { setImportSql(e.target.value); if (importParsed.length) setImportParsed([]); }}
                      />
                    )}
                    {importSource === 'sql-file' && (
                      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                        {importParsed.length > 0 ? (
                          <>
                            <CheckCircle2 size={20} className="text-emerald-500" />
                            <p className="text-[11px] text-gray-500 dark:text-slate-400">{importParsed.length} table{importParsed.length !== 1 ? 's' : ''} parsed — click Merge in the left panel</p>
                            <button onClick={() => importSqlFileRef.current?.click()} className="text-[10px] text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 underline transition-colors">Upload another</button>
                          </>
                        ) : (
                          <>
                            <Upload size={20} className="text-gray-400 dark:text-slate-600" />
                            <p className="text-[11px] text-gray-500 dark:text-slate-500">Upload a .sql file with CREATE TABLE statements</p>
                            <button onClick={() => importSqlFileRef.current?.click()}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 text-[11px] transition-colors">
                              <Upload size={11} /> Choose File
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {importSource === 'csv' && (
                      <div className="flex flex-col gap-2 px-4 py-3 h-full">
                        <div className="flex items-center gap-2 shrink-0">
                          <label className="text-[11px] text-gray-500 dark:text-slate-400 shrink-0">Table name:</label>
                          <input
                            className="flex-1 text-[11px] font-mono px-2 py-1 rounded-md border border-gray-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 focus:outline-none focus:border-blue-500 placeholder-gray-400 dark:placeholder-slate-600"
                            placeholder="my_table"
                            value={importCsvName}
                            onChange={e => setImportCsvName(e.target.value)}
                          />
                        </div>
                        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center">
                          {importParsed.length > 0 ? (
                            <>
                              <CheckCircle2 size={18} className="text-emerald-500" />
                              <p className="text-[11px] text-gray-500 dark:text-slate-400">
                                <span className="font-mono">{importParsed[0].name}</span> — {importParsed[0].columns.length} columns detected
                              </p>
                              <button onClick={() => importCsvFileRef.current?.click()} className="text-[10px] text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 underline transition-colors">Upload another</button>
                            </>
                          ) : (
                            <>
                              <FileText size={18} className="text-gray-400 dark:text-slate-600" />
                              <p className="text-[11px] text-gray-500 dark:text-slate-500">First row as headers · types inferred from data</p>
                              <button onClick={() => importCsvFileRef.current?.click()}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 text-[11px] transition-colors">
                                <Upload size={11} /> Choose File
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                    {importSource === 'xlsx' && (
                      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                        {importXlsxLoading ? (
                          <><Loader2 size={20} className="text-gray-400 dark:text-slate-500 animate-spin" /><p className="text-[11px] text-gray-500 dark:text-slate-500">Parsing…</p></>
                        ) : importParsed.length > 0 ? (
                          <>
                            <CheckCircle2 size={20} className="text-emerald-500" />
                            <p className="text-[11px] text-gray-500 dark:text-slate-400">{importParsed.length} sheet{importParsed.length !== 1 ? 's' : ''} parsed as tables</p>
                            <button onClick={() => importXlsxFileRef.current?.click()} className="text-[10px] text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 underline transition-colors">Upload another</button>
                          </>
                        ) : (
                          <>
                            <FileSpreadsheet size={20} className="text-gray-400 dark:text-slate-600" />
                            <p className="text-[11px] text-gray-500 dark:text-slate-500">Each sheet becomes a table · types inferred from data</p>
                            <button onClick={() => importXlsxFileRef.current?.click()}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-700 text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 text-[11px] transition-colors">
                              <Upload size={11} /> Choose File
                            </button>
                          </>
                        )}
                      </div>
                    )}
                    {importSource === 'db' && (
                      <div className="h-full overflow-y-auto sidebar-scroll">
                        {!importDbConn ? (
                          <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                            <Database size={20} className="text-gray-300 dark:text-slate-700" />
                            <p className="text-[11px] text-gray-400 dark:text-slate-500">Select a connection above to browse live schemas</p>
                          </div>
                        ) : importDbLoadingSchemas ? (
                          <div className="flex flex-col items-center justify-center h-full gap-2">
                            <Loader2 size={18} className="animate-spin text-gray-400 dark:text-slate-500" />
                            <p className="text-[11px] text-gray-400 dark:text-slate-500">Loading schemas…</p>
                          </div>
                        ) : importDbSchemas.length === 0 ? (
                          <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                            <Layers size={18} className="text-gray-300 dark:text-slate-700" />
                            <p className="text-[11px] text-gray-400 dark:text-slate-500">Choose a database and click Load to browse schemas</p>
                          </div>
                        ) : (
                          <div className="py-1">
                            {importDbSchemas.map(s => {
                              const schemaTables = importDbTables[s.schema] ?? [];
                              const expanded = importDbExpanded.has(s.schema);
                              const schemaKeys = schemaTables.map(t => `${t.schema}.${t.name}`);
                              const allChecked = schemaKeys.length > 0 && schemaKeys.every(k => importDbSelected.has(k));
                              const someChecked = schemaKeys.some(k => importDbSelected.has(k));
                              return (
                                <div key={s.schema}>
                                  <div className="flex items-center gap-1 px-2 py-1 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer"
                                    onClick={() => void toggleImportDbSchema(s.schema)}>
                                    {expanded ? <ChevronDown size={10} className="text-gray-400 dark:text-slate-500 shrink-0" /> : <ChevronRight size={10} className="text-gray-400 dark:text-slate-500 shrink-0" />}
                                    <input type="checkbox" checked={allChecked} ref={el => { if (el) el.indeterminate = !allChecked && someChecked; }}
                                      onChange={e => { e.stopPropagation(); toggleImportDbAll(s.schema); }}
                                      onClick={e => e.stopPropagation()}
                                      className="w-3 h-3 rounded accent-blue-500 shrink-0" />
                                    <Layers size={10} className="text-blue-400 dark:text-blue-500 shrink-0" />
                                    <span className="text-[10px] font-semibold text-gray-600 dark:text-slate-300 truncate">{s.schema}</span>
                                    <span className="ml-auto text-[10px] text-gray-400 dark:text-slate-500">{s.tableCount}</span>
                                  </div>
                                  {expanded && (
                                    <div className="pl-6">
                                      {schemaTables.length === 0 ? (
                                        <div className="flex items-center gap-1 px-2 py-1">
                                          <Loader2 size={9} className="animate-spin text-gray-400 dark:text-slate-600" />
                                          <span className="text-[10px] text-gray-400 dark:text-slate-500">Loading…</span>
                                        </div>
                                      ) : schemaTables.map(t => {
                                        const key = `${t.schema}.${t.name}`;
                                        const checked = importDbSelected.has(key);
                                        return (
                                          <label key={key} className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-gray-100 dark:hover:bg-slate-800 cursor-pointer">
                                            <input type="checkbox" checked={checked}
                                              onChange={() => setImportDbSelected(p => { const n = new Set(p); checked ? n.delete(key) : n.add(key); return n; })}
                                              className="w-3 h-3 rounded accent-blue-500 shrink-0" />
                                            <Table2 size={9} className="text-gray-400 dark:text-slate-500 shrink-0" />
                                            <span className="text-[10px] font-mono text-gray-600 dark:text-slate-300 truncate">{t.name}</span>
                                            {t.rowCount !== undefined && (
                                              <span className="ml-auto text-[10px] text-gray-400 dark:text-slate-500">{t.rowCount.toLocaleString()}</span>
                                            )}
                                          </label>
                                        );
                                      })}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Hidden file inputs */}
                  <input ref={importSqlFileRef} type="file" accept=".sql,.txt" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImportSqlFile(f); e.target.value = ''; }} />
                  <input ref={importCsvFileRef} type="file" accept=".csv" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleImportCsvFile(f); e.target.value = ''; }} />
                  <input ref={importXlsxFileRef} type="file" accept=".xlsx,.xls" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) void handleImportXlsx(f); e.target.value = ''; }} />
                </div>
              )}

              {/* Column editor */}
              <div className="flex-1 overflow-hidden bg-white dark:bg-slate-900">
                {activeEditTable ? (
                  <ColumnEditorPanel
                    table={activeEditTable}
                    tables={activeParsedTable ? [...tables, ...importParsed] : tables}
                    onUpdate={activeParsedTable ? handleUpdateParsedTable : handleUpdateTable}
                    onDeleteTable={() => activeParsedTable
                      ? handleDeleteParsedTable(activeParsedTable.id)
                      : handleDeleteTable(activeEditTable.id)
                    }
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-6">
                    <Columns size={32} className="text-gray-200 dark:text-slate-700" />
                    <p className="text-sm text-gray-400 dark:text-slate-500">
                      {designerMode === 'import'
                        ? (importParsed.length > 0
                          ? 'Select a parsed table to review and edit its columns.'
                          : 'Paste or upload SQL / CSV / XLSX to import tables.')
                        : designerSchemas.length === 0
                          ? 'Create a schema in the left panel first.'
                          : tables.length === 0
                            ? 'Add a table from the left panel.'
                            : 'Select a table to edit its columns.'}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* ── Right: Saved Jobs / ALTER SQL (collapsible) ── */}
            <div className={`shrink-0 flex flex-col border-l border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden transition-[width] duration-200 ease-in-out ${rightPanelOpen ? 'w-64' : 'w-9'}`}>

              {/* Header row — always visible, contains toggle */}
              <div className="shrink-0 flex items-center gap-1.5 px-2 py-2.5 border-b border-gray-200 dark:border-slate-800">
                {rightPanelOpen && (designerMode === 'refactor'
                  ? <Pencil size={11} className="text-amber-500 shrink-0" />
                  : <Save size={11} className="text-gray-400 shrink-0" />
                )}
                {rightPanelOpen && (
                  <span className="text-[11px] font-semibold text-gray-700 dark:text-slate-300 flex-1 truncate">
                    {designerMode === 'refactor' ? 'ALTER SQL' : 'Saved Jobs'}
                  </span>
                )}
                {rightPanelOpen && designerMode !== 'refactor' && groupedJobs.length > 0 && (
                  <span className="text-[10px] text-gray-400 shrink-0">{groupedJobs.length}</span>
                )}
                {rightPanelOpen && designerMode === 'refactor' && alterStmts.length > 0 && (
                  <span className="text-[10px] text-amber-500 shrink-0">{alterStmts.length}</span>
                )}
                <button
                  onClick={() => setRightPanelOpen(o => !o)}
                  className="shrink-0 p-1 rounded hover:bg-gray-100 dark:hover:bg-slate-800 text-gray-400 transition-colors ml-auto"
                >
                  {rightPanelOpen ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
                </button>
              </div>

              {/* Panel content — only when open */}
              {rightPanelOpen && designerMode === 'refactor' ? (
                /* ── Refactor: ALTER SQL diff panel ── */
                <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-slate-900 min-w-0">
                  <div className="shrink-0 flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 dark:border-slate-800 bg-amber-50/40 dark:bg-amber-900/10">
                    <Pencil size={12} className="text-amber-500 shrink-0" />
                    <span className="text-xs font-semibold text-amber-700 dark:text-amber-400 flex-1">ALTER SQL</span>
                    {alterStmts.length > 0 && (
                      <>
                        <button
                          onClick={async () => { await navigator.clipboard.writeText(alterText); setAlterCopied(true); setTimeout(() => setAlterCopied(false), 1500); }}
                          title="Copy ALTER SQL"
                          className="p-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                        >
                          {alterCopied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
                        </button>
                        <button
                          onClick={() => void applyAlterDDL()}
                          disabled={alterApplying || !refactorConnId || !refactorDatabase}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-40 transition-colors"
                        >
                          {alterApplying ? <><Loader2 size={9} className="animate-spin" /> Applying…</> : <><Play size={9} /> Apply</>}
                        </button>
                      </>
                    )}
                  </div>
                  <div className="flex-1 overflow-auto p-3 space-y-2">
                    {!refactorLoaded ? (
                      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-3">
                        <Pencil size={22} className="text-amber-200 dark:text-amber-800" />
                        <p className="text-[11px] text-gray-400 dark:text-slate-500">
                          Load a schema from a live DB, then edit tables and columns to generate ALTER statements.
                        </p>
                      </div>
                    ) : alterStmts.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-3">
                        <CheckCircle2 size={22} className="text-emerald-400" />
                        <p className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium">No changes</p>
                        <p className="text-[10px] text-gray-400 dark:text-slate-500">Schema matches the loaded snapshot.</p>
                      </div>
                    ) : (
                      <>
                        <div className="bg-slate-900 dark:bg-slate-950 rounded-lg overflow-hidden">
                          <pre className="text-[11px] font-mono text-slate-300 leading-relaxed p-3 whitespace-pre-wrap">{alterText}</pre>
                        </div>
                        <p className="text-[10px] text-gray-400 dark:text-slate-500">{alterStmts.length} statement{alterStmts.length !== 1 ? 's' : ''}</p>
                      </>
                    )}
                    {/* Apply log */}
                    {alterLog.length > 0 && (
                      <div className="border-t border-gray-100 dark:border-slate-800 pt-2 space-y-1">
                        <p className="text-[10px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">Apply Log</p>
                        {alterLog.map((l, i) => (
                          <div key={i} className={`flex items-start gap-1.5 text-[10px] font-mono ${l.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                            {l.ok ? <Check size={9} className="shrink-0 mt-0.5" /> : <X size={9} className="shrink-0 mt-0.5" />}
                            <span className="break-all">{l.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ) : rightPanelOpen && (
                /* ── Create/Import: Saved Jobs panel ── */
                <div className="flex-1 overflow-auto panel-scroll p-2 space-y-1.5">
                  {groupedJobs.length === 0 && !loadingJobs ? (
                    <div className="py-8 text-center">
                      <Save size={22} className="mx-auto text-gray-200 dark:text-slate-700 mb-2" />
                      <p className="text-[11px] text-gray-400 dark:text-slate-500">No saved jobs</p>
                    </div>
                  ) : groupedJobs.map(g => (
                    <JobGroupCard
                      key={g.job_name}
                      group={g}
                      onLoad={handleLoadJob}
                      onRename={handleRenameGroup}
                      onDelete={handleDeleteJobGroup}
                      isActive={loadedJob?.job_name === g.job_name}
                    />
                  ))}
                </div>
              )}
            </div>

        </div>
      </div>

      {/* Dialogs */}
      {showNewTable && (
        <NewTableDialog
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
      {showSchemaAssign && (
        <SchemaAssignModal
          existingSchemas={designerSchemas.filter(s => s !== 'public')}
          onAssign={handleSchemaAssigned}
          onSkip={() => { setShowSchemaAssign(false); setShowSaveModal(true); }}
          onClose={() => setShowSchemaAssign(false)}
        />
      )}
      {showSaveModal && (
        <SaveJobModal
          onSave={(name, desc) => void handleSaveJob(name, desc)}
          onSkip={() => setShowSaveModal(false)}
          defaultName={loadedJob?.job_name}
          defaultDesc={loadedJob?.description ?? undefined}
        />
      )}
      {showExecModal && execModalJob && (
        <ExecuteJobModal
          job={execModalJob}
          connections={connections}
          onClose={() => { setShowExecModal(false); setExecModalJob(null); }}
          onJobDone={() => void loadJobs()}
        />
      )}
      {showErdPreview && (
        <ErdPreviewModal tables={tables} onClose={() => setShowErdPreview(false)} />
      )}
    </div>
  );
}

export default function SchemaDesigner() {
  return <SchemaDesignerInner />;
}
