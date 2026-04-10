import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import axios from 'axios';
import { MigrationConfig, DryRunResult } from '../lib/types';
import DocumentationViewer from '../components/DocumentationViewer';
import { LoadingSpinner, ErrorAlert, EmptyState } from '../components/StateComponents';
import { FileText, Table, Code2, PlayCircle, CheckCircle, XCircle, AlertTriangle, ChevronRight } from 'lucide-react';

type DocFormat = 'markdown' | 'csv' | 'sql';

export default function Phase3() {
  const [config, setConfig] = useState<MigrationConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<{ content: string; format: DocFormat } | null>(null);
  const [dryRun, setDryRun] = useState<DryRunResult | null>(null);
  const [tab, setTab] = useState<'overview' | 'dryrun'>('overview');

  useEffect(() => {
    const raw = localStorage.getItem('migration_config');
    if (raw) setConfig(JSON.parse(raw) as MigrationConfig);
  }, []);

  const handleGenerateDocs = async (format: DocFormat) => {
    if (!config) return;
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.post('/api/generate-docs', { config, format });
      setDocContent({ content: data.content, format });
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDryRun = async () => {
    if (!config) return;
    setLoading(true);
    setError(null);
    setTab('dryrun');
    try {
      const { data } = await axios.post('/api/dry-run', { config });
      setDryRun(data);
    } catch (err: unknown) {
      setError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (!config) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <EmptyState
          title="No migration configuration found"
          description="Go to Phase 1, inspect your database, then set up mappings in Phase 2."
        />
      </div>
    );
  }

  const included = config.tables.filter((t) => t.include);

  return (
    <>
      <Head>
        <title>Docs & Dry Run — Phase 3</title>
      </Head>
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-900">Documentation & Dry Run</h1>
            <p className="text-xs text-gray-500">Phase 3 — Review before migration</p>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            {[
              { label: 'Inspect', href: '/' },
              { label: 'Mapping', href: '/mapping' },
              { label: 'Docs & Dry Run', href: '/docs', active: true },
              { label: 'Migrate', href: '/migrate' },
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

        <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
          {error && <ErrorAlert title="Error" message={error} />}

          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: 'Tables Selected', value: included.length, total: config.tables.length },
              { label: 'Columns', value: included.reduce((s, t) => s + t.columns.filter((c) => c.include).length, 0) },
              { label: 'PG Schemas', value: new Set(included.map((t) => t.pgSchema)).size },
              { label: 'Source DB', value: config.sourceDatabase },
            ].map((card) => (
              <div key={card.label} className="bg-white rounded-xl border border-gray-200 p-4">
                <p className="text-xs text-gray-500 font-medium">{card.label}</p>
                <p className="text-2xl font-bold text-gray-800 mt-1">{card.value}</p>
                {'total' in card && card.total !== undefined && (
                  <p className="text-xs text-gray-400">of {card.total}</p>
                )}
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-gray-200">
            {(['overview', 'dryrun'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium capitalize border-b-2 transition-colors ${
                  tab === t ? 'border-blue-500 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {t === 'dryrun' ? 'Dry Run' : 'Overview'}
              </button>
            ))}
          </div>

          {tab === 'overview' && (
            <div className="grid grid-cols-2 gap-4">
              {([
                { format: 'markdown' as DocFormat, Icon: FileText, title: 'Markdown Document', desc: 'Full migration plan for team review' },
                { format: 'csv' as DocFormat, Icon: Table, title: 'Spreadsheet (CSV)', desc: 'Editable in Excel/Google Sheets' },
                { format: 'sql' as DocFormat, Icon: Code2, title: 'SQL Script', desc: 'DDL ready for database execution' },
              ]).map(({ format, Icon, title, desc }) => (
                <div key={format} className="bg-white rounded-xl border border-gray-200 p-5 flex items-start gap-4">
                  <Icon className="text-blue-500 shrink-0" size={24} />
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-800">{title}</h3>
                    <p className="text-sm text-gray-500 mt-0.5">{desc}</p>
                    <button
                      onClick={() => handleGenerateDocs(format)}
                      disabled={loading}
                      className="mt-3 text-sm bg-blue-50 hover:bg-blue-100 text-blue-700 font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                    >
                      Generate & Preview
                    </button>
                  </div>
                </div>
              ))}

              <div className="bg-white rounded-xl border border-gray-200 p-5 flex items-start gap-4">
                <PlayCircle className="text-green-500 shrink-0" size={24} />
                <div className="flex-1">
                  <h3 className="font-semibold text-gray-800">Dry Run Validation</h3>
                  <p className="text-sm text-gray-500 mt-0.5">Validate config and preview SQL</p>
                  <button
                    onClick={handleDryRun}
                    disabled={loading}
                    className="mt-3 text-sm bg-green-50 hover:bg-green-100 text-green-700 font-medium px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50"
                  >
                    Run Dry Run
                  </button>
                </div>
              </div>
            </div>
          )}

          {tab === 'dryrun' && (
            <div className="space-y-4">
              <button
                onClick={handleDryRun}
                disabled={loading}
                className="bg-green-600 hover:bg-green-700 text-white font-semibold px-4 py-2 rounded-xl text-sm transition-colors disabled:opacity-50"
              >
                {loading ? 'Running…' : 'Re-run Dry Run'}
              </button>

              {loading && <LoadingSpinner message="Validating migration configuration…" />}

              {dryRun && !loading && (
                <div className="space-y-4">
                  {/* Status */}
                  <div className={`flex items-center gap-3 p-4 rounded-xl border ${dryRun.valid ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    {dryRun.valid
                      ? <CheckCircle className="text-green-600" size={20} />
                      : <XCircle className="text-red-600" size={20} />}
                    <span className={`font-semibold ${dryRun.valid ? 'text-green-800' : 'text-red-800'}`}>
                      {dryRun.valid ? '✓ Configuration is valid — ready to migrate' : '✗ Validation failed — fix errors before migrating'}
                    </span>
                  </div>

                  {/* Errors */}
                  {dryRun.errors.length > 0 && (
                    <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                      <h4 className="font-semibold text-red-800 mb-2 text-sm">Errors</h4>
                      <ul className="space-y-1">
                        {dryRun.errors.map((e, i) => (
                          <li key={i} className="text-sm text-red-700 flex items-center gap-2">
                            <XCircle size={14} /> {e}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Warnings */}
                  {dryRun.warnings.length > 0 && (
                    <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4">
                      <h4 className="font-semibold text-yellow-800 mb-2 text-sm">Warnings</h4>
                      <ul className="space-y-1">
                        {dryRun.warnings.map((w, i) => (
                          <li key={i} className="text-sm text-yellow-700 flex items-center gap-2">
                            <AlertTriangle size={14} /> {w}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Summary stats */}
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      ['Tables', dryRun.summary.includedTables],
                      ['Columns', dryRun.summary.totalColumns],
                      ['Indexes', dryRun.summary.totalIndexes],
                      ['Schemas', dryRun.summary.schemasToCreate.length],
                      ['SQL Statements', dryRun.summary.estimatedStatements],
                    ].map(([label, value]) => (
                      <div key={label} className="bg-white border border-gray-200 rounded-xl p-4 text-center">
                        <p className="text-2xl font-bold text-gray-800">{value}</p>
                        <p className="text-xs text-gray-500 mt-1">{label}</p>
                      </div>
                    ))}
                  </div>

                  {/* SQL Preview */}
                  {dryRun.sqlScript && (
                    <div className="bg-gray-900 rounded-xl overflow-hidden">
                      <div className="px-4 py-2 bg-gray-800 flex justify-between items-center">
                        <span className="text-xs text-gray-400 font-mono">SQL Preview</span>
                        <button
                          onClick={() => setDocContent({ content: dryRun.sqlScript, format: 'sql' })}
                          className="text-xs text-blue-400 hover:text-blue-300"
                        >
                          Expand
                        </button>
                      </div>
                      <pre className="text-xs font-mono text-green-300 p-4 overflow-x-auto max-h-72">
                        {dryRun.sqlScript}
                      </pre>
                    </div>
                  )}

                  {dryRun.valid && (
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
              )}
            </div>
          )}
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
