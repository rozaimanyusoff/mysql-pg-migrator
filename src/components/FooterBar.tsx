import { useEffect, useState } from 'react';
import { Clock3, Moon, Sun } from 'lucide-react';

export default function FooterBar() {
  const [now, setNow] = useState(new Date());
  const [mounted, setMounted] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    setMounted(true);
    const saved = localStorage.getItem('ui_theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = saved === 'dark' || saved === 'light' ? saved : (prefersDark ? 'dark' : 'light');
    setTheme(initialTheme);
    document.documentElement.classList.toggle('dark', initialTheme === 'dark');

    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const toggleTheme = () => {
    const nextTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(nextTheme);
    localStorage.setItem('ui_theme', nextTheme);
    document.documentElement.classList.toggle('dark', nextTheme === 'dark');
  };

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-slate-900 border-t border-gray-200 dark:border-slate-700 px-4 py-2 transition-colors duration-200">
      <div className="max-w-7xl mx-auto grid grid-cols-3 items-center">
        <div className="justify-self-start" />
        <div className="justify-self-center text-sm text-gray-500 dark:text-slate-400">
          © {new Date().getFullYear()} DB Maintenance Tools
        </div>
        <div className="justify-self-end flex items-center gap-3">
          <button
            type="button"
            onClick={toggleTheme}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-2.5 py-1.5 rounded-md border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-gray-50 dark:hover:bg-slate-700 text-gray-700 dark:text-slate-200 transition-colors duration-200"
          >
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <div className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-slate-400 font-mono" suppressHydrationWarning>
            <Clock3 size={14} />
            {mounted ? now.toLocaleString() : ''}
          </div>
        </div>
      </div>
    </footer>
  );
}
