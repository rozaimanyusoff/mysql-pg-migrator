import { useEffect, useState } from 'react';
import { Clock3, FileText, Moon, RotateCcw, Sun, X } from 'lucide-react';
import { useRouter } from 'next/router';
import axios from 'axios';
import { tableStorageKey } from '../lib/mapping-utils';

interface AuditLogEntry {
  timestamp: string;
  source: 'client' | 'server';
  module: string;
  action: string;
  level?: 'info' | 'warn' | 'error';
  details?: Record<string, unknown>;
}

export default function FooterBar() {
  const router = useRouter();
  const [now, setNow] = useState(new Date());
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [showRestore, setShowRestore] = useState(false);
  const [restoreMode, setRestoreMode] = useState<'config' | 'template'>('config');
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logEntries, setLogEntries] = useState<AuditLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logFiles, setLogFiles] = useState<string[]>([]);
  const [selectedLogFile, setSelectedLogFile] = useState('');
  const [logMode, setLogMode] = useState<'range' | 'file'>('range');
  const [logLevelFilter, setLogLevelFilter] = useState<'all' | 'success' | 'error'>('all');
  const [logSearch, setLogSearch] = useState('');
  const [logStart, setLogStart] = useState('');
  const [logEnd, setLogEnd] = useState('');
  const isTemplateSnapshotFile = (file: string) => /^template_\d{14}\.json$/.test(file);
  const activeConfigModule = router.pathname === '/schema-config' ? 'schema-config' : 'migration';

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem('ui_theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = saved === 'dark' || saved === 'light' ? saved : (prefersDark ? 'dark' : 'light');
    setTheme(initialTheme);
    document.documentElement.classList.toggle('dark', initialTheme === 'dark');

    const id = window.setInterval(() => setNow(new Date()), 1000);

    const today = new Date();
    const start = new Date(today);
    start.setDate(today.getDate() - 30);
    const toDateInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setLogStart(toDateInput(start));
    setLogEnd(toDateInput(today));

    return () => window.clearInterval(id);
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('ui_theme', nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

  const loadFiles = async (mode: 'config' | 'template' = restoreMode) => {
    try {
      const params = mode === 'template' ? undefined : { module: activeConfigModule };
      const { data } = await axios.get('/api/schema-config-list', { params });
      const list = (data.files ?? []) as string[];
      setFiles(list);
      const available = mode === 'template' ? list.filter(isTemplateSnapshotFile) : list;
      setSelectedFile((prev) => {
        if (prev && available.includes(prev)) return prev;
        return available[0] ?? '';
      });
    } catch {
      setFiles([]);
      setSelectedFile('');
    }
  };

  const openRestore = (mode: 'config' | 'template' = 'config') => {
    setRestoreMode(mode);
    setSelectedFile('');
    setShowRestore(true);
    setMessage(null);
    void loadFiles(mode);
  };

  const logClientActivity = async (
    action: string,
    level: 'info' | 'warn' | 'error',
    details: Record<string, unknown>
  ) => {
    try {
      await axios.post('/api/audit-event', {
        module: activeConfigModule,
        action,
        source: 'client',
        level,
        details,
      });
    } catch {
      // non-blocking
    }
  };

  const applySnapshotToLocalStorage = (snapshot: Record<string, unknown>) => {
    const keys: Array<[string, string]> = [
      ['mysql_connection_creds', 'mysql_connection_creds'],
      ['mysql_connection_state', 'mysql_connection_state'],
      ['pg_connection', 'pg_connection'],
      ['inspection_result', 'inspection_result'],
      ['mysql_table_status', 'mysql_table_status'],
      ['migration_config', 'migration_config'],
      ['phase2_schema_reviewed', 'phase2_schema_reviewed'],
      ['phase2_schema_reviewed_state', 'phase2_schema_reviewed_state'],
      ['phase3_template_ready', 'phase3_template_ready'],
      ['phase1_hidden_databases', 'phase1_hidden_databases'],
    ];
    for (const [localKey, snapshotKey] of keys) {
      const value = snapshot[snapshotKey];
      if (value !== undefined && value !== null) {
        localStorage.setItem(localKey, JSON.stringify(value));
      }
    }

    // Clear existing Phase 1 per-table keys first to avoid stale leftovers.
    Object.keys(localStorage)
      .filter((k) => k.startsWith('table_mappings_'))
      .forEach((k) => localStorage.removeItem(k));

    // Preferred: explicit table_mappings payload in snapshot.
    const explicitMappings = snapshot.table_mappings;
    if (explicitMappings && typeof explicitMappings === 'object' && !Array.isArray(explicitMappings)) {
      for (const [k, v] of Object.entries(explicitMappings as Record<string, unknown>)) {
        if (!k.startsWith('table_mappings_')) continue;
        localStorage.setItem(k, JSON.stringify(v));
      }
      return;
    }

    // Backward-compatible fallback:
    // derive Phase 1 per-table keys from migration_config.tables for older snapshots.
    const cfg = snapshot.migration_config as {
      sourceDatabase?: string;
      tables?: Array<{
        sourceDatabase?: string;
        mysqlName: string;
        pgName?: string;
        description?: string;
        columns?: unknown[];
      }>;
    } | undefined;
    if (!cfg?.tables?.length) return;
    for (const t of cfg.tables) {
      if (!t?.mysqlName || !Array.isArray(t.columns)) continue;
      const db = t.sourceDatabase || cfg.sourceDatabase || '';
      if (!db) continue;
      const key = tableStorageKey(db, t.mysqlName);
      localStorage.setItem(
        key,
        JSON.stringify({
          pgName: t.pgName || t.mysqlName,
          columns: t.columns,
          tableDescription: t.description || '',
        })
      );
    }

    // Normalize Phase 1 done/excluded status:
    // reviewed tables in Phase 2 should always be considered done in Phase 1 after restore.
    const inspection = snapshot.inspection_result as Array<{ database?: string; tables?: Array<{ name?: string }> }> | undefined;
    const byName = new Map<string, string[]>();
    for (const r of inspection ?? []) {
      for (const t of r.tables ?? []) {
        if (!r.database || !t.name) continue;
        const k = `${r.database}::${t.name}`;
        const list = byName.get(t.name) ?? [];
        list.push(k);
        byName.set(t.name, list);
      }
    }
    const toComposite = (key: string): string => {
      if (key.includes('::')) return key;
      const matches = byName.get(key) ?? [];
      return matches.length === 1 ? matches[0] : key;
    };
    const status = (snapshot.mysql_table_status ?? {}) as { done?: string[]; excluded?: string[] };
    const reviewed = (snapshot.phase2_schema_reviewed ?? []) as string[];
    const done = new Set([...(status.done ?? []), ...reviewed].map(toComposite));
    const excluded = new Set((status.excluded ?? []).map(toComposite));
    localStorage.setItem('mysql_table_status', JSON.stringify({ done: [...done], excluded: [...excluded] }));
  };

  const handleRestore = async () => {
    if (!selectedFile) return;
    if (restoreMode === 'template' && !isTemplateSnapshotFile(selectedFile)) return;
    setLoading(true);
    setMessage(null);
    await logClientActivity(
      restoreMode === 'template' ? 'restore_template_start' : 'restore_config_start',
      'info',
      { file: selectedFile, mode: restoreMode }
    );
    try {
      const { data } = await axios.get('/api/schema-config-load', { params: { file: selectedFile } });
      const snapshot = data.snapshot as Record<string, unknown>;
      if (restoreMode === 'config' && activeConfigModule === 'schema-config') {
        setMessage(`Restored from ${selectedFile}`);
        window.location.href = `/schema-config?restoreFile=${encodeURIComponent(selectedFile)}`;
        return;
      }
      applySnapshotToLocalStorage(snapshot);
      await logClientActivity(
        restoreMode === 'template' ? 'restore_template_success' : 'restore_config_success',
        'info',
        { file: selectedFile, mode: restoreMode }
      );
      setMessage(`Restored from ${selectedFile}`);
      if (restoreMode === 'template') {
        window.location.href = '/migrate';
      } else {
        const phase3 = snapshot.phase3_template_ready as { ready?: boolean } | undefined;
        window.location.href = phase3?.ready ? '/docs' : '/migration';
      }
    } catch (err: unknown) {
      await logClientActivity(
        restoreMode === 'template' ? 'restore_template_error' : 'restore_config_error',
        'error',
        {
          file: selectedFile,
          mode: restoreMode,
          message: axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err),
        }
      );
      setMessage(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadLogFiles = async () => {
    try {
      const { data } = await axios.get('/api/audit-files');
      const list = (data?.files ?? []) as string[];
      setLogFiles(list);
      if (!selectedLogFile && list.length > 0) setSelectedLogFile(list[0]);
    } catch {
      setLogFiles([]);
    }
  };

  const loadLogsByRange = async () => {
    if (!logStart || !logEnd) return;
    setLogLoading(true);
    try {
      const { data } = await axios.get('/api/audit-read', { params: { start: logStart, end: logEnd } });
      setLogEntries((data?.entries ?? []) as AuditLogEntry[]);
    } catch {
      setLogEntries([]);
    } finally {
      setLogLoading(false);
    }
  };

  const loadLogsByFile = async () => {
    if (!selectedLogFile) return;
    setLogLoading(true);
    try {
      const { data } = await axios.get('/api/audit-read', { params: { file: selectedLogFile } });
      setLogEntries((data?.entries ?? []) as AuditLogEntry[]);
    } catch {
      setLogEntries([]);
    } finally {
      setLogLoading(false);
    }
  };

  const openLogs = async () => {
    setShowLogs(true);
    setLogMode('range');
    setLogLevelFilter('all');
    setLogSearch('');
    await loadLogFiles();
    await loadLogsByRange();
  };

  const normalizeLogKind = (entry: AuditLogEntry): 'success' | 'error' | 'neutral' => {
    const action = (entry.action || '').toLowerCase();
    if (entry.level === 'error' || action.includes('error') || action.includes('fail')) return 'error';
    if (entry.level === 'info' || action.includes('success') || action.includes('complete')) return 'success';
    return 'neutral';
  };

  const sortedLogs = [...logEntries].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const displayedLogs = sortedLogs.filter((entry) => {
    const kind = normalizeLogKind(entry);
    if (logLevelFilter === 'success' && kind !== 'success') return false;
    if (logLevelFilter === 'error' && kind !== 'error') return false;
    if (!logSearch.trim()) return true;
    const q = logSearch.trim().toLowerCase();
    const details = entry.details ? JSON.stringify(entry.details).toLowerCase() : '';
    return (
      entry.timestamp.toLowerCase().includes(q) ||
      entry.module.toLowerCase().includes(q) ||
      entry.action.toLowerCase().includes(q) ||
      details.includes(q)
    );
  });
  const successCount = sortedLogs.filter((e) => normalizeLogKind(e) === 'success').length;
  const errorCount = sortedLogs.filter((e) => normalizeLogKind(e) === 'error').length;
  const restoreRelatedCount = sortedLogs.filter((e) => {
    const action = (e.action || '').toLowerCase();
    const details = e.details ? JSON.stringify(e.details).toLowerCase() : '';
    return action.includes('restore') || action.includes('schema_config_load') || details.includes('template_');
  }).length;

  const filteredFiles = restoreMode === 'template'
    ? files.filter((f) => isTemplateSnapshotFile(f))
    : files;

  return (
    <>
    <footer className="fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-slate-900 border-t border-gray-200 dark:border-slate-700 px-4 py-2 transition-colors duration-200">
      <div className="max-w-7xl mx-auto grid grid-cols-3 items-center">
        <div className="justify-self-start">
          <button
            type="button"
            onClick={() => openRestore('config')}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-700 dark:text-amber-300 mr-2"
          >
            <RotateCcw size={12} />
            Restore Config
          </button>
          <button
            type="button"
            onClick={() => openRestore('template')}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 mr-2"
          >
            <RotateCcw size={12} />
            Restore Template
          </button>
          <button
            type="button"
            onClick={() => void openLogs()}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300"
          >
            <FileText size={12} />
            Logs
          </button>
        </div>
        <div className="justify-self-center text-xs text-gray-500 dark:text-slate-400">
          © {new Date().getFullYear()} MySQL-PG Migrator
        </div>
        <div className="justify-self-end flex items-center gap-3">
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200 transition-colors duration-200"
          >
            {theme === 'dark' ? <Sun size={12} /> : <Moon size={12} />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <div className="inline-flex items-center gap-1.5 text-xs text-gray-500 dark:text-slate-400 font-mono" suppressHydrationWarning>
            <Clock3 size={12} />
            {mounted ? now.toLocaleString() : ''}
          </div>
        </div>
      </div>
    </footer>
    {showRestore && (
      <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
        <div className="w-full max-w-lg bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-700 shadow-xl">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-slate-700 flex items-center justify-between">
            <h2 className="font-semibold text-gray-900 dark:text-slate-100">
              {restoreMode === 'template' ? 'Restore Template Snapshot' : 'Restore Saved Config'}
            </h2>
            <button onClick={() => setShowRestore(false)} className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300">
              <X size={16} />
            </button>
          </div>
          <div className="p-5 space-y-3">
            <p className="text-xs text-gray-500 dark:text-slate-400">
              {restoreMode === 'template'
                ? 'Load template snapshot (`template_yyyymmddHHmmss.json`) from `/public/uploads/schema`.'
                : `Load ${activeConfigModule} config snapshot from \`/public/uploads/schema\`.`}
            </p>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <div className="min-w-0 flex-1">
                <select
                  value={selectedFile}
                  onChange={(e) => setSelectedFile(e.target.value)}
                  className="w-full border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 text-sm bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100"
                >
                  <option value="">{restoreMode === 'template' ? 'Select template file' : 'Select config file'}</option>
                  {filteredFiles.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 sm:flex-none">
                <button onClick={() => void loadFiles()} className="text-xs px-2.5 py-2 rounded-md bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200 whitespace-nowrap">
                  Refresh
                </button>
                <button
                  onClick={handleRestore}
                  disabled={!selectedFile || loading || (restoreMode === 'template' && !isTemplateSnapshotFile(selectedFile))}
                  className="text-xs px-2.5 py-2 rounded-md bg-amber-50 hover:bg-amber-100 dark:bg-amber-900/30 dark:hover:bg-amber-900/50 text-amber-700 dark:text-amber-300 disabled:opacity-50 whitespace-nowrap"
                >
                  {loading ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            </div>
            {message && <p className="text-xs text-gray-600 dark:text-slate-300">{message}</p>}
            <p className="text-xs text-gray-400 dark:text-slate-500">
              {restoreMode === 'template'
                ? 'This restores complete Phase 1-3 template snapshot state and opens Phase 4.'
                : `This will overwrite current local session values for ${activeConfigModule} module.`}
            </p>
          </div>
        </div>
      </div>
    )}
    {showLogs && (
      <div className="fixed inset-0 z-[70] bg-black/45 flex items-center justify-center p-4">
        <div className="w-full max-w-6xl bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-700 shadow-xl">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-slate-700 flex items-center justify-between gap-3">
            <div>
              <h2 className="font-semibold text-gray-900 dark:text-slate-100">Logs</h2>
              <p className="text-xs text-gray-500 dark:text-slate-400">
                Success and error logs across all phases. Restore-template checks use these same logs.
              </p>
            </div>
            <button onClick={() => setShowLogs(false)} className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300">
              <X size={16} />
            </button>
          </div>
          <div className="p-5 space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs px-2 py-1 rounded-md bg-gray-100 dark:bg-slate-800 text-gray-700 dark:text-slate-200">
                total: {sortedLogs.length}
              </span>
              <span className="text-xs px-2 py-1 rounded-md bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300">
                success: {successCount}
              </span>
              <span className="text-xs px-2 py-1 rounded-md bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300">
                error: {errorCount}
              </span>
              <span className="text-xs px-2 py-1 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                restore-related: {restoreRelatedCount}
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
              <div className="lg:col-span-1 space-y-2">
                <div className="text-xs font-medium text-gray-600 dark:text-slate-300">Scope</div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLogMode('range')}
                    className={`text-xs px-2.5 py-1.5 rounded-md border ${logMode === 'range' ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300' : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300'}`}
                  >
                    Date Range
                  </button>
                  <button
                    type="button"
                    onClick={() => setLogMode('file')}
                    className={`text-xs px-2.5 py-1.5 rounded-md border ${logMode === 'file' ? 'bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300' : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300'}`}
                  >
                    File
                  </button>
                </div>
                {logMode === 'range' ? (
                  <div className="space-y-2">
                    <input type="date" value={logStart} onChange={(e) => setLogStart(e.target.value)} className="w-full border border-gray-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100" />
                    <input type="date" value={logEnd} onChange={(e) => setLogEnd(e.target.value)} className="w-full border border-gray-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100" />
                    <button type="button" onClick={() => void loadLogsByRange()} className="w-full text-xs px-2.5 py-1.5 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200">
                      Load Range
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <select value={selectedLogFile} onChange={(e) => setSelectedLogFile(e.target.value)} className="w-full border border-gray-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100">
                      <option value="">Select log file</option>
                      {logFiles.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void loadLogsByFile()} className="w-full text-xs px-2.5 py-1.5 rounded-md bg-gray-100 hover:bg-gray-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200">
                      Load File
                    </button>
                  </div>
                )}
              </div>

              <div className="lg:col-span-3 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setLogLevelFilter('all')} className={`text-xs px-2.5 py-1.5 rounded-md border ${logLevelFilter === 'all' ? 'bg-gray-100 dark:bg-slate-700 border-gray-300 dark:border-slate-600 text-gray-800 dark:text-slate-100' : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300'}`}>All</button>
                  <button type="button" onClick={() => setLogLevelFilter('success')} className={`text-xs px-2.5 py-1.5 rounded-md border ${logLevelFilter === 'success' ? 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300' : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300'}`}>Success</button>
                  <button type="button" onClick={() => setLogLevelFilter('error')} className={`text-xs px-2.5 py-1.5 rounded-md border ${logLevelFilter === 'error' ? 'bg-rose-50 dark:bg-rose-900/30 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300' : 'bg-white dark:bg-slate-800 border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300'}`}>Error</button>
                  <input
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder="Search action/module/file..."
                    className="ml-auto min-w-[220px] border border-gray-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-xs bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100"
                  />
                </div>

                <div className="border border-gray-200 dark:border-slate-700 rounded-lg overflow-hidden">
                  <div className="max-h-[56vh] overflow-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50 dark:bg-slate-800 border-b border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300">
                        <tr>
                          <th className="text-left px-2.5 py-2">Timestamp</th>
                          <th className="text-left px-2.5 py-2">Module</th>
                          <th className="text-left px-2.5 py-2">Action</th>
                          <th className="text-left px-2.5 py-2">Status</th>
                          <th className="text-left px-2.5 py-2">Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {displayedLogs.map((e, idx) => {
                          const kind = normalizeLogKind(e);
                          return (
                            <tr key={`${e.timestamp}-${e.action}-${idx}`} className="border-b border-gray-100 dark:border-slate-800 align-top">
                              <td className="px-2.5 py-2 font-mono text-[11px] text-gray-600 dark:text-slate-300 whitespace-nowrap">{e.timestamp}</td>
                              <td className="px-2.5 py-2 text-gray-700 dark:text-slate-200">{e.module}</td>
                              <td className="px-2.5 py-2 text-gray-700 dark:text-slate-200">{e.action}</td>
                              <td className="px-2.5 py-2">
                                <span className={`inline-flex items-center px-1.5 py-0.5 rounded ${kind === 'error' ? 'bg-rose-50 dark:bg-rose-900/30 text-rose-700 dark:text-rose-300' : kind === 'success' ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300' : 'bg-gray-100 dark:bg-slate-700 text-gray-700 dark:text-slate-300'}`}>
                                  {kind}
                                </span>
                              </td>
                              <td className="px-2.5 py-2 text-gray-600 dark:text-slate-300">
                                <pre className="whitespace-pre-wrap break-words">{e.details ? JSON.stringify(e.details, null, 2) : ''}</pre>
                              </td>
                            </tr>
                          );
                        })}
                        {!logLoading && displayedLogs.length === 0 && (
                          <tr>
                            <td colSpan={5} className="px-2.5 py-10 text-center text-gray-500 dark:text-slate-400">
                              No logs found for current filter.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )}
    </>
  );
}
