'use client';
import Head from 'next/head';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import axios from 'axios';
import {
  ReactFlow, Background, Controls, MiniMap,
  useNodesState, useEdgesState, addEdge,
  BaseEdge, getSmoothStepPath,
  Handle, Position, type Node, type Edge, type Connection, type EdgeProps,
  Panel, useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ChevronRight, Database, Table2, Search,
  Plug, Unplug, RefreshCw, Download, FileSpreadsheet,
  Code2, Network, Columns, Check, X, Maximize2,
  ExternalLink, Printer, ArrowLeft, Layers,
} from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import type { ConnectionRow } from './api/connections/index';
import type { SchemaInfo } from './api/schema-explorer/schemas';
import type { TableInfo } from './api/schema-explorer/tables';
import type { ColumnInfo, TableColumnsResult } from './api/schema-explorer/columns';
import type { RecordsResult } from './api/schema-explorer/records';

function getStoredToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('auth_token') ?? '';
}

// ── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = 'columns' | 'erd' | 'export';

interface ConnPayload {
  type: 'postgresql' | 'mysql';
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

function connToPayload(c: ConnectionRow): ConnPayload {
  return {
    type: c.db_type === 'postgres' ? 'postgresql' : 'mysql',
    host: c.host,
    port: c.port,
    database: c.database_name,
    username: c.username,
    password: c.password_enc ?? '',
  };
}

// ── ERD Node ─────────────────────────────────────────────────────────────────

function TableNode({ data }: { data: { label: string; columns: ColumnInfo[]; onNavigate: () => void } }) {
  return (
    <div className="bg-white dark:bg-slate-800 border border-gray-300 dark:border-slate-600 rounded-lg shadow-md min-w-[220px] text-xs overflow-hidden">
      <Handle type="target" position={Position.Left} className="!bg-blue-500" />
      <Handle type="source" position={Position.Right} className="!bg-blue-500" />
      <div className="bg-blue-600 dark:bg-blue-700 text-white px-3 py-1.5 font-semibold text-[11px] tracking-wide flex items-center justify-between">
        <span className="truncate">{data.label}</span>
        <button
          onMouseDown={e => { e.stopPropagation(); data.onNavigate(); }}
          title="View columns"
          className="shrink-0 ml-1.5 p-0.5 rounded hover:bg-blue-500/60 transition-colors"
        >
          <ExternalLink size={10} />
        </button>
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

// ── Crow's foot edge ──────────────────────────────────────────────────────────

function CrowsFootEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 12,
  });
  const isOneToOne = Boolean(data?.isOneToOne);
  const color = '#3b82f6';
  const manyId = `cfm-${id}`;
  const oneId  = `cfo-${id}`;
  return (
    <g>
      <defs>
        {/* Many-end (source/FK table): bar + crow's foot, fans out from source handle */}
        <marker id={manyId} markerWidth="20" markerHeight="12" refX="1" refY="6"
          orient="auto" markerUnits="userSpaceOnUse">
          <line x1="1" y1="0" x2="1" y2="12" stroke={color} strokeWidth="1.5" />
          <path d="M3,6 L18,0 M3,6 L18,12 M3,6 L18,6" stroke={color} strokeWidth="1.5" fill="none" />
        </marker>
        {/* One-end (target/referenced table): single bar at path end */}
        <marker id={oneId} markerWidth="8" markerHeight="12" refX="0" refY="6"
          orient="auto" markerUnits="userSpaceOnUse">
          <line x1="2" y1="0" x2="2" y2="12" stroke={color} strokeWidth="1.5" />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: color, strokeWidth: 1.5 }}
        markerStart={`url(#${isOneToOne ? oneId : manyId})`}
        markerEnd={`url(#${oneId})`}
      />
    </g>
  );
}

const edgeTypes = { crowsFoot: CrowsFootEdge };

// ── ERD hierarchical layout helper ───────────────────────────────────────────

