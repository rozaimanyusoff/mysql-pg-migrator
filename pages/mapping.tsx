import React, { useEffect, useState, useRef } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import axios from 'axios';
import { toast } from 'sonner';
import { MigrationConfig } from '../lib/types';
import { mergePhase1Mappings, tableStorageKey } from '../lib/mapping-utils';
import { EmptyState } from '../components/StateComponents';
import ConnectionBadges from '../components/ConnectionBadges';
import ResetEverythingButton from '../components/ResetEverythingButton';
import PgHelpPopover from '../components/PgHelpPopover';
import {
  ChevronRight, ArrowLeft, CheckCircle, Key, Plus,
  BadgeCheck, Database, HelpCircle, PlusCircle, X, CheckCheck, ChevronUp, ChevronDown, Pencil, Save, Trash2, Check, AlertTriangle,
} from 'lucide-react';

const PG_CONN_KEY = 'pg_connection';
const TABLE_STATUS_KEY = 'mysql_table_status';
const PHASE2_REVIEWED_KEY = 'phase2_schema_reviewed';
const PHASE2_REVIEWED_STATE_KEY = 'phase2_schema_reviewed_state';
const PHASE3_TEMPLATE_READY_KEY = 'phase3_template_ready';

const PG_TYPES = [
  'SMALLINT', 'INTEGER', 'BIGINT', 'SERIAL', 'BIGSERIAL',
  'REAL', 'DOUBLE PRECISION', 'NUMERIC',
  'BOOLEAN', 'CHAR', 'VARCHAR', 'TEXT', 'BYTEA',
  'DATE', 'TIME WITHOUT TIME ZONE', 'TIMESTAMP WITHOUT TIME ZONE', 'TIMESTAMPTZ',
  'JSONB', 'JSON', 'UUID', 'BIT',
];

