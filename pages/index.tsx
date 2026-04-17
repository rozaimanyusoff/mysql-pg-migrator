import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Database, ArrowRight, UploadCloud, Wand2, SlidersHorizontal } from 'lucide-react';

const modules = [
  {
    key: 'migration',
    title: 'Migration',
    desc: 'Plan MySQL to PostgreSQL mapping, dry run, and execute migration.',
    href: '/migration',
    available: true,
    Icon: Database,
  },
  {
    key: 'schema-config',
    title: 'Schema Config',
    desc: 'Configure PostgreSQL schema, tables, PK/FK reassignment, and UUID generation.',
    href: '/schema-config',
    available: true,
    Icon: SlidersHorizontal,
  },
  {
    key: 'export-import',
    title: 'Export & Import',
    desc: 'Export local data and import to production environment safely.',
    href: '#',
    available: false,
    Icon: UploadCloud,
  },
  {
    key: 'normalization',
    title: 'Data Normalization',
    desc: 'Convert CSV/XLSX raw files into structured schema-ready datasets.',
    href: '#',
    available: false,
    Icon: Wand2,
  },
];

export default function ModuleMenu() {
  const [configuredModules, setConfiguredModules] = useState<Set<string>>(new Set());

  useEffect(() => {
    const loadConfigs = async () => {
      try {
        const res = await fetch('/api/module-config-list');
        if (!res.ok) return;
        const data = await res.json();
        setConfiguredModules(new Set((data.modules ?? []) as string[]));
      } catch {
        // ignore
      }
    };
    void loadConfigs();
  }, []);

  return (
    <>
      <Head>
        <title>Module Menu</title>
      </Head>
      <div className="min-h-screen bg-gray-50">
        <main className="max-w-5xl mx-auto px-6 py-16">
          <div className="mb-8">
            <h1 className="text-2xl font-bold text-gray-900">Select Module</h1>
            <p className="text-sm text-gray-500 mt-1">Choose the module you want to work on.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {modules.map(({ key, title, desc, href, available, Icon }) => {
              const content = (
                <div
                  className={`h-full rounded-2xl border p-6 flex flex-col ${available
                    ? 'bg-white border-gray-200 hover:border-blue-300 hover:shadow-md transition-all'
                    : 'bg-gray-100 border-gray-200 opacity-80'
                    }`}
                >
                  <div className="w-11 h-11 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center mb-4">
                    <Icon size={20} />
                  </div>
                  <h2 className="font-semibold text-gray-900">{title}</h2>
                  <p className="text-sm text-gray-500 mt-1 flex-1">{desc}</p>
                  {configuredModules.has(key) && (
                    <span className="mt-2 inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700 w-fit">
                      Config Found
                    </span>
                  )}
                  {available ? (
                    <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-700">
                      Open Module <ArrowRight size={14} />
                    </span>
                  ) : (
                    <span className="mt-4 inline-flex items-center text-xs font-medium px-2.5 py-1 rounded-full bg-gray-200 text-gray-600 w-fit">
                      Coming Soon
                    </span>
                  )}
                </div>
              );

              return available ? (
                <Link key={key} href={href}>
                  {content}
                </Link>
              ) : (
                <div key={key}>{content}</div>
              );
            })}
          </div>
        </main>
      </div>
    </>
  );
}