function computeHierarchicalLayout(
  nodes: Node[],
  edges: Edge[],
): Map<string, { x: number; y: number }> {
  const COL_W = 270, H_GAP = 120, V_GAP = 48, ROW_H = 26, BASE_H = 52;

  // "Pure parent" = table that is only referenced (no outgoing FK edges)
  const outCount = new Map<string, number>();
  nodes.forEach(n => outCount.set(n.id, 0));
  edges.forEach(e => outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1));

  const roots = nodes.filter(n => outCount.get(n.id) === 0).map(n => n.id);
  if (roots.length === 0) nodes.forEach(n => roots.push(n.id));

  // BFS along reverse edges (referenced → FK holder) to assign column levels
  const reverseAdj = new Map<string, string[]>();
  nodes.forEach(n => reverseAdj.set(n.id, []));
  edges.forEach(e => reverseAdj.get(e.target)?.push(e.source));

  const level = new Map<string, number>();
  roots.forEach(r => level.set(r, 0));
  const queue = [...roots];
  while (queue.length) {
    const curr = queue.shift()!;
    for (const next of reverseAdj.get(curr) ?? []) {
      if (!level.has(next)) {
        level.set(next, (level.get(curr) ?? 0) + 1);
        queue.push(next);
      }
    }
  }
  nodes.forEach(n => { if (!level.has(n.id)) level.set(n.id, 0); });

  // Group by level
  const byLevel = new Map<number, string[]>();
  nodes.forEach(n => {
    const l = level.get(n.id)!;
    const list = byLevel.get(l) ?? [];
    list.push(n.id);
    byLevel.set(l, list);
  });

  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const positioned = new Map<string, { x: number; y: number }>();
  let x = 0;

  levels.forEach(l => {
    const ids = byLevel.get(l)!;
    const heights = ids.map(id => {
      const node = nodes.find(n => n.id === id);
      const colCount = ((node?.data as Record<string, unknown>)?.columns as unknown[] | undefined)?.length ?? 5;
      return BASE_H + colCount * ROW_H;
    });
    const totalH = heights.reduce((s, h) => s + h + V_GAP, -V_GAP);
    let y = -totalH / 2;
    ids.forEach((id, i) => {
      positioned.set(id, { x, y });
      y += heights[i] + V_GAP;
    });
    x += COL_W + H_GAP;
  });

  return positioned;
}

// ── ERD Canvas (inner — needs ReactFlowProvider) ──────────────────────────────

type PaperSize = 'a4' | 'a3' | 'letter' | 'legal';
type Orientation = 'landscape' | 'portrait';
const PAPER_LABELS: Record<PaperSize, string> = { a4: 'A4', a3: 'A3', letter: 'Letter', legal: 'Legal' };

