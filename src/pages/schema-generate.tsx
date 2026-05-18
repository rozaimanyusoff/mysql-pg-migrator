import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import ConnectionBadges from '../components/ConnectionBadges';
import ResetEverythingButton from '../components/ResetEverythingButton';
import { ChevronRight, Play, ShieldCheck, FileCode2, Download } from 'lucide-react';

interface SchemaRuntime {
  selectedDb: string;
  selectedTableKeys: string[];
  tableConfigs: Record<string, { relationRole?: string; selectedPkColumn?: string; uuidPkColumn?: string; generateUuidPk?: boolean; reassignPrimaryKey?: boolean }>;
  childFkConfigs: Record<string, { childTableKey?: string; childColumn?: string; parentTableKey?: string; parentUuidColumn?: string; generateChildUuidFk?: boolean; relationshipKey?: string }>;
  generatedAt?: string;
}

interface PgConnLocal {
  form: { host: string; port: number; user: string; password: string; database: string; ssl?: boolean };
  connected: boolean;
}

interface PlanResponse {
  success: boolean;
  plan: {
    summary: { database: string; selectedTables: number; selectedRelationships: number; operations: number };
    applySql: string[];
    rollbackSql: string[];
  };
  preflight: {
    valid: boolean;
    errors: string[];
    warnings: string[];
    tableRowCounts: Array<{ tableKey: string; rowCount: number }>;
    orphanChecks: Array<{ relationshipKey: string; orphanRows: number }>;
  };
}

