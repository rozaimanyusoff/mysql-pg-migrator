import Link from 'next/link';
import { useRouter } from 'next/router';
import { ChevronRight, Settings2 } from 'lucide-react';

const MODULE_LABELS: Record<string, string> = {
  '/migration': 'Migration',
  '/schema-studio': 'Schema Studio',
  '/schema-generator': 'Schema Generator',
  '/export-import': 'Export & Import',
  '/schema-explorer': 'Schema Explorer',
  '/flow-designer': 'Flow Designer',
  '/normalizer': 'Normalizer',
  '/audit': 'Audit',
  '/settings': 'Settings',
  '/docs': 'Docs',
  '/schema-generate': 'Schema Generate',
};

export default function Navbar() {
  const router = useRouter();

  const currentLabel = MODULE_LABELS[router.pathname];

  return (
    <header className="fixed top-0 left-0 right-0 h-12 z-[60] bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm border-b border-gray-200 dark:border-slate-800 flex items-center px-5 gap-2.5">
      {/* App name */}
      <Link
        href="/"
        className="font-semibold text-sm text-gray-800 dark:text-slate-200 shrink-0 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
      >
        DB Maintenance
      </Link>

      {/* Current module breadcrumb */}
      {currentLabel && (
        <>
          <ChevronRight size={13} className="text-gray-300 dark:text-slate-600 shrink-0" />
          <span className="text-xs font-semibold text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-md bg-blue-50 dark:bg-blue-950/40">
            {currentLabel}
          </span>
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
        <Settings2 size={16} />
      </Link>
    </header>
  );
}
