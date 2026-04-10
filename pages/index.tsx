import React, { useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import axios from 'axios';
import { InspectionResult, MySQLTable } from '../lib/types';
import { initializeMigrationConfig } from '../lib/mapping-utils';
import TableList from '../components/TableList';
import TableDetail from '../components/TableDetail';
import { LoadingSpinner, ErrorAlert } from '../components/StateComponents';
import { Database, ChevronRight } from 'lucide-react';

interface ConnForm {
  host: string; port: string; user: string; password: string; database: string;
}

const DEFAULT_FORM: ConnForm = {
  host: process.env.NEXT_PUBLIC_MYSQL_HOST || 'localhost',
  port: '3306',
  user: '',
  password: '',
  database: '',
};

export default function Phase1() {
  const [form, setForm] = useState<ConnForm>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InspectionResult | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);

  const handleInspect = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setResult(null);
    setSelectedTable(null);
    try {
      const { data } = await axios.post('/api/inspect', {
        host: form.host,
        port: Number(form.port),
        user: form.user,
        password: form.password,
        database: form.database,
      });
      setResult(data.result);
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? err.message)
        : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleProceedToPhase2 = () => {
    if (!result) return;
    const config = initializeMigrationConfig(result);
    localStorage.setItem('migration_config', JSON.stringify(config));
    localStorage.setItem('inspection_result', JSON.stringify(result));
    window.location.href = '/mapping';
  };

  const selectedTableData: MySQLTable | undefined = result?.tables.find(
    (t) => t.name === selectedTable
  );

  return (
    <>
      <Head>
        <title>MySQL Inspector — Phase 1</title>
      </Head>
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Database className="text-blue-600" size={24} />
            <div>
              <h1 className="font-bold text-gray-900">MySQL → PostgreSQL Migrator</h1>
              <p className="text-xs text-gray-500">Phase 1: MySQL Inspection</p>
            </div>
          </div>
          {/* Phase nav */}
          <nav className="flex items-center gap-1 text-sm">
            {[
              { label: 'Inspect', href: '/', active: true },
              { label: 'Mapping', href: '/mapping' },
              { label: 'Docs & Dry Run', href: '/docs' },
              { label: 'Migrate', href: '/migrate' },
            ].map((item, i) => (
              <React.Fragment key={item.href}>
                {i > 0 && <ChevronRight size={14} className="text-gray-300" />}
                <Link
                  href={item.href}
                  className={`px-3 py-1 rounded-lg ${item.active ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:text-gray-800'}`}
                >
                  {item.label}
                </Link>
              </React.Fragment>
            ))}
          </nav>
        </header>

        <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
          {/* Connection form */}
          <div className="bg-white rounded-2xl border border-gray-200 p-6">
            <h2 className="font-semibold text-gray-800 mb-4">MySQL Connection</h2>
            <form onSubmit={handleInspect} className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Host</label>
                <input
                  className="input"
                  value={form.host}
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
                <input
                  className="input"
                  type="number"
                  value={form.port}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">User</label>
                <input
                  className="input"
                  value={form.user}
                  onChange={(e) => setForm({ ...form, user: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
                <input
                  className="input"
                  type="password"
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">Database</label>
                <input
                  className="input"
                  value={form.database}
                  onChange={(e) => setForm({ ...form, database: e.target.value })}
                  required
                />
              </div>
              <div className="col-span-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl transition-colors"
                >
                  {loading ? 'Inspecting…' : 'Inspect Database'}
                </button>
              </div>
            </form>
          </div>

          {loading && <LoadingSpinner message="Connecting to MySQL and reading schema…" />}
          {error && <ErrorAlert title="Connection Failed" message={error} />}

          {result && (
            <>
              {/* Summary bar */}
              <div className="bg-blue-50 border border-blue-200 rounded-xl px-6 py-4 flex items-center justify-between">
                <div className="flex gap-6 text-sm">
                  <span className="text-blue-800"><strong>{result.tables.length}</strong> tables found</span>
                  <span className="text-blue-600">Database: <strong>{result.database}</strong></span>
                  <span className="text-blue-600 text-xs">{new Date(result.inspectedAt).toLocaleString()}</span>
                </div>
                <button
                  onClick={handleProceedToPhase2}
                  className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-1"
                >
                  Proceed to Phase 2
                  <ChevronRight size={16} />
                </button>
              </div>

              {/* Table browser */}
              <div className="grid grid-cols-3 gap-6">
                <div className="col-span-1">
                  <TableList
                    tables={result.tables}
                    selectedTable={selectedTable}
                    onSelect={setSelectedTable}
                  />
                </div>
                <div className="col-span-2">
                  {selectedTableData ? (
                    <TableDetail table={selectedTableData} />
                  ) : (
                    <div className="flex items-center justify-center h-48 text-gray-400 text-sm">
                      Select a table to view details
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      <style jsx global>{`
        .input {
          width: 100%;
          border: 1px solid #e5e7eb;
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          outline: none;
          transition: box-shadow 0.15s;
        }
        .input:focus {
          box-shadow: 0 0 0 2px #3b82f6;
        }
      `}</style>
    </>
  );
}
