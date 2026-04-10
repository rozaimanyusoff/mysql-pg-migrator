import React, { useEffect, useState } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { MigrationConfig, TableMapping } from '../lib/types';
import TableMappingEditor from '../components/TableMappingEditor';
import ColumnMappingEditor from '../components/ColumnMappingEditor';
import { EmptyState } from '../components/StateComponents';
import { ChevronRight, Download, Save } from 'lucide-react';

export default function Phase2() {
  const [config, setConfig] = useState<MigrationConfig | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const raw = localStorage.getItem('migration_config');
    if (raw) {
      const cfg = JSON.parse(raw) as MigrationConfig;
      setConfig(cfg);
      if (cfg.tables.length > 0) setSelectedTable(cfg.tables[0].mysqlName);
    }
  }, []);

  const updateTable = (updated: TableMapping) => {
    if (!config) return;
    const tables = config.tables.map((t) =>
      t.mysqlName === updated.mysqlName ? updated : t
    );
    const newConfig = { ...config, tables, updatedAt: new Date().toISOString() };
    setConfig(newConfig);
    localStorage.setItem('migration_config', JSON.stringify(newConfig));
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleExport = () => {
    if (!config) return;
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${config.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const selectedTableData = config?.tables.find((t) => t.mysqlName === selectedTable);
  const includedCount = config?.tables.filter((t) => t.include).length ?? 0;

  if (!config) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <EmptyState
          title="No inspection data found"
          description="Go to Phase 1 and inspect your MySQL database first."
        />
        <Link href="/" className="absolute top-4 left-4 text-blue-600 text-sm hover:underline">
          ← Back to Phase 1
        </Link>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>Schema Mapping — Phase 2</title>
      </Head>
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-900">Schema Mapping</h1>
            <p className="text-xs text-gray-500">Phase 2 — Edit table and column mappings</p>
          </div>
          <nav className="flex items-center gap-1 text-sm">
            {[
              { label: 'Inspect', href: '/' },
              { label: 'Mapping', href: '/mapping', active: true },
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

        {/* Summary bar */}
        <div className="bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between">
          <div className="flex gap-4 text-sm text-gray-600">
            <span>{config.tables.length} tables total</span>
            <span className="text-green-700 font-medium">{includedCount} selected</span>
            <span className="text-gray-400">{config.sourceDatabase}</span>
          </div>
          <div className="flex gap-2">
            {saved && (
              <span className="text-xs text-green-600 flex items-center gap-1">
                <Save size={12} /> Saved
              </span>
            )}
            <button
              onClick={handleExport}
              className="flex items-center gap-1 text-sm border border-gray-200 hover:border-gray-300 text-gray-700 px-3 py-1.5 rounded-lg transition-colors"
            >
              <Download size={14} /> Export JSON
            </button>
            <Link
              href="/docs"
              className="flex items-center gap-1 text-sm bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg transition-colors"
            >
              Proceed to Phase 3 <ChevronRight size={14} />
            </Link>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-6 py-6 grid grid-cols-4 gap-6">
          {/* Table list sidebar */}
          <aside className="col-span-1">
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden sticky top-6">
              <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Tables</p>
              </div>
              <ul className="divide-y divide-gray-100 max-h-[70vh] overflow-y-auto">
                {config.tables.map((t) => (
                  <li key={t.mysqlName}>
                    <button
                      onClick={() => setSelectedTable(t.mysqlName)}
                      className={`w-full text-left px-4 py-2.5 text-sm hover:bg-blue-50 transition-colors flex items-center justify-between ${
                        selectedTable === t.mysqlName ? 'bg-blue-50 border-l-2 border-blue-500' : ''
                      }`}
                    >
                      <span className={`truncate ${!t.include ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
                        {t.mysqlName}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </aside>

          {/* Editor area */}
          <div className="col-span-3 space-y-4">
            {selectedTableData ? (
              <>
                <TableMappingEditor table={selectedTableData} onChange={updateTable} />
                {selectedTableData.include && (
                  <div className="bg-white rounded-xl border border-gray-200 p-5">
                    <h3 className="font-semibold text-gray-700 mb-3 text-sm">Column Mappings</h3>
                    <ColumnMappingEditor
                      columns={selectedTableData.columns}
                      onChange={(cols) => updateTable({ ...selectedTableData, columns: cols })}
                    />
                  </div>
                )}
              </>
            ) : (
              <EmptyState title="Select a table" description="Click a table in the sidebar to edit its mappings." />
            )}
          </div>
        </div>
      </div>
    </>
  );
}