const RUNTIME_KEY = 'schema_config_runtime';
const PG_CONN_KEY = 'pg_connection';

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function SchemaGeneratePage() {
  const [runtime, setRuntime] = useState<SchemaRuntime | null>(null);
  const [pgConn, setPgConn] = useState<PgConnLocal | null>(null);
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [planData, setPlanData] = useState<PlanResponse | null>(null);
  const [execLog, setExecLog] = useState<string[]>([]);
  const [execError, setExecError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const rawRuntime = localStorage.getItem(RUNTIME_KEY);
      if (rawRuntime) setRuntime(JSON.parse(rawRuntime) as SchemaRuntime);
      const rawPg = localStorage.getItem(PG_CONN_KEY);
      if (rawPg) setPgConn(JSON.parse(rawPg) as PgConnLocal);
    } catch {
      setRuntime(null);
      setPgConn(null);
    }
  }, []);

  const ready = Boolean(runtime && pgConn?.form?.host && pgConn?.form?.user && runtime.selectedDb);
  const canExecute = Boolean(ready && planData?.preflight.valid);

  const scopeText = useMemo(() => {
    if (!runtime) return '-';
    const t = runtime.selectedTableKeys?.length ?? 0;
    const r = Object.keys(runtime.childFkConfigs ?? {}).length;
    return `${t} table(s), ${r} relation(s)`;
  }, [runtime]);

  const handleGeneratePlan = async () => {
    if (!runtime || !pgConn?.form) return;
    setLoadingPlan(true);
    setExecError(null);
    try {
      const { data } = await axios.post('/api/schema-generate-plan', {
        runtime,
        pgConfig: {
          host: pgConn.form.host,
          port: Number(pgConn.form.port) || 5432,
          user: pgConn.form.user,
          password: pgConn.form.password,
          database: runtime.selectedDb,
          ssl: Boolean(pgConn.form.ssl),
        },
      });
      setPlanData(data as PlanResponse);
    } catch (err: unknown) {
      setExecError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setLoadingPlan(false);
    }
  };

  const handleExecute = async () => {
    if (!runtime || !pgConn?.form) return;
    if (!planData?.preflight.valid) {
      setExecError('Pre-flight validation failed. Resolve errors before executing SQL.');
      return;
    }
    setExecuting(true);
    setExecError(null);
    setExecLog([]);
    try {
      const { data } = await axios.post('/api/schema-generate-execute', {
        runtime,
        pgConfig: {
          host: pgConn.form.host,
          port: Number(pgConn.form.port) || 5432,
          user: pgConn.form.user,
          password: pgConn.form.password,
          database: runtime.selectedDb,
          ssl: Boolean(pgConn.form.ssl),
        },
        dryRun: false,
      });
      const d = data as { log?: string[]; success?: boolean; error?: string };
      setExecLog(d.log ?? []);
      if (!d.success && d.error) setExecError(d.error);
    } catch (err: unknown) {
      setExecError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setExecuting(false);
    }
  };

  return (
    <>
      <Head>
        <title>Schema Generate</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        <header className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-900 dark:text-slate-100">Schema Generate</h1>
            <p className="text-xs text-gray-500 dark:text-slate-400">Pre-flight validation, SQL generation, and execution.</p>
          </div>
          <ConnectionBadges />
          <nav className="flex items-center gap-1 text-sm">
            <Link href="/" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Home</Link>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <Link href="/schema-config" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Schema Selection</Link>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <Link href="/schema-config" className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200">Schema Config</Link>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <span className="px-3 py-1 rounded-lg bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold">Generate</span>
            <span className="w-px h-5 bg-gray-200 dark:bg-slate-700 mx-1" />
            <ResetEverythingButton />
          </nav>
        </header>

        <main className="max-w-6xl mx-auto px-6 py-8 space-y-4">
          <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4">
            <h2 className="font-semibold text-gray-900 dark:text-slate-100">Scope</h2>
            <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
              Database: <span className="font-medium text-gray-800 dark:text-slate-200">{runtime?.selectedDb || '-'}</span> · {scopeText}
            </p>
            {!ready && (
              <p className="text-sm text-rose-500 mt-2">Missing runtime or PostgreSQL connection. Return to Schema Config and click Generate again.</p>
            )}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                type="button"
                onClick={() => void handleGeneratePlan()}
                disabled={!ready || loadingPlan}
                className="inline-flex items-center gap-2 px-3 py-2 rounded border border-gray-300 text-sm font-medium disabled:opacity-60"
              >
                <ShieldCheck size={15} />
                {loadingPlan ? 'Running Pre-flight...' : 'Pre-flight + Plan'}
              </button>
              <button
                type="button"
                onClick={() => void handleExecute()}
                disabled={!canExecute || executing}
                className="inline-flex items-center gap-2 px-3 py-2 rounded bg-blue-600 text-white text-sm font-medium disabled:opacity-60"
              >
                <Play size={15} />
                {executing ? 'Executing...' : 'Execute'}
              </button>
              {planData && (
                <>
                  <button
                    type="button"
                    onClick={() => downloadText('schema_generate_apply.sql', planData.plan.applySql.join('\n\n'))}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded border border-gray-300 text-sm font-medium"
                  >
                    <Download size={14} />
                    Download Apply SQL
                  </button>
                  <button
                    type="button"
                    onClick={() => downloadText('schema_generate_rollback.sql', planData.plan.rollbackSql.join('\n\n'))}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded border border-gray-300 text-sm font-medium"
                  >
                    <Download size={14} />
                    Download Rollback SQL
                  </button>
                </>
              )}
            </div>
          </section>

          {planData && (
            <>
              <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 dark:text-slate-100">Pre-flight Result</h3>
                <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                  Tables: {planData.plan.summary.selectedTables} · Relationships: {planData.plan.summary.selectedRelationships} · Operations: {planData.plan.summary.operations}
                </p>
                <p className={`text-sm mt-2 ${planData.preflight.valid ? 'text-emerald-500' : 'text-rose-500'}`}>
                  {planData.preflight.valid ? 'Validation passed' : 'Validation failed'}
                </p>
                {planData.preflight.warnings.length > 0 && (
                  <ul className="text-xs text-amber-500 mt-2 space-y-1">
                    {planData.preflight.warnings.map((w) => <li key={w}>• {w}</li>)}
                  </ul>
                )}
                {planData.preflight.errors.length > 0 && (
                  <ul className="text-xs text-rose-500 mt-2 space-y-1">
                    {planData.preflight.errors.map((e) => <li key={e}>• {e}</li>)}
                  </ul>
                )}
              </section>

              <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 dark:text-slate-100 mb-2 inline-flex items-center gap-2"><FileCode2 size={16} /> SQL Preview (Apply)</h3>
                <pre className="text-xs bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded p-3 overflow-auto max-h-[320px]">
                  {planData.plan.applySql.join('\n\n')}
                </pre>
              </section>

              <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 dark:text-slate-100 mb-2">Rollback SQL</h3>
                <pre className="text-xs bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded p-3 overflow-auto max-h-[220px]">
                  {planData.plan.rollbackSql.join('\n\n')}
                </pre>
              </section>
            </>
          )}

          {(execLog.length > 0 || execError) && (
            <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4">
              <h3 className="font-semibold text-gray-900 dark:text-slate-100">Execution Report</h3>
              {execError && <p className="text-sm text-rose-500 mt-2">{execError}</p>}
              {execLog.length > 0 && (
                <pre className="text-xs bg-gray-50 dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded p-3 overflow-auto max-h-[220px] mt-2">
                  {execLog.join('\n')}
                </pre>
              )}
            </section>
          )}
        </main>
      </div>
    </>
  );
}
