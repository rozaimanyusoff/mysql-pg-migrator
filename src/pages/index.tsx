import Head from 'next/head';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Database, ArrowRight, UploadCloud, Wand2, Network,
  Settings2, Lock, LogIn, LogOut, User, Eye, EyeOff, Mail, Columns,
} from 'lucide-react';
import { useAuth } from '../lib/auth-context';

const modules = [
  { key: 'schema-designer', title: 'Schema Designer',   desc: 'Design schemas and tables visually, import from SQL/XLSX/CSV or a live DB, and execute DDL against PostgreSQL or MySQL.', href: '/schema-designer', available: true, Icon: Columns },
  { key: 'export-import',title: 'Export & Import',     desc: 'Export local data and import to production environment safely.',                 href: '/export-import',available: true,  Icon: UploadCloud },
  { key: 'normalization',title: 'Data Normalization',  desc: 'Convert CSV/XLSX raw files into structured schema-ready datasets.',             href: '/normalizer',   available: true,  Icon: Wand2 },
  { key: 'schema-explorer', title: 'Schema Explorer', desc: 'Browse any database, inspect columns, visualise ERD, and export migration SQL or XLSX.', href: '/schema-explorer', available: true, Icon: Network },
  { key: 'migration',    title: 'Migration',           desc: 'Map and migrate data across any two databases (MySQL ↔ PostgreSQL), with serial→UUID conversion, rollback, and job management.', href: '/migration', available: true, Icon: Database },
];