function localSavedAt(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function templateFileStamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function TablePreview({
  table,
  onMoveColumn,
  onReorderColumn,
  onRemoveTargetColumn,
  onUpdateColumn,
}: {
  table: MigrationConfig['tables'][0];
  onMoveColumn: (fromIndex: number, direction: 'up' | 'down') => void;
  onReorderColumn: (fromIndex: number, toIndex: number) => void;
  onRemoveTargetColumn: (columnIndex: number) => void;
  onUpdateColumn: (
    columnIndex: number,
    patch: Partial<MigrationConfig['tables'][0]['columns'][number]>
  ) => void;
}) {
  const pkCol = table.columns.find((c) => c.isPrimaryKey);
  const showUuidId = pkCol != null;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [activeEditRow, setActiveEditRow] = useState<number | null>(null);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="text-left text-xs text-gray-500 border-b border-gray-200 bg-gray-50">
            <th className="px-3 py-2 font-medium w-1/4">MySQL Column</th>
            <th className="px-3 py-2 font-medium w-1/4">PG Column</th>
            <th className="px-3 py-2 font-medium">PG Type</th>
            <th className="px-3 py-2 font-medium">Nullable</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium text-right">Order</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {showUuidId && (
            <tr className="bg-emerald-50">
              <td className="px-3 py-2 text-xs text-emerald-600 italic">
                <span className="flex items-center gap-1"><Plus size={11} /> new column</span>
              </td>
              <td className="px-3 py-2 font-mono font-semibold text-emerald-800">id</td>
              <td className="px-3 py-2">
                <span className="font-mono text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">UUID</span>
              </td>
              <td className="px-3 py-2 text-xs text-gray-500">NOT NULL</td>
              <td className="px-3 py-2">
                <span className="text-xs bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">PK · added</span>
              </td>
              <td className="px-3 py-2 text-right text-xs text-gray-400">auto</td>
            </tr>
          )}
          {table.columns.map((c, idx) => (
            <tr
              key={c.mysqlName}
              draggable={activeEditRow === null}
              onDragStart={() => {
                if (activeEditRow !== null) return;
                setDragFrom(idx);
                setDragOver(idx);
              }}
              onDragOver={(e) => {
                if (activeEditRow !== null) return;
                e.preventDefault();
                if (dragOver !== idx) setDragOver(idx);
              }}
              onDrop={(e) => {
                if (activeEditRow !== null) return;
                e.preventDefault();
                if (dragFrom === null) return;
                if (dragFrom !== idx) onReorderColumn(dragFrom, idx);
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              className={`${!c.include ? 'opacity-40 bg-gray-50' : ''} ${dragOver === idx ? 'ring-1 ring-blue-300' : ''} ${activeEditRow === null ? 'cursor-move' : ''} ${activeEditRow === idx ? 'ring-1 ring-blue-200' : ''}`}
            >
              <td className="px-3 py-2 font-mono text-gray-700">
                <span className="flex items-center gap-1">
                  {c.isPrimaryKey && <Key size={10} className="text-yellow-500 flex-shrink-0" />}
                  {c.isTargetOnly ? (
                    <span className="text-emerald-600 italic inline-flex items-center gap-1">
                      <Plus size={10} /> new column
                    </span>
                  ) : (
                    c.mysqlName
                  )}
                  {c.isPrimaryKey && (
                    <span className="ml-1 text-xs bg-gray-100 text-gray-500 px-1 rounded">
                      {c.pkHandling === 'migrate_to_id' ? '→ id' : 'kept'}
                    </span>
                  )}
                </span>
              </td>
              <td className="px-3 py-2 font-mono text-gray-700">
                {c.include ? (
                  activeEditRow === idx ? (
                    <input
                      autoFocus
                      value={c.pgName}
                      onChange={(e) => onUpdateColumn(idx, { pgName: e.target.value })}
                      className="w-full max-w-[220px] border border-blue-300 rounded px-2 py-1 text-sm bg-white"
                    />
                  ) : (
                    <span>{c.pgName}</span>
                  )
                ) : '—'}
                {activeEditRow === idx ? (
                  <input
                    value={c.description ?? ''}
                    onChange={(e) => onUpdateColumn(idx, { description: e.target.value })}
                    placeholder="PG comment"
                    className="mt-1 w-full max-w-[240px] border border-gray-200 rounded px-2 py-1 text-xs bg-white text-gray-600"
                  />
                ) : (
                  <p className="mt-1 text-xs text-gray-400">{c.description?.trim() || '—'}</p>
                )}
              </td>
              <td className="px-3 py-2">
                {c.include && activeEditRow === idx ? (
                  <select
                    value={c.pgType}
                    onChange={(e) => onUpdateColumn(idx, { pgType: e.target.value })}
                    className="w-full min-w-[140px] border border-gray-200 rounded px-2 py-1 text-xs bg-white text-blue-700 font-mono"
                  >
                    {PG_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                    {!PG_TYPES.includes(c.pgType) && (
                      <option value={c.pgType}>{c.pgType}</option>
                    )}
                  </select>
                ) : (
                  <span className="font-mono text-xs text-blue-600">{c.include ? c.pgType : '—'}</span>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-gray-500">
                {activeEditRow === idx ? (
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={c.nullable}
                      onChange={(e) => onUpdateColumn(idx, { nullable: e.target.checked })}
                      className="w-3.5 h-3.5"
                    />
                    {c.nullable ? 'YES' : 'NO'}
                  </label>
                ) : (
                  <span>{c.nullable ? 'YES' : 'NO'}</span>
                )}
              </td>
              <td className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => activeEditRow === idx && onUpdateColumn(idx, { include: !c.include })}
                  className={`text-xs font-semibold px-2 py-0.5 rounded border ${
                    c.include
                      ? 'text-green-600 border-green-200 bg-green-50'
                      : 'text-red-500 border-red-200 bg-red-50'
                  } ${activeEditRow === idx ? 'cursor-pointer' : 'cursor-not-allowed opacity-80'}`}
                  title={activeEditRow === idx ? 'Toggle include/exclude' : 'Click pencil to edit this row'}
                >
                  {c.include ? <Check size={12} /> : <X size={12} />}
                </button>
              </td>
              <td className="px-3 py-2 text-right">
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    title={activeEditRow === idx ? 'Done editing row' : 'Edit row'}
                    onClick={() => setActiveEditRow((prev) => (prev === idx ? null : idx))}
                    className={`p-1 rounded border transition-colors ${
                      activeEditRow === idx
                        ? 'border-blue-300 text-blue-600 bg-blue-50'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-100'
                    }`}
                  >
                    {activeEditRow === idx ? <Save size={12} /> : <Pencil size={12} />}
                  </button>
                  {c.isTargetOnly && (
                    <button
                      type="button"
                      title="Remove target-only column"
                      onClick={() => onRemoveTargetColumn(idx)}
                      className="p-1 rounded border border-red-200 text-red-500 hover:bg-red-50"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    title="Move up"
                    onClick={() => onMoveColumn(idx, 'up')}
                    disabled={activeEditRow !== idx || idx === 0}
                    className="p-1 rounded border border-gray-200 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    onClick={() => onMoveColumn(idx, 'down')}
                    disabled={activeEditRow !== idx || idx === table.columns.length - 1}
                    className="p-1 rounded border border-gray-200 hover:bg-gray-100 disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronDown size={12} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function Phase2() {
  const [config, setConfig] = useState<MigrationConfig | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  // Phase 1 excluded tables (locked in Phase 2)
  const [phase1Excluded, setPhase1Excluded] = useState<Set<string>>(new Set());

  // Phase 1 done tables (only these appear in Phase 2)
  const [phase1Done, setPhase1Done] = useState<Set<string>>(new Set());

  // Phase 2 schema-reviewed tables
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [reviewedState, setReviewedState] = useState<Record<string, string>>({});
  const [phase3TemplateReady, setPhase3TemplateReady] = useState<{ ready?: boolean; readyAt?: string; confirmedCount?: number; assignedKeys?: string[] } | null>(null);
  const [migrateCompletedKeys, setMigrateCompletedKeys] = useState<Set<string>>(new Set());

  // PG schemas from Phase 1 connection
  const [pgConnected, setPgConnected] = useState(false);
  const [pgSchemas, setPgSchemas] = useState<string[]>([]);
  const [pgDatabase, setPgDatabase] = useState('');

  // New schema inline add
  const [addingSchema, setAddingSchema] = useState(false);
  const [newSchemaInput, setNewSchemaInput] = useState('');

  // Help popover
  const [showHelp, setShowHelp] = useState(false);
  const [helpPos, setHelpPos] = useState({ top: 0, left: 0 });
  const helpBtnRef = useRef<HTMLButtonElement>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  useEffect(() => {
    // Load config
    const raw = localStorage.getItem('migration_config');
    if (raw) {
      const cfg = mergePhase1Mappings(JSON.parse(raw) as MigrationConfig);
      setConfig(cfg);
      localStorage.setItem('migration_config', JSON.stringify(cfg));
      // selectedTable will be set after statusRaw is loaded further below
      // (we defer via a separate effect triggered by phase1Done)
    }

    // Load Phase 1 excluded tables
    const statusRaw = localStorage.getItem(TABLE_STATUS_KEY);
    if (statusRaw) {
      const status = JSON.parse(statusRaw) as { done: string[]; excluded: string[] };
      setPhase1Excluded(new Set(status.excluded ?? []));
      const doneSet = new Set(status.done ?? []);
      setPhase1Done(doneSet);
      // Auto-select first done table
      if (status.done && status.done.length > 0) {
        setSelectedTable((prev) => prev || status.done[0]);
      }
    }

    // Load Phase 2 reviewed tables
    const reviewedRaw = localStorage.getItem(PHASE2_REVIEWED_KEY);
    if (reviewedRaw) {
      setReviewed(new Set(JSON.parse(reviewedRaw) as string[]));
    }
    const reviewedStateRaw = localStorage.getItem(PHASE2_REVIEWED_STATE_KEY);
    if (reviewedStateRaw) {
      try {
        setReviewedState(JSON.parse(reviewedStateRaw) as Record<string, string>);
      } catch {
        setReviewedState({});
      }
    }
    const templateReadyRaw = localStorage.getItem(PHASE3_TEMPLATE_READY_KEY);
    if (templateReadyRaw) {
      try {
        setPhase3TemplateReady(JSON.parse(templateReadyRaw) as { ready?: boolean; readyAt?: string; confirmedCount?: number; assignedKeys?: string[] });
      } catch {
        setPhase3TemplateReady(null);
      }
    }

    // Read PG schemas stored by Phase 1 connection
    const pgRaw = localStorage.getItem(PG_CONN_KEY);
    if (pgRaw) {
      const saved = JSON.parse(pgRaw) as { form: { database: string }; connected: boolean; schemas?: string[] };
      if (saved.connected) {
        setPgConnected(true);
        setPgSchemas(saved.schemas ?? []);
        setPgDatabase(saved.form.database || '');
      }
    }
    void loadLatestRunStatus();
  }, []);

  const loadLatestRunStatus = async () => {
    try {
      const { data } = await axios.get('/api/migration-run-status');
      const runs = (data?.runs ?? []) as Array<{ id: string }>;
      if (!runs.length) {
        setMigrateCompletedKeys(new Set());
        return;
      }
      const { data: runData } = await axios.get('/api/migration-run-status', { params: { id: runs[0].id } });
      const run = runData?.run as { tables?: Array<{ key: string; status: 'pending' | 'running' | 'completed' | 'failed' }> } | undefined;
      const next = new Set<string>();
      for (const t of run?.tables ?? []) {
        if (t.status === 'completed') next.add(t.key);
      }
      setMigrateCompletedKeys(next);
    } catch {
      // non-blocking
    }
  };

  // Ensure PG schema options can be restored from config snapshot:
  // merge pg_connection.schemas with schemas used by mapping tables.
  useEffect(() => {
    if (!config) return;
    const fromTables = [...new Set(config.tables.map((t) => (t.pgSchema || '').trim()).filter(Boolean))];
    const merged = [...new Set([...pgSchemas, ...fromTables])];
    if (merged.length === pgSchemas.length && merged.every((s, i) => s === pgSchemas[i])) return;

    setPgSchemas(merged);
    try {
      const raw = localStorage.getItem(PG_CONN_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { form?: { database?: string }; connected?: boolean; schemas?: string[] };
        localStorage.setItem(
          PG_CONN_KEY,
          JSON.stringify({
            ...saved,
            form: saved.form ?? { database: pgDatabase || config.targetDatabase || '' },
            connected: Boolean(saved.connected),
            schemas: merged,
          })
        );
      } else {
        localStorage.setItem(
          PG_CONN_KEY,
          JSON.stringify({
            form: { database: pgDatabase || config.targetDatabase || '' },
            connected: false,
            schemas: merged,
          })
        );
      }
    } catch {
      // non-blocking
    }
  }, [config, pgSchemas, pgDatabase]);

  // Composite key helper: "sourceDatabase::mysqlName"
  const tKey = (t: { sourceDatabase?: string; mysqlName: string }) =>
    t.sourceDatabase ? `${t.sourceDatabase}::${t.mysqlName}` : t.mysqlName;

  // Match a table by composite key (with backward-compat for plain mysqlName)
  const matchByKey = (t: { sourceDatabase?: string; mysqlName: string }, key: string) =>
    tKey(t) === key || t.mysqlName === key;
  const allTables = config?.tables ?? [];
  const configureTotal = allTables.length;
  const includedTables = allTables.filter(
    (t) => t.include && !phase1Excluded.has(tKey(t)) && !phase1Excluded.has(t.mysqlName)
  );
  // Only tables marked Done in Phase 1 appear in the Phase 2 sidebar
  const doneTables = allTables.filter(
    (t) => phase1Done.has(tKey(t)) || phase1Done.has(t.mysqlName)
  );
  const configureDone = doneTables.length;
  const assignTotal = doneTables.length;
  const totalCols = includedTables.reduce(
    (sum, t) => sum + t.columns.filter((c) => c.include).length,
    0
  );
  const selectedTableData = allTables.find((t) => matchByKey(t, selectedTable ?? ''));
  const tableSignature = (t: MigrationConfig['tables'][number]) =>
    JSON.stringify({
      pgSchema: t.pgSchema,
      pgName: t.pgName,
      columns: t.columns.map((c) => ({
        mysqlName: c.mysqlName,
        pgName: c.pgName,
        pgType: c.pgType,
        include: c.include,
        nullable: c.nullable,
        isTargetOnly: c.isTargetOnly ?? false,
        pkHandling: c.pkHandling ?? '',
        description: c.description ?? '',
      })),
    });
  const isReviewedTable = (t: MigrationConfig['tables'][number]) =>
    reviewed.has(tKey(t)) || reviewed.has(t.mysqlName);
  const reviewedSnapshotFor = (t: MigrationConfig['tables'][number]) =>
    reviewedState[tKey(t)] ?? reviewedState[t.mysqlName];
  const isReviewedDirty = (t: MigrationConfig['tables'][number]) => {
    if (!isReviewedTable(t)) return false;
    const baseline = reviewedSnapshotFor(t);
    if (!baseline) return false;
    return baseline !== tableSignature(t);
  };
  const assignDone = doneTables.filter((t) => isReviewedTable(t) && !isReviewedDirty(t)).length;
  const hasDirtyReviewed = doneTables.some((t) => isReviewedDirty(t));
  const assignConfirmedKeys = doneTables.filter((t) => isReviewedTable(t) && !isReviewedDirty(t)).map((t) => tKey(t));
  const assignedTemplateKeySet = new Set(phase3TemplateReady?.assignedKeys ?? []);
  const templateAssigned = phase3TemplateReady?.ready
    ? (assignedTemplateKeySet.size > 0
      ? assignConfirmedKeys.filter((k) => assignedTemplateKeySet.has(k)).length
      : Math.min(phase3TemplateReady.confirmedCount ?? assignDone, assignDone))
    : 0;
  const templateScopeKeysForMigrate = phase3TemplateReady?.ready
    ? (assignedTemplateKeySet.size > 0 ? assignConfirmedKeys.filter((k) => assignedTemplateKeySet.has(k)) : assignConfirmedKeys)
    : [];
  const migrateTotal = templateAssigned;
  const migrateSuccess = Math.min(
    templateScopeKeysForMigrate.filter((k) => migrateCompletedKeys.has(k)).length,
    migrateTotal
  );
  const handleHomeNavigate = () => {
    const ok = window.confirm('Return to module home and clear all local session data?');
    if (!ok) return;
    localStorage.clear();
    window.location.href = '/';
  };

  const handleSchemaChange = (tableKey: string, newSchema: string) => {
    if (!config) return;
    const tables = config.tables.map((t) =>
      matchByKey(t, tableKey) ? { ...t, pgSchema: newSchema } : t
    );
    const updated = { ...config, tables, updatedAt: new Date().toISOString() };
    setConfig(updated);
    localStorage.setItem('migration_config', JSON.stringify(updated));
  };

  const handlePgNameChange = (tableKey: string, newPgName: string) => {
    if (!config) return;
    const target = config.tables.find((t) => matchByKey(t, tableKey));
    if (target) {
      persistPhase1TableStorage(target, target.columns, { pgName: newPgName });
    }
    const tables = config.tables.map((t) =>
      matchByKey(t, tableKey) ? { ...t, pgName: newPgName } : t
    );
    const updated = { ...config, tables, updatedAt: new Date().toISOString() };
    setConfig(updated);
    localStorage.setItem('migration_config', JSON.stringify(updated));
  };

  const handleMarkReviewed = (tableKey: string) => {
    const next = new Set(reviewed);
    next.add(tableKey);
    setReviewed(next);
    localStorage.setItem(PHASE2_REVIEWED_KEY, JSON.stringify([...next]));
    if (config) {
      const table = config.tables.find((t) => matchByKey(t, tableKey));
      if (table) {
        const nextState = { ...reviewedState, [tKey(table)]: tableSignature(table) };
        setReviewedState(nextState);
        localStorage.setItem(PHASE2_REVIEWED_STATE_KEY, JSON.stringify(nextState));
      }
    }
  };

  useEffect(() => {
    if (!config) return;
    const nextState = { ...reviewedState };
    let changed = false;
    for (const t of config.tables) {
      const key = tKey(t);
      if (!(reviewed.has(key) || reviewed.has(t.mysqlName))) continue;
      if (!nextState[key]) {
        nextState[key] = tableSignature(t);
        changed = true;
      }
    }
    if (changed) {
      setReviewedState(nextState);
      localStorage.setItem(PHASE2_REVIEWED_STATE_KEY, JSON.stringify(nextState));
    }
  }, [config, reviewed, reviewedState]);

  const persistPhase1TableStorage = (
    table: MigrationConfig['tables'][number],
    columns: MigrationConfig['tables'][number]['columns'],
    overrides?: { pgName?: string }
  ) => {
    if (!config) return;
    try {
      const db = table.sourceDatabase || config.sourceDatabase;
      const key = tableStorageKey(db, table.mysqlName);
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) as { pgName?: string; tableDescription?: string } : null;
      localStorage.setItem(
        key,
        JSON.stringify({
          pgName: overrides?.pgName ?? parsed?.pgName ?? table.pgName,
          columns,
          tableDescription: parsed?.tableDescription ?? table.description ?? '',
        })
      );
    } catch {
      // non-blocking
    }
  };

  const handleMoveColumn = (tableKey: string, fromIndex: number, direction: 'up' | 'down') => {
    if (!config) return;
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
    handleReorderColumn(tableKey, fromIndex, toIndex);
  };

  const handleReorderColumn = (tableKey: string, fromIndex: number, toIndex: number) => {
    if (!config) return;
    if (toIndex < 0) return;

    const tables = config.tables.map((t) => {
      if (!matchByKey(t, tableKey)) return t;
      if (toIndex >= t.columns.length) return t;
      if (fromIndex === toIndex) return t;

      const nextColumns = [...t.columns];
      const [moved] = nextColumns.splice(fromIndex, 1);
      nextColumns.splice(toIndex, 0, moved);

      const nextTable = { ...t, columns: nextColumns };

      // Keep Phase 1 per-table storage in sync so ordering persists across reloads.
      persistPhase1TableStorage(t, nextColumns);

      return nextTable;
    });

    const updated = { ...config, tables, updatedAt: new Date().toISOString() };
    setConfig(updated);
    localStorage.setItem('migration_config', JSON.stringify(updated));
  };

  const handleUpdateColumn = (
    tableKey: string,
    columnIndex: number,
    patch: Partial<MigrationConfig['tables'][number]['columns'][number]>
  ) => {
    if (!config) return;
    const tables = config.tables.map((t) => {
      if (!matchByKey(t, tableKey)) return t;
      if (columnIndex < 0 || columnIndex >= t.columns.length) return t;
      const nextColumns = [...t.columns];
      nextColumns[columnIndex] = { ...nextColumns[columnIndex], ...patch };
      persistPhase1TableStorage(t, nextColumns);
      return { ...t, columns: nextColumns };
    });
    const updated = { ...config, tables, updatedAt: new Date().toISOString() };
    setConfig(updated);
    localStorage.setItem('migration_config', JSON.stringify(updated));
  };

  const handleAddTargetColumn = (tableKey: string) => {
    if (!config) return;
    const tables = config.tables.map((t) => {
      if (!matchByKey(t, tableKey)) return t;
      const id = Date.now();
      const nextColumns = [
        ...t.columns,
        {
          mysqlName: `__target_only_${id}`,
          sourceMysqlName: '',
          pgName: `new_column_${t.columns.length + 1}`,
          mysqlType: '(target-only)',
          pgType: 'TEXT',
          nullable: true,
          defaultValue: null,
          isPrimaryKey: false,
          isUnique: false,
          indexStrategy: 'none' as const,
          description: '',
          include: true,
          isTargetOnly: true,
        },
      ];
      persistPhase1TableStorage(t, nextColumns);
      return { ...t, columns: nextColumns };
    });

    const updated = { ...config, tables, updatedAt: new Date().toISOString() };
    setConfig(updated);
    localStorage.setItem('migration_config', JSON.stringify(updated));
  };

  const handleRemoveTargetColumn = (tableKey: string, columnIndex: number) => {
    if (!config) return;
    const tables = config.tables.map((t) => {
      if (!matchByKey(t, tableKey)) return t;
      const col = t.columns[columnIndex];
      if (!col?.isTargetOnly) return t;
      const nextColumns = t.columns.filter((_, idx) => idx !== columnIndex);
      persistPhase1TableStorage(t, nextColumns);
      return { ...t, columns: nextColumns };
    });

    const updated = { ...config, tables, updatedAt: new Date().toISOString() };
    setConfig(updated);
    localStorage.setItem('migration_config', JSON.stringify(updated));
  };

  const handleConfirmAndSaveTemplate = async () => {
    if (!config) return;
    setSavingConfig(true);
    try {
      const safeParse = <T,>(raw: string | null): T | null => {
        if (!raw) return null;
        try { return JSON.parse(raw) as T; } catch { return null; }
      };
      const status = safeParse<{ done?: string[]; excluded?: string[] }>(
        localStorage.getItem(TABLE_STATUS_KEY)
      );
      const doneSet = new Set(status?.done ?? []);
      const excludedSet = new Set(status?.excluded ?? []);
      const keyOf = (t: MigrationConfig['tables'][number]) =>
        t.sourceDatabase ? `${t.sourceDatabase}::${t.mysqlName}` : t.mysqlName;
      const readyAt = new Date().toISOString();
      const templateState = {
        ready: true,
        readyAt,
        confirmedCount: assignDone,
        assignedKeys: assignConfirmedKeys,
      };

      const canonical: MigrationConfig = {
        ...config,
        tables: config.tables.map((t) => {
          const key = keyOf(t);
          const isDone = doneSet.has(key) || doneSet.has(t.mysqlName);
          const isExcluded = excludedSet.has(key) || excludedSet.has(t.mysqlName);
          return { ...t, include: isDone && !isExcluded };
        }),
        phase3TemplateReady: true,
        phase3TemplateReadyAt: readyAt,
        updatedAt: readyAt,
      };
      localStorage.setItem('migration_config', JSON.stringify(canonical));
      localStorage.setItem(PHASE3_TEMPLATE_READY_KEY, JSON.stringify(templateState));
      setConfig(canonical);
      setPhase3TemplateReady(templateState);

      const snapshot = {
        meta: {
          module: 'migration',
          savedAt: localSavedAt(),
          note: 'Template snapshot from Phase 2 (confirmed mappings)',
        },
        mysql_connection_creds: safeParse<Record<string, unknown>>(localStorage.getItem('mysql_connection_creds')),
        mysql_connection_state: safeParse<Record<string, unknown>>(localStorage.getItem('mysql_connection_state')),
        pg_connection: safeParse<Record<string, unknown>>(localStorage.getItem('pg_connection')),
        inspection_result: safeParse<Record<string, unknown> | Array<Record<string, unknown>>>(localStorage.getItem('inspection_result')),
        mysql_table_status: safeParse<Record<string, unknown>>(localStorage.getItem('mysql_table_status')),
        migration_config: canonical,
        phase2_schema_reviewed: safeParse<Array<string>>(localStorage.getItem(PHASE2_REVIEWED_KEY)),
        phase2_schema_reviewed_state: safeParse<Record<string, string>>(localStorage.getItem(PHASE2_REVIEWED_STATE_KEY)),
        phase3_template_ready: templateState,
        phase1_hidden_databases: safeParse<Array<string>>(localStorage.getItem('phase1_hidden_databases')),
        table_mappings: Object.fromEntries(
          Object.keys(localStorage)
            .filter((k) => k.startsWith('table_mappings_'))
            .map((k) => {
              const raw = localStorage.getItem(k);
              const parsed = safeParse<unknown>(raw);
              return [k, parsed];
            })
        ),
      };
      const { data } = await axios.post('/api/schema-config-save', {
        module: 'migration',
        name: config.name || 'migration',
        fileName: `template_${templateFileStamp()}.json`,
        snapshot,
      });
      toast.success(`Confirmed & template saved: ${data.fileName}`);
    } catch (err: unknown) {
      const message = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      window.alert(message);
    } finally {
      setSavingConfig(false);
    }
  };


  const handleAddSchema = (tableKey: string) => {
    const name = newSchemaInput.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!name) return;
    if (!pgSchemas.includes(name)) {
      const updated = [...pgSchemas, name];
      setPgSchemas(updated);
      // Persist back so Phase 1 localStorage reflects it too
      try {
        const raw = localStorage.getItem(PG_CONN_KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          localStorage.setItem(PG_CONN_KEY, JSON.stringify({ ...saved, schemas: updated }));
        }
      } catch { /* ignore */ }
    }
    handleSchemaChange(tableKey, name);
    setNewSchemaInput('');
    setAddingSchema(false);
  };

  if (!config) {
    return (
      <>
        <Head>
          <title>Mapping Preview — Phase 2</title>
        </Head>
        <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
          <header className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="font-bold text-gray-900 dark:text-slate-100">Migration: Assign Target</h1>
              <p className="text-xs text-gray-500 dark:text-slate-400">Review confirmed tables and assign PostgreSQL schema/table targets.</p>
            </div>
            <ConnectionBadges />
            <nav className="flex items-center gap-1 text-sm">
              {[
                { label: 'Home', href: '/' },
                { label: 'Source Selection', href: '/migration' },
                { label: 'Mapping Config', href: '/mapping', active: true },
                { label: 'Schema Template', href: '/docs' },
                { label: 'Migrate', href: '/migrate' },
              ].map((item, i) => (
                <React.Fragment key={item.href}>
                  {i > 0 && <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />}
                  {item.href === '/' ? (
                    <button
                      type="button"
                      onClick={handleHomeNavigate}
                      className={`px-3 py-1 rounded-lg ${(item as { active?: boolean }).active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}
                    >
                      {item.label}
                    </button>
                  ) : (
                    <Link
                      href={item.href}
                      className={`px-3 py-1 rounded-lg ${(item as { active?: boolean }).active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}
                    >
                      {item.label}
                      {item.href === '/migration' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-200/70 dark:bg-blue-800/70 text-blue-800 dark:text-blue-200 font-semibold">
                          {configureDone}/{configureTotal}
                        </span>
                      )}
                      {item.href === '/mapping' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-200/70 dark:bg-emerald-800/70 text-emerald-800 dark:text-emerald-200 font-semibold">
                          {assignDone}/{assignTotal}
                        </span>
                      )}
                      {item.href === '/docs' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-200/70 dark:bg-amber-800/70 text-amber-800 dark:text-amber-200 font-semibold">
                          {templateAssigned}/{assignDone}
                        </span>
                      )}
                      {item.href === '/migrate' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-cyan-200/70 dark:bg-cyan-800/70 text-cyan-800 dark:text-cyan-200 font-semibold">
                          {migrateSuccess}/{migrateTotal}
                        </span>
                      )}
                    </Link>
                  )}
                </React.Fragment>
              ))}
              <span className="w-px h-5 bg-gray-200 dark:bg-slate-700 mx-1" />
              <ResetEverythingButton />
            </nav>
          </header>
          <main className="max-w-7xl mx-auto px-6 py-20">
            <EmptyState
              title="No inspection data found"
              description="Go to Configure Mapping and inspect your MySQL database first."
            />
          </main>
        </div>
      </>
    );
  }

  return (
    <>
      <Head>
        <title>Mapping Preview — Phase 2</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        {/* Header */}
        <header className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-900 dark:text-slate-100">Migration: Assign Target</h1>
            <p className="text-xs text-gray-500 dark:text-slate-400">Review confirmed tables and assign PostgreSQL schema/table targets.</p>
          </div>
          <ConnectionBadges />
          <nav className="flex items-center gap-1 text-sm">
            {[
              { label: 'Home', href: '/' },
              { label: 'Source Selection', href: '/migration' },
              { label: 'Mapping Config', href: '/mapping', active: true },
              { label: 'Schema Template', href: '/docs' },
              { label: 'Migrate', href: '/migrate' },
            ].map((item, i) => (
              <React.Fragment key={item.href}>
                {i > 0 && <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />}
                  {item.href === '/' ? (
                    <button
                      type="button"
                      onClick={handleHomeNavigate}
                      className={`px-3 py-1 rounded-lg ${(item as { active?: boolean }).active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}
                    >
                      {item.label}
                    </button>
                  ) : (
                    <Link
                      href={item.href}
                      className={`px-3 py-1 rounded-lg ${(item as { active?: boolean }).active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}
                    >
                      {item.label}
                      {item.href === '/migration' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-200/70 dark:bg-blue-800/70 text-blue-800 dark:text-blue-200 font-semibold">
                          {configureDone}/{configureTotal}
                        </span>
                      )}
                      {item.href === '/mapping' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-200/70 dark:bg-emerald-800/70 text-emerald-800 dark:text-emerald-200 font-semibold">
                          {assignDone}/{assignTotal}
                        </span>
                      )}
                      {item.href === '/docs' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-200/70 dark:bg-amber-800/70 text-amber-800 dark:text-amber-200 font-semibold">
                          {templateAssigned}/{assignDone}
                        </span>
                      )}
                      {item.href === '/migrate' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-cyan-200/70 dark:bg-cyan-800/70 text-cyan-800 dark:text-cyan-200 font-semibold">
                          {migrateSuccess}/{migrateTotal}
                        </span>
                      )}
                    </Link>
                  )}
                </React.Fragment>
              ))}
            <span className="w-px h-5 bg-gray-200 dark:bg-slate-700 mx-1" />
            <ResetEverythingButton />
          </nav>
        </header>

        {/* Action bar */}
        <div className="bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between flex-wrap gap-3">
          <div className="flex gap-5 text-sm text-gray-600">
            <span><strong className="text-gray-900">{config.tables.length}</strong> tables</span>
            <span className="text-green-700"><strong>{includedTables.length}</strong> included</span>
            {phase1Excluded.size > 0 && (
              <span className="text-gray-400"><strong>{phase1Excluded.size}</strong> excluded (Phase 1)</span>
            )}
            <span><strong>{totalCols}</strong> columns mapped</span>
            <button
              type="button"
              onClick={handleConfirmAndSaveTemplate}
              disabled={savingConfig}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors disabled:opacity-50 bg-emerald-100 text-emerald-700 border-emerald-200 hover:bg-emerald-200 ${hasDirtyReviewed ? 'animate-pulse' : ''}`}
              title="Confirm mapping and save template"
            >
              <Save size={12} />
              {savingConfig ? 'Saving…' : 'Confirmed & Save as Template'}
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href="/migration"
              className="flex items-center gap-1 text-sm text-gray-600 border border-gray-200 px-3 py-1.5 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft size={14} /> Select More Tables
            </Link>

            {/* Confirmed counter — read-only status indicator */}
            <span
              className={`flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg border ${assignDone > 0 && assignDone === doneTables.length
                ? 'bg-green-50 text-green-700 border-green-200'
                : 'bg-gray-50 text-gray-500 border-gray-200'
                }`}
            >
              <CheckCheck size={14} />
              {assignDone} / {doneTables.length} Confirmed & Add to Template
            </span>

            <Link
              href="/docs"
              className="flex items-center gap-1 text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              Schema Template <ChevronRight size={14} />
            </Link>
          </div>
        </div>

        {/* Body */}
        <div className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-4 gap-6">
          {/* Table list sidebar */}
          <aside className="col-span-1">
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden sticky top-6">
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tables</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {doneTables.length} ready · {phase1Excluded.size} excluded
                </p>
              </div>
              <ul className="divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
                {doneTables.map((t) => {
                  const key = tKey(t);
                  const isReviewed = reviewed.has(key) || reviewed.has(t.mysqlName);
                  const isDirty = isReviewedDirty(t);
                  const pkCol = t.columns.find((c) => c.isPrimaryKey);
                  const newColCount = t.columns.filter((c) => c.include).length + (pkCol ? 1 : 0);
                  const oldColCount = t.columns.length;

                  return (
                    <li key={t.mysqlName}>
                      <button
                        onClick={() => setSelectedTable(key)}
                        className={`w-full text-left px-3 py-2.5 hover:bg-blue-50 transition-colors ${selectedTable === key || selectedTable === t.mysqlName ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                          }`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1 min-w-0">
                            {/* Source line */}
                            <p className="text-xs font-mono leading-tight truncate text-gray-600">
                              <span className="text-gray-400">{t.sourceDatabase ?? config.sourceDatabase}.</span>
                              <span className="text-gray-800 font-medium">{t.mysqlName}</span>
                              <span className="text-gray-400 ml-1">({oldColCount})</span>
                            </p>
                            {/* Arrow + target line */}
                            <p className="text-xs font-mono leading-tight truncate mt-0.5 text-blue-600">
                              <span className="mr-1 text-gray-300">→</span>
                              <span className="text-gray-400">{t.pgSchema}.</span>
                              <span>{t.pgName}</span>
                              <span className="text-gray-400 ml-1">({newColCount})</span>
                            </p>
                            {/* Table description */}
                            {t.description && (
                              <p className="text-xs text-gray-400 mt-0.5 truncate italic">{t.description}</p>
                            )}
                          </div>
                          {/* Reviewed badge */}
                          {isReviewed && !isDirty && (
                            <BadgeCheck size={14} className="text-green-500 flex-shrink-0 mt-0.5" />
                          )}
                          {isReviewed && isDirty && (
                            <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                          )}
                        </div>
                      </button>
                    </li>
                  );
                })}
                {doneTables.length === 0 && (
                  <li className="px-4 py-6 text-center">
                    <p className="text-xs text-gray-400">No tables marked as Done in Phase 1.</p>
                    <Link href="/migration" className="text-xs text-blue-500 underline mt-1 inline-block">← Select More Tables</Link>
                  </li>
                )}
              </ul>
              <div className="px-4 py-2 bg-gray-50 border-t border-gray-100">
                <p className="text-xs text-gray-400 flex items-center gap-1">
                  <ArrowLeft size={11} />
                  <Link href="/migration" className="underline hover:text-blue-500">Select More Tables</Link>
                  {' '}to mark more tables
                </p>
              </div>
            </div>
          </aside>

          {/* Right panel */}
          <div className="col-span-3 space-y-4">
            {selectedTableData && (phase1Done.has(tKey(selectedTableData)) || phase1Done.has(selectedTableData.mysqlName)) ? (
              <>
                {/* Schema Assignment Panel */}
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
                    <div>
                      <h2 className="font-semibold text-gray-800 text-sm flex items-center gap-2">
                        <Database size={14} className="text-blue-500" />
                        Target Schema Assignment
                      </h2>
                      <p className="text-xs text-gray-400 mt-0.5">
                        Choose which PostgreSQL schema this table will be migrated to
                      </p>
                    </div>
                    <button
                      onClick={() => handleMarkReviewed(tKey(selectedTableData))}
                      className={`flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg transition-colors ${
                        isReviewedTable(selectedTableData)
                          ? isReviewedDirty(selectedTableData)
                            ? 'bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 animate-pulse'
                            : 'bg-green-100 text-green-700 border border-green-200'
                          : 'bg-green-600 hover:bg-green-700 text-white'
                      }`}
                    >
                      <BadgeCheck size={14} />
                      {isReviewedTable(selectedTableData)
                        ? (isReviewedDirty(selectedTableData) ? 'Save Changes' : 'Schema Confirmed')
                        : 'Mark as Done'}
                    </button>
                  </div>

                  <div className="px-5 py-5">
                    {/* Top row: three equal columns */}
                    <div className="grid grid-cols-3 gap-4 items-start">
                      {/* MySQL Source */}
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">MySQL Source</span>
                        <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                          <p className="font-mono text-sm text-gray-700">
                            <span className="text-gray-400">{selectedTableData.sourceDatabase ?? config.sourceDatabase}.</span>
                            <span className="font-semibold">{selectedTableData.mysqlName}</span>
                          </p>
                          <p className="text-xs text-gray-400 mt-0.5">{selectedTableData.columns.length} columns</p>
                        </div>
                      </div>

                      {/* PG Schema */}
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs text-gray-400 font-medium uppercase tracking-wide flex items-center gap-1">
                          PG Schema
                          <button
                            ref={helpBtnRef}
                            type="button"
                            onClick={() => {
                              if (helpBtnRef.current) {
                                const r = helpBtnRef.current.getBoundingClientRect();
                                setHelpPos({ top: r.bottom + 6, left: r.left });
                              }
                              setShowHelp((v) => !v);
                            }}
                            className="text-gray-300 hover:text-blue-400 transition-colors"
                            title="How to create DB, schema & roles"
                          >
                            <HelpCircle size={13} />
                          </button>
                        </span>
                        {pgSchemas.length > 0 ? (
                          <div className="flex items-center gap-1.5">
                            {addingSchema ? (
                              <>
                                <input
                                  autoFocus
                                  type="text"
                                  value={newSchemaInput}
                                  onChange={(e) => setNewSchemaInput(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleAddSchema(selectedTableData.mysqlName);
                                    if (e.key === 'Escape') { setAddingSchema(false); setNewSchemaInput(''); }
                                  }}
                                  placeholder="new_schema"
                                  className="border border-blue-300 rounded-lg px-3 py-2 text-sm font-mono flex-1 focus:outline-none focus:border-blue-500"
                                />
                                <button onClick={() => handleAddSchema(tKey(selectedTableData))} className="text-blue-600 hover:text-blue-800" title="Save schema"><Check size={16} /></button>
                                <button onClick={() => { setAddingSchema(false); setNewSchemaInput(''); }} className="text-gray-400 hover:text-gray-600" title="Cancel"><X size={15} /></button>
                              </>
                            ) : (
                              <>
                                <select
                                  value={selectedTableData.pgSchema}
                                  onChange={(e) => handleSchemaChange(tKey(selectedTableData), e.target.value)}
                                  className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono bg-white focus:border-blue-400 focus:outline-none"
                                >
                                  {pgSchemas.map((s) => (
                                    <option key={s} value={s}>{s}</option>
                                  ))}
                                  {!pgSchemas.includes(selectedTableData.pgSchema) && (
                                    <option value={selectedTableData.pgSchema}>{selectedTableData.pgSchema}</option>
                                  )}
                                </select>
                                <button onClick={() => setAddingSchema(true)} title="Add new schema" className="text-gray-400 hover:text-blue-500 transition-colors"><PlusCircle size={16} /></button>
                              </>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-col gap-1">
                            <input
                              type="text"
                              value={selectedTableData.pgSchema}
                              onChange={(e) => handleSchemaChange(tKey(selectedTableData), e.target.value)}
                              className="border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono bg-white focus:border-blue-400 focus:outline-none w-full"
                              placeholder="public"
                            />
                            <Link href="/migration" className="text-xs text-amber-600 hover:text-amber-700 underline">Connect PG in Configure Mapping</Link>
                          </div>
                        )}
                      </div>

                      {/* PG Table Name */}
                      <div className="flex flex-col gap-1.5">
                        <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">PG Table Name</span>
                        <input
                          type="text"
                          value={selectedTableData.pgName}
                          onChange={(e) => handlePgNameChange(tKey(selectedTableData), e.target.value)}
                          className="w-full font-mono text-sm text-blue-700 font-semibold border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300"
                          placeholder="table_name"
                        />
                        <span className="text-xs text-gray-400">
                          {selectedTableData.columns.filter((c) => c.include).length + (selectedTableData.columns.find((c) => c.isPrimaryKey) ? 1 : 0)} columns
                        </span>
                      </div>
                    </div>

                    {/* Full target path — full width bottom row */}
                    <div className="mt-4 pt-4 border-t border-gray-100 flex items-center justify-between">
                      <span className="text-xs text-gray-400 font-medium uppercase tracking-wide">Full Target Path</span>
                      <span className="font-mono text-sm">
                        {pgDatabase && <span className="text-gray-400">{pgDatabase}/</span>}
                        <span className="text-gray-500">{selectedTableData.pgSchema}.</span>
                        <span className="font-bold text-blue-700">{selectedTableData.pgName}</span>
                      </span>
                    </div>
                  </div>
                </div>

                {/* Column mapping preview */}
                <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                  <div className="px-5 py-3 border-b border-gray-100 bg-gray-50 flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <h2 className="font-semibold text-gray-800 text-sm">Column Mapping Preview</h2>
                      <div className="mt-1 flex gap-3 text-xs text-gray-500">
                        <span>
                          <strong className="text-gray-700">
                            {selectedTableData.columns.filter((c) => c.include).length}
                          </strong>{' '}columns included
                        </span>
                        {selectedTableData.columns.some(
                          (c) => c.isPrimaryKey && (c.pkHandling === 'migrate_to_id' || c.pkHandling === 'keep')
                        ) && (
                            <span className="text-emerald-600 font-medium">+ id UUID added</span>
                          )}
                        {selectedTableData.columns.some((c) => !c.include) && (
                          <span className="text-red-400">
                            {selectedTableData.columns.filter((c) => !c.include).length} excluded
                          </span>
                        )}
                      </div>
                      <div className="mt-2 inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded border border-amber-200 bg-amber-50 text-amber-700">
                        <AlertTriangle size={12} />
                        Final changes can be made here: include/exclude, rename PG column, type, nullable, comment, add, and reorder columns.
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleAddTargetColumn(tKey(selectedTableData))}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100"
                    >
                      <PlusCircle size={12} />
                      Add PG Column
                    </button>
                  </div>
                  <TablePreview
                    table={selectedTableData}
                    onMoveColumn={(fromIndex, direction) =>
                      handleMoveColumn(tKey(selectedTableData), fromIndex, direction)
                    }
                    onReorderColumn={(fromIndex, toIndex) =>
                      handleReorderColumn(tKey(selectedTableData), fromIndex, toIndex)
                    }
                    onRemoveTargetColumn={(columnIndex) =>
                      handleRemoveTargetColumn(tKey(selectedTableData), columnIndex)
                    }
                    onUpdateColumn={(columnIndex, patch) =>
                      handleUpdateColumn(tKey(selectedTableData), columnIndex, patch)
                    }
                  />
                </div>
              </>
            ) : !selectedTable || !doneTables.find((t) => matchByKey(t, selectedTable)) ? (
              <EmptyState
                title="Select a table"
                description="Click a table in the sidebar to view its schema assignment and column mapping."
              />
            ) : null}
          </div>
        </div>
      </div>

      {/* Help popover — fixed so it escapes overflow-hidden containers */}
      {showHelp && (
        <PgHelpPopover
          top={helpPos.top}
          left={helpPos.left}
          onClose={() => setShowHelp(false)}
        />
      )}
    </>
  );
}
