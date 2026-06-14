'use client';
import Head from 'next/head';
import React, { useCallback, useContext, useEffect, useMemo, useRef, useState, createContext } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import axios from 'axios';
import {
  ReactFlow, Background, MiniMap,
  useNodesState, useEdgesState, addEdge,
  BaseEdge, getSmoothStepPath,
  Handle, Position, type Node, type Edge, type Connection, type EdgeProps,
  Panel, useReactFlow, ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ChevronRight, ChevronDown, Database, Table2, Search, HelpCircle,
  Plug, Unplug, RefreshCw, Download, FileSpreadsheet,
  Code2, Network, Columns, Check, X, Maximize2,
  ExternalLink, Printer, ArrowLeft, Layers, ZoomIn, ZoomOut,
  ArrowRight, ArrowDown, ArrowLeft as ArrowLeftIcon, ArrowUp,
  AlignJustify, LayoutGrid, SortAsc, GitBranch, Minus, Hand, MousePointer2,
  AlertCircle, Wand2, CheckCircle2, Send,
  GripVertical, Loader2, ArrowRightLeft, Copy,
} from 'lucide-react';
import type { ExportInclude } from '../lib/sql-exporter';
import type { ConnectionRow } from './api/connections/index';
import type { SchemaInfo } from './api/schema-explorer/schemas';
import type { TableInfo } from './api/schema-explorer/tables';
import type { ColumnInfo, TableColumnsResult } from './api/schema-explorer/columns';
import type { RecordsResult } from './api/schema-explorer/records';


// ── Types ────────────────────────────────────────────────────────────────────

type ActiveTab = 'columns' | 'erd' | 'export' | 'advisor';

type AdvisorConfidence = 'high' | 'low' | 'unresolved';
interface AdvisorSuggestion {
  id: string;               // "schema.table::colName" — unique key
  fromTableKey: string;     // "schema.table"
  fromCol: string;
  toTableKey: string | null;  // inferred target, null when unresolved
  toCol: string;              // always "id"
  confidence: AdvisorConfidence;
}
type LayoutDir     = 'LR' | 'TB' | 'RL' | 'BT';
type LayoutSpacing = 'compact' | 'normal' | 'loose';
type LayoutSort    = 'none' | 'name' | 'columns' | 'connections';
type LayoutAlgo    = 'hierarchical' | 'grid';
type EdgeStyle     = 'crowfoot' | 'simple';

// ── Highlight context (edge hover → blue border on connected nodes) ───────────

const HighlightCtx = createContext<Set<string>>(new Set());

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
  const highlighted = useContext(HighlightCtx);
  const isHighlighted = highlighted.has(data.label);
  return (
    <div className={`bg-white dark:bg-slate-800 border rounded-lg shadow-md min-w-[220px] text-sm overflow-hidden transition-all duration-150 ${isHighlighted ? 'border-red-500 shadow-red-500/30 shadow-lg ring-2 ring-red-500/40' : 'border-gray-300 dark:border-slate-600'}`}>
      <Handle type="target" position={Position.Left} className={isHighlighted ? '!bg-red-500' : '!bg-blue-500'} />
      <Handle type="source" position={Position.Right} className={isHighlighted ? '!bg-red-500' : '!bg-blue-500'} />
      <div className={`text-white px-3 py-1.5 font-semibold text-[13px] tracking-wide flex items-center justify-between transition-colors duration-150 ${isHighlighted ? 'bg-red-600 dark:bg-red-700' : 'bg-blue-600 dark:bg-blue-700'}`}>
        <span className="truncate">{data.label}</span>
        <button
          onMouseDown={e => { e.stopPropagation(); data.onNavigate(); }}
          title="View columns"
          className={`shrink-0 ml-1.5 p-0.5 rounded transition-colors ${isHighlighted ? 'hover:bg-red-500/60' : 'hover:bg-blue-500/60'}`}
        >
          <ExternalLink size={12} />
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

// ── Edge components ───────────────────────────────────────────────────────────

function CrowsFootEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const highlighted = useContext(HighlightCtx);
  const src = String((data as Record<string,unknown>)?.sourceTable ?? '');
  const tgt = String((data as Record<string,unknown>)?.targetTable ?? '');
  const isHighlighted = highlighted.has(src) || highlighted.has(tgt);
  const [edgePath] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 12,
  });
  const isOneToOne = Boolean(data?.isOneToOne);
  const color = isHighlighted ? '#ef4444' : '#3b82f6';
  const manyId = `cfm-${id}`;
  const oneId  = `cfo-${id}`;
  return (
    <g>
      <defs>
        <marker id={manyId} markerWidth="20" markerHeight="12" refX="1" refY="6"
          orient="auto" markerUnits="userSpaceOnUse">
          <line x1="1" y1="0" x2="1" y2="12" stroke={color} strokeWidth="1.5" />
          <path d="M3,6 L18,0 M3,6 L18,12 M3,6 L18,6" stroke={color} strokeWidth="1.5" fill="none" />
        </marker>
        <marker id={oneId} markerWidth="8" markerHeight="12" refX="0" refY="6"
          orient="auto" markerUnits="userSpaceOnUse">
          <line x1="2" y1="0" x2="2" y2="12" stroke={color} strokeWidth="1.5" />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: color, strokeWidth: isHighlighted ? 2.5 : 1.5 }}
        markerStart={`url(#${isOneToOne ? oneId : manyId})`}
        markerEnd={`url(#${oneId})`}
      />
    </g>
  );
}

function SimpleEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const highlighted = useContext(HighlightCtx);
  const src = String((data as Record<string,unknown>)?.sourceTable ?? '');
  const tgt = String((data as Record<string,unknown>)?.targetTable ?? '');
  const isHighlighted = highlighted.has(src) || highlighted.has(tgt);
  const [edgePath] = getSmoothStepPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
    borderRadius: 12,
  });
  const color = isHighlighted ? '#ef4444' : '#3b82f6';
  const arrowId = `arr-${id}`;
  return (
    <g>
      <defs>
        <marker id={arrowId} markerWidth="10" markerHeight="10" refX="9" refY="5"
          orient="auto" markerUnits="userSpaceOnUse">
          <path d="M0,0 L0,10 L10,5 z" fill={color} />
        </marker>
      </defs>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{ stroke: color, strokeWidth: isHighlighted ? 2.5 : 1.5 }}
        markerEnd={`url(#${arrowId})`}
      />
    </g>
  );
}

const edgeTypes = { crowsFoot: CrowsFootEdge, simple: SimpleEdge };

// ── Layout helpers ────────────────────────────────────────────────────────────

const SPACING_CFG = {
  compact: { COL_W: 250, H_GAP: 60,  V_GAP: 24 },
  normal:  { COL_W: 270, H_GAP: 120, V_GAP: 48 },
  loose:   { COL_W: 290, H_GAP: 200, V_GAP: 80 },
} as const;
const ROW_H = 26, BASE_H = 52;

function nodeColCount(node: Node) {
  return ((node.data as Record<string, unknown>)?.columns as unknown[] | undefined)?.length ?? 5;
}
function nodeHeight(node: Node) { return BASE_H + nodeColCount(node) * ROW_H; }

function sortIds(ids: string[], sort: LayoutSort, nodes: Node[], edges: Edge[]) {
  if (sort === 'none') return ids;
  const edgeDeg = new Map<string, number>();
  edges.forEach(e => {
    edgeDeg.set(e.source, (edgeDeg.get(e.source) ?? 0) + 1);
    edgeDeg.set(e.target, (edgeDeg.get(e.target) ?? 0) + 1);
  });
  return [...ids].sort((a, b) => {
    if (sort === 'name') return a.localeCompare(b);
    if (sort === 'columns') {
      const na = nodes.find(n => n.id === a), nb = nodes.find(n => n.id === b);
      return nodeColCount(nb!) - nodeColCount(na!);
    }
    if (sort === 'connections') return (edgeDeg.get(b) ?? 0) - (edgeDeg.get(a) ?? 0);
    return 0;
  });
}

function computeHierarchicalLayout(
  nodes: Node[], edges: Edge[],
  dir: LayoutDir = 'LR', spacing: LayoutSpacing = 'normal', sort: LayoutSort = 'none',
): Map<string, { x: number; y: number }> {
  const { COL_W, H_GAP, V_GAP } = SPACING_CFG[spacing];

  const outCount = new Map<string, number>();
  nodes.forEach(n => outCount.set(n.id, 0));
  edges.forEach(e => outCount.set(e.source, (outCount.get(e.source) ?? 0) + 1));

  const roots = nodes.filter(n => outCount.get(n.id) === 0).map(n => n.id);
  if (roots.length === 0) nodes.forEach(n => roots.push(n.id));

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

  const byLevel = new Map<number, string[]>();
  nodes.forEach(n => {
    const l = level.get(n.id)!;
    byLevel.set(l, [...(byLevel.get(l) ?? []), n.id]);
  });

  const isHoriz = dir === 'LR' || dir === 'RL';
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const positioned = new Map<string, { x: number; y: number }>();
  let primary = 0;

  levels.forEach(l => {
    const ids = sortIds(byLevel.get(l)!, sort, nodes, edges);
    const sizes = ids.map(id => {
      const node = nodes.find(n => n.id === id);
      return isHoriz ? nodeHeight(node!) : COL_W;
    });
    const crossSize = isHoriz ? COL_W : (nodes.find(n => n.id === ids[0]) ? nodeHeight(nodes.find(n => n.id === ids[0])!) : BASE_H);
    const total = sizes.reduce((s, h) => s + h + V_GAP, -V_GAP);
    let secondary = -total / 2;
    ids.forEach((id, i) => {
      if (isHoriz) {
        positioned.set(id, { x: primary, y: secondary });
      } else {
        positioned.set(id, { x: secondary, y: primary });
      }
      secondary += sizes[i] + V_GAP;
    });
    primary += (isHoriz ? crossSize + H_GAP : crossSize + H_GAP);
  });

  // Flip axis for RL / BT
  if (dir === 'RL' || dir === 'BT') {
    const maxP = Math.max(...[...positioned.values()].map(p => isHoriz ? p.x : p.y));
    positioned.forEach((pos, id) => {
      if (isHoriz) positioned.set(id, { ...pos, x: maxP - pos.x });
      else positioned.set(id, { ...pos, y: maxP - pos.y });
    });
  }

  return positioned;
}

