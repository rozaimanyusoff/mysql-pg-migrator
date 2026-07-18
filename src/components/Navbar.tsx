import Link from 'next/link';
import { useRouter } from 'next/router';
import { ChevronDown, ChevronRight, Home, Settings2 } from 'lucide-react';
import MigrationGuidePopover from './MigrationGuidePopover';

const MODULE_LABELS: Record<string, string> = {
  '/migration': 'Migration',
  '/schema-studio': 'Schema Studio',
  '/schema-generator': 'Schema Generator',
  '/export-import': 'Data Maintenance',
  '/schema-explorer': 'Schema Explorer',
  '/flow-designer': 'Flow Designer',
  '/normalizer': 'Normalizer',
  '/audit': 'Audit',
  '/settings': 'Settings',
  '/docs': 'Docs',
  '/schema-generate': 'Schema Generate',
  '/ai-migration': 'AI Migration',
  '/scheduler': 'Scheduler',
};

const MODULE_LINKS = [
  ['/migration', 'Migration'],
  ['/scheduler', 'Scheduler'],
  ['/schema-studio', 'Schema Studio'],
  ['/schema-explorer', 'Schema Explorer'],
  ['/flow-designer', 'Flow Designer'],
  ['/export-import', 'Data Maintenance'],
  ['/normalizer', 'Normalizer'],
  ['/ai-migration', 'AI Migration'],
  ['/schema-generate', 'Schema Generate'],
  ['/audit', 'Audit'],
  ['/docs', 'Docs'],
] as const;

export default function Navbar() {
  const router = useRouter();

  const currentLabel = MODULE_LABELS[router.pathname];

  return (
    <header className="fixed top-0 left-0 right-0 h-12 z-[60] bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border-b border-gray-200 dark:border-slate-800 flex items-center px-5 gap-2.5">
      {/* Home breadcrumb */}
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 font-semibold text-sm text-gray-800 dark:text-slate-200 shrink-0 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
      >
        <Home size={15} /> Home
      </Link>

      {/* Current module breadcrumb */}
      {currentLabel && (
        <>
          <ChevronRight size={15} className="text-slate-400 dark:text-slate-500 shrink-0" />
          <details className="group relative">
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md bg-blue-50 px-2 py-0.5 text-sm font-semibold text-blue-700 marker:content-none dark:bg-blue-950/40 dark:text-blue-300">
              {currentLabel}<ChevronDown size={13} className="transition-transform group-open:rotate-180" />
            </summary>
            <div className="absolute left-0 top-full z-[80] mt-2 w-56 overflow-hidden rounded-xl border border-gray-200 bg-white py-1.5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
              <p className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">Switch module</p>
              {MODULE_LINKS.map(([href, label]) => (
                <Link key={href} href={href}
                  className={`block px-3 py-1.5 text-sm transition-colors ${router.pathname === href ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/40 dark:text-blue-300' : 'text-gray-600 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-slate-800'}`}>
                  {label}
                </Link>
              ))}
            </div>
          </details>
          {router.pathname === '/migration' && <MigrationGuidePopover />}
        </>
      )}

      <div className="flex-1" />

      <Link
        href="/settings"
        title="Settings"
        className={`p-1.5 rounded-md transition-colors ${
          router.pathname === '/settings'
            ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40'
            : 'text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200 hover:bg-gray-100 dark:hover:bg-slate-800'
        }`}
      >
        <Settings2 size={18} />
      </Link>
    </header>
  );
}
