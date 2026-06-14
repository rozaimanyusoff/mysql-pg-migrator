import Head from 'next/head';
import Link from 'next/link';
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Settings2, Database, Server, CheckCircle2, XCircle, Loader2, Save,
  ChevronRight, Eye, EyeOff, Plus, Pencil, Trash2,
  ToggleLeft, ToggleRight, X, Mail, ScrollText, Send, RefreshCw,
  ChevronDown,
} from 'lucide-react';
import type { ConnectionRow } from './api/connections/index';
import type { AuditLogEntry } from '../lib/audit-logger';

// ── Types ─────────────────────────────────────────────────────────────────────

type DbType = 'mysql' | 'postgres';
type TestStatus = 'idle' | 'testing' | 'ok' | 'error';
type Tab = 'connections' | 'email' | 'audit';

interface EmailForm {
  host: string; port: number; username: string; password: string;
  from_email: string; from_name: string; secure: boolean; enable_2fa: boolean;
}

interface ConnForm {
  db_type: DbType;
  label: string;
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  ssl: boolean;
}

const DEFAULT_FORM: ConnForm = {
  db_type: 'postgres', label: '', host: 'localhost', port: 5432,
  username: '', password: '', database: '', ssl: false,
};

// ── Small reusables ───────────────────────────────────────────────────────────

function InputField({ label, type = 'text', value, onChange, placeholder, readOnly, col2 }: {
  label: string; type?: string; value: string | number; col2?: boolean;
  onChange?: (v: string) => void; placeholder?: string; readOnly?: boolean;
}) {
  return (
    <div className={col2 ? 'col-span-2' : ''}>
      <label className="block text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">{label}</label>
      <input type={type} value={value} readOnly={readOnly}
        onChange={(e) => onChange?.(e.target.value)} placeholder={placeholder}
        className={`w-full px-3 py-2 text-base rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500 ${readOnly ? 'opacity-60 cursor-not-allowed' : ''}`}
      />
    </div>
  );
}

function PasswordField({ label, value, onChange, placeholder, autoComplete, col2 }: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; autoComplete?: string; col2?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className={col2 ? 'col-span-2' : ''}>
      <label className="block text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">{label}</label>
      <div className="relative">
        <input type={show ? 'text' : 'password'} value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? '••••••••'} autoComplete={autoComplete}
          className="w-full pl-3 pr-9 py-2 text-base rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
        <button type="button" tabIndex={-1} onClick={() => setShow((v) => !v)}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-slate-500">
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}