function computeGridLayout(
  nodes: Node[], edges: Edge[],
  spacing: LayoutSpacing = 'normal', sort: LayoutSort = 'none',
): Map<string, { x: number; y: number }> {
  const { COL_W, H_GAP, V_GAP } = SPACING_CFG[spacing];
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const sorted = sortIds(nodes.map(n => n.id), sort, nodes, edges);
  const positioned = new Map<string, { x: number; y: number }>();
  sorted.forEach((id, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const node = nodes.find(n => n.id === id);
    positioned.set(id, { x: col * (COL_W + H_GAP), y: row * (nodeHeight(node!) + V_GAP) });
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
  paperSize,
  orientation,
  onCapturingChange,
  captureRef,
}: {
  erdTableKeys: string[];
  columnsCache: Record<string, TableColumnsResult>;
  onTableClick: (key: string) => void;
  paperSize: PaperSize;
  orientation: Orientation;
  onCapturingChange: (v: boolean) => void;
  captureRef: React.MutableRefObject<{ triggerPng: () => Promise<void>; triggerPrint: () => Promise<void> } | null>;
}) {
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  // Layout options
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [layoutDir, setLayoutDir] = useState<LayoutDir>('LR');
  const [layoutSpacing, setLayoutSpacing] = useState<LayoutSpacing>('normal');
  const [layoutSort, setLayoutSort] = useState<LayoutSort>('none');
  const [layoutAlgo, setLayoutAlgo] = useState<LayoutAlgo>('hierarchical');
  const [edgeStyle, setEdgeStyle] = useState<EdgeStyle>('crowfoot');
  const [selectMode, setSelectMode] = useState(false);

  // Edge hover highlight + tooltip
  const [highlightedNodes, setHighlightedNodes] = useState<Set<string>>(new Set());
  const [edgeTooltip, setEdgeTooltip] = useState<{ x: number; y: number; label: string } | null>(null);

  const capture = async () => {
    const el = containerRef.current?.querySelector<HTMLElement>('.react-flow');
    if (!el) return null;
    const { toPng } = await import('html-to-image');
    return toPng(el, {
      backgroundColor: document.documentElement.classList.contains('dark') ? '#0f172a' : '#f9fafb',
      width: el.offsetWidth,
      height: el.offsetHeight,
      pixelRatio: 3,
      filter: node => !(node instanceof HTMLElement && node.classList.contains('react-flow__panel')),
    });
  };

  const prepareCapture = async () => {
    fitView({ duration: 0, padding: 0.06 });
    await new Promise(r => setTimeout(r, 180));
  };

  const handlePng = async () => {
    onCapturingChange(true);
    try {
      await prepareCapture();
      const dataUrl = await capture();
      if (!dataUrl) return;
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `erd-${Date.now()}.png`;
      a.click();
    } finally { onCapturingChange(false); }
  };

  const handlePrint = async () => {
    onCapturingChange(true);
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
    } finally { onCapturingChange(false); }
  };

  const applyLayout = useCallback((
    overrideNodes?: Node[], overrideEdges?: Edge[],
    dir = layoutDir, spacing = layoutSpacing, sort = layoutSort, algo = layoutAlgo,
  ) => {
    const n = overrideNodes ?? nodes;
    const e = overrideEdges ?? edges;
    if (n.length === 0) return;
    const positioned = algo === 'grid'
      ? computeGridLayout(n, e, spacing, sort)
      : computeHierarchicalLayout(n, e, dir, spacing, sort);
    setNodes(prev => prev.map(node => ({ ...node, position: positioned.get(node.id) ?? node.position })));
    setTimeout(() => fitView({ padding: 0.12 }), 80);
  }, [nodes, edges, fitView, setNodes, layoutDir, layoutSpacing, layoutSort, layoutAlgo]);

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
            type: edgeStyle === 'crowfoot' ? 'crowsFoot' : 'simple',
            data: { isOneToOne, sourceTable: key, targetTable: targetKey, fromCol: fk.fromCol, toCol: fk.toCol },
            label: `${fk.fromCol}→${fk.toCol}`,
            labelStyle: { fontSize: 8, fill: '#94a3b8' },
          });
        }
      });
    });

    const positioned = computeHierarchicalLayout(newNodes, newEdges);
    const laid = newNodes.map(n => ({ ...n, position: positioned.get(n.id) ?? n.position }));

    setNodes(laid);
    setEdges(newEdges);
    setTimeout(() => fitView({ padding: 0.12 }), 100);
  }, [erdTableKeys, columnsCache]);

  // Sync edge type when edgeStyle changes
  useEffect(() => {
    setEdges(prev => prev.map(e => ({ ...e, type: edgeStyle === 'crowfoot' ? 'crowsFoot' : 'simple' })));
  }, [edgeStyle]);

  const onConnect = useCallback((params: Connection) => setEdges(e => addEdge(params, e)), []);

  // Expose capture functions to parent via ref (updated on every render so always current)
  captureRef.current = { triggerPng: handlePng, triggerPrint: handlePrint };

  return (
    <HighlightCtx.Provider value={highlightedNodes}>
    <div ref={containerRef} className="flex-1 relative h-full">
      {/* Edge hover tooltip */}
      {edgeTooltip && (
        <div
          className="pointer-events-none fixed z-50 px-2 py-1.5 rounded-lg bg-slate-900 text-slate-100 text-[13px] shadow-xl border border-slate-700 max-w-[240px]"
          style={{ left: edgeTooltip.x + 12, top: edgeTooltip.y - 10 }}
        >
          {edgeTooltip.label}
        </div>
      )}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onEdgeMouseEnter={(_evt, edge) => {
          const src = String((edge.data as Record<string,unknown>)?.sourceTable ?? edge.source);
          const tgt = String((edge.data as Record<string,unknown>)?.targetTable ?? edge.target);
          const fromCol = String((edge.data as Record<string,unknown>)?.fromCol ?? '');
          const toCol = String((edge.data as Record<string,unknown>)?.toCol ?? '');
          setHighlightedNodes(new Set([src, tgt]));
          setEdgeTooltip({
            x: _evt.clientX,
            y: _evt.clientY,
            label: `${src} · ${fromCol} → ${tgt} · ${toCol}`,
          });
        }}
        onEdgeMouseLeave={() => { setHighlightedNodes(new Set()); setEdgeTooltip(null); }}
        onConnect={onConnect}
        onNodeClick={(_evt, node) => onTableClick(node.id)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        selectionOnDrag={selectMode}
        panOnDrag={!selectMode}
        onSelectionChange={({ nodes: sel }) => {
          if (!selectMode || sel.length === 0) return;
          // Delay zoom until after XYFlow finishes computing the selection rect
          setTimeout(() => {
            fitView({ nodes: sel, padding: 0.25, duration: 350 });
            // Reset select mode after animation completes
            setTimeout(() => setSelectMode(false), 400);
          }, 80);
        }}
        fitView
        minZoom={0.05}
        maxZoom={2}
        className="bg-gray-50 dark:bg-slate-900"
      >
        <Background gap={20} size={1} color="#e5e7eb" />
        <MiniMap nodeColor="#3b82f6" />
        <Panel position="top-left" className="flex flex-col items-start gap-2">
          <div className="flex items-center gap-2">
            {/* Pan / Select area toggle */}
            <button
              onClick={() => setSelectMode(v => !v)}
              title={selectMode ? 'Select mode — drag to zoom area (click to switch to pan)' : 'Pan mode (click to switch to select area)'}
              className={`p-1.5 rounded-lg border text-sm shadow-sm transition-colors flex items-center gap-1 ${selectMode ? 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700' : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700'}`}
            >
              {selectMode ? <MousePointer2 size={15} /> : <Hand size={15} />}
            </button>

            {/* Layout dropdown */}
            <div className="relative">
              <button
                onClick={() => setLayoutOpen(v => !v)}
                title="Layout options"
                className="px-2 py-1.5 rounded-lg text-sm bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 flex items-center gap-1.5 shadow-sm"
              >
                <Layers size={14} /> Layout
              </button>
              {layoutOpen && (
                <div className="absolute left-0 top-full mt-1 w-64 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-xl z-50 p-3 space-y-3">

                  {/* Algorithm */}
                  <div>
                    <p className="text-[12px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1"><GitBranch size={11} /> Algorithm</p>
                    <div className="grid grid-cols-2 gap-1">
                      {([['hierarchical','Hierarchical'],['grid','Grid']] as [LayoutAlgo,string][]).map(([v,label]) => (
                        <button key={v} onClick={() => { setLayoutAlgo(v); applyLayout(undefined, undefined, layoutDir, layoutSpacing, layoutSort, v); }}
                          className={`py-1 text-[12px] rounded border transition-colors ${layoutAlgo === v ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Direction (hierarchical only) */}
                  {layoutAlgo === 'hierarchical' && (
                    <div>
                      <p className="text-[12px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1"><ArrowRight size={11} /> Direction</p>
                      <div className="grid grid-cols-4 gap-1">
                        {([
                          ['LR', <ArrowDown size={12} key="lr" />, 'Horizontal (Left → Right)'],
                          ['RL', <ArrowUp size={12} key="rl" />, 'Horizontal (Right → Left)'],
                          ['TB', <ArrowRight size={12} key="tb" />, 'Vertical (Top → Bottom)'],
                          ['BT', <ArrowLeftIcon size={12} key="bt" />, 'Vertical (Bottom → Top)'],
                        ] as [LayoutDir, React.ReactNode, string][]).map(([v, icon, tip]) => (
                          <button key={v} onClick={() => { setLayoutDir(v); applyLayout(undefined, undefined, v, layoutSpacing, layoutSort, layoutAlgo); }}
                            title={tip}
                            className={`py-1.5 flex items-center justify-center rounded border transition-colors ${layoutDir === v ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'}`}>
                            {icon}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Spacing */}
                  <div>
                    <p className="text-[12px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1"><AlignJustify size={11} /> Spacing</p>
                    <div className="grid grid-cols-3 gap-1">
                      {([['compact','Compact'],['normal','Normal'],['loose','Loose']] as [LayoutSpacing,string][]).map(([v,label]) => (
                        <button key={v} onClick={() => { setLayoutSpacing(v); applyLayout(undefined, undefined, layoutDir, v, layoutSort, layoutAlgo); }}
                          className={`py-1 text-[12px] rounded border transition-colors ${layoutSpacing === v ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Sort */}
                  <div>
                    <p className="text-[12px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1"><SortAsc size={11} /> Sort within level</p>
                    <div className="grid grid-cols-2 gap-1">
                      {([['none','Default'],['name','Name'],['columns','Columns'],['connections','Connections']] as [LayoutSort,string][]).map(([v,label]) => (
                        <button key={v} onClick={() => { setLayoutSort(v); applyLayout(undefined, undefined, layoutDir, layoutSpacing, v, layoutAlgo); }}
                          className={`py-1 text-[12px] rounded border transition-colors ${layoutSort === v ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'}`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Edge style */}
                  <div className="pt-2 border-t border-gray-100 dark:border-slate-700">
                    <p className="text-[12px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5 flex items-center gap-1"><Minus size={11} /> Edge style</p>
                    <div className="grid grid-cols-2 gap-1">
                      <button onClick={() => setEdgeStyle('crowfoot')}
                        className={`py-1 text-[12px] rounded border transition-colors ${edgeStyle === 'crowfoot' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'}`}>
                        Crow&apos;s foot
                      </button>
                      <button onClick={() => setEdgeStyle('simple')}
                        className={`py-1 text-[12px] rounded border transition-colors ${edgeStyle === 'simple' ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'}`}>
                        Simple arrow
                      </button>
                    </div>
                  </div>

                  {/* Apply button */}
                  <button onClick={() => { applyLayout(); setLayoutOpen(false); }}
                    className="w-full py-1.5 text-[13px] rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors font-medium">
                    Apply Layout
                  </button>
                </div>
              )}
            </div>


          </div>

          {/* Zoom + Fit combined pill */}
          <div className="flex items-center rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 shadow-sm overflow-hidden">
            <button onClick={() => zoomOut({ duration: 200 })} title="Zoom out"
              className="px-2 py-1.5 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors">
              <ZoomOut size={15} />
            </button>
            <div className="w-px h-4 bg-gray-200 dark:bg-slate-700" />
            <button onClick={() => fitView({ padding: 0.15, duration: 300 })} title="Fit to view"
              className="px-2.5 py-1.5 text-[12px] font-medium text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors flex items-center gap-1">
              <Maximize2 size={13} /> Fit
            </button>
            <div className="w-px h-4 bg-gray-200 dark:bg-slate-700" />
            <button onClick={() => zoomIn({ duration: 200 })} title="Zoom in"
              className="px-2 py-1.5 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-700 transition-colors">
              <ZoomIn size={15} />
            </button>
          </div>
        </Panel>
      </ReactFlow>
    </div>
    </HighlightCtx.Provider>
  );
}

// ── Schema Transfer Modal ────────────────────────────────────────────────────

function SchemaTransferModal({
  schema, sourceConn, sourceDb, targetConn, onClose,
}: {
  schema: string;
  sourceConn: ConnectionRow;
  sourceDb: string;
  targetConn: ConnectionRow;
  onClose: () => void;
}) {
  const [dbs, setDbs] = useState<string[]>([]);
  const [loadingDbs, setLoadingDbs] = useState(false);
  const [targetDb, setTargetDb] = useState('');
  const [targetSchema, setTargetSchema] = useState(schema);
  const [mode, setMode] = useState<'copy' | 'move'>('copy');
  const [include, setInclude] = useState<ExportInclude>('both');
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const typeMismatch = sourceConn.db_type !== targetConn.db_type;

  useEffect(() => {
    setLoadingDbs(true);
    const c = targetConn;
    const req = c.db_type === 'postgres'
      ? axios.post<{ databases: string[] }>('/api/pg-databases', {
          host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '', ssl: c.ssl_enabled,
        })
      : axios.post<{ databases: string[] }>('/api/list-databases', {
          host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '',
        });
    req.then(r => { setDbs(r.data.databases); setTargetDb(r.data.databases[0] ?? ''); })
      .catch(() => { setDbs([c.database_name]); setTargetDb(c.database_name); })
      .finally(() => setLoadingDbs(false));
  }, [targetConn]);

  const handleTransfer = async () => {
    setRunning(true); setLog([]);
    try {
      const { data } = await axios.post<{ success: boolean; log: string[] }>(
        '/api/schema-explorer/transfer-schema',
        {
          source: {
            db_type: sourceConn.db_type, host: sourceConn.host, port: sourceConn.port,
            user: sourceConn.username, password: sourceConn.password_enc ?? '',
            database: sourceDb, ssl: sourceConn.ssl_enabled, schema,
          },
          target: {
            db_type: targetConn.db_type, host: targetConn.host, port: targetConn.port,
            user: targetConn.username, password: targetConn.password_enc ?? '',
            database: targetDb, ssl: targetConn.ssl_enabled,
            schema: targetConn.db_type === 'postgres' ? targetSchema : undefined,
          },
          mode, include,
        },
      );
      setLog(data.log ?? []);
      setDone(data.success);
    } catch (err: unknown) {
      const d = axios.isAxiosError(err) ? err.response?.data as { log?: string[] } | undefined : undefined;
      setLog(d?.log ?? [`[ERROR] ${axios.isAxiosError(err) ? err.message : String(err)}`]);
    } finally { setRunning(false); }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="shrink-0 flex items-center gap-2.5 px-5 py-4 border-b border-gray-100 dark:border-slate-800">
          <ArrowRightLeft size={17} className="text-blue-500 shrink-0" />
          <p className="font-semibold text-base text-gray-900 dark:text-slate-100 flex-1">Transfer Schema</p>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300">
            <X size={17} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 sidebar-scroll">

          {/* Type mismatch */}
          {typeMismatch && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-sm text-rose-700 dark:text-rose-400">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              Cross-type transfer (MySQL ↔ PostgreSQL) is not supported. Use the Migration module instead.
            </div>
          )}

          {/* Source */}
          <div className="space-y-1.5">
            <p className="text-[12px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide">Source</p>
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-sm">
              <Database size={14} className="text-blue-500 shrink-0" />
              <span className="font-medium text-gray-700 dark:text-slate-300">{sourceConn.label}</span>
              <span className="text-gray-300 dark:text-slate-600">·</span>
              <span className="font-mono text-gray-500 dark:text-slate-400">{sourceDb}</span>
              <span className="text-gray-300 dark:text-slate-600">·</span>
              <code className="font-mono font-semibold text-blue-600 dark:text-blue-400">&quot;{schema}&quot;</code>
            </div>
          </div>

          {/* Target connection + database */}
          <div className="space-y-2">
            <p className="text-[12px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide">Target</p>
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 text-sm">
              <Database size={14} className="text-violet-500 shrink-0" />
              <span className="font-medium text-gray-700 dark:text-slate-300">{targetConn.label}</span>
              <span className={`ml-auto text-[11px] font-semibold px-1.5 py-0.5 rounded ${
                targetConn.db_type === 'mysql'
                  ? 'bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-400'
                  : 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400'
              }`}>
                {targetConn.db_type === 'mysql' ? 'MySQL' : 'PG'}
              </span>
            </div>
            {loadingDbs ? (
              <p className="text-[13px] text-gray-400 animate-pulse px-1">Loading databases…</p>
            ) : (
              <select value={targetDb} onChange={e => setTargetDb(e.target.value)}
                className="w-full px-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500">
                {dbs.map(db => <option key={db} value={db}>{db}</option>)}
              </select>
            )}
            {targetConn.db_type === 'postgres' && (
              <div className="flex items-center gap-2">
                <label className="text-[13px] text-gray-500 dark:text-slate-400 shrink-0 w-24">Schema name:</label>
                <input type="text" value={targetSchema} onChange={e => setTargetSchema(e.target.value)}
                  className="flex-1 px-2 py-1 text-sm font-mono rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              </div>
            )}
          </div>

          {/* Include */}
          <div className="space-y-2">
            <p className="text-[12px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide">Include</p>
            <div className="flex gap-1.5">
              {([
                { v: 'both'   as ExportInclude, label: 'Schema + Data' },
                { v: 'schema' as ExportInclude, label: 'Schema only'   },
                { v: 'data'   as ExportInclude, label: 'Data only'     },
              ]).map(({ v, label }) => (
                <button key={v} type="button" onClick={() => setInclude(v)}
                  className={`flex-1 px-2 py-1.5 text-[13px] rounded-lg border transition-colors ${
                    include === v
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                      : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                  }`}>{label}</button>
              ))}
            </div>
          </div>

          {/* Mode */}
          <div className="space-y-2">
            <p className="text-[12px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide">Mode</p>
            <div className="flex gap-1.5">
              {([
                { v: 'copy' as const, label: 'Copy', desc: 'Keep source intact', Icon: Copy },
                { v: 'move' as const, label: 'Move', desc: 'Drop source after transfer', Icon: ArrowRightLeft },
              ]).map(({ v, label, desc, Icon }) => (
                <button key={v} type="button" onClick={() => setMode(v)}
                  className={`flex-1 flex flex-col items-center gap-0.5 px-3 py-2.5 rounded-lg border transition-colors ${
                    mode === v
                      ? v === 'copy'
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                        : 'border-rose-500 bg-rose-50 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400'
                      : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800'
                  }`}>
                  <Icon size={15} />
                  <span className="text-[13px] font-semibold">{label}</span>
                  <span className="text-[12px] opacity-70">{desc}</span>
                </button>
              ))}
            </div>
            {mode === 'move' && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 text-sm text-rose-700 dark:text-rose-400">
                <AlertCircle size={15} className="mt-0.5 shrink-0" />
                <span>
                  <strong>Warning:</strong> Schema <code className="font-mono bg-rose-100 dark:bg-rose-900/40 px-1 rounded">&quot;{schema}&quot;</code> will be
                  {' '}<strong>permanently deleted</strong> from <em>{sourceConn.label} / {sourceDb}</em> after the transfer completes. This cannot be undone.
                </span>
              </div>
            )}
          </div>

          {/* Log */}
          {log.length > 0 && (
            <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
              <div className="px-3 py-1.5 bg-gray-50 dark:bg-slate-800/50 border-b border-gray-100 dark:border-slate-800">
                <p className="text-[12px] font-semibold text-gray-400 dark:text-slate-500 uppercase tracking-wide">Log</p>
              </div>
              <div className="p-3 space-y-0.5 font-mono text-[12px] max-h-36 overflow-y-auto sidebar-scroll">
                {log.map((line, i) => (
                  <div key={i} className={
                    line.startsWith('[OK]') ? 'text-emerald-600 dark:text-emerald-400' :
                    line.startsWith('[ERROR]') || line.startsWith('[FAIL]') ? 'text-rose-600 dark:text-rose-400' :
                    line.startsWith('[WARN]') ? 'text-amber-600 dark:text-amber-400' :
                    'text-gray-500 dark:text-slate-400'
                  }>{line}</div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-t border-gray-100 dark:border-slate-800">
          <button type="button" onClick={onClose}
            className="px-4 py-2 rounded-lg text-base text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800">
            {done ? 'Close' : 'Cancel'}
          </button>
          {!done ? (
            <button type="button" onClick={() => void handleTransfer()}
              disabled={running || typeMismatch || !targetDb || (targetConn.db_type === 'postgres' && !targetSchema.trim())}
              className={`inline-flex items-center gap-2 px-5 py-2 rounded-lg text-base font-medium text-white disabled:opacity-40 transition-colors ${
                mode === 'move' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-blue-600 hover:bg-blue-700'
              }`}>
              {running ? <Loader2 size={15} className="animate-spin" /> : <ArrowRightLeft size={15} />}
              {running ? 'Transferring…' : mode === 'move' ? 'Move Schema' : 'Copy Schema'}
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-base font-medium">
              <CheckCircle2 size={16} /> Done
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SchemaExplorer() {
  const router = useRouter();

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
    axios.get<{ connections: ConnectionRow[] }>('/api/connections')
      .then(r => {
        const conns = r.data.connections;
        setConnections(conns);
        setSelectedConnId(prev => prev ?? (conns.find(c => c.is_active)?.id ?? null));
      })
      .catch(() => {});
  }, []);

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
  const [collapsedSchemas, setCollapsedSchemas] = useState<Set<string>>(new Set());
  const [guideOpen, setGuideOpen] = useState(false);

  // Selection
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [erdTables, setErdTables] = useState<Set<string>>(new Set());

  // Columns
  const [columnsCache, setColumnsCache] = useState<Record<string, TableColumnsResult>>({});
  const [loadingCols, setLoadingCols] = useState(false);

  // Tab
  const [activeTab, setActiveTab] = useState<ActiveTab>('columns');

  // Export
  const [exportFormat, setExportFormat] = useState<'sql' | 'xlsx' | 'drizzle' | 'prisma' | 'typeorm'>('sql');
  const [exporting, setExporting] = useState(false);

  // FK Advisor
  const [advisorSuggestions, setAdvisorSuggestions] = useState<AdvisorSuggestion[]>([]);
  const [advisorAccepted, setAdvisorAccepted] = useState<Set<string>>(new Set());
  const [advisorManual, setAdvisorManual] = useState<Record<string, string>>({});
  const [sendingToDesigner, setSendingToDesigner] = useState(false);

  // Schema drag-and-transfer
  const [draggingSchema, setDraggingSchema] = useState<string | null>(null);
  const [transferModal, setTransferModal] = useState<{ schema: string; targetConn: ConnectionRow } | null>(null);

  // Canvas capture (state lives here so Export tab can show/control it)
  const [paperSize, setPaperSize] = useState<PaperSize>('a4');
  const [orientation, setOrientation] = useState<Orientation>('landscape');
  const [capturing, setCapturing] = useState(false);
  const captureRef = useRef<{ triggerPng: () => Promise<void>; triggerPrint: () => Promise<void> } | null>(null);

  // ERD schema filter

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
      await axios.post('/api/schema-explorer/schemas', connPayload);
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
        '/api/schema-explorer/schemas', connPayload
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
        { conn: connPayload, tableKey }
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
        { conn: connPayload, schemas: [schema] }
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
        { conn: connPayload, tableKey: key, limit: RECORDS_LIMIT, offset }
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
        { responseType: 'blob' }
      );
      const url = URL.createObjectURL(new Blob([resp.data as BlobPart]));
      const a = document.createElement('a');
      a.href = url;
      const dlMap: Record<string, string> = {
        xlsx: 'schema-overview.xlsx', sql: 'migration.sql',
        drizzle: 'drizzle-schema.ts', prisma: 'schema.prisma', typeorm: 'typeorm-entities.ts',
      };
      a.download = dlMap[exportFormat] ?? 'export.txt';
      a.click();
      URL.revokeObjectURL(url);
    } catch { /* ignore */ } finally {
      setExporting(false);
    }
  };

  // ── FK Advisor ────────────────────────────────────────────────────────────

  const computeAdvisorSuggestions = useCallback(() => {
    const allKeys = Object.keys(columnsCache);
    const tableNames = allKeys.map(k => ({ key: k, name: k.split('.').pop()!.toLowerCase() }));
    const suggestions: AdvisorSuggestion[] = [];

    for (const key of allKeys) {
      const cached = columnsCache[key];
      if (!cached) continue;

      for (const col of cached.columns) {
        if (!col.name.endsWith('_id') || col.isFk || col.isPk) continue;

        const prefix = col.name.slice(0, -3); // strip '_id'
        const candidates: string[] = [
          prefix,
          prefix + 's',
          prefix + 'es',
          prefix.endsWith('y') ? prefix.slice(0, -1) + 'ies' : '',
          prefix.endsWith('s') ? prefix.slice(0, -1) : '',
        ].filter(Boolean);

        let toTableKey: string | null = null;
        let confidence: AdvisorConfidence = 'unresolved';

        for (const candidate of candidates) {
          const match = tableNames.find(t => t.name === candidate && t.key !== key);
          if (match) {
            toTableKey = match.key;
            confidence = candidate === prefix || candidate === prefix + 's' ? 'high' : 'low';
            break;
          }
        }

        suggestions.push({ id: `${key}::${col.name}`, fromTableKey: key, fromCol: col.name, toTableKey, toCol: 'id', confidence });
      }
    }

    setAdvisorSuggestions(suggestions);
    // Auto-accept high + low confidence suggestions that have a resolved target
    setAdvisorAccepted(new Set(suggestions.filter(s => s.toTableKey).map(s => s.id)));
    setAdvisorManual({});
  }, [columnsCache]);

  // Auto-scan when user switches to the advisor tab
  const computeAdvisorRef = useRef(computeAdvisorSuggestions);
  computeAdvisorRef.current = computeAdvisorSuggestions;
  useEffect(() => {
    if (activeTab === 'advisor' && Object.keys(columnsCache).length > 0) {
      computeAdvisorRef.current();
    }
  }, [activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const PG_INTERNAL_TO_DDL: Record<string, string> = {
    int4: 'INTEGER', int2: 'SMALLINT', int8: 'BIGINT',
    serial: 'SERIAL', bigserial: 'BIGSERIAL', smallserial: 'SMALLSERIAL',
    bool: 'BOOLEAN', float4: 'REAL', float8: 'FLOAT8',
    bpchar: 'CHAR', timestamptz: 'TIMESTAMPTZ',
  };

  const buildAdvisorDdl = useCallback((accepted: Set<string>, manual: Record<string, string>): string => {
    // Build effective FK map: "tableKey::colName" → { toTable, toCol }
    const fkApply = new Map<string, { toTable: string; toCol: string }>();
    for (const s of advisorSuggestions) {
      if (!accepted.has(s.id)) continue;
      const targetKey = manual[s.id] ?? s.toTableKey;
      if (!targetKey) continue;
      fkApply.set(s.id, { toTable: targetKey.split('.').pop()!, toCol: s.toCol });
    }

    const stmts: string[] = [`-- FK Advisor schema — ${new Date().toISOString()}`];

    for (const [key, cached] of Object.entries(columnsCache)) {
      if (!cached) continue;
      const parts = key.split('.');
      const [schema, table] = parts.length === 2 ? parts : ['public', parts[0]];

      const colDefs: string[] = [];
      for (const col of cached.columns) {
        const dt = col.dataType.toLowerCase();
        const base = PG_INTERNAL_TO_DDL[dt] ?? col.fullType.toUpperCase();
        const notNull = !col.nullable ? ' NOT NULL' : '';
        const pk = col.isPk ? ' PRIMARY KEY' : '';
        const def = col.defaultValue && !col.isPk ? ` DEFAULT ${col.defaultValue}` : '';

        const fkKey = `${key}::${col.name}`;
        const fk = fkApply.get(fkKey);
        let ref = '';
        if (fk) {
          ref = ` REFERENCES "${fk.toTable}"("${fk.toCol}")`;
        } else if (col.isFk && col.fkRef) {
          const fkParts = col.fkRef.split('.');
          if (fkParts.length >= 2) {
            ref = ` REFERENCES "${fkParts[fkParts.length - 2]}"("${fkParts[fkParts.length - 1]}")`;
          }
        }

        colDefs.push(`  "${col.name}" ${base}${notNull}${def}${pk}${ref}`);
      }

      const tbl = schema === 'public' ? `"${table}"` : `"${schema}"."${table}"`;
      stmts.push(`\nCREATE TABLE IF NOT EXISTS ${tbl} (\n${colDefs.join(',\n')}\n);`);
    }

    return stmts.join('\n');
  }, [advisorSuggestions, columnsCache, PG_INTERNAL_TO_DDL]);

  const sendToDesigner = async () => {
    const accepted = advisorSuggestions.filter(s => advisorAccepted.has(s.id));
    const appliedCount = accepted.filter(s => (advisorManual[s.id] ?? s.toTableKey)).length;

    const ddl = buildAdvisorDdl(advisorAccepted, advisorManual);
    const connLabel = selectedConn?.label ?? selectedConn?.host ?? 'db';
    const jobName = `FK Advisor — ${connLabel}/${selectedDb} (${new Date().toLocaleDateString()})`;

    setSendingToDesigner(true);
    try {
      await axios.post('/api/schema-generator/jobs', {
        job_name: jobName,
        description: `Imported from FK Advisor — ${appliedCount} inferred FK relationship(s) applied`,
        schema_sql: ddl,
      });
      void router.push('/schema-studio');
    } catch { /* ignore */ } finally {
      setSendingToDesigner(false);
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
      <div className="flex flex-col h-[calc(100vh-48px)] bg-gray-50 dark:bg-slate-950 overflow-hidden">

        {/* ── Top bar ────────────────────────────────────────────────────── */}
        <header className="shrink-0 sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-3 flex items-center gap-4">

          {/* Title */}
          <div className="flex items-center gap-3 shrink-0">
            <Network size={20} className="text-blue-600" />
            <div>
              <h1 className="font-bold text-base text-gray-900 dark:text-slate-100">Schema Explorer</h1>
              <p className="text-sm text-gray-500 dark:text-slate-400">Browse schemas, tables, ERD and export</p>
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
            className="px-2 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60 min-w-[200px]"
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
              ? <span className="text-sm text-gray-400 dark:text-slate-500 animate-pulse">Loading databases…</span>
              : (
                <select
                  value={selectedDb}
                  onChange={e => { if (!connected) setSelectedDb(e.target.value); }}
                  disabled={connected || !dbs.length}
                  className="px-2 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-800 dark:text-slate-200 disabled:opacity-60 min-w-[140px]"
                >
                  {dbs.map(db => <option key={db} value={db}>{db}</option>)}
                </select>
              )
          )}

          {/* DB type badge — green border + check icon when connected */}
          {selectedConn && (
            <span className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-[13px] font-medium border transition-colors ${
              connected
                ? 'bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-300 border-emerald-400 dark:border-emerald-600'
                : 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300 border-blue-100 dark:border-blue-900'
            }`}>
              {connected && <Check size={12} strokeWidth={2.5} />}
              {selectedConn.db_type === 'postgres' ? 'PostgreSQL' : 'MySQL'}
            </span>
          )}

          {connError && <span className="text-sm text-rose-500">{connError}</span>}

          {!connected ? (
            <button
              onClick={() => void handleConnect()}
              disabled={connecting || !selectedConnId || !selectedDb}
              title={connecting ? 'Connecting…' : 'Connect'}
              className="p-1.5 rounded-lg text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40 transition-colors"
            >
              {connecting
                ? <RefreshCw size={17} className="animate-spin" />
                : <Plug size={17} />}
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <button onClick={handleDisconnect} title="Disconnect"
                className="p-1.5 rounded-lg text-gray-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/20 transition-colors">
                <Unplug size={17} />
              </button>
              <button onClick={() => void loadSchemas()} title="Refresh schemas"
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
                <RefreshCw size={16} />
              </button>
            </div>
          )}

        </header>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div className="flex flex-1 min-h-0">

          {/* ── Left panel — flat grouped table list ───────────────────── */}
          <aside className="w-64 shrink-0 flex flex-col border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="flex-1 overflow-y-auto sidebar-scroll">
              {/* Sticky search */}
              <div className="sticky top-0 z-20 px-2 py-1.5 bg-white dark:bg-slate-900 border-b border-gray-100 dark:border-slate-800">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 dark:text-slate-400" />
                  <input value={treeSearch} onChange={e => setTreeSearch(e.target.value)}
                    placeholder="Filter schemas / tables…"
                    className="w-full pl-7 pr-2 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
              </div>

              {!connected && (
                <div className="px-4 py-8 text-center">
                  <Database size={30} className="mx-auto text-slate-400 dark:text-slate-500 mb-2" />
                  <p className="text-sm text-gray-400 dark:text-slate-500">Connect to a database to browse</p>
                </div>
              )}

              {connected && loadingSchemas && (
                <div className="px-4 py-4 text-sm text-gray-400 dark:text-slate-500 animate-pulse">Loading schemas…</div>
              )}

              {connected && !loadingSchemas && filteredSchemas.map(s => {
                const q = treeSearch.toLowerCase();
                const schemaTables = (tables[s.schema] ?? []).filter(t =>
                  !treeSearch || t.name.toLowerCase().includes(q) || s.schema.toLowerCase().includes(q)
                );
                const isLoadingT = loadingTables.has(s.schema);
                const allChecked = schemaTables.length > 0 && schemaTables.every(t => erdTables.has(`${t.schema}.${t.name}`));
                const someChecked = !allChecked && schemaTables.some(t => erdTables.has(`${t.schema}.${t.name}`));
                const isCollapsed = collapsedSchemas.has(s.schema);
                const toggleCollapse = () => setCollapsedSchemas(prev => {
                  const next = new Set(prev);
                  next.has(s.schema) ? next.delete(s.schema) : next.add(s.schema);
                  return next;
                });

                return (
                  <div key={s.schema}>
                    {/* Schema header */}
                    <div
                      className="flex items-center gap-1 px-2 py-1.5 bg-gray-50 dark:bg-slate-800/60 border-b border-gray-100 dark:border-slate-800 sticky top-[38px] z-10 group"
                      draggable={connected}
                      onDragStart={e => {
                        setDraggingSchema(s.schema);
                        e.dataTransfer.effectAllowed = 'copyMove';
                        e.dataTransfer.setData('text/plain', s.schema);
                      }}
                      onDragEnd={() => setDraggingSchema(null)}
                    >
                      {connected && (
                        <GripVertical
                          size={13}
                          className="shrink-0 text-gray-300 dark:text-slate-600 group-hover:text-gray-400 dark:group-hover:text-slate-500 cursor-grab"
                        />
                      )}
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={el => { if (el) el.indeterminate = someChecked; }}
                        onChange={() => toggleSchemaErd(s.schema)}
                        onClick={e => e.stopPropagation()}
                        onMouseDown={e => e.stopPropagation()}
                        className="shrink-0 accent-blue-600 cursor-pointer"
                        title={allChecked ? 'Uncheck all' : 'Check all'}
                      />
                      <button
                        onClick={toggleCollapse}
                        className="flex items-center gap-1 flex-1 min-w-0 text-left"
                      >
                        {isCollapsed
                          ? <ChevronRight size={13} className="shrink-0 text-slate-500 dark:text-slate-400" />
                          : <ChevronDown size={13} className="shrink-0 text-slate-500 dark:text-slate-400" />
                        }
                        <Database size={13} className="text-blue-500 shrink-0" />
                        <span className="text-[13px] font-semibold text-gray-600 dark:text-slate-300 flex-1 truncate ml-0.5">{s.schema}</span>
                      </button>
                      <span className="text-[12px] text-gray-400 dark:text-slate-500 shrink-0 ml-1">
                        {isLoadingT ? '…' : schemaTables.length}
                      </span>
                    </div>

                    {/* Table rows — hidden when collapsed */}
                    {!isCollapsed && (
                      isLoadingT ? (
                        <div className="pl-8 py-1.5 text-[12px] text-gray-400 animate-pulse">Loading…</div>
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
                              <Table2 size={13} className="shrink-0 text-slate-500 dark:text-slate-400" />
                              <span className="text-sm flex-1 truncate">{t.name}</span>
                              <span className="text-[12px] text-gray-400 shrink-0">{t.rowCount.toLocaleString()}</span>
                            </div>
                          );
                        })
                      )
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          {/* ── Right panel ────────────────────────────────────────────── */}
          <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">

            {/* ── Drag-to-transfer overlay ──────────────────────────────── */}
            {draggingSchema && connections.length > 0 && (
              <div className="absolute inset-0 z-40 bg-black/40 backdrop-blur-sm flex flex-col items-center justify-center gap-5 p-8 pointer-events-auto">
                <div className="flex flex-col items-center gap-1">
                  <ArrowRightLeft size={22} className="text-white/70" />
                  <p className="text-white font-semibold text-base">
                    Drop schema <code className="bg-white/20 px-1.5 py-0.5 rounded font-mono">&quot;{draggingSchema}&quot;</code> onto a target connection
                  </p>
                  <p className="text-white/50 text-sm">Same DB type required — use Migration module for cross-type</p>
                </div>
                <div className="flex flex-wrap gap-3 justify-center max-w-2xl">
                  {connections.map(conn => {
                    const compatible = conn.db_type === selectedConn?.db_type;
                    return (
                      <div key={conn.id}
                        onDragOver={e => { if (compatible) e.preventDefault(); }}
                        onDrop={e => {
                          e.preventDefault();
                          if (!compatible) return;
                          setDraggingSchema(null);
                          setTransferModal({ schema: draggingSchema!, targetConn: conn });
                        }}
                        className={`flex flex-col items-center gap-1.5 px-5 py-4 rounded-xl border-2 min-w-[130px] transition-all select-none ${
                          compatible
                            ? 'border-white/40 bg-white/10 hover:bg-white/20 hover:border-white/70 cursor-copy'
                            : 'border-white/10 bg-white/5 opacity-40 cursor-not-allowed'
                        }`}>
                        <Database size={20} className="text-white" />
                        <p className="text-sm font-semibold text-white truncate max-w-[120px]">{conn.label}</p>
                        <p className="text-[12px] text-white/50 font-mono truncate max-w-[120px]">{conn.host}:{conn.port}</p>
                        <span className={`text-[11px] font-bold px-1.5 py-0.5 rounded ${
                          conn.db_type === 'mysql'
                            ? 'bg-orange-500/30 text-orange-200'
                            : 'bg-blue-500/30 text-blue-200'
                        }`}>{conn.db_type === 'mysql' ? 'MySQL' : 'PG'}</span>
                        {!compatible && <span className="text-[11px] text-white/40">incompatible</span>}
                      </div>
                    );
                  })}
                </div>
                <p className="text-white/40 text-[13px]">Press Escape or release outside a target to cancel</p>
              </div>
            )}

            {/* Tab bar */}
            <div className="shrink-0 flex items-center border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900">
              {([
                { key: 'columns', label: 'Columns', Icon: Columns },
                { key: 'erd',     label: 'ERD',     Icon: Network },
                { key: 'export',  label: 'Export',  Icon: Download },
                { key: 'advisor', label: 'FK Advisor', Icon: Wand2 },
              ] as { key: ActiveTab; label: string; Icon: React.FC<{size:number}> }[]).map(({ key, label, Icon }) => (
                <button key={key} onClick={() => setActiveTab(key)}
                  className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === key
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-300'
                  }`}>
                  <Icon size={15} /> {label}
                  {key === 'erd' && erdTables.size > 0 && (
                    <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/50 text-blue-700 dark:text-blue-400 text-[12px] font-semibold">
                      {erdTables.size}
                    </span>
                  )}
                  {key === 'advisor' && advisorSuggestions.length > 0 && (
                    <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-400 text-[12px] font-semibold">
                      {advisorSuggestions.length}
                    </span>
                  )}
                </button>
              ))}

              {/* Right side: columns context + ? Guide flush right */}
              <div className="ml-auto flex items-center pr-2">
                {selectedTable && activeTab === 'columns' && (
                  <div className="flex items-center gap-2 pr-3 mr-1 border-r border-gray-200 dark:border-slate-700">
                    <button
                      onClick={() => setActiveTab('erd')}
                      className="inline-flex items-center gap-1 text-[13px] text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
                      title="View in ERD"
                    >
                      <Network size={13} /> ERD
                    </button>
                    <span className="text-sm text-gray-400 dark:text-slate-500 font-mono">{selectedTable}</span>
                  </div>
                )}

                {/* ? Guide popover — far right of tab bar */}
                <div className="relative">
                  <button
                    onClick={() => setGuideOpen(v => !v)}
                    title="How to use Schema Explorer"
                    className="p-1.5 rounded-md text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors"
                  >
                    <HelpCircle size={16} />
                  </button>
                  {guideOpen && (
                    <div className="absolute right-0 top-full mt-1 w-80 bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-xl shadow-xl z-50 p-4 text-sm text-gray-600 dark:text-slate-300 space-y-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="font-semibold text-gray-800 dark:text-slate-100 text-[15px]">Schema Explorer — Guide</p>
                        <button onClick={() => setGuideOpen(false)} className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-200">
                          <X size={15} />
                        </button>
                      </div>
                      <div className="space-y-2">
                        <div>
                          <p className="font-medium text-slate-600 dark:text-slate-300 mb-0.5 flex items-center gap-1"><Database size={13} className="text-blue-500" /> Left Panel</p>
                          <p className="text-gray-500 dark:text-slate-400 leading-relaxed">Click a schema name to collapse or expand its tables. Use the checkbox to select or deselect all tables in a schema for the ERD.</p>
                        </div>
                        <div>
                          <p className="font-medium text-slate-600 dark:text-slate-300 mb-0.5 flex items-center gap-1"><Columns size={13} className="text-blue-500" /> Columns tab</p>
                          <p className="text-gray-500 dark:text-slate-400 leading-relaxed">Click any table in the left panel to view its columns, data types, PK/FK keys, and sample records.</p>
                        </div>
                        <div>
                          <p className="font-medium text-slate-600 dark:text-slate-300 mb-0.5 flex items-center gap-1"><Network size={13} className="text-blue-500" /> ERD tab</p>
                          <p className="text-gray-500 dark:text-slate-400 leading-relaxed">Checked tables appear on the ERD canvas. Hover over a relationship line to highlight connected tables. Use the Layout button to change direction, spacing, and algorithm.</p>
                        </div>
                        <div>
                          <p className="font-medium text-slate-600 dark:text-slate-300 mb-0.5 flex items-center gap-1"><MousePointer2 size={13} className="text-blue-500" /> Area zoom</p>
                          <p className="text-gray-500 dark:text-slate-400 leading-relaxed">Toggle the <span className="font-mono bg-gray-100 dark:bg-slate-700 px-1 rounded">Hand / Select</span> icon in the canvas to enter select mode — drag a box around nodes to zoom into that area.</p>
                        </div>
                        <div>
                          <p className="font-medium text-slate-600 dark:text-slate-300 mb-0.5 flex items-center gap-1"><Download size={13} className="text-blue-500" /> Export tab</p>
                          <p className="text-gray-500 dark:text-slate-400 leading-relaxed">Download selected tables as SQL, XLSX, or ORM schema (Drizzle, Prisma, TypeORM). Also export the ERD canvas as a PNG or send to the printer.</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* ── Tab content ─────────────────────────────────────────── */}
            <div className="flex-1 overflow-hidden relative">

              {/* Columns tab */}
              {activeTab === 'columns' && (
                <div className="h-full overflow-auto">
                  {!selectedTable && (
                    <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                      <Columns size={38} className="text-slate-400 dark:text-slate-500" />
                      <p className="text-base text-gray-400 dark:text-slate-500">Select a table from the left panel</p>
                    </div>
                  )}
                  {selectedTable && loadingCols && !selectedCols && (
                    <div className="p-8 text-base text-gray-400 animate-pulse">Loading columns…</div>
                  )}
                  {selectedTable && selectedCols && (
                    <div>
                      <table className="w-full text-sm border-collapse">
                        <thead>
                          <tr className="bg-gray-50 dark:bg-slate-800/60 sticky top-0">
                            {['Column', 'Type', 'Nullable', 'Default', 'Key', 'FK Reference', 'Comment'].map(h => (
                              <th key={h} className="text-left px-4 py-2.5 text-[13px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">
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
                              <td className="px-4 py-2 text-gray-500 dark:text-slate-500 font-mono text-[13px] max-w-[140px] truncate">
                                {col.defaultValue ?? <span className="text-gray-300 dark:text-slate-600">—</span>}
                              </td>
                              <td className="px-4 py-2">
                                <div className="flex gap-1">
                                  {col.isPk && <span className="px-1.5 py-0.5 rounded text-[12px] font-bold bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400">PK</span>}
                                  {col.isFk && <span className="px-1.5 py-0.5 rounded text-[12px] font-bold bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400">FK</span>}
                                  {col.isUnique && !col.isPk && <span className="px-1.5 py-0.5 rounded text-[12px] font-bold bg-violet-100 dark:bg-violet-950/40 text-violet-700 dark:text-violet-400">UNI</span>}
                                  {!col.isPk && !col.isFk && !col.isUnique && <span className="text-gray-300 dark:text-slate-600">—</span>}
                                </div>
                              </td>
                              <td className="px-4 py-2 text-blue-600 dark:text-blue-400 font-mono text-[13px]">
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
                          <p className="text-[13px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider mb-2">Foreign Keys</p>
                          <div className="flex flex-wrap gap-2">
                            {selectedCols.fks.map(fk => (
                              <span key={`${fk.fromCol}->${fk.toTable}`}
                                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[13px] bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border border-blue-100 dark:border-blue-900">
                                {fk.fromCol} → {fk.toSchema}.{fk.toTable}.{fk.toCol}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Records section */}
                      <div className="border-t border-gray-100 dark:border-slate-800">
                        <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 dark:bg-slate-800/50">
                          <p className="text-[13px] font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wider">
                            Records
                            {records && <span className="ml-2 normal-case font-normal text-gray-400 dark:text-slate-500">({records.total.toLocaleString()} total)</span>}
                          </p>
                          <button
                            onClick={() => void loadRecords(selectedTable!, recordsOffset)}
                            disabled={loadingRecords}
                            className="inline-flex items-center gap-1 text-[13px] text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors disabled:opacity-40"
                          >
                            <RefreshCw size={13} className={loadingRecords ? 'animate-spin' : ''} />
                            {loadingRecords ? 'Loading…' : 'Reload'}
                          </button>
                        </div>

                        {loadingRecords && !records && (
                          <div className="px-4 py-4 text-sm text-gray-400 animate-pulse">Loading records…</div>
                        )}

                        {records && records.rows.length === 0 && (
                          <div className="px-4 py-4 text-sm text-gray-400 dark:text-slate-500">No records found.</div>
                        )}

                        {records && records.rows.length > 0 && (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm border-collapse">
                              <thead>
                                <tr className="bg-gray-50 dark:bg-slate-800/60">
                                  {records.columns.map(col => (
                                    <th key={col} className="text-left px-3 py-2 text-[13px] font-semibold text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700 whitespace-nowrap">
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
                              <span className="text-[13px] text-gray-400 dark:text-slate-500">
                                {recordsOffset + 1}–{Math.min(recordsOffset + RECORDS_LIMIT, records.total)} of {records.total.toLocaleString()}
                              </span>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => void loadRecords(selectedTable!, recordsOffset - RECORDS_LIMIT)}
                                  disabled={recordsOffset === 0 || loadingRecords}
                                  className="px-2 py-1 text-[13px] rounded border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                                >
                                  ← Prev
                                </button>
                                <button
                                  onClick={() => void loadRecords(selectedTable!, recordsOffset + RECORDS_LIMIT)}
                                  disabled={recordsOffset + RECORDS_LIMIT >= records.total || loadingRecords}
                                  className="px-2 py-1 text-[13px] rounded border border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
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

              {/* ERD tab — always mounted so captureRef stays valid from Export tab */}
              {(() => {
                const visibleKeys = [...erdTables];
                return (
                  <div className={activeTab === 'erd' ? 'h-full flex flex-col' : 'absolute inset-0 invisible pointer-events-none'}>

                    {erdTables.size === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                        <Network size={38} className="text-slate-400 dark:text-slate-500" />
                        <p className="text-base text-gray-400 dark:text-slate-500">
                          Expand a schema in the left panel — tables are added to the ERD automatically
                        </p>
                      </div>
                    ) : (
                      <ReactFlowProvider>
                        <ERDInner
                          erdTableKeys={visibleKeys}
                          columnsCache={columnsCache}
                          onTableClick={selectTable}
                          paperSize={paperSize}
                          orientation={orientation}
                          onCapturingChange={setCapturing}
                          captureRef={captureRef}
                        />
                      </ReactFlowProvider>
                    )}
                  </div>
                );
              })()}

              {/* FK Advisor tab */}
              {activeTab === 'advisor' && (
                <div className="h-full overflow-auto p-6">
                  <div className="max-w-2xl space-y-5">

                    {/* Header */}
                    <div>
                      <h2 className="text-base font-semibold text-gray-800 dark:text-slate-200 mb-1">FK Advisor</h2>
                      <p className="text-sm text-gray-500 dark:text-slate-400 leading-relaxed">
                        Scans loaded tables for <code className="font-mono bg-gray-100 dark:bg-slate-800 px-1 rounded">*_id</code> columns that have no FK constraint defined in the database. Suggests the most likely relationship target using naming conventions, then sends the revised schema to Schema Designer with all accepted FKs applied.
                      </p>
                    </div>

                    {/* Not connected / no columns yet */}
                    {Object.keys(columnsCache).length === 0 ? (
                      <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/20">
                        <AlertCircle size={17} className="text-amber-500 shrink-0 mt-0.5" />
                        <p className="text-sm text-amber-700 dark:text-amber-400">
                          No table columns loaded yet. Connect to a database and load at least one schema first.
                        </p>
                      </div>
                    ) : (
                      <>
                        {/* Scan bar */}
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-gray-500 dark:text-slate-400">
                            <strong className="text-gray-700 dark:text-slate-300">{Object.keys(columnsCache).length}</strong> tables loaded
                            {advisorSuggestions.length > 0 && (
                              <> · <strong className="text-gray-700 dark:text-slate-300">{advisorSuggestions.length}</strong> potential FK(s) found</>
                            )}
                          </span>
                          <button onClick={computeAdvisorSuggestions}
                            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-slate-700 text-sm text-gray-600 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                            <RefreshCw size={13} /> Re-scan
                          </button>
                        </div>

                        {/* No suggestions */}
                        {advisorSuggestions.length === 0 && (
                          <div className="flex items-center gap-3 p-4 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/20">
                            <CheckCircle2 size={17} className="text-emerald-500 shrink-0" />
                            <p className="text-sm text-emerald-700 dark:text-emerald-400">
                              No missing FK relationships detected — all <code className="font-mono">*_id</code> columns either already have constraints or no matching table was inferred.
                            </p>
                          </div>
                        )}

                        {/* Suggestions list */}
                        {advisorSuggestions.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-gray-600 dark:text-slate-400">Suggested relationships</p>
                              <span className="text-[12px] text-gray-400 dark:text-slate-500 ml-auto">
                                {advisorAccepted.size} accepted · {advisorSuggestions.filter(s => !s.toTableKey && !advisorManual[s.id]).length} unresolved
                              </span>
                            </div>

                            <div className="rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden divide-y divide-gray-100 dark:divide-slate-800">
                              {advisorSuggestions.map(s => {
                                const isAccepted = advisorAccepted.has(s.id);
                                const effectiveTarget = advisorManual[s.id] ?? s.toTableKey;
                                const canAccept = !!effectiveTarget;

                                return (
                                  <div key={s.id} className={`flex items-center gap-3 px-4 py-3 text-sm transition-colors ${
                                    isAccepted ? 'bg-white dark:bg-slate-900' : 'bg-gray-50/60 dark:bg-slate-800/40'
                                  }`}>
                                    {/* Accept toggle */}
                                    <button
                                      onClick={() => {
                                        if (!canAccept) return;
                                        setAdvisorAccepted(prev => {
                                          const next = new Set(prev);
                                          next.has(s.id) ? next.delete(s.id) : next.add(s.id);
                                          return next;
                                        });
                                      }}
                                      disabled={!canAccept}
                                      title={canAccept ? (isAccepted ? 'Click to reject' : 'Click to accept') : 'Resolve target first'}
                                      className={`shrink-0 w-5 h-5 rounded flex items-center justify-center border transition-colors ${
                                        isAccepted
                                          ? 'border-emerald-500 bg-emerald-500 text-white'
                                          : canAccept
                                            ? 'border-gray-300 dark:border-slate-600 text-gray-400 hover:border-emerald-400 hover:text-emerald-500'
                                            : 'border-gray-200 dark:border-slate-700 text-gray-300 dark:text-slate-700 cursor-not-allowed'
                                      }`}>
                                      {isAccepted ? <Check size={13} /> : <Minus size={13} />}
                                    </button>

                                    {/* From */}
                                    <div className="flex-1 min-w-0">
                                      <span className="font-mono text-gray-500 dark:text-slate-500">{s.fromTableKey}.</span>
                                      <span className="font-mono font-medium text-gray-800 dark:text-slate-200">{s.fromCol}</span>
                                    </div>

                                    <ArrowRight size={15} className="shrink-0 text-slate-400 dark:text-slate-500" />

                                    {/* To — resolved or picker */}
                                    <div className="flex-1 min-w-0">
                                      {effectiveTarget ? (
                                        <span className={`font-mono ${isAccepted ? 'text-blue-600 dark:text-blue-400' : 'text-gray-400 dark:text-slate-500 line-through'}`}>
                                          {effectiveTarget}.{s.toCol}
                                        </span>
                                      ) : (
                                        <select
                                          value={advisorManual[s.id] ?? ''}
                                          onChange={e => {
                                            const val = e.target.value;
                                            setAdvisorManual(prev => ({ ...prev, [s.id]: val }));
                                            if (val) setAdvisorAccepted(prev => new Set(prev).add(s.id));
                                          }}
                                          className="text-[13px] font-mono rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400 max-w-[180px]">
                                          <option value="">— pick target table —</option>
                                          {Object.keys(columnsCache).filter(k => k !== s.fromTableKey).map(k => (
                                            <option key={k} value={k}>{k}</option>
                                          ))}
                                        </select>
                                      )}
                                    </div>

                                    {/* Confidence badge */}
                                    <span className={`shrink-0 text-[12px] font-semibold px-1.5 py-0.5 rounded-full ${
                                      s.confidence === 'high'       ? 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400' :
                                      s.confidence === 'low'        ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400' :
                                                                      'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400'
                                    }`}>
                                      {s.confidence}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>

                            {/* Legend */}
                            <div className="flex items-center gap-4 text-[13px] text-gray-400 dark:text-slate-500 pt-1">
                              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-emerald-400" /> high — exact name match</span>
                              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-400" /> low — plural/singular guess</span>
                              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-gray-300 dark:bg-slate-600" /> unresolved — manual pick required</span>
                            </div>
                          </div>
                        )}

                        {/* Send to Designer */}
                        {advisorSuggestions.length > 0 && (
                          <div className="pt-5 border-t border-gray-100 dark:border-slate-800 space-y-3">
                            <div>
                              <h3 className="text-base font-semibold text-gray-800 dark:text-slate-200 mb-0.5">Send to Designer</h3>
                              <p className="text-sm text-gray-500 dark:text-slate-400 leading-relaxed">
                                Generates DDL for all <strong>{Object.keys(columnsCache).length}</strong> loaded tables with <strong>{advisorAccepted.size}</strong> inferred FK(s) applied as <code className="font-mono bg-gray-100 dark:bg-slate-800 px-1 rounded">REFERENCES</code> constraints, saves it as a new Schema Designer job, and opens the designer.
                              </p>
                            </div>
                            <button
                              onClick={() => void sendToDesigner()}
                              disabled={sendingToDesigner || advisorAccepted.size === 0}
                              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-violet-600 text-white text-base font-medium hover:bg-violet-700 disabled:opacity-50 transition-colors"
                            >
                              <Send size={16} />
                              {sendingToDesigner ? 'Saving…' : `Send to Designer (${advisorAccepted.size} FK applied)`}
                            </button>
                            <p className="text-[13px] text-gray-400 dark:text-slate-500">
                              In Schema Designer: load the saved job → review → export ORM (Drizzle / Prisma / TypeORM).
                            </p>
                          </div>
                        )}
                      </>
                    )}

                  </div>
                </div>
              )}

              {/* Export tab */}
              {activeTab === 'export' && (
                <div className="h-full overflow-auto p-6">
                  <div className="max-w-xl space-y-6">
                    <div>
                      <h2 className="text-base font-semibold text-gray-800 dark:text-slate-200 mb-1">Export</h2>
                      <p className="text-sm text-gray-500 dark:text-slate-400">
                        Export selected tables ({erdTables.size} selected via ERD panel).
                        Add tables to the ERD first using the <Network size={13} className="inline-block" /> icon.
                      </p>
                    </div>

                    {/* Format picker */}
                    <div className="space-y-3">
                      <p className="text-sm font-medium text-gray-600 dark:text-slate-400">Format</p>

                      {/* Schema files */}
                      <div className="flex gap-2">
                        {([
                          { v: 'sql' as const,  label: 'Migration SQL',  Icon: Code2,          desc: 'CREATE TABLE + FK constraints' },
                          { v: 'xlsx' as const, label: 'Schema XLSX',    Icon: FileSpreadsheet, desc: 'Single sheet — all columns' },
                        ]).map(({ v, label, Icon, desc }) => (
                          <button key={v} onClick={() => setExportFormat(v)}
                            className={`flex-1 flex flex-col items-start gap-1 p-3 rounded-xl border-2 text-left transition-colors ${
                              exportFormat === v
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/20'
                                : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                            }`}>
                            <div className="flex items-center gap-2">
                              <Icon size={16} className={exportFormat === v ? 'text-blue-600' : 'text-slate-500 dark:text-slate-400'} />
                              <span className={`text-sm font-semibold ${exportFormat === v ? 'text-blue-700 dark:text-blue-400' : 'text-gray-700 dark:text-slate-300'}`}>{label}</span>
                            </div>
                            <p className="text-[13px] text-gray-400 dark:text-slate-500">{desc}</p>
                          </button>
                        ))}
                      </div>

                      {/* ORM */}
                      <div>
                        <p className="text-[13px] text-gray-400 dark:text-slate-500 mb-1.5">ORM Schema</p>
                        <div className="flex gap-2">
                          {([
                            { v: 'drizzle'  as const, label: 'Drizzle',  desc: 'drizzle-schema.ts' },
                            { v: 'prisma'   as const, label: 'Prisma',   desc: 'schema.prisma' },
                            { v: 'typeorm'  as const, label: 'TypeORM',  desc: 'typeorm-entities.ts' },
                          ]).map(({ v, label, desc }) => (
                            <button key={v} onClick={() => setExportFormat(v)}
                              className={`flex-1 flex flex-col items-start gap-1 p-3 rounded-xl border-2 text-left transition-colors ${
                                exportFormat === v
                                  ? 'border-violet-500 bg-violet-50 dark:bg-violet-950/20'
                                  : 'border-gray-200 dark:border-slate-700 hover:border-gray-300 dark:hover:border-slate-600'
                              }`}>
                              <span className={`text-sm font-semibold ${exportFormat === v ? 'text-violet-700 dark:text-violet-400' : 'text-gray-700 dark:text-slate-300'}`}>{label}</span>
                              <p className="text-[13px] text-gray-400 dark:text-slate-500 font-mono">{desc}</p>
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Selected tables list */}
                    {erdTables.size > 0 && (
                      <div>
                        <p className="text-sm font-medium text-gray-600 dark:text-slate-400 mb-1.5">Tables to export</p>
                        <div className="rounded-lg border border-gray-200 dark:border-slate-700 overflow-hidden">
                          {[...erdTables].map((key, i) => (
                            <div key={key} className={`flex items-center justify-between px-3 py-2 text-sm ${i > 0 ? 'border-t border-gray-100 dark:border-slate-800' : ''}`}>
                              <span className="font-mono text-gray-700 dark:text-slate-300">{key}</span>
                              <button onClick={() => setErdTables(p => { const n = new Set(p); n.delete(key); return n; })}
                                className="text-gray-300 dark:text-slate-600 hover:text-rose-500 transition-colors">
                                <X size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <button
                      onClick={() => void handleExport()}
                      disabled={exporting || erdTables.size === 0}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-blue-600 text-white text-base font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                    >
                      <Download size={16} />
                      {exporting ? 'Exporting…' : `Export ${({ sql: 'SQL', xlsx: 'XLSX', drizzle: 'Drizzle', prisma: 'Prisma', typeorm: 'TypeORM' } as Record<string,string>)[exportFormat] ?? exportFormat}`}
                    </button>

                    {/* ── Canvas image export ─────────────────────────── */}
                    <div className="pt-4 border-t border-gray-100 dark:border-slate-800 space-y-3">
                      <div>
                        <h3 className="text-base font-semibold text-gray-800 dark:text-slate-200 mb-0.5">Canvas Image</h3>
                        <p className="text-sm text-gray-500 dark:text-slate-400">Print or save the ERD canvas as a PNG image.</p>
                      </div>

                      {/* Paper size */}
                      <div className="space-y-1.5">
                        <p className="text-sm font-medium text-gray-600 dark:text-slate-400">Paper size</p>
                        <div className="grid grid-cols-4 gap-1.5">
                          {(['a4','a3','letter','legal'] as PaperSize[]).map(s => (
                            <button key={s} onClick={() => setPaperSize(s)}
                              className={`py-1.5 text-sm rounded-lg border transition-colors ${paperSize === s ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'}`}>
                              {PAPER_LABELS[s]}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Orientation */}
                      <div className="space-y-1.5">
                        <p className="text-sm font-medium text-gray-600 dark:text-slate-400">Orientation</p>
                        <div className="grid grid-cols-2 gap-1.5">
                          {(['landscape','portrait'] as Orientation[]).map(o => (
                            <button key={o} onClick={() => setOrientation(o)}
                              className={`py-1.5 text-sm rounded-lg border transition-colors capitalize ${orientation === o ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400' : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-gray-300 dark:hover:border-slate-600'}`}>
                              {o}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Print + PNG buttons */}
                      <div className="flex gap-3">
                        <button
                          onClick={() => void captureRef.current?.triggerPrint()}
                          disabled={capturing || erdTables.size === 0}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 text-base font-medium hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
                        >
                          <Printer size={15} />
                          {capturing ? 'Capturing…' : 'Print'}
                        </button>
                        <button
                          onClick={() => void captureRef.current?.triggerPng()}
                          disabled={capturing || erdTables.size === 0}
                          className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-gray-700 dark:text-slate-300 text-base font-medium hover:bg-gray-50 dark:hover:bg-slate-700 disabled:opacity-50 transition-colors"
                        >
                          <Download size={15} />
                          {capturing ? 'Capturing…' : 'Export PNG'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}


            </div>
          </main>
        </div>
      </div>

      {/* Schema transfer modal */}
      {transferModal && selectedConn && (
        <SchemaTransferModal
          schema={transferModal.schema}
          sourceConn={selectedConn}
          sourceDb={selectedDb}
          targetConn={transferModal.targetConn}
          onClose={() => setTransferModal(null)}
        />
      )}
    </>
  );
}
