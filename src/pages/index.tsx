import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Database, ArrowRight, UploadCloud, Wand2, Network,
  Columns, Workflow,
} from 'lucide-react';

const modules = [
  { key: 'schema-studio', title: 'Schema Studio',   desc: 'Inspect, design and refactor PostgreSQL schemas visually. Scan live DB, get PK/FK/constraint suggestions, interactive ERD with drag-to-create FK.', href: '/schema-studio', available: true, Icon: Columns },
  { key: 'export-import',title: 'Export & Import',     desc: 'Export local data and import to production environment safely.',                 href: '/export-import',available: true,  Icon: UploadCloud },
  { key: 'normalization',title: 'Data Normalization',  desc: 'Convert CSV/XLSX raw files into structured schema-ready datasets.',             href: '/normalizer',   available: true,  Icon: Wand2 },
  { key: 'schema-explorer', title: 'Schema Explorer', desc: 'Browse any database, inspect columns, visualise ERD, and export migration SQL or XLSX.', href: '/schema-explorer', available: true, Icon: Network },
  { key: 'migration',    title: 'Migration',           desc: 'Map and migrate data across any two databases (MySQL ↔ PostgreSQL), with serial→UUID conversion, rollback, and job management.', href: '/migration', available: true, Icon: Database },
  { key: 'flow-designer', title: 'Flow-to-Database Designer', desc: 'Design your database starting from a business process flow. Get entities, relationships, ERD, PostgreSQL DDL, and Drizzle ORM schema.', href: '/flow-designer', available: true, Icon: Workflow },
];

export default function ModuleMenu() {
  const [configuredModules, setConfiguredModules] = useState<Set<string>>(new Set());

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/module-config-list');
        if (!res.ok) return;
        const data = await res.json();
        setConfiguredModules(new Set((data.modules ?? []) as string[]));
      } catch { /* ignore */ }
    })();
  }, []);

  return (
    <>
      <Head><title>DB Maintenance Tools</title></Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">

        <main className="max-w-5xl mx-auto px-6 py-14">
          <div className="mb-10">
            <p className="text-sm text-gray-500 dark:text-slate-400">Choose a module to get started.</p>
          </div>

          {/* Module grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {modules.map(({ key, title, desc, href, available, Icon }) => {
              const content = (
                <div className={`h-full rounded-2xl border p-6 flex flex-col ${
                  available
                    ? 'bg-white dark:bg-slate-800/60 border-gray-200 dark:border-slate-700 hover:border-blue-300 dark:hover:border-blue-600 hover:shadow-md transition-all'
                    : 'bg-gray-100 dark:bg-slate-800/30 border-gray-200 dark:border-slate-700 opacity-70'
                }`}>
                  <div className="w-11 h-11 rounded-xl bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 flex items-center justify-center mb-4">
                    <Icon size={20} />
                  </div>
                  <h2 className="font-semibold text-gray-900 dark:text-slate-100">{title}</h2>
                  <p className="text-sm text-gray-500 dark:text-slate-400 mt-1 flex-1">{desc}</p>
                  {configuredModules.has(key) && (
                    <span className="mt-2 inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-950/40 text-green-700 dark:text-green-400 w-fit">
                      Config Found
                    </span>
                  )}
                  {available
                    ? <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700 dark:text-blue-400">Open Module <ArrowRight size={14} /></span>
                    : <span className="mt-4 inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-gray-200 dark:bg-slate-700 text-gray-600 dark:text-slate-400 w-fit">Coming Soon</span>
                  }
                </div>
              );
              return available
                ? <Link key={key} href={href}>{content}</Link>
                : <div key={key}>{content}</div>;
            })}
          </div>
        </main>
      </div>
    </>
  );
}