function DbTypeBadge({ type }: { type: DbType }) {
  return type === 'mysql'
    ? <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-1.5 py-0.5 rounded bg-orange-100 dark:bg-orange-950/40 text-orange-700 dark:text-orange-400"><Database size={11} />MySQL</span>
    : <span className="inline-flex items-center gap-1 text-[12px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400"><Server size={11} />PostgreSQL</span>;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('connections');

  // ── Connection manager state ─────────────────────────────────────────────────
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [loadingConns, setLoadingConns] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ConnForm>(DEFAULT_FORM);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMsg, setTestMsg] = useState('');
  const [formSaving, setFormSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [activatingId, setActivatingId] = useState<number | null>(null);

  // ── Email config state ───────────────────────────────────────────────────────
  const [emailForm, setEmailForm] = useState<EmailForm>({
    host: '', port: 587, username: '', password: '',
    from_email: '', from_name: 'DB Maintenance Tools', secure: false, enable_2fa: false,
  });
  const [emailHasPassword, setEmailHasPassword] = useState(false);
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailSaved, setEmailSaved] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailTestStatus, setEmailTestStatus] = useState<TestStatus>('idle');
  const [emailTestMsg, setEmailTestMsg] = useState('');
  const [testSendTo, setTestSendTo] = useState('');

  // ── Audit logs state ─────────────────────────────────────────────────────────
  const [auditFiles, setAuditFiles] = useState<string[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [selectedAuditFile, setSelectedAuditFile] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [auditReadLoading, setAuditReadLoading] = useState(false);

  // ── Load connections ─────────────────────────────────────────────────────────
  const loadConnections = useCallback(async () => {
    setLoadingConns(true);
    try {
      const { data } = await axios.get('/api/connections');
      setConnections((data as { connections: ConnectionRow[] }).connections);
    } catch { /* ignore */ }
    finally { setLoadingConns(false); }
  }, []);

  useEffect(() => { void loadConnections(); }, [loadConnections]);

  // Load email config
  useEffect(() => {
    void (async () => {
      try {
        const { data } = await axios.get('/api/email-config');
        const cfg = (data as { config: (EmailForm & { has_password?: boolean }) | null }).config;
        if (cfg) {
          setEmailForm({ host: cfg.host, port: cfg.port, username: cfg.username, password: '',
            from_email: cfg.from_email, from_name: cfg.from_name, secure: cfg.secure, enable_2fa: cfg.enable_2fa });
          setEmailHasPassword(Boolean(cfg.has_password));
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // Load audit file list
  const loadAuditFiles = useCallback(async () => {
    setAuditLoading(true);
    try {
      const { data } = await axios.get('/api/audit-files');
      setAuditFiles((data as { files: string[] }).files);
    } catch { /* ignore */ }
    finally { setAuditLoading(false); }
  }, []);

  const loadAuditFile = async (file: string) => {
    setSelectedAuditFile(file);
    setAuditReadLoading(true);
    try {
      const { data } = await axios.get(`/api/audit-read?file=${encodeURIComponent(file)}`);
      setAuditEntries((data as { entries: AuditLogEntry[] }).entries);
    } catch { setAuditEntries([]); }
    finally { setAuditReadLoading(false); }
  };

  // ── Form helpers ─────────────────────────────────────────────────────────────
  const setField = <K extends keyof ConnForm>(k: K) => (v: ConnForm[K] | string) =>
    setForm((p) => ({
      ...p,
      [k]: k === 'port' ? (Number(v) || p.port) : v,
    }));

  const openAdd = () => {
    setEditingId(null);
    setForm(DEFAULT_FORM);
    setTestStatus('idle');
    setTestMsg('');
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (c: ConnectionRow) => {
    setEditingId(c.id);
    setForm({
      db_type: c.db_type,
      label: c.label,
      host: c.host,
      port: c.port,
      username: c.username,
      password: c.password_enc ?? '',
      database: c.database_name,
      ssl: c.ssl_enabled,
    });
    setTestStatus('idle');
    setTestMsg('');
    setFormError('');
    setShowForm(true);
  };

  const closeForm = () => { setShowForm(false); setEditingId(null); };

  // Sync active PG/MySQL to localStorage so existing modules pick it up
  const syncToLocalStorage = (c: ConnectionRow) => {
    if (c.db_type === 'postgres') {
      localStorage.setItem('pg_connection', JSON.stringify({
        form: { host: c.host, port: c.port, user: c.username, password: c.password_enc ?? '', database: c.database_name, ssl: c.ssl_enabled },
        connected: true, schemas: [],
      }));
    } else {
      localStorage.setItem('mysql_connection_creds', JSON.stringify({ host: c.host, port: String(c.port), user: c.username, password: c.password_enc ?? '' }));
      localStorage.setItem('mysql_connection_state', JSON.stringify({ databases: [c.database_name], database: c.database_name }));
    }
  };

  // ── Actions ──────────────────────────────────────────────────────────────────
  const handleTest = async () => {
    setTestStatus('testing'); setTestMsg('');
    try {
      if (form.db_type === 'postgres') {
        const { data } = await axios.post('/api/pg-test', {
          host: form.host, port: Number(form.port) || 5432,
          user: form.username, password: form.password,
          database: form.database, ssl: form.ssl,
        });
        const d = data as { ok?: boolean; message?: string };
        if (d.ok) { setTestStatus('ok'); setTestMsg('Connected'); }
        else       { setTestStatus('error'); setTestMsg(d.message ?? 'Failed'); }
      } else {
        await axios.post('/api/list-databases', {
          host: form.host, port: Number(form.port) || 3306,
          user: form.username, password: form.password,
        });
        setTestStatus('ok'); setTestMsg('Connected');
      }
    } catch (err: unknown) {
      setTestStatus('error');
      setTestMsg(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    }
  };

  const handleSaveForm = async () => {
    setFormError('');
    if (!form.label || !form.host || !form.username || !form.database) {
      setFormError('Label, host, username and database are required');
      return;
    }
    setFormSaving(true);
    try {
      if (editingId !== null) {
        await axios.put(`/api/connections/${editingId}`, {
          label: form.label, host: form.host, port: form.port,
          username: form.username, password: form.password,
          database: form.database, ssl: form.ssl,
        });
      } else {
        await axios.post('/api/connections', {
          db_type: form.db_type, label: form.label, host: form.host,
          port: form.port, username: form.username, password: form.password,
          database: form.database, ssl: form.ssl,
        });
      }
      closeForm();
      await loadConnections();
    } catch (err: unknown) {
      setFormError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setFormSaving(false);
    }
  };

  const handleActivate = async (c: ConnectionRow) => {
    setActivatingId(c.id);
    try {
      await axios.patch(`/api/connections/${c.id}`);
      syncToLocalStorage(c);
      await loadConnections();
    } catch { /* ignore */ }
    finally { setActivatingId(null); }
  };

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await axios.delete(`/api/connections/${id}`);
      await loadConnections();
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  const handleSaveEmail = async () => {
    setEmailSaving(true); setEmailSaved(false); setEmailError('');
    try {
      await axios.post('/api/email-config', {
        host: emailForm.host, port: emailForm.port, username: emailForm.username,
        password: emailForm.password || undefined,
        from_email: emailForm.from_email, from_name: emailForm.from_name,
        secure: emailForm.secure, enable_2fa: emailForm.enable_2fa,
      });
      if (emailForm.password) setEmailHasPassword(true);
      setEmailForm((p) => ({ ...p, password: '' }));
      setEmailSaved(true);
      setTimeout(() => setEmailSaved(false), 3000);
    } catch (err: unknown) {
      setEmailError(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally { setEmailSaving(false); }
  };

  const handleTestEmail = async () => {
    setEmailTestStatus('testing'); setEmailTestMsg('');
    try {
      const { data } = await axios.post('/api/email-config/test', {
        host: emailForm.host, port: emailForm.port, username: emailForm.username,
        password: emailForm.password || undefined,
        from_email: emailForm.from_email, from_name: emailForm.from_name,
        secure: emailForm.secure,
        send_to: testSendTo || undefined,
      });
      setEmailTestStatus('ok');
      setEmailTestMsg((data as { message: string }).message);
    } catch (err: unknown) {
      setEmailTestStatus('error');
      setEmailTestMsg(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    }
  };

  const setEmail = <K extends keyof EmailForm>(k: K) => (v: EmailForm[K] | string) =>
    setEmailForm((p) => ({ ...p, [k]: k === 'port' ? (Number(v) || p.port) : v }));

  return (
    <>
      <Head><title>Settings — DB Maintenance Tools</title></Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">

        <header className="sticky top-12 z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center">
          <Settings2 size={20} className="text-blue-600 shrink-0 mr-3" />
          <div>
            <h1 className="font-bold text-gray-900 dark:text-slate-100">Settings</h1>
            <p className="text-sm text-gray-500 dark:text-slate-400">Global configuration for DB Maintenance Tools.</p>
          </div>
        </header>

        <main className="max-w-3xl mx-auto px-6 py-8 space-y-6">

          {/* Tabs */}
          <div className="flex gap-1 border-b border-gray-200 dark:border-slate-700">
            {([
              { key: 'connections' as Tab, label: 'DB Connection', Icon: Database },
              { key: 'email'       as Tab, label: 'Email',         Icon: Mail },
              { key: 'audit'       as Tab, label: 'Audit Logs',    Icon: ScrollText, onSelect: loadAuditFiles },
            ] as { key: Tab; label: string; Icon: React.ElementType; onSelect?: () => void }[]).map(({ key, label, Icon, onSelect }) => (
              <button key={key} type="button" onClick={() => { setActiveTab(key); onSelect?.(); }}
                className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-base font-medium border-b-2 -mb-px transition-colors ${
                  activeTab === key
                    ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-slate-400 hover:text-gray-700 dark:hover:text-slate-200'
                }`}>
                <Icon size={16} />{label}
              </button>
            ))}
          </div>

          {/* ══ DB Connection tab ════════════════════════════════════════════════ */}
          {activeTab === 'connections' && (
            <div className="space-y-4">

              {/* Add / Edit form */}
              {showForm ? (
                <section className="bg-white dark:bg-slate-900/70 border border-blue-200 dark:border-blue-800 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-5 py-3 bg-blue-50 dark:bg-blue-950/30 border-b border-blue-100 dark:border-blue-800">
                    <p className="text-base font-semibold text-blue-800 dark:text-blue-300">
                      {editingId !== null ? 'Edit Connection' : 'New Connection'}
                    </p>
                    <button type="button" onClick={closeForm} className="text-gray-400 hover:text-gray-600 dark:text-slate-500 dark:hover:text-slate-300">
                      <X size={18} />
                    </button>
                  </div>

                  <div className="p-5 space-y-4">
                    {/* DB type + label */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-sm font-medium text-gray-500 dark:text-slate-400 mb-1">DB Type</label>
                        <select value={form.db_type}
                          onChange={(e) => {
                            const t = e.target.value as DbType;
                            setField('db_type')(t);
                            setField('port')(t === 'mysql' ? '3306' : '5432');
                          }}
                          disabled={editingId !== null}
                          className="w-full px-3 py-2 text-base rounded-lg border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-60"
                        >
                          <option value="postgres">PostgreSQL</option>
                          <option value="mysql">MySQL</option>
                        </select>
                      </div>
                      <InputField label="Label" value={form.label} onChange={setField('label')} placeholder="e.g. production, local" />
                    </div>

                    {/* Connection fields */}
                    <div className="grid grid-cols-2 gap-4">
                      <InputField label="Host" value={form.host} onChange={setField('host')} placeholder="localhost" />
                      <InputField label="Port" type="number" value={form.port} onChange={setField('port')} placeholder="5432" />
                      <InputField label="User" value={form.username} onChange={setField('username')} placeholder="postgres" />
                      <PasswordField label="Password" value={form.password} onChange={setField('password')} autoComplete="off" />
                      <InputField label="Database" value={form.database} onChange={setField('database')} placeholder="my_db" col2 />
                    </div>

                    {/* SSL toggle (PG only) */}
                    {form.db_type === 'postgres' && (
                      <div className="flex items-center gap-2">
                        <button type="button" role="switch" aria-checked={form.ssl}
                          onClick={() => setField('ssl')(!form.ssl)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${form.ssl ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'}`}>
                          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform ${form.ssl ? 'translate-x-4' : 'translate-x-1'}`} />
                        </button>
                        <span className="text-base text-gray-700 dark:text-slate-300">Enable SSL</span>
                      </div>
                    )}

                    {formError && <p className="text-sm text-rose-600 dark:text-rose-400 flex items-center gap-1"><XCircle size={14}/>{formError}</p>}

                    {/* Actions */}
                    <div className="flex items-center gap-3 pt-1">
                      <button type="button" onClick={() => void handleTest()} disabled={testStatus === 'testing'}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-base text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-50">
                        {testStatus === 'testing' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
                        Test
                      </button>

                      {testStatus === 'ok'    && <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={14}/>{testMsg}</span>}
                      {testStatus === 'error' && <span className="inline-flex items-center gap-1 text-sm text-rose-600 dark:text-rose-400 max-w-xs truncate"><XCircle size={14}/>{testMsg}</span>}

                      <div className="flex-1" />

                      <button type="button" onClick={closeForm} className="px-3 py-1.5 rounded-lg text-base text-gray-500 dark:text-slate-400 hover:bg-gray-100 dark:hover:bg-slate-800">
                        Cancel
                      </button>
                      <button type="button" onClick={() => void handleSaveForm()} disabled={formSaving}
                        className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-blue-600 text-white text-base font-medium hover:bg-blue-700 disabled:opacity-50">
                        {formSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                        {formSaving ? 'Saving…' : 'Save Connection'}
                      </button>
                    </div>
                  </div>
                </section>
              ) : (
                <button type="button" onClick={openAdd}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-dashed border-gray-300 dark:border-slate-600 text-base text-gray-600 dark:text-slate-400 hover:border-blue-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                  <Plus size={17} /> New Connection
                </button>
              )}

              {/* Connection list */}
              <div className="space-y-2">
                {loadingConns ? (
                  <div className="flex items-center gap-2 text-base text-gray-400 dark:text-slate-500 py-4">
                    <Loader2 size={16} className="animate-spin" /> Loading connections…
                  </div>
                ) : connections.length === 0 ? (
                  <div className="text-base text-gray-400 dark:text-slate-500 py-6 text-center border border-dashed border-gray-200 dark:border-slate-700 rounded-xl">
                    No connections saved yet. Click "New Connection" to add one.
                  </div>
                ) : (
                  connections.map((c) => (
                    <div key={c.id}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl border bg-white dark:bg-slate-800/60 transition-colors ${
                        c.is_active
                          ? 'border-blue-300 dark:border-blue-700'
                          : 'border-gray-200 dark:border-slate-700'
                      }`}
                    >
                      <DbTypeBadge type={c.db_type} />

                      <div className="flex-1 min-w-0">
                        <p className="text-base font-medium text-gray-900 dark:text-slate-100 truncate">{c.label}</p>
                        <p className="text-sm text-gray-400 dark:text-slate-500 truncate">
                          {c.username}@{c.host}:{c.port} / {c.database_name}
                          {c.ssl_enabled && ' · SSL'}
                        </p>
                      </div>

                      {c.is_active && (
                        <span className="text-[12px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400">
                          Active
                        </span>
                      )}

                      {/* Activate toggle */}
                      <button type="button"
                        onClick={() => !c.is_active && void handleActivate(c)}
                        disabled={c.is_active || activatingId === c.id}
                        title={c.is_active ? 'Already active' : 'Set as active'}
                        className="text-gray-400 dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 disabled:opacity-40 disabled:cursor-default transition-colors"
                      >
                        {activatingId === c.id
                          ? <Loader2 size={19} className="animate-spin" />
                          : c.is_active ? <ToggleRight size={20} className="text-blue-600 dark:text-blue-400" /> : <ToggleLeft size={20} />
                        }
                      </button>

                      {/* Edit */}
                      <button type="button" onClick={() => openEdit(c)}
                        className="text-gray-400 dark:text-slate-500 hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
                        <Pencil size={16} />
                      </button>

                      {/* Delete */}
                      <button type="button"
                        onClick={() => void handleDelete(c.id)}
                        disabled={deletingId === c.id}
                        className="text-gray-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-40 transition-colors">
                        {deletingId === c.id ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ══ Email Config tab ══════════════════════════════════════════════ */}
          {activeTab === 'email' && (
            <div className="space-y-4">
              <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
                  <Mail size={18} className="text-blue-500" />
                  <h2 className="font-semibold text-gray-900 dark:text-slate-100 text-base">SMTP Configuration</h2>
                </div>

                <div className="p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <InputField label="SMTP Host" value={emailForm.host} onChange={setEmail('host')} placeholder="smtp.example.com" />
                    <InputField label="Port" type="number" value={emailForm.port} onChange={setEmail('port')} placeholder="587" />
                    <InputField label="Username" value={emailForm.username} onChange={setEmail('username')} placeholder="user@example.com" />
                    <PasswordField label={emailHasPassword ? 'Password (saved — leave blank to keep)' : 'Password'} value={emailForm.password} onChange={setEmail('password')} autoComplete="off" />
                    <InputField label="From Address" value={emailForm.from_email} onChange={setEmail('from_email')} placeholder="noreply@example.com" />
                    <InputField label="From Name" value={emailForm.from_name} onChange={setEmail('from_name')} placeholder="DB Maintenance Tools" />
                  </div>

                  {/* Secure toggle */}
                  <div className="flex items-center gap-3 pt-1">
                    <button type="button" role="switch" aria-checked={emailForm.secure}
                      onClick={() => setEmailForm((p) => ({ ...p, secure: !p.secure }))}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${emailForm.secure ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'}`}>
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform ${emailForm.secure ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                    <span className="text-base text-gray-700 dark:text-slate-300">Use SSL/TLS (port 465)</span>
                  </div>

                  {/* 2FA toggle */}
                  <div className="flex items-center gap-3">
                    <button type="button" role="switch" aria-checked={emailForm.enable_2fa}
                      onClick={() => setEmailForm((p) => ({ ...p, enable_2fa: !p.enable_2fa }))}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${emailForm.enable_2fa ? 'bg-blue-600' : 'bg-gray-300 dark:bg-slate-600'}`}>
                      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform ${emailForm.enable_2fa ? 'translate-x-4' : 'translate-x-1'}`} />
                    </button>
                    <div>
                      <span className="text-base text-gray-700 dark:text-slate-300">Enable Two-Factor Authentication (2FA)</span>
                      <p className="text-sm text-gray-400 dark:text-slate-500">Users must verify a 6-digit code sent to their email on each login.</p>
                    </div>
                  </div>

                  {emailError && <p className="text-sm text-rose-600 dark:text-rose-400 flex items-center gap-1"><XCircle size={14}/>{emailError}</p>}

                  <div className="flex items-center gap-3 pt-1">
                    <button type="button" onClick={() => void handleSaveEmail()} disabled={emailSaving || !emailForm.host || !emailForm.from_email}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-base font-medium hover:bg-blue-700 disabled:opacity-50">
                      {emailSaving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                      {emailSaving ? 'Saving…' : 'Save'}
                    </button>
                    {emailSaved && <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={14}/>Saved</span>}
                  </div>
                </div>
              </section>

              {/* Test connection */}
              <section className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
                <div className="flex items-center gap-2.5 px-5 py-4 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
                  <Send size={17} className="text-slate-500 dark:text-slate-400" />
                  <h2 className="font-semibold text-gray-900 dark:text-slate-100 text-base">Test Connection</h2>
                </div>
                <div className="p-5 flex flex-col gap-3">
                  <InputField label="Send test email to (optional)" value={testSendTo} onChange={setTestSendTo} placeholder="you@example.com" />
                  <div className="flex items-center gap-3">
                    <button type="button" onClick={() => void handleTestEmail()} disabled={emailTestStatus === 'testing' || !emailForm.host}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-base text-gray-700 dark:text-slate-300 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-50">
                      {emailTestStatus === 'testing' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
                      Test SMTP
                    </button>
                    {emailTestStatus === 'ok'    && <span className="inline-flex items-center gap-1 text-sm text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={14}/>{emailTestMsg}</span>}
                    {emailTestStatus === 'error' && <span className="inline-flex items-center gap-1 text-sm text-rose-600 dark:text-rose-400 max-w-xs truncate"><XCircle size={14}/>{emailTestMsg}</span>}
                  </div>
                </div>
              </section>
            </div>
          )}

          {/* ══ Audit Logs tab ════════════════════════════════════════════════ */}
          {activeTab === 'audit' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-400 dark:text-slate-500">Daily log files — click a file to view entries.</p>
                <button type="button" onClick={() => void loadAuditFiles()} disabled={auditLoading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 dark:border-slate-600 text-sm text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 disabled:opacity-50">
                  {auditLoading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  Refresh
                </button>
              </div>

              {auditLoading ? (
                <div className="flex items-center gap-2 text-base text-gray-400 dark:text-slate-500 py-4">
                  <Loader2 size={16} className="animate-spin" /> Loading log files…
                </div>
              ) : auditFiles.length === 0 ? (
                <div className="text-base text-gray-400 dark:text-slate-500 py-8 text-center border border-dashed border-gray-200 dark:border-slate-700 rounded-xl">
                  No audit log files found.
                </div>
              ) : (
                <div className="space-y-2">
                  {auditFiles.map((file) => (
                    <div key={file} className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
                      <button type="button" onClick={() => void (selectedAuditFile === file ? setSelectedAuditFile(null) : loadAuditFile(file))}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-slate-800/60 transition-colors">
                        <ScrollText size={16} className="text-slate-500 dark:text-slate-400 shrink-0" />
                        <span className="flex-1 text-base font-medium text-gray-800 dark:text-slate-200">{file}</span>
                        {auditReadLoading && selectedAuditFile === file
                          ? <Loader2 size={15} className="animate-spin text-slate-500 dark:text-slate-400" />
                          : <ChevronDown size={15} className={`text-slate-500 dark:text-slate-400 transition-transform ${selectedAuditFile === file ? 'rotate-180' : ''}`} />
                        }
                      </button>

                      {selectedAuditFile === file && !auditReadLoading && (
                        <div className="border-t border-gray-100 dark:border-slate-800">
                          {auditEntries.length === 0 ? (
                            <p className="px-4 py-3 text-sm text-gray-400 dark:text-slate-500">No entries in this file.</p>
                          ) : (
                            <div className="max-h-80 overflow-y-auto">
                              <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-gray-50 dark:bg-slate-800">
                                  <tr>
                                    <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-slate-400 whitespace-nowrap">Time</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-slate-400">Level</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-slate-400">Module</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-slate-400">Action</th>
                                    <th className="px-4 py-2 text-left font-medium text-gray-500 dark:text-slate-400">Details</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-slate-800">
                                  {auditEntries.map((e, i) => (
                                    <tr key={i} className="hover:bg-gray-50 dark:hover:bg-slate-800/40">
                                      <td className="px-4 py-2 text-gray-400 dark:text-slate-500 whitespace-nowrap font-mono">
                                        {new Date(e.timestamp).toLocaleTimeString()}
                                      </td>
                                      <td className="px-4 py-2">
                                        <span className={`inline-flex px-1.5 py-0.5 rounded text-[12px] font-semibold ${
                                          e.level === 'error' ? 'bg-rose-100 dark:bg-rose-950/40 text-rose-700 dark:text-rose-400' :
                                          e.level === 'warn'  ? 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400' :
                                                                'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-400'
                                        }`}>{e.level ?? 'info'}</span>
                                      </td>
                                      <td className="px-4 py-2 text-gray-400 dark:text-slate-500 font-mono">{e.module}</td>
                                      <td className="px-4 py-2 text-gray-700 dark:text-slate-300 font-mono">{e.action}</td>
                                      <td className="px-4 py-2 text-gray-500 dark:text-slate-400 max-w-xs truncate">
                                        {e.details ? JSON.stringify(e.details) : '—'}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

        </main>
      </div>
    </>
  );
}
