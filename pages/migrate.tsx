import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import axios from 'axios';
import { MigrationConfig, PgConnectionConfig, MigrationExecutionResult } from '../lib/types';
import { LoadingSpinner, ErrorAlert, EmptyState } from '../components/StateComponents';
import {
  ChevronRight, CheckCircle, XCircle, AlertTriangle, Database, Play,
  Server, RefreshCw, List
} from 'lucide-react';

const DEFAULT_PG: PgConnectionConfig = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '',
  database: '',
  ssl: false,
};

type Phase4Step = 'connect' | 'confirm' | 'running' | 'done';

export default function Phase4() {
  const [config, setConfig] = useState<MigrationConfig | null>(null);
  const [mysqlConfig, setMysqlConfig] = useState<{
    host: string; port: string; user: string; password: string; database: string;
  } | null>(null);
  const [pgConfig, setPgConfig] = useState<PgConnectionConfig>(DEFAULT_PG);
  const [step, setStep] = useState<Phase4Step>('connect');
  const [pgTestOk, setPgTestOk] = useState<boolean | null>(null);
  const [pgTestError, setPgTestError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<MigrationExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const rawConfig = localStorage.getItem('migration_config');
    const rawInspect = localStorage.getItem('inspection_result');
    if (rawConfig) setConfig(JSON.parse(rawConfig) as MigrationConfig);
    if (rawInspect) {
      const insp = JSON.parse(rawInspect);
      setMysqlConfig({
        host: 'localhost',
        port: '3306',
        user: '',
        password: '',
        database: insp.database ?? '',
      });
    }
  }, []);

  const handleTestPg = async () => {
    setTesting(true);
    setPgTestOk(null);
    setPgTestError(null);
    try {
      await axios.post('/api/pg-test', pgConfig);
      setPgTestOk(true);
    } catch (err: unknown) {
      setPgTestOk(false);
      setPgTestError(
        axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err)
      );
    } finally {
      setTesting(false);
    }
  };

  const handleExecute = async () => {
    if (!config || !mysqlConfig) return;
    setRunning(true);
    setError(null);
    setStep('running');
    try {
      const { data } = await axios.post('/api/migrate', {
        migrationConfig: config,
        pgConfig,
        mysqlConfig: {
          ...mysqlConfig,
          port: Number(mysqlConfig.port) || 3306,
        },
      });
      setResult(data.result);
      setStep('done');
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? err.message)
        : String(err);
      setError(msg);
      setStep('confirm');
    } finally {
      setRunning(false);
    }
  };

  if (!config) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <EmptyState
          title="No migration configuration found"
          description="Complete Phases 1–3 first before executing the migration."
        />
      </div>
    );
  }

  const included = config.tables.filter((t) => t.include);

  return (
    <>
      <Head>
        <title>Execute Migration — Phase 4</title>
      </Head>
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-900">Migration Execution</h1>
            <p className="text-xs text-gray-500">Phase 4 — Connect, execute, and verify</p>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            {[
              { label: 'Inspect', href: '/' },
              { label: 'Mapping', href: '/mapping' },
              { label: 'Docs & Dry Run', href: '/docs' },
              { label: 'Migrate', href: '/migrate', active: true },
            ].map((item, i) => (
              <React.Fragment key={item.href}>
                {i > 0 && <ChevronRight size={14} className="text-gray-300" />}
                <Link href={item.href} className={`px-3 py-1 rounded-lg ${item.active ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:text-gray-800'}`}>
                  {item.label}
                </Link>
              </React.Fragment>
            ))}
          </nav>
        </header>

        <main className="max-w-4xl mx-auto px-6 py-8 space-y-6">
          {error && <ErrorAlert title="Migration Error" message={error} />}

          {/* Step: connect */}
          {(step === 'connect' || step === 'confirm') && (
            <>
              {/* PG Connection */}
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <h2 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
                  <Server size={18} className="text-purple-500" />
                  PostgreSQL Connection
                </h2>
                <div className="grid grid-cols-2 gap-4">
                  {[
                    { label: 'Host', key: 'host', type: 'text' },
                    { label: 'Port', key: 'port', type: 'number' },
                    { label: 'User', key: 'user', type: 'text' },
                    { label: 'Password', key: 'password', type: 'password' },
                    { label: 'Database', key: 'database', type: 'text' },
                  ].map(({ label, key, type }) => (
                    <div key={key}>
                      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                      <input
                        type={type}
                        value={String(pgConfig[key as keyof PgConnectionConfig])}
                        onChange={(e) =>
                          setPgConfig({ ...pgConfig, [key]: type === 'number' ? Number(e.target.value) : e.target.value })
                        }
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400"
                      />
                    </div>
                  ))}
                  <div className="flex items-center gap-2 mt-4">
                    <input
                      type="checkbox"
                      id="ssl"
                      checked={pgConfig.ssl}
                      onChange={(e) => setPgConfig({ ...pgConfig, ssl: e.target.checked })}
                      className="w-4 h-4"
                    />
                    <label htmlFor="ssl" className="text-sm text-gray-600 cursor-pointer">Use SSL</label>
                  </div>
                </div>

                <div className="mt-4 flex items-center gap-3">
                  <button
                    onClick={handleTestPg}
                    disabled={testing}
                    className="flex items-center gap-2 bg-purple-50 hover:bg-purple-100 text-purple-700 font-medium text-sm px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={14} className={testing ? 'animate-spin' : ''} />
                    {testing ? 'Testing…' : 'Test Connection'}
                  </button>
                  {pgTestOk === true && (
                    <span className="flex items-center gap-1 text-green-700 text-sm">
                      <CheckCircle size={14} /> Connected successfully
                    </span>
                  )}
                  {pgTestOk === false && (
                    <span className="flex items-center gap-1 text-red-700 text-sm">
                      <XCircle size={14} /> {pgTestError}
                    </span>
                  )}
                </div>
              </div>

              {/* MySQL credentials for data transfer */}
              {mysqlConfig && (
                <div className="bg-white rounded-2xl border border-gray-200 p-6">
                  <h2 className="font-semibold text-gray-800 mb-4 flex items-center gap-2">
                    <Database size={18} className="text-blue-500" />
                    MySQL Source (for data transfer)
                  </h2>
                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { label: 'Host', key: 'host', type: 'text' },
                      { label: 'Port', key: 'port', type: 'number' },
                      { label: 'User', key: 'user', type: 'text' },
                      { label: 'Password', key: 'password', type: 'password' },
                      { label: 'Database', key: 'database', type: 'text' },
                    ].map(({ label, key, type }) => (
                      <div key={key}>
                        <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                        <input
                          type={type}
                          value={mysqlConfig[key as keyof typeof mysqlConfig]}
                          onChange={(e) =>
                            setMysqlConfig({ ...mysqlConfig, [key]: e.target.value })
                          }
                          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Migration summary + execute */}
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                <h2 className="font-semibold text-gray-800 mb-4">Migration Summary</h2>
                <div className="grid grid-cols-3 gap-4 mb-6">
                  {[
                    { label: 'Tables', value: included.length },
                    { label: 'Columns', value: included.reduce((s, t) => s + t.columns.filter((c) => c.include).length, 0) },
                    { label: 'Target DB', value: pgConfig.database || '—' },
                  ].map((c) => (
                    <div key={c.label} className="border border-gray-100 rounded-xl p-4 text-center">
                      <p className="text-2xl font-bold text-gray-800">{c.value}</p>
                      <p className="text-xs text-gray-400 mt-1">{c.label}</p>
                    </div>
                  ))}
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4">
                  <div className="flex gap-2">
                    <AlertTriangle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-sm text-amber-800">
                      <strong>This will execute the migration.</strong> Ensure you have backed up your data
                      and tested on a staging environment before proceeding.
                    </div>
                  </div>
                </div>

                <button
                  onClick={() => { setStep('confirm'); handleExecute(); }}
                  disabled={!pgTestOk || running}
                  className="w-full flex items-center justify-center gap-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white font-bold py-3 rounded-xl text-sm transition-colors"
                >
                  <Play size={16} />
                  {!pgTestOk ? 'Test PostgreSQL connection first' : 'Execute Migration'}
                </button>
              </div>
            </>
          )}

          {/* Step: running */}
          {step === 'running' && (
            <div className="bg-white rounded-2xl border border-gray-200 p-10">
              <LoadingSpinner message="Migration in progress — creating schemas, tables, migrating data…" />
              <p className="text-center text-xs text-gray-400 mt-4">
                Do not close this page. This may take several minutes for large databases.
              </p>
            </div>
          )}

          {/* Step: done */}
          {step === 'done' && result && (
            <div className="space-y-4">
              {/* Overall status */}
              <div className={`flex items-center gap-3 p-5 rounded-2xl border ${result.success ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                {result.success
                  ? <CheckCircle className="text-green-600 shrink-0" size={28} />
                  : <XCircle className="text-red-600 shrink-0" size={28} />}
                <div>
                  <p className={`font-bold text-lg ${result.success ? 'text-green-800' : 'text-red-800'}`}>
                    {result.success ? 'Migration Complete!' : 'Migration Failed'}
                  </p>
                  <p className="text-sm text-gray-600">
                    {result.totalRowsMigrated.toLocaleString()} rows migrated ·{' '}
                    {result.tablesCreated.length} tables created ·{' '}
                    {result.indexesCreated} indexes created
                  </p>
                </div>
              </div>

              {/* Errors & Warnings */}
              {result.errors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                  <h4 className="font-semibold text-red-800 text-sm mb-2">Errors</h4>
                  <ul className="space-y-1 text-sm text-red-700">
                    {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                </div>
              )}
              {result.warnings.length > 0 && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
                  <h4 className="font-semibold text-yellow-800 text-sm mb-2">Warnings</h4>
                  <ul className="space-y-1 text-sm text-yellow-700">
                    {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                </div>
              )}

              {/* Table results */}
              <div className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100 bg-gray-50 flex items-center gap-2">
                  <List size={16} className="text-gray-500" />
                  <h3 className="font-semibold text-gray-700 text-sm">Table Migration Results</h3>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-gray-500 border-b border-gray-100 bg-gray-50">
                      <th className="px-6 py-3 text-left font-medium">MySQL Table</th>
                      <th className="px-6 py-3 text-left font-medium">PostgreSQL Target</th>
                      <th className="px-6 py-3 text-right font-medium">Rows Migrated</th>
                      <th className="px-6 py-3 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {result.tableResults.map((r) => (
                      <tr key={r.tableName} className="hover:bg-gray-50">
                        <td className="px-6 py-3 font-mono text-gray-700">{r.tableName}</td>
                        <td className="px-6 py-3 font-mono text-blue-600">
                          {r.pgSchema}.{r.pgTable}
                        </td>
                        <td className="px-6 py-3 text-right text-gray-600">
                          {r.rowsMigrated.toLocaleString()} / {r.rowsInSource.toLocaleString()}
                        </td>
                        <td className="px-6 py-3 text-right">
                          {r.success
                            ? <span className="text-green-600 flex items-center justify-end gap-1"><CheckCircle size={14} /> OK</span>
                            : <span className="text-red-600 flex items-center justify-end gap-1"><XCircle size={14} /> Failed</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Migration log */}
              <div className="bg-gray-900 rounded-2xl overflow-hidden">
                <div className="px-4 py-2 bg-gray-800">
                  <span className="text-xs text-gray-400 font-mono">Migration Log</span>
                </div>
                <pre className="text-xs font-mono text-green-300 p-4 overflow-x-auto max-h-64">
                  {result.log.join('\n')}
                </pre>
              </div>

              <div className="flex gap-3 justify-end">
                <button
                  onClick={() => { setStep('connect'); setResult(null); }}
                  className="text-sm border border-gray-200 hover:border-gray-300 text-gray-700 px-4 py-2 rounded-xl"
                >
                  Run Again
                </button>
                <Link href="/" className="text-sm bg-blue-600 hover:bg-blue-700 text-white font-semibold px-4 py-2 rounded-xl">
                  Back to Start
                </Link>
              </div>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
