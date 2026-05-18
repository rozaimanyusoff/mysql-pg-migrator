import Head from 'next/head';
import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';

interface LogEntry {
  timestamp: string;
  source: 'client' | 'server';
  module: string;
  action: string;
  level?: 'info' | 'warn' | 'error';
  details?: Record<string, unknown>;
}

export default function AuditPage() {
  const [files, setFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const notifyError = (message: string) => {
    window.alert(message);
  };
  const handleHomeNavigate = () => {
    const ok = window.confirm('Return to module home and clear all local session data?');
    if (!ok) return;
    localStorage.clear();
    window.location.href = '/';
  };

  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.timestamp.localeCompare(a.timestamp)),
    [entries]
  );

  useEffect(() => {
    const loadFiles = async () => {
      try {
        const { data } = await axios.get('/api/audit-files');
        const list = (data.files ?? []) as string[];
        setFiles(list);
        if (list.length > 0) setSelectedFile(list[0]);
        toast.success(`Loaded ${list.length} audit log file(s).`);
      } catch (err: unknown) {
        notifyError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
      }
    };
    void loadFiles();
  }, []);

  const loadByFile = async () => {
    if (!selectedFile) return;
    setLoading(true);
    try {
      const { data } = await axios.get('/api/audit-read', { params: { file: selectedFile } });
      const next = (data.entries ?? []) as LogEntry[];
      setEntries(next);
      toast.success(`Loaded ${next.length} log entries from ${selectedFile}.`);
    } catch (err: unknown) {
      notifyError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setLoading(false);
    }
  };

  const loadByRange = async () => {
    if (!start || !end) return;
    setLoading(true);
    try {
      const { data } = await axios.get('/api/audit-read', { params: { start, end } });
      const next = (data.entries ?? []) as LogEntry[];
      setEntries(next);
      toast.success(`Loaded ${next.length} log entries for selected range.`);
    } catch (err: unknown) {
      notifyError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Head>
        <title>Audit Logs</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        <header className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="font-bold text-gray-900 dark:text-slate-100">Global Audit Logs</h1>
            <p className="text-xs text-gray-500 dark:text-slate-400">Daily files in `/public/uploads/logs`</p>
          </div>
          <button
            type="button"
            onClick={handleHomeNavigate}
            className="text-sm bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-blue-700 dark:text-blue-300 px-3 py-1.5 rounded-lg font-medium"
          >
            Back to Module Home
          </button>
        </header>

        <main className="max-w-6xl mx-auto px-6 py-6 space-y-4">
          <div className="bg-white border border-gray-200 rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-gray-800">Retrieve by file</h2>
              <div className="flex items-center gap-2">
                <select
                  value={selectedFile}
                  onChange={(e) => setSelectedFile(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">Select log file</option>
                  {files.map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
                <button
                  onClick={loadByFile}
                  disabled={!selectedFile || loading}
                  className="text-sm px-3 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
                >
                  Load
                </button>
              </div>
            </div>

            <div className="space-y-2">
              <h2 className="text-sm font-semibold text-gray-800">Retrieve by date range</h2>
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
                <input
                  type="date"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
                />
                <button
                  onClick={loadByRange}
                  disabled={!start || !end || loading}
                  className="text-sm px-3 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
                >
                  Load
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-100 text-sm text-gray-600">
              {loading ? 'Loading logs…' : `${sorted.length} entries`}
            </div>
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-100 text-gray-500 text-xs">
                  <tr>
                    <th className="text-left px-3 py-2">Timestamp</th>
                    <th className="text-left px-3 py-2">Module</th>
                    <th className="text-left px-3 py-2">Action</th>
                    <th className="text-left px-3 py-2">Source</th>
                    <th className="text-left px-3 py-2">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((e, i) => (
                    <tr key={`${e.timestamp}-${e.action}-${i}`} className="border-b border-gray-50 align-top">
                      <td className="px-3 py-2 font-mono text-xs text-gray-600">{e.timestamp}</td>
                      <td className="px-3 py-2">{e.module}</td>
                      <td className="px-3 py-2">{e.action}</td>
                      <td className="px-3 py-2">{e.source}</td>
                      <td className="px-3 py-2 text-xs">
                        <pre className="whitespace-pre-wrap break-words text-gray-600">
                          {e.details ? JSON.stringify(e.details, null, 2) : ''}
                        </pre>
                      </td>
                    </tr>
                  ))}
                  {!loading && sorted.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-8 text-center text-gray-400">No logs loaded.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </main>
      </div>
    </>
  );
}
