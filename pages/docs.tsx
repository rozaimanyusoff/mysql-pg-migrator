import React, { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import axios from 'axios';
import { toast } from 'sonner';
import { MigrationConfig, PgConnectionConfig } from '../lib/types';
import DocumentationViewer from '../components/DocumentationViewer';
import { LoadingSpinner, EmptyState } from '../components/StateComponents';
import ConnectionBadges from '../components/ConnectionBadges';
import ResetEverythingButton from '../components/ResetEverythingButton';
import { CheckCircle, XCircle, ChevronRight, FileText, Table, Code2, Image as ImageIcon, PenSquare, HelpCircle, ShieldCheck, ShieldAlert, RotateCcw, RefreshCw } from 'lucide-react';

type DocFormat = 'markdown' | 'csv' | 'sql' | 'svg' | 'canvas';
const PHASE2_REVIEWED_KEY = 'phase2_schema_reviewed';
const TABLE_STATUS_KEY = 'mysql_table_status';
const PHASE3_TEMPLATE_READY_KEY = 'phase3_template_ready';

type Phase3TemplateReadyState = {
  ready: boolean;
  readyAt: string;
  confirmedCount: number;
  assignedKeys?: string[];
};

type RowValidationState = {
  valid: boolean;
  errors: number;
  warnings: number;
  checkedAt: string;
};

type TargetScanState = {
  valid: boolean;
  exists: boolean;
  errors: number;
  warnings: number;
  checkedAt: string;
};

type MigrationRowState = {
  status: 'pending' | 'running' | 'completed' | 'failed';
  rowsCopied: number;
  rowsSource: number | null;
  runId: string;
  error?: string;
};

function Phase3PurposeHelp() {
  return (
    <details className="group relative">
      <summary className="list-none inline-flex items-center justify-center w-4 h-4 rounded-full border border-gray-300 dark:border-slate-600 text-gray-500 dark:text-slate-300 hover:text-gray-700 dark:hover:text-slate-100 cursor-pointer">
        <HelpCircle size={12} />
      </summary>
      <div className="absolute left-0 mt-2 z-50 w-[min(42rem,calc(100vw-2rem))] rounded-xl border border-amber-200 bg-amber-50 p-3 shadow-lg dark:border-amber-700 dark:bg-slate-900">
        <h3 className="text-sm font-semibold text-amber-900 dark:text-amber-300">Phase 3: Schema Template Validation & Preparation</h3>
        <p className="mt-1 text-xs text-amber-800 dark:text-slate-300">
          Validate template mappings, scan target schemas/tables, and safely generate or regenerate target structures before Phase 4 migration.
        </p>
        <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-amber-900 dark:text-slate-200">
          <div className="rounded-md border border-amber-200 bg-white/80 px-2.5 py-2 dark:border-amber-800 dark:bg-slate-800/80">
            <p className="font-semibold">Check</p>
            <p className="text-amber-800 mt-0.5 dark:text-slate-300">Run validation (individual, selected, or all configured) to detect errors/warnings and preview SQL.</p>
          </div>
          <div className="rounded-md border border-amber-200 bg-white/80 px-2.5 py-2 dark:border-amber-800 dark:bg-slate-800/80">
            <p className="font-semibold">Generate</p>
            <p className="text-amber-800 mt-0.5 dark:text-slate-300">Create schema/table/index on target PostgreSQL (if not exist), based on Phase 2 final configuration.</p>
          </div>
          <div className="rounded-md border border-amber-200 bg-white/80 px-2.5 py-2 dark:border-amber-800 dark:bg-slate-800/80">
            <p className="font-semibold">Template Scope</p>
            <p className="text-amber-800 mt-0.5 dark:text-slate-300">Only Phase 2 template tables are shown here. Confirm & save template in Phase 2 first.</p>
          </div>
          <div className="rounded-md border border-amber-200 bg-white/80 px-2.5 py-2 dark:border-amber-800 dark:bg-slate-800/80">
            <p className="font-semibold">Export Docs</p>
            <p className="text-amber-800 mt-0.5 dark:text-slate-300">Export Markdown/CSV/SQL/SVG/Canvas JSON for review, documentation, and audit readiness.</p>
          </div>
        </div>
      </div>
    </details>
  );
}

export default function Phase3() {
  const [config, setConfig] = useState<MigrationConfig | null>(null);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [phase1Done, setPhase1Done] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [selectedExportTables, setSelectedExportTables] = useState<Set<string>>(new Set());
  const [viewOptions, setViewOptions] = useState({ includeSource: true, includeTarget: true });
  const [docContent, setDocContent] = useState<{ content: string; format: DocFormat } | null>(null);
  const [templateReady, setTemplateReady] = useState<Phase3TemplateReadyState | null>(null);
  const [pgConfig, setPgConfig] = useState<PgConnectionConfig | null>(null);
  const [generatingTargetSchema, setGeneratingTargetSchema] = useState(false);
  const [rowValidation, setRowValidation] = useState<Record<string, RowValidationState>>({});
  const [rowScan, setRowScan] = useState<Record<string, TargetScanState>>({});
  const [rowMigration, setRowMigration] = useState<Record<string, MigrationRowState>>({});
  const [loadingRunStatus, setLoadingRunStatus] = useState(false);
  const autoAnalyzeSignatureRef = useRef<string>('');

  const notifyError = (message: string) => {
    window.alert(message);
  };

  useEffect(() => {
    const raw = localStorage.getItem('migration_config');
    if (raw) {
      const parsed = JSON.parse(raw) as MigrationConfig;
      setConfig(parsed);
      if (parsed.phase3TemplateReady) {
        setTemplateReady({
          ready: true,
          readyAt: parsed.phase3TemplateReadyAt || parsed.updatedAt,
          confirmedCount: parsed.tables.filter((t) => t.include).length,
        });
      }
    }

    const rawTemplateReady = localStorage.getItem(PHASE3_TEMPLATE_READY_KEY);
    if (rawTemplateReady) {
      try {
        setTemplateReady(JSON.parse(rawTemplateReady) as Phase3TemplateReadyState);
      } catch {
        setTemplateReady(null);
      }
    }

    const rawPg = localStorage.getItem('pg_connection');
    if (rawPg) {
      try {
        const parsed = JSON.parse(rawPg) as { form?: PgConnectionConfig; connected?: boolean };
        if (parsed.form && parsed.connected) setPgConfig(parsed.form);
      } catch {
        setPgConfig(null);
      }
    }

    const reviewedRaw = localStorage.getItem(PHASE2_REVIEWED_KEY);
    if (reviewedRaw) {
      try {
        const keys = JSON.parse(reviewedRaw) as string[];
        setReviewed(new Set(keys));
      } catch {
        setReviewed(new Set());
      }
    }

    const statusRaw = localStorage.getItem(TABLE_STATUS_KEY);
    if (statusRaw) {
      try {
        const status = JSON.parse(statusRaw) as { done?: string[] };
        setPhase1Done(new Set(status.done ?? []));
      } catch {
        setPhase1Done(new Set());
      }
    }
  }, []);

  const loadLatestRunStatus = async () => {
    setLoadingRunStatus(true);
    try {
      const { data } = await axios.get('/api/migration-run-status');
      const runs = (data?.runs ?? []) as Array<{ id: string }>;
      if (!runs.length) {
        setRowMigration({});
        return;
      }
      const { data: runData } = await axios.get('/api/migration-run-status', { params: { id: runs[0].id } });
      const run = runData?.run as { id: string; tables?: Array<{ key: string; status: 'pending' | 'running' | 'completed' | 'failed'; rowsCopied: number; rowsSource: number | null; error?: string }> } | undefined;
      if (!run?.tables) {
        setRowMigration({});
        return;
      }
      const map: Record<string, MigrationRowState> = {};
      for (const t of run.tables) {
        map[t.key] = {
          status: t.status,
          rowsCopied: t.rowsCopied,
          rowsSource: t.rowsSource,
          runId: run.id,
          error: t.error,
        };
      }
      setRowMigration(map);
    } catch {
      // non-blocking
    } finally {
      setLoadingRunStatus(false);
    }
  };

  useEffect(() => {
    void loadLatestRunStatus();
  }, []);

  const handleGenerateDocs = async (format: DocFormat) => {
    if (!effectiveConfig) return;
    if (!viewOptions.includeSource && !viewOptions.includeTarget) {
      notifyError('Select at least one view option: Source or Target.');
      return;
    }
    if (selectedTemplateTables.length === 0) {
      notifyError('Select at least one template table for export.');
      return;
    }
    setLoading(true);
    try {
      const { data } = await axios.post('/api/generate-docs', {
        config: effectiveConfig,
        format,
        viewOptions,
      });
      setDocContent({ content: data.content, format });
      toast.success(`${format.toUpperCase()} document generated.`);
    } catch (err: unknown) {
      notifyError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setLoading(false);
    }
  };

  const buildConfigForKeys = (keys: Set<string>) => {
    if (!config) return null;
    return {
      ...config,
      tables: config.tables.map((t) => ({
        ...t,
        include: t.include && isReviewed(t) && keys.has(tableKey(t)),
      })),
    } as MigrationConfig;
  };

  const handleDryRun = async (keys?: Set<string>, sourceKey?: string) => {
    const effectiveKeys = keys ?? selectedExportTables;
    const scopedConfig = buildConfigForKeys(effectiveKeys);
    if (!scopedConfig) return;
    const selectedCount = scopedConfig.tables.filter((t) => t.include).length;
    if (selectedCount === 0) {
      notifyError('Select at least one template table for check.');
      return;
    }
    setLoading(true);
    try {
      const { data } = await axios.post('/api/dry-run', { config: scopedConfig });
      toast.success(`Check completed for ${selectedCount} table(s).`);
      const checkedAt = new Date().toISOString();
      if (sourceKey) {
        setRowValidation((prev) => ({
          ...prev,
          [sourceKey]: {
            valid: !!data.valid,
            errors: Array.isArray(data.errors) ? data.errors.length : 0,
            warnings: Array.isArray(data.warnings) ? data.warnings.length : 0,
            checkedAt,
          },
        }));
      }
    } catch (err: unknown) {
      notifyError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setLoading(false);
    }
  };


  const handleGenerateSchemaOnTarget = async (
    keys?: Set<string>,
    opts?: { dropExisting?: boolean }
  ) => {
    const effectiveKeys = keys ?? selectedExportTables;
    const scopedConfig = buildConfigForKeys(effectiveKeys);
    if (!scopedConfig) return;
    const selectedCount = scopedConfig.tables.filter((t) => t.include).length;
    if (selectedCount === 0) {
      notifyError('Select at least one template table to generate schema.');
      return;
    }
    if (!pgConfig) {
      notifyError('PostgreSQL connection is not available. Connect target DB in Phase 1 first.');
      return;
    }
    setGeneratingTargetSchema(true);
    try {
      const { data } = await axios.post('/api/generate-schema-target', {
        config: scopedConfig,
        pgConfig,
        options: { dropExisting: Boolean(opts?.dropExisting) },
      });
      if (data?.success === false) {
        const errors = Array.isArray(data?.errors) ? data.errors : [];
        const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
        const errorPreview = errors.slice(0, 3).join(' | ');
        notifyError(
          `Generate schema finished with errors (${errors.length}).` +
          (errorPreview ? ` ${errorPreview}` : '')
        );
        toast.success(
          `Partial generate: ${data.schemasCreated ?? 0} schemas, ${data.tablesCreated ?? 0} tables, ${data.indexesCreated ?? 0} indexes` +
          (warnings.length ? `, ${warnings.length} warnings.` : '.')
        );
        return;
      }
      toast.success(`${opts?.dropExisting ? 'Regenerated' : 'Generated'} for ${selectedCount} table(s): ${data.schemasCreated} schemas, ${data.tablesCreated} tables, ${data.indexesCreated} indexes.`);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const payload = err.response?.data as { error?: string; errors?: string[]; warnings?: string[] } | undefined;
        const details = Array.isArray(payload?.errors) ? payload.errors.slice(0, 3).join(' | ') : '';
        const base = payload?.error ?? err.message;
        notifyError(details ? `${base}: ${details}` : base);
      } else {
        notifyError(String(err));
      }
    } finally {
      setGeneratingTargetSchema(false);
    }
  };

  const handleScanTarget = async (keys?: Set<string>, sourceKey?: string, opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent);
    const effectiveKeys = keys ?? selectedExportTables;
    const scopedConfig = buildConfigForKeys(effectiveKeys);
    if (!scopedConfig) return;
    const selectedCount = scopedConfig.tables.filter((t) => t.include).length;
    if (selectedCount === 0) {
      if (!silent) notifyError('Select at least one template table to scan target schema.');
      return;
    }
    if (!pgConfig) {
      if (!silent) notifyError('PostgreSQL connection is not available. Connect target DB in Phase 1 first.');
      return;
    }
    if (!silent) setLoading(true);
    try {
      const { data } = await axios.post('/api/scan-template-target', {
        config: scopedConfig,
        pgConfig,
      });
      const results = (data?.results ?? []) as Array<{ key: string; valid: boolean; exists: boolean; errors?: string[]; warnings?: string[] }>;
      const checkedAt = new Date().toISOString();
      const next: Record<string, TargetScanState> = {};
      for (const r of results) {
        next[r.key] = {
          valid: Boolean(r.valid),
          exists: Boolean(r.exists),
          errors: Array.isArray(r.errors) ? r.errors.length : 0,
          warnings: Array.isArray(r.warnings) ? r.warnings.length : 0,
          checkedAt,
        };
      }
      setRowScan((prev) => ({ ...prev, ...next }));
      if (silent) return;
      if (sourceKey && next[sourceKey]) {
        const s = next[sourceKey];
        if (!s.valid) {
          notifyError(`Target scan failed for selected table. errors: ${s.errors}, warnings: ${s.warnings}`);
        } else {
          toast.success('Target scan passed for selected table.');
        }
      } else {
        const failed = Number(data?.failed ?? 0);
        if (failed > 0) notifyError(`Target scan completed with ${failed} table issue(s).`);
        else toast.success(`Target scan passed for ${selectedCount} table(s).`);
      }
    } catch (err: unknown) {
      if (!silent) {
        notifyError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
      }
    } finally {
      if (!silent) setLoading(false);
    }
  };


  const isReviewed = (t: MigrationConfig['tables'][number]) => {
    const composite = `${t.sourceDatabase}::${t.mysqlName}`;
    return reviewed.has(composite) || reviewed.has(t.mysqlName);
  };
  const isDone = (t: MigrationConfig['tables'][number]) => {
    const composite = `${t.sourceDatabase}::${t.mysqlName}`;
    return phase1Done.has(composite) || phase1Done.has(t.mysqlName);
  };

  const confirmed = config?.tables.filter((t) => t.include && isDone(t) && isReviewed(t)) ?? [];
  const configureTotal = config?.tables.length ?? 0;
  const configureDone = config?.tables.filter((t) => isDone(t)).length ?? 0;
  const assignTotal = configureDone;
  const assignDone = config?.tables.filter((t) => isDone(t) && isReviewed(t)).length ?? 0;
  const tableKey = (t: MigrationConfig['tables'][number]) => `${t.sourceDatabase}::${t.mysqlName}`;
  const confirmedKeys = confirmed.map((t) => tableKey(t));
  const assignedKeySet = new Set(
    templateReady?.ready
      ? ((templateReady.assignedKeys?.length ? templateReady.assignedKeys : confirmedKeys))
      : []
  );
  const templateTables = confirmed.filter((t) => assignedKeySet.has(tableKey(t)));
  const templateAssigned = templateTables.length;
  const selectedTemplateTables = templateTables.filter((t) => selectedExportTables.has(tableKey(t)));
  const templateKeysSorted = templateTables.map((t) => tableKey(t)).sort();
  const migrateTotal = templateTables.length;
  const migrateSuccess = templateTables.filter((t) => rowMigration[tableKey(t)]?.status === 'completed').length;
  const handleHomeNavigate = () => {
    const ok = window.confirm('Return to module home and clear all local session data?');
    if (!ok) return;
    localStorage.clear();
    window.location.href = '/';
  };

  useEffect(() => {
    if (!templateReady?.ready || !pgConfig || templateKeysSorted.length === 0) return;
    const signature = JSON.stringify({
      keys: templateKeysSorted,
      pg: `${pgConfig.host}:${pgConfig.port}/${pgConfig.database}`,
    });
    if (autoAnalyzeSignatureRef.current === signature) return;
    autoAnalyzeSignatureRef.current = signature;
    void loadLatestRunStatus();
    void handleScanTarget(new Set(templateKeysSorted), undefined, { silent: true });
  }, [
    templateReady?.ready,
    templateKeysSorted.join('|'),
    pgConfig?.host,
    pgConfig?.port,
    pgConfig?.database,
  ]);

  useEffect(() => {
    if (!config) return;
    const next = new Set(selectedExportTables);
    let changed = false;
    const scope = templateTables;
    for (const t of scope) {
      const key = tableKey(t);
      if (!next.has(key)) {
        next.add(key);
        changed = true;
      }
    }
    for (const k of next) {
      if (!scope.some((t) => tableKey(t) === k)) {
        next.delete(k);
        changed = true;
      }
    }
    if (changed) setSelectedExportTables(next);
  }, [config, reviewed, templateReady, templateAssigned]);

  if (!config) {
    return (
      <>
        <Head>
          <title>Schema Template — Phase 3</title>
        </Head>
        <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
          <header className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between">
            <div>
              <h1 className="font-bold text-gray-900 dark:text-slate-100">Migration: Schema Template</h1>
              <div className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 dark:text-slate-400">
                <span>Generate export documents and validate selected mappings before migration.</span>
                <Phase3PurposeHelp />
              </div>
            </div>
            <ConnectionBadges />
            <nav className="flex items-center gap-1 text-sm">
              {[
                { label: 'Home', href: '/' },
                { label: 'Configure Mapping', href: '/migration' },
                { label: 'Assign Target', href: '/mapping' },
                { label: 'Schema Template', href: '/docs', active: true },
                { label: 'Migrate', href: '/migrate' },
              ].map((item, i) => (
                <React.Fragment key={item.href}>
                  {i > 0 && <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />}
                  {item.href === '/' ? (
                    <button
                      type="button"
                      onClick={handleHomeNavigate}
                      className={`px-3 py-1 rounded-lg ${item.active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}
                    >
                      {item.label}
                    </button>
                  ) : (
                    <Link href={item.href} className={`px-3 py-1 rounded-lg ${item.active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}>
                      {item.label}
                      {item.label === 'Configure Mapping' && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-200/70 dark:bg-blue-800/70 text-blue-800 dark:text-blue-200 font-semibold">
                          {configureDone}/{configureTotal}
                        </span>
                      )}
                      {item.label === 'Assign Target' && (
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
          <main className="max-w-5xl mx-auto px-6 py-20">
            <EmptyState
              title="No migration configuration found"
              description="Go to Phase 1, inspect your database, then set up mappings in Phase 2."
            />
          </main>
        </div>
      </>
    );
  }

  const effectiveConfig: MigrationConfig = {
    ...config,
    tables: config.tables.map((t) => ({ ...t, include: t.include && isReviewed(t) && selectedExportTables.has(tableKey(t)) })),
  };

  const toggleExportTable = (key: string) => {
    const next = new Set(selectedExportTables);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedExportTables(next);
  };

  const setAllExportSelection = (checked: boolean) => {
    const scope = templateTables;
    if (!checked) {
      setSelectedExportTables(new Set());
      return;
    }
    setSelectedExportTables(new Set(scope.map((t) => tableKey(t))));
  };

  return (
    <>
      <Head>
        <title>Schema Template — Phase 3</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        <header className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-900 dark:text-slate-100">Migration: Schema Template</h1>
            <div className="mt-0.5 flex items-center gap-1 text-xs text-gray-500 dark:text-slate-400">
              <span>Generate export documents and validate selected mappings before migration.</span>
              <Phase3PurposeHelp />
            </div>
          </div>
          <ConnectionBadges />
          <nav className="flex items-center gap-1 text-sm">
            {[
              { label: 'Home', href: '/' },
              { label: 'Configure Mapping', href: '/migration' },
              { label: 'Assign Target', href: '/mapping' },
              { label: 'Schema Template', href: '/docs', active: true },
              { label: 'Migrate', href: '/migrate' },
            ].map((item, i) => (
              <React.Fragment key={item.href}>
                {i > 0 && <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />}
                {item.href === '/' ? (
                  <button
                    type="button"
                    onClick={handleHomeNavigate}
                    className={`px-3 py-1 rounded-lg ${item.active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}
                  >
                    {item.label}
                  </button>
                ) : (
                  <Link href={item.href} className={`px-3 py-1 rounded-lg ${item.active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}>
                    {item.label}
                    {item.label === 'Configure Mapping' && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-200/70 dark:bg-blue-800/70 text-blue-800 dark:text-blue-200 font-semibold">
                        {configureDone}/{configureTotal}
                      </span>
                    )}
                    {item.label === 'Assign Target' && (
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

        <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
          <div className="space-y-4">
            <div className="bg-white dark:bg-slate-900/70 rounded-xl border border-gray-200 dark:border-slate-700 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-gray-800 dark:text-slate-100 text-sm">Export Documents</h3>
                  <p className="text-xs text-gray-500 dark:text-slate-400">Generate review artifacts and run schema checks before migration.</p>
                  {templateReady?.ready && (
                    <p className="text-xs text-emerald-700 mt-1">
                      Template stage ready at {new Date(templateReady.readyAt).toLocaleString()} ({templateReady.assignedKeys?.length ?? templateReady.confirmedCount} tables).
                    </p>
                  )}
                  <div className="mt-2 flex items-center gap-3">
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={viewOptions.includeSource}
                        onChange={(e) => setViewOptions((v) => ({ ...v, includeSource: e.target.checked }))}
                        className="w-3.5 h-3.5"
                      />
                      Source
                    </label>
                    <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={viewOptions.includeTarget}
                        onChange={(e) => setViewOptions((v) => ({ ...v, includeTarget: e.target.checked }))}
                        className="w-3.5 h-3.5"
                      />
                      Target
                    </label>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => handleGenerateDocs('markdown')} disabled={loading} className="text-xs bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/25 dark:hover:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><FileText size={13} />Markdown</button>
                  <button onClick={() => handleGenerateDocs('csv')} disabled={loading} className="text-xs bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/25 dark:hover:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><Table size={13} />CSV</button>
                  <button onClick={() => handleGenerateDocs('sql')} disabled={loading} className="text-xs bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/25 dark:hover:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><Code2 size={13} />SQL</button>
                  <button onClick={() => handleGenerateDocs('svg')} disabled={loading} className="text-xs bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/25 dark:hover:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><ImageIcon size={13} />SVG Diagram</button>
                  <button onClick={() => handleGenerateDocs('canvas')} disabled={loading} className="text-xs bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-900/25 dark:hover:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><PenSquare size={13} />Canvas JSON</button>
                  <button onClick={() => void handleDryRun()} disabled={loading} className="text-xs bg-green-50 hover:bg-green-100 dark:bg-emerald-900/25 dark:hover:bg-emerald-900/40 text-green-700 dark:text-emerald-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><CheckCircle size={13} />Check Selected</button>
                  <button onClick={() => void handleDryRun(new Set(templateTables.map((t) => tableKey(t))))} disabled={loading || templateTables.length === 0} className="text-xs bg-green-50 hover:bg-green-100 dark:bg-emerald-900/25 dark:hover:bg-emerald-900/40 text-green-700 dark:text-emerald-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><CheckCircle size={13} />Check All Template</button>
                  <button onClick={() => void handleGenerateSchemaOnTarget()} disabled={generatingTargetSchema || !pgConfig} className="text-xs bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/25 dark:hover:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><CheckCircle size={13} />Generate Selected</button>
                  <button onClick={() => void handleGenerateSchemaOnTarget(new Set(templateTables.map((t) => tableKey(t))))} disabled={generatingTargetSchema || !pgConfig || templateTables.length === 0} className="text-xs bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/25 dark:hover:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><CheckCircle size={13} />Generate All Template</button>
                  <button onClick={() => void handleGenerateSchemaOnTarget(undefined, { dropExisting: true })} disabled={generatingTargetSchema || !pgConfig} className="text-xs bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/25 dark:hover:bg-amber-900/40 text-amber-700 dark:text-amber-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><RotateCcw size={13} />Regenerate Selected</button>
                  <button onClick={() => void handleScanTarget()} disabled={loading || !pgConfig} className="text-xs bg-cyan-50 hover:bg-cyan-100 dark:bg-cyan-900/25 dark:hover:bg-cyan-900/40 text-cyan-700 dark:text-cyan-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><ShieldCheck size={13} />Scan Selected</button>
                  <button onClick={() => void loadLatestRunStatus()} disabled={loadingRunStatus} className="text-xs bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 font-medium px-2.5 py-1.5 rounded-md transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"><RefreshCw size={13} className={loadingRunStatus ? 'animate-spin' : ''} />Refresh Run Status</button>
                </div>
              </div>
            </div>

            {loading && <LoadingSpinner message="Validating selected configuration…" />}

            <div className="bg-white dark:bg-slate-900/70 rounded-xl border border-gray-200 dark:border-slate-700 p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-gray-800 dark:text-slate-100 text-sm">Template Tables (Phase 2 Scope)</h3>
                <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={templateTables.length > 0 && selectedTemplateTables.length === templateTables.length}
                    onChange={(e) => setAllExportSelection(e.target.checked)}
                    className="w-3.5 h-3.5"
                  />
                  Select all
                </label>
              </div>
              {templateTables.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-slate-400">No template table found. Complete “Confirmed & Save as Template” in Phase 2.</p>
              ) : (
                <ul className="space-y-1.5">
                  {templateTables.map((t) => (
                    <li key={tableKey(t)} className="text-sm text-gray-700 dark:text-slate-200 bg-gray-50 dark:bg-slate-800/70 border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selectedExportTables.has(tableKey(t))}
                        onChange={() => toggleExportTable(tableKey(t))}
                        className="w-3.5 h-3.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{t.mysqlName}</span>
                          <span className="text-gray-500 dark:text-slate-400"> → {t.pgSchema}.{t.pgName}</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => void handleDryRun(new Set([tableKey(t)]), tableKey(t))}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/25 text-blue-700 dark:text-blue-300 font-semibold hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
                            >
                              Validate
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleGenerateSchemaOnTarget(new Set([tableKey(t)]))}
                              disabled={generatingTargetSchema || !pgConfig}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/25 text-emerald-700 dark:text-emerald-300 font-semibold hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors disabled:opacity-50"
                            >
                              Generate
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleScanTarget(new Set([tableKey(t)]), tableKey(t))}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-cyan-200 dark:border-cyan-800 bg-cyan-50 dark:bg-cyan-900/25 text-cyan-700 dark:text-cyan-300 font-semibold hover:bg-cyan-100 dark:hover:bg-cyan-900/40 transition-colors"
                            >
                              Scan
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleGenerateSchemaOnTarget(new Set([tableKey(t)]), { dropExisting: true })}
                              disabled={generatingTargetSchema || !pgConfig}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/25 text-amber-700 dark:text-amber-300 font-semibold hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors disabled:opacity-50"
                            >
                              Regenerate
                            </button>
                          </div>
                        </div>
                        {rowValidation[tableKey(t)] && (
                          <p className={`text-[11px] mt-1 ${
                            rowValidation[tableKey(t)].valid ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'
                          }`}>
                            {rowValidation[tableKey(t)].valid ? 'Validated' : 'Validation failed'} ·
                            {' '}errors: {rowValidation[tableKey(t)].errors}, warnings: {rowValidation[tableKey(t)].warnings}
                          </p>
                        )}
                        {rowScan[tableKey(t)] && (
                          <p className={`text-[11px] mt-1 ${rowScan[tableKey(t)].valid ? 'text-cyan-700 dark:text-cyan-300' : 'text-amber-700 dark:text-amber-300'}`}>
                            {rowScan[tableKey(t)].valid ? <ShieldCheck size={11} className="inline mr-1" /> : <ShieldAlert size={11} className="inline mr-1" />}
                            Target scan · {rowScan[tableKey(t)].exists ? 'exists' : 'missing'} · errors: {rowScan[tableKey(t)].errors}, warnings: {rowScan[tableKey(t)].warnings}
                          </p>
                        )}
                        {rowMigration[tableKey(t)] && (
                          <p className={`text-[11px] mt-1 ${rowMigration[tableKey(t)].status === 'completed' ? 'text-emerald-700 dark:text-emerald-300' : rowMigration[tableKey(t)].status === 'failed' ? 'text-rose-700 dark:text-rose-300' : 'text-blue-700 dark:text-blue-300'}`}>
                            Migration {rowMigration[tableKey(t)].status} · copied {rowMigration[tableKey(t)].rowsCopied.toLocaleString()} / {(rowMigration[tableKey(t)].rowsSource ?? 0).toLocaleString()} · run {rowMigration[tableKey(t)].runId}
                          </p>
                        )}
                        {t.description?.trim() && (
                          <p className="text-xs text-gray-500 dark:text-slate-400 italic truncate">{t.description}</p>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {templateReady?.ready && (
              <div className="flex justify-end">
                <Link
                  href="/migrate"
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold px-5 py-2.5 rounded-xl text-sm transition-colors"
                >
                  Proceed to Phase 4: Execute Migration →
                </Link>
              </div>
            )}
          </div>
        </main>
      </div>

      {docContent && (
        <DocumentationViewer
          title={`Migration ${docContent.format.toUpperCase()}`}
          content={docContent.content}
          format={docContent.format}
          onClose={() => setDocContent(null)}
        />
      )}
    </>
  );
}
