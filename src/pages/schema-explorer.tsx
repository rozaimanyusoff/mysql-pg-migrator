'use client';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  Handle, Position, type Node, type Edge, type Connection,
  Panel, useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ChevronRight, ChevronDown, Database, Table2, Search,
  Plug, Unplug, RefreshCw, Download, FileSpreadsheet,
  Code2, Network, Columns, Check, X, ArrowLeft,
  Eye, EyeOff, Maximize2, Layers,
} from 'lucide-react';
import { useAuth } from '../lib/auth-context';

function getStoredToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('auth_token') ?? '';
}
import type { SchemaInfo } from './api/schema-explorer/schemas';
import type { TableInfo } from './api/schema-explorer/tables';
import type { ColumnInfo, FkInfo, TableColumnsResult } from './api/schema-explorer/columns';

// ── Types ────────────────────────────────────────────────────────────────────

type DbType = 'postgresql' | 'mysql';
type ActiveTab = 'columns' | 'erd' | 'export';

interface ConnForm {
  type: DbType;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
}

// ── ERD Node ─────────────────────────────────────────────────────────────────

function TableNode({ data }: { data: { label: string; columns: ColumnInfo[] } }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg shadow-md min-w-[220px] text-xs overflow-hidden">
      <Handle type="target" position={Position.Left} className="!bg-blue-500" />
      <Handle type="source" position={Position.Right} className="!bg-blue-500" />
      <div className="bg-blue-600 dark:bg-blue-700 text-white px-3 py-1.5 font-semibold text-[11px] tracking-wide">
        {data.label}
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-700">
        {data.columns.map((col) => (
          <div key={col.name} className="flex items-center gap-1.5 px-3 py-1 hover:bg-gray-50 dark:hover:bg-slate-700/50">
            <span className="flex gap-0.5 shrink-0 w-8">
              {col.isPk && <span className="text-amber-500 font-bold">PK</span>}
              {col.isFk && <span className="text-blue-500 font-bold">FK</span>}
              {!col.isPk && !col.isFk && <span className="text-gray-400 dark:text-slate-500">—</span>}
            </span>
            <span className="font-medium text-gray-800 dark:text-slate-200 truncate flex-1">{col.name}</span>
            <span className="text-gray-400 dark:text-slate-500 shrink-0">{col.fullType}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const nodeTypes = { table: TableNode };

// ── ERD Canvas (inner — needs ReactFlowProvider) ──────────────────────────────

function ERDInner({
  erdTableKeys,
  columnsCache,
  onFitView,
}: {
  erdTableKeys: string[];
  columnsCache: Record<string, TableColumnsResult>;
  onFitView: () => void;
}) {
  const { fitView, getViewport } = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  useEffect(() => {
    // Build nodes from erdTableKeys that have columns loaded
    const cols = 3;
    const newNodes: Node[] = [];
    erdTableKeys.forEach((key, idx) => {
      const data = columnsCache[key];
      if (!data) return;
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      newNodes.push({
        id: key,
        type: 'table',
        position: { x: col * 300, y: row * 340 },
        data: { label: key, columns: data.columns },
      });
    });

    // Build edges from FK relationships
    const newEdges: Edge[] = [];
    erdTableKeys.forEach(key => {
      const data = columnsCache[key];
      if (!data) return;
      data.fks.forEach(fk => {
        const targetKey = `${fk.toSchema}.${fk.toTable}`;
        if (erdTableKeys.includes(targetKey)) {
          const edgeId = `${key}-${fk.fromCol}->${targetKey}-${fk.toCol}`;
          newEdges.push({
            id: edgeId,
            source: key,
            target: targetKey,
            animated: true,
            label: `${fk.fromCol} → ${fk.toCol}`,
            style: { stroke: '#3b82f6' },
            labelStyle: { fontSize: 9, fill: '#6b7280' },
          });
        }
      });
    });

    setNodes(newNodes);
    setEdges(newEdges);

    setTimeout(() => fitView({ padding: 0.15 }), 100);
  }, [erdTableKeys, columnsCache]);

  const onConnect = useCallback((params: Connection) => setEdges(e => addEdge(params, e)), []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.1}
      maxZoom={2}
      className="bg-gray-50 dark:bg-slate-900"
    >
      <Background gap={20} size={1} color="#e5e7eb" />
      <Controls />
      <MiniMap nodeColor="#3b82f6" className="!bg-white dark:!bg-slate-800" />
      <Panel position="top-right" className="flex gap-2">
        <button
          onClick={() => fitView({ padding: 0.15 })}
          className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-1.5 shadow-sm"
        >
          <Maximize2 size={12} /> Fit
        </button>
      </Panel>
    </ReactFlow>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SchemaExplorer() {
  useAuth(); // ensure auth context is mounted
  const authHeader = useMemo(() => ({ Authorization: `Bearer ${getStoredToken()}` }), []);

  // Connection form
  const [form, setForm] = useState<ConnForm>({
    type: 'postgresql', host: 'localhost', port: '5432',
    database: '', username: '', password: '',
  });
  const [showPw, setShowPw] = useState(false);
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState('');
  const [connecting, setConnecting] = useState(false);

  // Tree
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set());
  const [loadingSchemas, setLoadingSchemas] = useState(false);
  const [loadingTables, setLoadingTables] = useState<Set<string>>(new Set());
  const [treeSearch, setTreeSearch] = useState('');

  // Selection
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [erdTables, setErdTables] = useState<Set<string>>(new Set());

  // Columns
  const [columnsCache, setColumnsCache] = useState<Record<string, TableColumnsResult>>({});
  const [loadingCols, setLoadingCols] = useState(false);

  // Tab
  const [activeTab, setActiveTab] = useState<ActiveTab>('columns');

  // Export
  const [exportFormat, setExportFormat] = useState<'sql' | 'xlsx'>('sql');
  const [exporting, setExporting] = useState(false);

  const connPayload = useMemo(() => ({
    type: form.type,
    host: form.host,
    port: Number(form.port),
    database: form.database,
    username: form.username,
    password: form.password,
  }), [form]);

  // ── Connect ────────────────────────────────────────────────────────────────

  const handleConnect = async () => {
    setConnecting(true);
    setConnError('');
    try {
      await axios.post('/api/schema-explorer/schemas', connPayload, { headers: authHeader });
      setConnected(true);
      loadSchemas();
    } catch (err) {
      setConnError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Connection failed') : 'Connection failed');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setConnected(false);
    setSchemas([]);
    setTables({});
    setExpandedSchemas(new Set());
    setSelectedTable(null);
    setErdTables(new Set());
    setColumnsCache({});
    setConnError('');
  };

  // ── Load schemas ───────────────────────────────────────────────────────────

  const loadSchemas = async () => {
    setLoadingSchemas(true);
    try {
      const { data } = await axios.post<{ schemas: SchemaInfo[] }>(
        '/api/schema-explorer/schemas', connPayload, { headers: authHeader }
      );
      setSchemas(data.schemas);
      if (data.schemas.length === 1) {
        void loadTables(data.schemas[0].schema);
        setExpandedSchemas(new Set([data.schemas[0].schema]));
      }
    } catch { /* ignore */ } finally {
      setLoadingSchemas(false);
    }
  };

  // ── Load tables ────────────────────────────────────────────────────────────

  const loadTables = async (schema: string) => {
    if (tables[schema]) return;
    setLoadingTables(prev => new Set(prev).add(schema));
    try {
      const { data } = await axios.post<{ tables: TableInfo[] }>(
        '/api/schema-explorer/tables',
        { conn: connPayload, schemas: [schema] },
        { headers: authHeader }
      );
      setTables(prev => ({ ...prev, [schema]: data.tables }));
    } catch { /* ignore */ } finally {
      setLoadingTables(prev => { const s = new Set(prev); s.delete(schema); return s; });
    }
  };

  const toggleSchema = (schema: string) => {
    setExpandedSchemas(prev => {
      const next = new Set(prev);
      if (next.has(schema)) { next.delete(schema); } else {
        next.add(schema);
        void loadTables(schema);
      }
      return next;
    });
  };

  // ── Load columns ──────────────────────────────────────────────────────────

  const loadColumns = async (tableKey: string) => {
    if (columnsCache[tableKey]) return;
    setLoadingCols(true);
    try {
      const { data } = await axios.post<TableColumnsResult>(
        '/api/schema-explorer/columns',
        { conn: connPayload, tableKey },
        { headers: authHeader }
      );
      setColumnsCache(prev => ({ ...prev, [tableKey]: data }));
    } catch { /* ignore */ } finally {
      setLoadingCols(false);
    }
  };

  const selectTable = (key: string) => {
    setSelectedTable(key);
    setActiveTab('columns');
    void loadColumns(key);
  };

  const toggleErd = (key: string) => {
    setErdTables(prev => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); } else {
        next.add(key);
        void loadColumns(key);
      }
      return next;
    });
  };

  const addAllToErd = (schema: string) => {
    const schemaTables = tables[schema] ?? [];
    schemaTables.forEach(t => {
      const key = `${t.schema}.${t.name}`;
      setErdTables(prev => { const n = new Set(prev); n.add(key); return n; });
      void loadColumns(key);
    });
  };

  // ── Export ────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    const keys = [...erdTables];
    if (!keys.length) return;
    setExporting(true);
    try {
      const resp = await axios.post(
        '/api/schema-explorer/export',
        { conn: connPayload, tableKeys: keys, format: exportFormat },
        { headers: authHeader, responseType: 'blob' }
      );
      const url = URL.createObjectURL(new Blob([resp.data as BlobPart]));
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFormat === 'xlsx' ? 'data-model.xlsx' : 'migration.sql';
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ } finally {
      setExporting(false);
    }
  };

  // ── Tree filtering ────────────────────────────────────────────────────────

  const filteredSchemas = useMemo(() =>
    schemas.filter(s => !treeSearch || s.schema.toLowerCase().includes(treeSearch.toLowerCase()))
  , [schemas, treeSearch]);

  // ── Columns view for selected table ──────────────────────────────────────

  const selectedCols = selectedTable ? columnsCache[selectedTable] : null;

  return (
    <>
      <Head><title>Schema Explorer</title></Head>
      <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* ── Top bar ────────────────────────────────────────────────────── */}
        <header className="shrink-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2 flex items-center gap-3">
          <Link href="/" className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300">
            <ArrowLeft size={16} />
          </Link>
          <div className="flex items-center gap-2">
            <Network size={16} className="text-blue-500" />
            <span className="text-sm font-semibold text-gray-800 dark:text-slate-200">Schema Explorer</span>
          </div>

          <div className="h-5 w-px bg-gray-200 dark:bg-slate-700 mx-1" />

          {/* DB type selector */}
          <div className="flex rounded-lg overflow-hidden border border-gray-200 dark:border-slate-700">
            {(['postgresql', 'mysql'] as DbType[]).map(t => (
              <button key={t} onClick={() => {
                if (!connected) {
                  setForm(f => ({ ...f, type: t, port: t === 'postgresql' ? '5432' : '3306' }));
                }
              }}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  form.type === t
                    ? 'bg-blue-600 text-white'
                    : 'bg-white dark:bg-slate-800 text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700'
                } ${connected ? 'cursor-default' : ''}`}
              >
                {t === 'postgresql' ? 'PostgreSQL' : 'MySQL'}
              </button>
            ))}
          </div>

          {/* Connection fields */}
          <div className="flex items-center gap-1.5">
            <input value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))}
              disabled={connected}
              placeholder="host"
              className="w-28 px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60"
            />
            <span className="text-gray-400 text-xs">:</span>
            <input value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))}
              disabled={connected}
              placeholder="port"
              className="w-14 px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60"
            />
            <input value={form.database} onChange={e => setForm(f => ({ ...f, database: e.target.value }))}
              disabled={connected}
              placeholder="database"
              className="w-28 px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60"
            />
            <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
              disabled={connected}
              placeholder="user"
              className="w-20 px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60"
            />
            <div className="relative">
              <input type={showPw ? 'text' : 'password'}
                value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                disabled={connected}
                placeholder="password"
                className="w-24 pl-2 pr-7 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60"
              />
              <button type="button" onClick={() => setShowPw(v => !v)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400">
                {showPw ? <EyeOff size={11} /> : <Eye size={11} />}
              </button>
            </div>
          </div>

          {connError && <span className="text-xs text-rose-500">{connError}</span>}

          {!connected ? (
            <button onClick={() => void handleConnect()} disabled={connecting || !form.host || !form.username}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
              <Plug size={12} /> {connecting ? 'Connecting…' : 'Connect'}
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                <Check size={12} /> Connected
              </span>
              <button onClick={handleDisconnect}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-500 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
                <Unplug size={12} /> Disconnect
              </button>
              <button onClick={() => void loadSchemas()} title="Refresh"
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800">
                <RefreshCw size={12} />
              </button>
            </div>
          )}
        </header>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0">

          {/* ── Left panel — schema/table tree ─────────────────────────── */}
          <aside className="w-64 shrink-0 flex flex-col border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            {/* search */}
            <div className="p-2 border-b border-gray-100 dark:border-slate-800">
              <div className="relative">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={treeSearch} onChange={e => setTreeSearch(e.target.value)}
                  placeholder="Filter schemas / tables…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* ERD selection summary */}
            {erdTables.size > 0 && (
              <div className="px-3 py-1.5 border-b border-gray-100 dark:border-slate-800 flex items-center justify-between">
                <span className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                  {erdTables.size} in ERD
                </span>
                <button onClick={() => setErdTables(new Set())}
                  className="text-xs text-gray-400 hover:text-rose-500">
                  Clear all
                </button>
              </div>
            )}

            {/* tree */}
            <div className="flex-1 overflow-y-auto py-1">
              {!connected && (
                <div className="px-4 py-8 text-center">
                  <Database size={28} className="mx-auto text-gray-300 dark:text-slate-600 mb-2" />
                  <p className="text-xs text-gray-400 dark:text-slate-500">Connect to a database to browse</p>
                </div>
              )}

              {connected && loadingSchemas && (
                <div className="px-4 py-4 text-xs text-gray-400 dark:text-slate-500 animate-pulse">Loading schemas…</div>
              )}

              {connected && !loadingSchemas && filteredSchemas.map(s => {
                const isExpanded = expandedSchemas.has(s.schema);
                const schemaTables = (tables[s.schema] ?? []).filter(t =>
                  !treeSearch || t.name.toLowerCase().includes(treeSearch.toLowerCase())
                );
                const isLoadingT = loadingTables.has(s.schema);

                return (
                  <div key={s.schema}>
                    {/* Schema row */}
                    <div
                      className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-slate-800 cursor-pointer group"
                      onClick={() => toggleSchema(s.schema)}
                    >
                      {isExpanded
                        ? <ChevronDown size={12} className="text-gray-400 shrink-0" />
                        : <ChevronRight size={12} className="text-gray-400 shrink-0" />}
                      <Database size={12} className="text-blue-500 shrink-0" />
                      <span className="text-xs font-medium text-gray-700 dark:text-slate-300 flex-1 truncate">{s.schema}</span>
                      <span className="text-[10px] text-gray-400 dark:text-slate-500 shrink-0">{s.tableCount}</span>
                      {isExpanded && tables[s.schema] && (
                        <button
                          onClick={e => { e.stopPropagation(); addAllToErd(s.schema); }}
                          title="Add all to ERD"
                          className="hidden group-hover:inline-flex p-0.5 rounded text-gray-400 hover:text-blue-500"
                        >
                          <Layers size={11} />
                        </button>
                      )}
                    </div>

                    {/* Tables */}
                    {isExpanded && (
                      <div>
                        {isLoadingT && (
                          <div className="pl-8 py-1 text-[10px] text-gray-400 animate-pulse">Loading…</div>
                        )}
                        {schemaTables.map(t => {
                          const key = `${t.schema}.${t.name}`;
                          const isSelected = selectedTable === key;
                          const inErd = erdTables.has(key);
                          return (
                            <div
                              key={key}
                              className={`flex items-center gap-1.5 pl-6 pr-2 py-1 cursor-pointer group ${
                                isSelected
                                  ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
                                  : 'hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-400'
                              }`}
                              onClick={() => selectTable(key)}
                            >
                              <Table2 size={11} className="shrink-0 text-gray-400 dark:text-slate-500" />
                              <span className="text-xs flex-1 truncate">{t.name}</span>
                              <span className="text-[10px] text-gray-400 shrink-0">
                                {t.rowCount.toLocaleString()}
                              </span>
                              {/* ERD toggle */}
                              <button
                                onClick={e => { e.stopPropagation(); toggleErd(key); }}
                                title={inErd ? 'Remove from ERD' : 'Add to ERD'}
                                className={`shrink-0 p-0.5 rounded transition-colors ${
                                  inErd
                                    ? 'text-blue-500'
                                    : 'text-gray-300 dark:text-slate-600 opacity-0 group-hover:opacity-100 hover:text-blue-500'
                                }`}
                              >
                                <Network size={11} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          {/* ── Right panel ────────────────────────────────────────────── */}
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden">

            {/* Tab bar */}
            <div className="shrink-0 flex items-center gap-0 border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4">
              {([
                { key: 'columns', label: 'Columns', Icon: Columns },
                { key: 'erd',     label: 'ERD',     Icon: Network },
                { key: 'export',  label: 'Export',  Icon: Download },
              ] as { key: ActiveTab; label: string; Icon: React.FC<any> }[]).map(({ key, label, Icon }) => (
                <button key={key} onClick={() => setActiveTab(key)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                    activeTab === key
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
                  }`}>
                  <Icon size={13} /> {label}
                  {key === 'erd' && erdTables.size > 0 && (
                    <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400 text-[10px] font-semibold">
                      {erdTables.size}
                    </span>
                  )}
                </button>
              ))}

              {/* Selected table label */}
              {selectedTable && activeTab === 'columns' && (
                <span className="ml-auto text-xs text-gray-400 dark:text-slate-500 font-mono">
                  {selectedTable}
                </span>
              )}
            </div>

            {/* ── Tab content ─────────────────────────────────────────── */}
            <div className="flex-1 overflow-hidden">

              {/* Columns tab */}
              {activeTab === 'columns' && (
                <div className="h-full overflow-auto">
                  {!selectedTable && (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                      <Columns size={36} className="text-gray-200 dark:text-slate-700" />
                      <p className="text-sm text-gray-400 dark:text-slate-500">Select a table from the left panel</p>
                    </div>
                  )}
                  {selectedTable && loadingCols && !selectedCols && (
                    <div className="p-8 text-sm text-gray-400 animate-pulse">Loading columns…</div>
                  )}
                  {selectedTable && selectedCols && (
                    <div>
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-slate-800/60 sticky top-0">
                            {['Column', 'Type', 'Nullable', 'Default', 'Key', 'FK Reference', 'Comment'].map(h => (
                              <th key={h} className="text-left px-4 py-2.5 text-[11px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                          {selectedCols.columns.map(col => (
                            <tr key={col.name} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                              <td className="px-4 py-2 font-medium text-gray-800 dark:text-slate-200 font-mono">
                                {col.name}
                              </td>
                              <td className="px-4 py-2 text-gray-600 dark:text-slate-400 font-mono">{col.fullType}</td>
                              <td className="px-4 py-2">
                                {col.nullable
                                  ? <span className="text-gray-400 dark:text-slate-500">YES</span>
                                  : <span className="text-rose-600 dark:text-rose-400 font-medium">NO</span>}
                              </td>
                              <td className="px-4 py-2 text-gray-500 dark:text-slate-500 font-mono text-[11px] max-w-[140px] truncate">
                                {col.defaultValue ?? <span className="text-gray-300 dark:text-slate-600">—</span>}
                              </td>
                              <td className="px-4 py-2">
                                <div className="flex gap-1">
                                  {col.isPk && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400">PK</span>}
                                  {col.isFk && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400">FK</span>}
                                  {col.isUnique && !col.isPk && <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-400">UNI</span>}
                                  {!col.isPk && !col.isFk && !col.isUnique && <span className="text-gray-300 dark:text-slate-600">—</span>}
                                </div>
                              </td>
                              <td className="px-4 py-2 text-blue-600 dark:text-blue-400 font-mono text-[11px]">
                                {col.fkRef ?? <span className="text-gray-300 dark:text-slate-600">—</span>}
                              </td>
                              <td className="px-4 py-2 text-gray-400 dark:text-slate-500 max-w-[180px] truncate">
                                {col.comment ?? '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>

                      {/* FK summary */}
                      {selectedCols.fks.length > 0 && (
                        <div className="px-4 py-3 border-t border-gray-100 dark:border-slate-800">
                          <p className="text-[11px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-2">Foreign Keys</p>
                          <div className="flex flex-wrap gap-2">
                            {selectedCols.fks.map(fk => (
                              <span key={`${fk.fromCol}->${fk.toTable}`}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border border-blue-100 dark:border-blue-900">
                                {fk.fromCol} → {fk.toSchema}.{fk.toTable}.{fk.toCol}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ERD tab */}
              {activeTab === 'erd' && (
                <div className="h-full flex flex-col">
                  {erdTables.size === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                      <Network size={36} className="text-gray-200 dark:text-slate-700" />
                      <p className="text-sm text-gray-400 dark:text-slate-500">
                        Click the <Network size={13} className="inline-block" /> icon on any table to add it to the ERD
                      </p>
                    </div>
                  ) : (
                    <ReactFlowProvider>
                      <ERDInner
                        erdTableKeys={[...erdTables]}
                        columnsCache={columnsCache}
                        onFitView={() => {}}
                      />
                    </ReactFlowProvider>
                  )}
                </div>
              )}

              {/* Export tab */}
              {activeTab === 'export' && (
                <div className="h-full overflow-auto p-6">
                  <div className="max-w-xl space-y-6">
                    <div>
                      <h2 className="text-sm font-semibold text-gray-800 dark:text-slate-200 mb-1">Export</h2>
                      <p className="text-xs text-gray-500 dark:text-slate-400">
                        Export selected tables ({erdTables.size} selected via ERD panel).
                        Add tables to the ERD first using the <Network size={11} className="inline-block" /> icon.
                      </p>
                    </div>

                    {/* Format picker */}
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-gray-600 dark:text-slate-400">Format</p>
                      <div className="flex gap-3">
                        {([
                          { v: 'sql',  label: 'Migration SQL',    Icon: Code2,          desc: 'CREATE TABLE statements with FK constraints' },
                          { v: 'xlsx', label: 'Data Model XLSX',  Icon: FileSpreadsheet, desc: 'One sheet per table with column definitions' },
                        ] as { v: 'sql'|'xlsx'; label: string; Icon: React.FC<any>; desc: string }[]).map(({ v, label, Icon, desc }) => (
                          <button key={v} onClick={() => setExportFormat(v)}
                            className={`flex-1 flex flex-col items-start gap-1 p-3 rounded-xl border-2 text-left transition-colors ${
                              exportFormat === v
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
                                : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                            }`}>
                            <div className="flex items-center gap-2">
                              <Icon size={15} className={exportFormat === v ? 'text-blue-600' : 'text-gray-500 dark:text-slate-400'} />
                              <span className={`text-xs font-semibold ${exportFormat === v ? 'text-blue-700 dark:text-blue-400' : 'text-gray-700 dark:text-slate-300'}`}>{label}</span>
                            </div>
                            <p className="text-[11px] text-gray-400 dark:text-slate-500">{desc}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Selected tables list */}
                    {erdTables.size > 0 && (
                      <div>
                        <p className="text-xs font-medium text-gray-600 dark:text-slate-400 mb-1.5">Tables to export</p>
                        <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
                          {[...erdTables].map((key, i) => (
                            <div key={key} className={`flex items-center justify-between px-3 py-2 text-xs ${i > 0 ? 'border-t border-gray-100 dark:border-slate-800' : ''}`}>
                              <span className="font-mono text-gray-700 dark:text-slate-300">{key}</span>
                              <button onClick={() => setErdTables(p => { const n = new Set(p); n.delete(key); return n; })}
                                className="text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors">
                                <X size={12} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <button
                      onClick={() => void handleExport()}
                      disabled={exporting || erdTables.size === 0}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      <Download size={14} />
                      {exporting ? 'Exporting…' : `Export ${exportFormat === 'xlsx' ? 'XLSX' : 'SQL'}`}
                    </button>
                  </div>
                </div>
              )}

            </div>
          </main>
        </div>
      </div>
    </>
  );
}