export default function ModuleMenu() {
  const { authenticated, username, loading, login, logout } = useAuth();
  const [configuredModules, setConfiguredModules] = useState<Set<string>>(new Set());

  // Login form state (only used in the overlay dialog)
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);

  // 2FA OTP state
  const [otpStep, setOtpStep] = useState(false);
  const [otpUsername, setOtpUsername] = useState('');
  const [otpDigits, setOtpDigits] = useState(['', '', '', '', '', '']);
  const [otpError, setOtpError] = useState('');
  const [otpVerifying, setOtpVerifying] = useState(false);
  const otpRefs = [
    useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null),
  ];

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

  // Focus username field when lock overlay appears
  useEffect(() => {
    if (!loading && !authenticated) {
      setTimeout(() => usernameRef.current?.focus(), 80);
    }
  }, [loading, authenticated]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginUsername || !loginPassword) return;
    setLoggingIn(true);
    setLoginError('');
    try {
      const { data } = await axios.post('/api/auth/login', { username: loginUsername, password: loginPassword });
      const d = data as { twoFactorRequired: boolean; accessToken?: string; refreshToken?: string; username: string };
      if (d.twoFactorRequired) {
        setOtpStep(true);
        setOtpUsername(d.username);
        setOtpDigits(['', '', '', '', '', '']);
        setOtpError('');
        setTimeout(() => otpRefs[0].current?.focus(), 80);
      } else {
        login(d.accessToken!, d.refreshToken!, d.username);
        setLoginUsername('');
        setLoginPassword('');
      }
    } catch (err: unknown) {
      setLoginError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Invalid credentials') : 'Login failed');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleOtpInput = (idx: number, val: string) => {
    const ch = val.replace(/\D/g, '').slice(-1);
    const next = otpDigits.map((d, i) => (i === idx ? ch : d));
    setOtpDigits(next);
    setOtpError('');
    if (ch && idx < 5) otpRefs[idx + 1].current?.focus();
  };

  const handleOtpKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !otpDigits[idx] && idx > 0) otpRefs[idx - 1].current?.focus();
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = otpDigits.join('');
    if (code.length !== 6) return;
    setOtpVerifying(true);
    setOtpError('');
    try {
      const { data } = await axios.post('/api/auth/verify-otp', { username: otpUsername, code });
      const d = data as { accessToken: string; refreshToken: string; username: string };
      login(d.accessToken, d.refreshToken, d.username);
      setOtpStep(false);
      setLoginUsername('');
      setLoginPassword('');
    } catch (err: unknown) {
      setOtpError(axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Invalid code') : 'Verification failed');
    } finally {
      setOtpVerifying(false);
    }
  };

  return (
    <>
      <Head><title>DB Maintenance Tools</title></Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">

        {/* Top bar */}
        <header className="border-b border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-3 flex items-center gap-4">
          <span className="text-sm font-semibold text-gray-800 dark:text-slate-200 tracking-tight shrink-0">
            DB Maintenance Tools
          </span>
          <div className="flex-1" />

          {/* User info + logout when authenticated */}
          {!loading && authenticated && (
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                <User size={13} />{username}
              </span>
              <button type="button" onClick={() => void logout()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 transition-colors">
                <LogOut size={13} /> Logout
              </button>
            </div>
          )}

          {/* Settings — only when authenticated */}
          {authenticated ? (
            <Link href="/settings"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800 hover:text-gray-900 dark:hover:text-slate-100 transition-colors">
              <Settings2 size={15} /> Settings
            </Link>
          ) : (
            <span title="Login to access Settings"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-gray-300 dark:text-slate-600 cursor-not-allowed select-none">
              <Settings2 size={15} /> Settings
            </span>
          )}
        </header>

        <main className="max-w-5xl mx-auto px-6 py-14">
          <div className="mb-10">
            <p className="text-sm text-gray-500 dark:text-slate-400">Choose a module to get started.</p>
          </div>

          {/* Module grid */}
          <div className="relative">
            <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 transition-all duration-300 ${!authenticated ? 'blur-sm pointer-events-none select-none' : ''}`}>
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

            {/* Lock + login dialog — only after loading is done and not authenticated */}
            {!loading && !authenticated && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="bg-white dark:bg-slate-800 border border-gray-200 dark:border-slate-700 rounded-2xl px-8 py-7 w-full max-w-sm shadow-xl flex flex-col items-center gap-5">

                  {!otpStep ? (
                    <>
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-slate-700 flex items-center justify-center">
                          <Lock size={22} className="text-gray-400 dark:text-slate-400" />
                        </div>
                        <p className="text-sm font-semibold text-gray-800 dark:text-slate-100">Sign in to continue</p>
                        <p className="text-xs text-gray-400 dark:text-slate-500">DB Maintenance Tools</p>
                      </div>

                      <form onSubmit={(e) => void handleLogin(e)} className="w-full flex flex-col gap-3">
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Username</label>
                          <input ref={usernameRef} type="text" value={loginUsername}
                            onChange={(e) => { setLoginUsername(e.target.value); setLoginError(''); }}
                            placeholder="admin" autoComplete="username"
                            className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-500 dark:text-slate-400 mb-1">Password</label>
                          <div className="relative">
                            <input type={showPw ? 'text' : 'password'} value={loginPassword}
                              onChange={(e) => { setLoginPassword(e.target.value); setLoginError(''); }}
                              placeholder="••••••••" autoComplete="current-password"
                              className="w-full pl-3 pr-9 py-2 text-sm rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                            <button type="button" tabIndex={-1} onClick={() => setShowPw((v) => !v)}
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-slate-500">
                              {showPw ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          </div>
                        </div>

                        {loginError && <p className="text-xs text-rose-500 dark:text-rose-400 text-center">{loginError}</p>}

                        <button type="submit" disabled={loggingIn || !loginUsername || !loginPassword}
                          className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors mt-1">
                          <LogIn size={14} />
                          {loggingIn ? 'Signing in…' : 'Sign In'}
                        </button>
                      </form>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-col items-center gap-2">
                        <div className="w-12 h-12 rounded-full bg-blue-50 dark:bg-blue-950/40 flex items-center justify-center">
                          <Mail size={22} className="text-blue-500" />
                        </div>
                        <p className="text-sm font-semibold text-gray-800 dark:text-slate-100">Check your email</p>
                        <p className="text-xs text-gray-400 dark:text-slate-500 text-center">
                          A 6-digit code was sent to the address on file for <span className="font-medium text-gray-600 dark:text-slate-300">{otpUsername}</span>.
                        </p>
                      </div>

                      <form onSubmit={(e) => void handleVerifyOtp(e)} className="w-full flex flex-col gap-4">
                        <div className="flex gap-2 justify-center">
                          {otpDigits.map((d, i) => (
                            <input key={i} ref={otpRefs[i]} type="text" inputMode="numeric" maxLength={1} value={d}
                              onChange={(e) => handleOtpInput(i, e.target.value)}
                              onKeyDown={(e) => handleOtpKeyDown(i, e)}
                              className="w-10 h-12 text-center text-lg font-bold rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-700 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 caret-transparent"
                            />
                          ))}
                        </div>

                        {otpError && <p className="text-xs text-rose-500 dark:text-rose-400 text-center">{otpError}</p>}

                        <button type="submit" disabled={otpVerifying || otpDigits.join('').length !== 6}
                          className="w-full inline-flex items-center justify-center gap-2 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors">
                          <LogIn size={14} />
                          {otpVerifying ? 'Verifying…' : 'Verify Code'}
                        </button>

                        <button type="button" onClick={() => { setOtpStep(false); setOtpError(''); }}
                          className="text-xs text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 text-center w-full">
                          ← Back to sign in
                        </button>
                      </form>
                    </>
                  )}

                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
}