function ERDInner({
  erdTableKeys,
  columnsCache,
  onTableClick,
}: {
  erdTableKeys: string[];
  columnsCache: Record<string, TableColumnsResult>;
  onTableClick: (key: string) => void;
}) {
  const { fitView } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [printOpen, setPrintOpen] = useState(false);
  const [paperSize, setPaperSize] = useState<PaperSize>('a4');
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  const [capturing, setCapturing] = useState(false);

  const capture = async () => {
    const el = containerRef.current?.querySelector<HTMLElement>('.react-flow');
    if (!el) return null;
    const { toPng } = await import('html-to-image');
    return toPng(el, {
      backgroundColor: document.documentElement.classList.contains('dark') ? '#0f172a' : '#f9fafb',
      width: el.offsetWidth,
      height: el.offsetHeight,
      // exclude the Panel overlay from capture
      filter: node => !(node instanceof HTMLElement && node.classList.contains('react-flow__panel')),
    });
  };

  const prepareCapture = async () => {
    setPrintOpen(false);   // close dialog before capturing
    fitView({ duration: 0, padding: 0.06 });   // fit all nodes into view
    await new Promise(r => setTimeout(r, 180)); // wait for layout to settle
  };

  const handlePng = async () => {
    setCapturing(true);
    try {
      await prepareCapture();
      const dataUrl = await capture();
      if (!dataUrl) return;
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `erd-${Date.now()}.png`;
      a.click();
    } finally { setCapturing(false); }
  };

  const handlePrint = async () => {
    setCapturing(true);
    try {
      await prepareCapture();
      const dataUrl = await capture();
      if (!dataUrl) return;
      const win = window.open('', '_blank');
      if (!win) return;
      win.document.write(`<!DOCTYPE html><html><head><title>ERD</title><style>
        @page{size:${paperSize} ${orientation};margin:10mm}
        body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh}
        img{max-width:100%;height:auto}
      </style></head><body><img src="${dataUrl}"/><script>window.onload=()=>{window.print();window.close()}</script></body></html>`);
      win.document.close();
    } finally { setCapturing(false); }
  };

  const applyLayout = useCallback((overrideNodes?: Node[], overrideEdges?: Edge[]) => {
    const n = overrideNodes ?? nodes;
    const e = overrideEdges ?? edges;
    if (n.length === 0) return;
    const positioned = computeHierarchicalLayout(n, e);
    setNodes(prev => prev.map(node => ({ ...node, position: positioned.get(node.id) ?? node.position })));
    setTimeout(() => fitView({ padding: 0.12 }), 80);
  }, [nodes, edges, fitView, setNodes]);

  useEffect(() => {
    const newNodes: Node[] = [];
    erdTableKeys.forEach(key => {
      const data = columnsCache[key];
      if (!data) return;
      newNodes.push({
        id: key,
        type: 'table',
        position: { x: 0, y: 0 }, // layout will be applied below
        data: { label: key, columns: data.columns, onNavigate: () => onTableClick(key) },
      });
    });

    const newEdges: Edge[] = [];
    erdTableKeys.forEach(key => {
      const data = columnsCache[key];
      if (!data) return;
      data.fks.forEach(fk => {
        const targetKey = `${fk.toSchema}.${fk.toTable}`;
        if (erdTableKeys.includes(targetKey)) {
          const fromColData = data.columns.find(c => c.name === fk.fromCol);
          const isOneToOne = fromColData?.isUnique ?? false;
          const edgeId = `${key}-${fk.fromCol}->${targetKey}-${fk.toCol}`;
          newEdges.push({
            id: edgeId,
            source: key,
            target: targetKey,
            type: 'crowsFoot',
            data: { isOneToOne },
            label: `${fk.fromCol}→${fk.toCol}`,
            labelStyle: { fontSize: 8, fill: '#94a3b8' },
          });
        }
      });
    });

    // Apply hierarchical layout immediately
    const positioned = computeHierarchicalLayout(newNodes, newEdges);
    const laid = newNodes.map(n => ({ ...n, position: positioned.get(n.id) ?? n.position }));

    setNodes(laid);
    setEdges(newEdges);
    setTimeout(() => fitView({ padding: 0.12 }), 100);
  }, [erdTableKeys, columnsCache]);

  const onConnect = useCallback((params: Connection) => setEdges(e => addEdge(params, e)), []);

  return (
    <div ref={containerRef} className="flex-1 relative h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={(_evt, node) => onTableClick(node.id)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        minZoom={0.05}
        maxZoom={2}
        className="bg-gray-50 dark:bg-slate-900"
      >
        <Background gap={20} size={1} color="#e5e7eb" />
        <Controls />
        <MiniMap nodeColor="#3b82f6" className="!bg-white dark:!bg-slate-800" />
        <Panel position="top-right" className="flex items-center gap-2">
          {/* Auto layout */}
          <button
            onClick={() => applyLayout()}
            title="Re-arrange tables by FK hierarchy"
            className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-1.5 shadow-sm"
          >
            <Layers size={12} /> Layout
          </button>

          {/* Print dropdown */}
          <div className="relative">
            <button
              onClick={() => setPrintOpen(v => !v)}
              title="Print / Export PNG"
              className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-1.5 shadow-sm"
            >
              <Printer size={12} /> {capturing ? 'Capturing…' : 'Export'}
            </button>
            {printOpen && (
              <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-lg z-50 p-3 space-y-3">
                {/* Paper size */}
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider mb-1">Paper</p>
                  <div className="grid grid-cols-4 gap-1">
                    {(['a4','a3','letter','legal'] as PaperSize[]).map(s => (
                      <button key={s} onClick={() => setPaperSize(s)}
                        className={`py-1 text-[10px] rounded border transition-colors ${paperSize === s ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300'}`}>
                        {PAPER_LABELS[s]}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Orientation */}
                <div>
                  <p className="text-[10px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wider mb-1">Orientation</p>
                  <div className="grid grid-cols-2 gap-1">
                    {(['landscape','portrait'] as Orientation[]).map(o => (
                      <button key={o} onClick={() => setOrientation(o)}
                        className={`py-1 text-[10px] rounded border transition-colors capitalize ${orientation === o ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300'}`}>
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Actions */}
                <div className="grid grid-cols-2 gap-1 pt-1 border-t border-gray-100 dark:border-slate-700">
                  <button onClick={() => void handlePrint()} disabled={capturing}
                    className="flex items-center justify-center gap-1 py-1.5 text-[11px] rounded-lg bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300 hover:bg-gray-200 dark:hover:bg-slate-600 disabled:opacity-50 transition-colors">
                    <Printer size={11} /> Print
                  </button>
                  <button onClick={() => void handlePng()} disabled={capturing}
                    className="flex items-center justify-center gap-1 py-1.5 text-[11px] rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                    <Download size={11} /> PNG
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={() => fitView({ padding: 0.15 })}
            className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-1.5 shadow-sm"
          >
            <Maximize2 size={12} /> Fit
          </button>
        </Panel>
      </ReactFlow>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SchemaExplorer() {
  useAuth(); // ensure auth context is mounted
  const authHeader = useMemo(() => ({ Authorization: `Bearer ${getStoredToken()}` }), []);

  // Saved connections
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [selectedConnId, setSelectedConnId] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [connError, setConnError] = useState('');
  const [connecting, setConnecting] = useState(false);

  // Database list for selected connection
  const [dbs, setDbs] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [selectedDb, setSelectedDb] = useState('');

  useEffect(() => {
    axios.get<{ connections: ConnectionRow[] }>('/api/connections', { headers: authHeader })
      .then(r => setConnections(r.data.connections))
      .catch(() => {});
  }, [authHeader]);

  const selectedConn = useMemo(
    () => connections.find(c => c.id === selectedConnId) ?? null,
    [connections, selectedConnId]
  );

  useEffect(() => {
    if (!selectedConn) { setDbs([]); setSelectedDb(''); return; }
    if (connected) return;
    setLoadingDbs(true);
    setDbs([]);
    setSelectedDb('');
    const c = selectedConn;
    const req = c.db_type === 'postgres'
      ? axios.post<{ databases: string[] }>('/api/pg-databases', {
          host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '', ssl: c.ssl_enabled,
        })
      : axios.post<{ databases: string[] }>('/api/list-databases', {
          host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '',
        });
    req
      .then(r => {
        setDbs(r.data.databases);
        const def = r.data.databases.includes(c.database_name) ? c.database_name : (r.data.databases[0] ?? '');
        setSelectedDb(def);
      })
      .catch(() => {
        setDbs([c.database_name]);
        setSelectedDb(c.database_name);
      })
      .finally(() => setLoadingDbs(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConn?.id]);

  // Tree
  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [tables, setTables] = useState<Record<string, TableInfo[]>>({});
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

  // ERD schema filter
  const [erdSchemaFilter, setErdSchemaFilter] = useState<string>('all');

  // Records
  const RECORDS_LIMIT = 50;
  const [records, setRecords] = useState<RecordsResult | null>(null);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [recordsOffset, setRecordsOffset] = useState(0);

  const connPayload = useMemo(
    () => selectedConn && selectedDb ? { ...connToPayload(selectedConn), database: selectedDb } : null,
    [selectedConn, selectedDb]
  );

  // ── Connect ────────────────────────────────────────────────────────────────

  const handleConnect = async () => {
    if (!connPayload) return;
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
    setSelectedTable(null);
    setErdTables(new Set());
    setColumnsCache({});
    setConnError('');
    setRecords(null);
    setRecordsOffset(0);
  };

  // ── Load schemas ───────────────────────────────────────────────────────────

  const loadSchemas = async () => {
    if (!connPayload) return;
    setLoadingSchemas(true);
    try {
      const { data } = await axios.post<{ schemas: SchemaInfo[] }>(
        '/api/schema-explorer/schemas', connPayload, { headers: authHeader }
      );
      setSchemas(data.schemas);
      data.schemas.forEach(s => void loadTables(s.schema));
    } catch { /* ignore */ } finally {
      setLoadingSchemas(false);
    }
  };

  // ── Load columns ──────────────────────────────────────────────────────────

  const loadColumns = async (tableKey: string) => {
    if (columnsCache[tableKey] || !connPayload) return;
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

  // ── Load tables ────────────────────────────────────────────────────────────

  const loadTables = async (schema: string) => {
    if (tables[schema] || !connPayload) return;
    setLoadingTables(prev => new Set(prev).add(schema));
    try {
      const { data } = await axios.post<{ tables: TableInfo[] }>(
        '/api/schema-explorer/tables',
        { conn: connPayload, schemas: [schema] },
        { headers: authHeader }
      );
      setTables(prev => ({ ...prev, [schema]: data.tables }));
      // auto-add all tables to ERD and preload their columns
      const keys = data.tables.map(t => `${t.schema}.${t.name}`);
      setErdTables(prev => { const n = new Set(prev); keys.forEach(k => n.add(k)); return n; });
      keys.forEach(k => void loadColumns(k));
    } catch { /* ignore */ } finally {
      setLoadingTables(prev => { const s = new Set(prev); s.delete(schema); return s; });
    }
  };

  const toggleSchemaErd = (schema: string) => {
    const schemaTables = tables[schema] ?? [];
    const allChecked = schemaTables.every(t => erdTables.has(`${t.schema}.${t.name}`));
    setErdTables(prev => {
      const n = new Set(prev);
      schemaTables.forEach(t => {
        const key = `${t.schema}.${t.name}`;
        if (allChecked) { n.delete(key); } else { n.add(key); }
      });
      return n;
    });
    if (!allChecked) schemaTables.forEach(t => void loadColumns(`${t.schema}.${t.name}`));
  };

  const loadRecords = async (key: string, offset = 0) => {
    if (!connPayload) return;
    setLoadingRecords(true);
    try {
      const { data } = await axios.post<RecordsResult>(
        '/api/schema-explorer/records',
        { conn: connPayload, tableKey: key, limit: RECORDS_LIMIT, offset },
        { headers: authHeader }
      );
      setRecords(data);
      setRecordsOffset(offset);
    } catch { /* ignore */ } finally {
      setLoadingRecords(false);
    }
  };

  const selectTable = (key: string) => {
    setSelectedTable(key);
    setActiveTab('columns');
    setRecords(null);
    setRecordsOffset(0);
    void loadColumns(key);
    void loadRecords(key, 0);
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

  // ── Export ────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    const keys = [...erdTables];
    if (!keys.length || !connPayload) return;
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

  const filteredSchemas = useMemo(() => {
    if (!treeSearch) return schemas;
    const q = treeSearch.toLowerCase();
    return schemas.filter(s =>
      s.schema.toLowerCase().includes(q) ||
      (tables[s.schema] ?? []).some(t => t.name.toLowerCase().includes(q))
    );
  }, [schemas, treeSearch, tables]);

  // ── Columns view for selected table ──────────────────────────────────────

  const selectedCols = selectedTable ? columnsCache[selectedTable] : null;

  return (
    <>
      <Head><title>Schema Explorer</title></Head>
      <div className="flex flex-col h-screen bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* ── Top bar ────────────────────────────────────────────────────── */}
        <header className="shrink-0 sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-3 flex items-center gap-4">

          {/* Title */}
          <div className="flex items-center gap-3 shrink-0">
            <Network size={18} className="text-blue-600" />
            <div>
              <h1 className="font-bold text-sm text-gray-900 dark:text-slate-100">Schema Explorer</h1>
              <p className="text-xs text-gray-500 dark:text-slate-400">Browse schemas, tables, ERD and export</p>
            </div>
          </div>

          <div className="h-8 w-px bg-gray-200 dark:bg-slate-700 shrink-0" />

          {/* Saved connection picker */}
          <select
            value={selectedConnId ?? ''}
            onChange={e => {
              if (!connected) setSelectedConnId(e.target.value ? Number(e.target.value) : null);
            }}
            disabled={connected}
            className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60 min-w-[200px]"
          >
            <option value="">— select connection —</option>
            {(['postgres', 'mysql'] as const).map(type => {
              const group = connections.filter(c => c.db_type === type);
              if (!group.length) return null;
              return (
                <optgroup key={type} label={type === 'postgres' ? 'PostgreSQL' : 'MySQL'}>
                  {group.map(c => (
                    <option key={c.id} value={c.id}>{c.label} ({c.database_name})</option>
                  ))}
                </optgroup>
              );
            })}
          </select>

          {/* Database picker */}
          {selectedConn && (
            loadingDbs
              ? <span className="text-xs text-gray-400 dark:text-slate-500 animate-pulse">Loading databases…</span>
              : (
                <select
                  value={selectedDb}
                  onChange={e => { if (!connected) setSelectedDb(e.target.value); }}
                  disabled={connected || !dbs.length}
                  className="px-2 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60 min-w-[140px]"
                >
                  {dbs.map(db => <option key={db} value={db}>{db}</option>)}
                </select>
              )
          )}

          {/* DB type badge — green border + check icon when connected */}
          {selectedConn && (
            <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors ${
              connected
                ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300 border-emerald-400 dark:border-emerald-600'
                : 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-900'
            }`}>
              {connected && <Check size={10} strokeWidth={2.5} />}
              {selectedConn.db_type === 'postgres' ? 'PostgreSQL' : 'MySQL'}
            </span>
          )}

          {connError && <span className="text-xs text-rose-500">{connError}</span>}

          {!connected ? (
            <button
              onClick={() => void handleConnect()}
              disabled={connecting || !selectedConnId || !selectedDb}
              title={connecting ? 'Connecting…' : 'Connect'}
              className="p-1.5 rounded-lg text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40 transition-colors"
            >
              {connecting
                ? <RefreshCw size={15} className="animate-spin" />
                : <Plug size={15} />}
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <button onClick={handleDisconnect} title="Disconnect"
                className="p-1.5 rounded-lg text-gray-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors">
                <Unplug size={15} />
              </button>
              <button onClick={() => void loadSchemas()} title="Refresh schemas"
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
                <RefreshCw size={14} />
              </button>
            </div>
          )}

          {/* Breadcrumb */}
          <nav className="ml-auto flex items-center gap-1 text-sm shrink-0">
            <Link href="/" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Home</Link>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <span className="px-3 py-1 rounded-lg bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold">Schema Explorer</span>
          </nav>
        </header>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0">

          {/* ── Left panel — flat grouped table list ───────────────────── */}
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

            <div className="flex-1 overflow-y-auto">
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
                const q = treeSearch.toLowerCase();
                const schemaTables = (tables[s.schema] ?? []).filter(t =>
                  !treeSearch || t.name.toLowerCase().includes(q) || s.schema.toLowerCase().includes(q)
                );
                const isLoadingT = loadingTables.has(s.schema);
                const allChecked = schemaTables.length > 0 && schemaTables.every(t => erdTables.has(`${t.schema}.${t.name}`));
                const someChecked = !allChecked && schemaTables.some(t => erdTables.has(`${t.schema}.${t.name}`));

                return (
                  <div key={s.schema}>
                    {/* Schema header */}
                    <div className="flex items-center gap-1.5 px-2 py-1.5 bg-gray-50 dark:bg-slate-800/60 border-b border-gray-100 dark:border-slate-800 sticky top-0 z-10">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={el => { if (el) el.indeterminate = someChecked; }}
                        onChange={() => toggleSchemaErd(s.schema)}
                        className="shrink-0 accent-blue-600 cursor-pointer"
                        title={allChecked ? 'Uncheck all' : 'Check all'}
                      />
                      <Database size={11} className="text-blue-500 shrink-0" />
                      <span className="text-[11px] font-semibold text-gray-600 dark:text-slate-300 flex-1 truncate">{s.schema}</span>
                      <span className="text-[10px] text-gray-400 dark:text-slate-500 shrink-0">
                        {isLoadingT ? '…' : schemaTables.length}
                      </span>
                    </div>

                    {/* Table rows */}
                    {isLoadingT ? (
                      <div className="pl-8 py-1.5 text-[10px] text-gray-400 animate-pulse">Loading…</div>
                    ) : (
                      schemaTables.map(t => {
                        const key = `${t.schema}.${t.name}`;
                        const isSelected = selectedTable === key;
                        const inErd = erdTables.has(key);
                        return (
                          <div
                            key={key}
                            className={`flex items-center gap-1.5 pl-4 pr-2 py-1 cursor-pointer ${
                              isSelected
                                ? 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400'
                                : 'hover:bg-gray-50 dark:hover:bg-slate-800 text-gray-600 dark:text-slate-400'
                            }`}
                            onClick={() => selectTable(key)}
                          >
                            <input
                              type="checkbox"
                              checked={inErd}
                              onChange={e => { e.stopPropagation(); toggleErd(key); }}
                              onClick={e => e.stopPropagation()}
                              className="shrink-0 accent-blue-600 cursor-pointer"
                            />
                            <Table2 size={11} className="shrink-0 text-gray-400 dark:text-slate-500" />
                            <span className="text-xs flex-1 truncate">{t.name}</span>
                            <span className="text-[10px] text-gray-400 shrink-0">{t.rowCount.toLocaleString()}</span>
                          </div>
                        );
                      })
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
                { key: 'columns',    label: 'Columns',    Icon: Columns },
                { key: 'erd',        label: 'ERD',        Icon: Network },
                { key: 'export',     label: 'Export',     Icon: Download },
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

              {/* Columns context: table label + back to ERD */}
              {selectedTable && activeTab === 'columns' && (
                <div className="ml-auto flex items-center gap-2">
                  <button
                    onClick={() => setActiveTab('erd')}
                    className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
                    title="View in ERD"
                  >
                    <Network size={11} /> ERD
                  </button>
                  <span className="text-xs text-gray-400 dark:text-slate-500 font-mono">{selectedTable}</span>
                </div>
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

                      {/* Records section */}
                      <div className="border-t border-gray-100 dark:border-slate-800">
                        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-slate-800/50">
                          <p className="text-[11px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">
                            Records
                            {records && <span className="ml-2 normal-case font-normal text-gray-400 dark:text-slate-500">({records.total.toLocaleString()} total)</span>}
                          </p>
                          <button
                            onClick={() => void loadRecords(selectedTable!, recordsOffset)}
                            disabled={loadingRecords}
                            className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors disabled:opacity-40"
                          >
                            <RefreshCw size={11} className={loadingRecords ? 'animate-spin' : ''} />
                            {loadingRecords ? 'Loading…' : 'Reload'}
                          </button>
                        </div>

                        {loadingRecords && !records && (
                          <div className="px-4 py-4 text-xs text-gray-400 animate-pulse">Loading records…</div>
                        )}

                        {records && records.rows.length === 0 && (
                          <div className="px-4 py-4 text-xs text-gray-400 dark:text-slate-500">No records found.</div>
                        )}

                        {records && records.rows.length > 0 && (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs border-collapse">
                              <thead>
                                <tr className="bg-gray-50 dark:bg-slate-800/60">
                                  {records.columns.map(col => (
                                    <th key={col} className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">
                                      {col}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                                {records.rows.map((row, i) => (
                                  <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                                    {records.columns.map(col => (
                                      <td key={col} className="px-3 py-1.5 text-gray-700 dark:text-slate-300 font-mono max-w-[200px] truncate whitespace-nowrap">
                                        {row[col] === null
                                          ? <span className="text-gray-300 dark:text-slate-600 italic">null</span>
                                          : String(row[col])}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>

                            {/* Pagination */}
                            <div className="flex items-center justify-between px-4 py-2 border-t border-gray-100 dark:border-slate-800">
                              <span className="text-[11px] text-gray-400 dark:text-slate-500">
                                {recordsOffset + 1}–{Math.min(recordsOffset + RECORDS_LIMIT, records.total)} of {records.total.toLocaleString()}
                              </span>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => void loadRecords(selectedTable!, recordsOffset - RECORDS_LIMIT)}
                                  disabled={recordsOffset === 0 || loadingRecords}
                                  className="px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                                >
                                  ← Prev
                                </button>
                                <button
                                  onClick={() => void loadRecords(selectedTable!, recordsOffset + RECORDS_LIMIT)}
                                  disabled={recordsOffset + RECORDS_LIMIT >= records.total || loadingRecords}
                                  className="px-2 py-1 text-[11px] rounded border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                                >
                                  Next →
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ERD tab */}
              {activeTab === 'erd' && (() => {
                const visibleKeys = [...erdTables].filter(k =>
                  erdSchemaFilter === 'all' || k.startsWith(erdSchemaFilter + '.')
                );
                const schemaOptions = [...new Set([...erdTables].map(k => k.split('.')[0]))].sort();
                return (
                  <div className="h-full flex flex-col">
                    {/* Schema filter bar */}
                    {erdTables.size > 0 && (
                      <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-gray-100 dark:border-slate-800 bg-white dark:bg-slate-900">
                        <span className="text-xs text-gray-500 dark:text-slate-400">Schema</span>
                        <select
                          value={erdSchemaFilter}
                          onChange={e => setErdSchemaFilter(e.target.value)}
                          className="px-2 py-1 text-xs rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200"
                        >
                          <option value="all">All ({erdTables.size} tables)</option>
                          {schemaOptions.map(s => {
                            const count = [...erdTables].filter(k => k.startsWith(s + '.')).length;
                            return <option key={s} value={s}>{s} ({count})</option>;
                          })}
                        </select>
                        <span className="text-xs text-gray-400 dark:text-slate-500">
                          {visibleKeys.length} visible
                        </span>
                        <button
                          onClick={() => {
                            const keys = erdSchemaFilter === 'all'
                              ? [...erdTables]
                              : [...erdTables].filter(k => k.startsWith(erdSchemaFilter + '.'));
                            keys.forEach(k => setErdTables(prev => { const n = new Set(prev); n.delete(k); return n; }));
                          }}
                          className="ml-auto text-xs text-gray-400 hover:text-rose-500 transition-colors"
                        >
                          Uncheck {erdSchemaFilter === 'all' ? 'all' : erdSchemaFilter}
                        </button>
                      </div>
                    )}

                    {erdTables.size === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                        <Network size={36} className="text-gray-200 dark:text-slate-700" />
                        <p className="text-sm text-gray-400 dark:text-slate-500">
                          Expand a schema in the left panel — tables are added to the ERD automatically
                        </p>
                      </div>
                    ) : (
                      <ReactFlowProvider>
                        <ERDInner
                          erdTableKeys={visibleKeys}
                          columnsCache={columnsCache}
                          onTableClick={selectTable}
                        />
                      </ReactFlowProvider>
                    )}
                  </div>
                );
              })()}

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
