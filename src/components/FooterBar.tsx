import { useEffect, useState } from 'react';
import { Activity, Clock3, Cpu, MemoryStick, Moon, Sun } from 'lucide-react';

interface RuntimeMetrics {
  serverTime: string;
  timezone: string;
  utcOffset: string;
  hostname: string;
  cpuPercent: number;
  cpuCores: number;
  loadAverage1m: number;
  totalMemoryBytes: number;
  usedMemoryBytes: number;
  workspaceFreeBytes: number | null;
}

function percent(used: number, total: number): number {
  return total > 0 ? Math.round((used / total) * 100) : 0;
}

export default function FooterBar() {
  const [now, setNow] = useState(new Date());
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [runtime, setRuntime] = useState<RuntimeMetrics | null>(null);
  const [serverClockOffset, setServerClockOffset] = useState(0);

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem('ui_theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = saved === 'dark' || saved === 'light' ? saved : (prefersDark ? 'dark' : 'light');
    setTheme(initialTheme);
    document.documentElement.classList.toggle('dark', initialTheme === 'dark');

    const loadRuntime = async () => {
      try {
        const response = await fetch('/api/runtime-metrics', { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json() as RuntimeMetrics;
        setRuntime(data);
        setServerClockOffset(Date.parse(data.serverTime) - Date.now());
      } catch { /* keep the last successful sample */ }
    };
    void loadRuntime();
    const clockId = window.setInterval(() => setNow(new Date()), 1000);
    const metricsId = window.setInterval(() => void loadRuntime(), 10_000);
    return () => { window.clearInterval(clockId); window.clearInterval(metricsId); };
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('ui_theme', nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-slate-900 border-t border-gray-200 dark:border-slate-700 px-4 py-2 transition-colors duration-200">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3 justify-self-start text-[11px] text-gray-500 dark:text-slate-400">
          {runtime ? <>
            <span className="inline-flex items-center gap-1" title={`${runtime.cpuCores} cores · load average ${runtime.loadAverage1m}`}><Cpu size={13} />CPU {runtime.cpuPercent}%</span>
            <span className="inline-flex items-center gap-1" title={`${(runtime.usedMemoryBytes / 1024 ** 3).toFixed(1)} of ${(runtime.totalMemoryBytes / 1024 ** 3).toFixed(1)} GB used`}><MemoryStick size={13} />RAM {percent(runtime.usedMemoryBytes, runtime.totalMemoryBytes)}%</span>
            <span className="hidden items-center gap-1 xl:inline-flex" title={`Application host: ${runtime.hostname}`}><Activity size={13} />{runtime.hostname}</span>
          </> : <span className="text-gray-400">Server metrics unavailable</span>}
        </div>
        <div className="hidden text-sm text-gray-500 dark:text-slate-400 xl:block">
          © {new Date().getFullYear()} DB Maintenance Tools
        </div>
        <div className="justify-self-end flex items-center gap-3">
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200 transition-colors duration-200"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            <span className="hidden sm:inline">{theme === 'dark' ? 'Light' : 'Dark'}</span>
          </button>
          <div className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-slate-400 font-mono" suppressHydrationWarning>
            <Clock3 size={14} />
            {mounted ? new Date(now.getTime() + serverClockOffset).toLocaleString('sv-SE', runtime ? { timeZone: runtime.timezone === 'System timezone' ? undefined : runtime.timezone } : undefined) : ''}
            {runtime && <span className="hidden text-[10px] text-gray-400 lg:inline" title="Time reported by the application production server">Server time · {runtime.timezone} · {runtime.utcOffset}</span>}
          </div>
        </div>
      </div>
    </footer>
  );
}
