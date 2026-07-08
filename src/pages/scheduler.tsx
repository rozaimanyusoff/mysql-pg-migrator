'use client';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Calendar, Check, CheckCircle2,
  Clock, Copy, Loader2, Pause, Pencil, Play,
  Plus, Terminal, Trash2, X,
  AlertTriangle, CircleDot, ListChecks, RotateCcw, Mail, Info,
  FileSpreadsheet, FileText, MoreVertical, Search, Square, RefreshCw,
} from 'lucide-react';
import { Tooltip } from '../components/Tooltip';
import { useAlert } from '../lib/alert-context';
import type { CronSchedule, MigJobSummary, MigRun } from '../lib/migv2/types';
import type { PreflightReport } from '../lib/migv2/preflight';

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `~${m}m`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m`;
}

// ── Cron helpers ──────────────────────────────────────────────────────────────

const CRON_PRESETS = [
  { label: 'Every minute',      value: '* * * * *' },
  { label: 'Every 5 minutes',   value: '*/5 * * * *' },
  { label: 'Every 15 minutes',  value: '*/15 * * * *' },
  { label: 'Every 30 minutes',  value: '*/30 * * * *' },
  { label: 'Every hour',        value: '0 * * * *' },
  { label: 'Every 6 hours',     value: '0 */6 * * *' },
  { label: 'Every 12 hours',    value: '0 */12 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Daily at 2:00 AM',  value: '0 2 * * *' },
  { label: 'Daily at 6:00 AM',  value: '0 6 * * *' },
  { label: 'Weekly (Sun midnight)', value: '0 0 * * 0' },
  { label: 'Monthly (1st midnight)', value: '0 0 1 * *' },
];

function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [min, hour, dom, month, dow] = p;
  const preset = CRON_PRESETS.find(x => x.value === expr);
  if (preset) return preset.label;
  if (min !== '*' && hour !== '*' && dom === '*' && month === '*' && dow === '*') {
    const h = hour.padStart(2, '0');
    const m = min.padStart(2, '0');
    return `Daily at ${h}:${m}`;
  }
  if (min === '0' && hour.startsWith('*/')) return `Every ${hour.slice(2)} hours`;
  if (min.startsWith('*/') && hour === '*' && dom === '*') return `Every ${min.slice(2)} minutes`;
  return expr;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Status helpers ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CronSchedule['lastRunStatus'] }) {
  if (!status) return null;
  if (status === 'completed') return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-semibold">
      <CheckCircle2 size={9} />completed
    </span>
  );
  if (status === 'failed') return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 font-semibold">
      <AlertTriangle size={9} />failed
    </span>
  );
  if (status === 'running') return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400 font-semibold">
      <Loader2 size={9} className="animate-spin" />running
    </span>
  );
  return null;
}

function RunStatusBadge({ status }: { status: MigRun['status'] }) {
  const map: Record<string, string> = {
    completed: 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400',
    failed: 'bg-rose-100 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400',
    running: 'bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400',
    pending: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
    aborted: 'bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400',
    rolled_back: 'bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400',
  };
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${map[status] ?? map.pending}`}>
      {status === 'running' && <Loader2 size={9} className="animate-spin" />}
      {status === 'completed' && <CheckCircle2 size={9} />}
      {status === 'failed' && <AlertTriangle size={9} />}
      {status}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SchedulerPage() {
  const router = useRouter();
  const { showError, showConfirm } = useAlert();
  const [schedules, setSchedules] = useState<CronSchedule[]>([]);
  const [jobs, setJobs] = useState<MigJobSummary[]>([]);
  const [runs, setRuns] = useState<MigRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<CronSchedule | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [runLogSelection, setRunLogSelection] = useState<{ runId: string; tableId: string | null } | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [tableSearch, setTableSearch] = useState('');
  const [tableStatusFilter, setTableStatusFilter] = useState('all');
  const [showStatusFilter, setShowStatusFilter] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [tableActionKey, setTableActionKey] = useState<string | null>(null);
  const [runMenuId, setRunMenuId] = useState<string | null>(null);
  const [hideCompletedRunIds, setHideCompletedRunIds] = useState<Set<string>>(new Set());
  const [preflight, setPreflight] = useState<{ jobName: string; loading: boolean; report: PreflightReport | null; error: string | null } | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const highlightHandledRef = useRef(false);

  // ── Form state ───────────────────────────────────────────────────────────────
  const [formJobId, setFormJobId] = useState('');
  const [formCron, setFormCron] = useState('0 2 * * *');
  const [formPreset, setFormPreset] = useState('0 2 * * *');
  const [formNotifyEmail, setFormNotifyEmail] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  // selectedId is now a JOB id, not a schedule id
  const selectedJob = jobs.find(j => j.id === selectedId) ?? null;
  const selectedSchedule = schedules.find(s => s.jobId === selectedId) ?? null;
  const selectedRuns = runs
    .filter(r => r.jobId === selectedId)
    .slice(0, 10);

  // ── Data fetching ─────────────────────────────────────────────────────────────
  const loadAll = async () => {
    try {
      const [schRes, jobRes, runRes] = await Promise.all([
        axios.get<{ schedules: CronSchedule[] }>('/api/scheduler'),
        axios.get<{ jobs: MigJobSummary[] }>('/api/migv2/jobs'),
        axios.get<{ runs: MigRun[] }>('/api/migv2/run/status'),
      ]);
      setSchedules(schRes.data.schedules);
      setJobs(jobRes.data.jobs);
      setRuns(runRes.data.runs);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const pollRuns = async () => {
    try {
      const [schRes, runRes] = await Promise.all([
        axios.get<{ schedules: CronSchedule[] }>('/api/scheduler'),
        axios.get<{ runs: MigRun[] }>('/api/migv2/run/status'),
      ]);
      setSchedules(schRes.data.schedules);
      setRuns(runRes.data.runs);
    } catch { /* ignore */ }
  };

  useEffect(() => { void loadAll(); }, []);

  // Deep-link: ?highlight=<jobId> — auto-select the job and open the Add Schedule
  // form when it has no schedule yet. Fires once after jobs have loaded.
  useEffect(() => {
    if (loading || highlightHandledRef.current || !router.isReady) return;
    const jobId = typeof router.query.highlight === 'string' ? router.query.highlight : null;
    if (!jobId) return;
    const job = jobs.find(j => j.id === jobId);
    if (!job) return;
    highlightHandledRef.current = true;
    setSelectedId(jobId);
    const hasSchedule = schedules.some(s => s.jobId === jobId);
    if (!hasSchedule) openAddForm(jobId);
    // Clean the URL so a refresh doesn't re-trigger
    void router.replace('/scheduler', undefined, { shallow: true });
  }, [loading, jobs, schedules, router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll every 3s when any schedule or run is in progress (covers resumed runs)
  useEffect(() => {
    const hasRunning = schedules.some(s => s.lastRunStatus === 'running') || runs.some(r => r.status === 'running');
    if (hasRunning) {
      if (!pollingRef.current) pollingRef.current = setInterval(() => void pollRuns(), 3000);
    } else {
      if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
    }
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [schedules, runs]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ───────────────────────────────────────────────────────────────────
  const handleToggleEnabled = async (s: CronSchedule) => {
    const updated = { ...s, enabled: !s.enabled };
    setSchedules(prev => prev.map(x => x.id === s.id ? updated : x));
    try {
      await axios.patch(`/api/scheduler/${s.id}`, { enabled: !s.enabled });
    } catch {
      setSchedules(prev => prev.map(x => x.id === s.id ? s : x));
    }
  };

  const handleRunNow = async (s: CronSchedule) => {
    setTriggering(s.id);
    try {
      await axios.post(`/api/scheduler/${s.id}/run`);
      await pollRuns();
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Failed to trigger') : 'Failed to trigger';
      showError('Run failed', msg);
    } finally { setTriggering(null); }
  };

  const handlePreflight = async (jobId: string, jobName: string) => {
    setPreflight({ jobName, loading: true, report: null, error: null });
    try {
      const { data } = await axios.post<{ report: PreflightReport }>('/api/migv2/preflight', { jobId });
      setPreflight({ jobName, loading: false, report: data.report, error: null });
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Pre-flight failed') : 'Pre-flight failed';
      setPreflight({ jobName, loading: false, report: null, error: msg });
    }
  };

  const handleResume = async (runId: string) => {
    setResuming(runId);
    try {
      await axios.post('/api/migv2/run/resume', { runId });
      await pollRuns();
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Resume failed') : 'Resume failed';
      showError('Resume failed', msg);
    } finally { setResuming(null); }
  };

  const handleRestart = async (runId: string, truncate: boolean) => {
    if (truncate) {
      showConfirm({
        title: 'Restart with truncate?',
        description: 'Target tables will be cleared before migrating. All previously migrated data in target will be deleted. This cannot be undone.',
        confirmLabel: 'Truncate & Restart',
        onConfirm: async () => {
          setRestarting(runId);
          try {
            await axios.post('/api/migv2/run/restart', { runId, truncate: true });
            await pollRuns();
          } catch (err) {
            const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Restart failed') : 'Restart failed';
            showError('Restart failed', msg);
          } finally { setRestarting(null); }
        },
      });
    } else {
      setRestarting(runId);
      try {
        await axios.post('/api/migv2/run/restart', { runId, truncate: false });
        await pollRuns();
      } catch (err) {
        const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Restart failed') : 'Restart failed';
        showError('Restart failed', msg);
      } finally { setRestarting(null); }
    }
  };

  const handleTableAction = async (runId: string, tableId: string, action: 'run' | 'pause' | 'resume' | 'stop' | 'restart') => {
    const key = `${runId}:${tableId}:${action}`;
    setTableActionKey(key);
    try {
      await axios.post('/api/migv2/run/control-table', { runId, tableId, action });
      await pollRuns();
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? `${action} failed`) : `${action} failed`;
      showError(`Table ${action} failed`, msg);
    } finally { setTableActionKey(null); }
  };

  const handleDelete = (s: CronSchedule) => {
    showConfirm({
      title: 'Delete schedule?',
      description: `"${s.jobName}" scheduled at "${s.cronExpr}" will be removed. The migration job itself is not affected.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        await axios.delete(`/api/scheduler/${s.id}`);
        setSchedules(prev => prev.filter(x => x.id !== s.id));
      },
    });
  };

  const handleCopyCrontab = (s: CronSchedule, appPath: string) => {
    const line = `${s.cronExpr} cd ${appPath} && node scripts/run-job.js --schedule-id ${s.id}`;
    void navigator.clipboard.writeText(line);
    setCopiedId(s.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // ── Form ──────────────────────────────────────────────────────────────────────
  const openAddForm = (preselectedJobId?: string) => {
    setEditTarget(null);
    setFormJobId(preselectedJobId ?? jobs[0]?.id ?? '');
    setFormCron('0 2 * * *');
    setFormPreset('0 2 * * *');
    setFormNotifyEmail('');
    setShowForm(true);
  };

  const openEditForm = (s: CronSchedule) => {
    setEditTarget(s);
    setFormJobId(s.jobId);
    setFormCron(s.cronExpr);
    setFormPreset(CRON_PRESETS.find(p => p.value === s.cronExpr)?.value ?? '__custom__');
    setFormNotifyEmail(s.notifyEmail ?? '');
    setShowForm(true);
  };

  const handleFormSave = async () => {
    if (!formJobId || !formCron.trim()) return;
    setFormSaving(true);
    try {
      const job = jobs.find(j => j.id === formJobId);
      if (!job) throw new Error('Job not found');
      const notifyEmail = formNotifyEmail.trim() || null;
      if (editTarget) {
        const { data } = await axios.patch<{ schedule: CronSchedule }>(`/api/scheduler/${editTarget.id}`, {
          jobId: formJobId, jobName: job.name, cronExpr: formCron.trim(), notifyEmail,
        });
        setSchedules(prev => prev.map(s => s.id === editTarget.id ? data.schedule : s));
      } else {
        const { data } = await axios.post<{ schedule: CronSchedule }>('/api/scheduler', {
          jobId: formJobId, jobName: job.name, cronExpr: formCron.trim(), notifyEmail,
        });
        setSchedules(prev => [...prev, data.schedule]);
        setSelectedId(data.schedule.jobId);
      }
      setShowForm(false);
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Save failed') : 'Save failed';
      showError('Save failed', msg);
    } finally { setFormSaving(false); }
  };

  // ── App path detection (best-effort) ─────────────────────────────────────────
  const appPath = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const appDir = '/path/to/app'; // user fills this in from the crontab command

  return (
    <>
      <Head><title>Scheduler — DB Maintenance</title></Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-950 pt-12">

        {/* Body */}
        <div className="flex h-[calc(100vh-3rem)] overflow-hidden">

          {/* Left — all jobs list */}
          <div className="w-72 shrink-0 border-r border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-100 dark:border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500 flex items-center justify-between">
              <span>MIGRATION JOBS</span>
              <div className="flex items-center gap-2">
                <span>{jobs.length}</span>
                <button onClick={() => void loadAll()} title="Refresh"
                  className="p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
              </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center h-32 gap-2 text-[13px] text-gray-400">
                  <Loader2 size={14} className="animate-spin" />Loading…
                </div>
              ) : jobs.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2 px-4 text-center">
                  <Calendar size={28} className="text-slate-300 dark:text-slate-600" />
                  <p className="text-[13px] text-gray-400 dark:text-slate-500">No migration jobs saved yet</p>
                  <p className="text-[11px] text-gray-300 dark:text-slate-600">Create and save jobs in the Migration module first.</p>
                </div>
              ) : jobs.map(job => {
                const sched = schedules.find(s => s.jobId === job.id);
                const isSelected = selectedId === job.id;
                return (
                  <div key={job.id}
                    onClick={() => setSelectedId(job.id)}
                    className={`px-3 py-2.5 border-b border-gray-50 dark:border-slate-800/50 cursor-pointer transition-colors ${isSelected ? 'bg-violet-50 dark:bg-violet-950/30' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}>
                    {/* Job name */}
                    <div className="flex items-center gap-2">
                      <span className={`text-[13px] font-medium truncate flex-1 ${isSelected ? 'text-violet-700 dark:text-violet-300' : 'text-gray-800 dark:text-slate-200'}`}>
                        {job.name}
                      </span>
                      <span className="text-[11px] text-gray-400 dark:text-slate-500 shrink-0">{job.tableCount} tables</span>
                    </div>
                    {/* Schedule info or "not scheduled" */}
                    {sched ? (
                      <>
                        <div className="flex items-center gap-1.5 mt-1 pl-0">
                          <CircleDot size={9} className={sched.enabled ? 'text-violet-400 shrink-0' : 'text-gray-300 dark:text-slate-600 shrink-0'} />
                          <Clock size={9} className="text-slate-400 shrink-0" />
                          <span className="text-[11px] text-slate-400 dark:text-slate-500 truncate">{describeCron(sched.cronExpr)}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-0.5 pl-4">
                          {sched.lastRunStatus && <StatusBadge status={sched.lastRunStatus} />}
                          {sched.lastRunAt
                            ? <span className="text-[11px] text-gray-400 dark:text-slate-500">{relativeTime(sched.lastRunAt)}</span>
                            : <span className="text-[11px] text-gray-300 dark:text-slate-600 italic">never run</span>}
                        </div>
                      </>
                    ) : (
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-[11px] text-gray-300 dark:text-slate-600 italic">not scheduled</span>
                        <button
                          onClick={e => { e.stopPropagation(); openAddForm(job.id); }}
                          className="text-[11px] text-violet-400 hover:text-violet-600 dark:hover:text-violet-300 ml-1 hover:underline transition-colors">
                          + Add schedule
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right — detail panel */}
          <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-slate-950">
            {!selectedJob ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
                <Calendar size={36} className="text-slate-300 dark:text-slate-700" />
                <p className="text-[14px] text-gray-400 dark:text-slate-500">Select a job to view its schedule and run history</p>
              </div>
            ) : (
              <div className="max-w-6xl mx-auto px-6 py-5 space-y-5">

                {/* Job + schedule header */}
                <div className="bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 p-4 space-y-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[15px] font-semibold text-gray-800 dark:text-slate-100">{selectedJob.name}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">{selectedJob.tableCount} tables</span>
                        {selectedSchedule && <StatusBadge status={selectedSchedule.lastRunStatus} />}
                      </div>
                      {selectedSchedule ? (
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <CircleDot size={10} className={selectedSchedule.enabled ? 'text-violet-400' : 'text-gray-300 dark:text-slate-600'} />
                          <Clock size={10} className="text-slate-400" />
                          <span className="text-[12px] text-gray-500 dark:text-slate-400">{describeCron(selectedSchedule.cronExpr)}</span>
                          <code className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">({selectedSchedule.cronExpr})</code>
                          {!selectedSchedule.enabled && (
                            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-500">disabled</span>
                          )}
                        </div>
                      ) : (
                        <p className="text-[12px] text-gray-400 dark:text-slate-500 italic mt-0.5">No schedule configured</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Tooltip content="Export all scheduler runs and table-level logs to an Excel workbook" side="bottom">
                        <a href={`/api/scheduler/export-logs?jobId=${encodeURIComponent(selectedJob.id)}`}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-400 text-[12px] font-medium hover:bg-emerald-50 dark:hover:bg-emerald-950/30 transition-colors">
                          <FileSpreadsheet size={13} />Logs XLSX
                        </a>
                      </Tooltip>
                      <Tooltip content="Export the live migrated target schema as ORM-ready Markdown" side="bottom">
                        <a href={`/api/scheduler/export-schema-md?jobId=${encodeURIComponent(selectedJob.id)}`}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-400 text-[12px] font-medium hover:bg-blue-50 dark:hover:bg-blue-950/30 transition-colors">
                          <FileText size={13} />Schema MD
                        </a>
                      </Tooltip>
                      <Tooltip content="Validate connectivity, row counts, type/FK issues and estimate duration before running" side="bottom">
                        <button onClick={() => void handlePreflight(selectedJob.id, selectedJob.name)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-gray-200 dark:border-slate-700 text-gray-600 dark:text-slate-300 text-[12px] font-medium hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                          <ListChecks size={13} />Pre-flight
                        </button>
                      </Tooltip>
                      {selectedSchedule ? (
                        <>
                          <button onClick={() => void handleRunNow(selectedSchedule)}
                            disabled={!!triggering || selectedSchedule.lastRunStatus === 'running'}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 text-[12px] font-medium hover:bg-violet-100 dark:hover:bg-violet-900/40 disabled:opacity-40 transition-colors">
                            {triggering === selectedSchedule.id ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                            Run Now
                          </button>
                          <button onClick={() => handleToggleEnabled(selectedSchedule)}
                            title={selectedSchedule.enabled ? 'Disable' : 'Enable'}
                            className="p-1.5 rounded border border-gray-200 dark:border-slate-700 text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
                            {selectedSchedule.enabled ? <Pause size={13} /> : <Play size={13} />}
                          </button>
                          <button onClick={() => openEditForm(selectedSchedule)} title="Edit schedule"
                            className="p-1.5 rounded border border-gray-200 dark:border-slate-700 text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
                            <Pencil size={13} />
                          </button>
                          <button onClick={() => handleDelete(selectedSchedule)} title="Delete schedule"
                            className="p-1.5 rounded border border-gray-200 dark:border-slate-700 text-gray-400 hover:text-rose-500 hover:border-rose-400 transition-colors">
                            <Trash2 size={13} />
                          </button>
                        </>
                      ) : (
                        <button onClick={() => openAddForm(selectedJob.id)}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 text-[12px] font-medium hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-colors">
                          <Plus size={12} />Add Schedule
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Crontab command — only when schedule exists */}
                  {selectedSchedule && (
                    <div className="rounded-md bg-slate-900 dark:bg-slate-950 border border-slate-700 dark:border-slate-800 p-3">
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                          <Terminal size={11} />
                          <span className="font-medium uppercase tracking-wider">Crontab command</span>
                        </div>
                        <button
                          onClick={() => handleCopyCrontab(selectedSchedule, '/path/to/app')}
                          className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 transition-colors">
                          {copiedId === selectedSchedule.id ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                          {copiedId === selectedSchedule.id ? 'Copied!' : 'Copy'}
                        </button>
                      </div>
                      <code className="text-[12px] text-emerald-400 dark:text-emerald-300 font-mono break-all">
                        {selectedSchedule.cronExpr} cd /path/to/app &amp;&amp; node scripts/run-job.js --schedule-id {selectedSchedule.id}
                      </code>
                      <p className="text-[11px] text-slate-500 mt-1.5">
                        Replace <code className="text-slate-400">/path/to/app</code> with your app directory. Set <code className="text-slate-400">APP_URL</code> if not on port 3000.
                      </p>
                      <code className="text-[11px] text-slate-400 font-mono block mt-0.5">APP_URL={appPath}</code>
                    </div>
                  )}
                </div>

                {/* Sync-mode summary */}
                {(() => {
                  const incTables = selectedJob.tables.filter(t => t.syncMode === 'incremental');
                  if (incTables.length === 0) return null;
                  const withWatermark = incTables.filter(t => t.lastSyncedValue);
                  return (
                    <div className="bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 dark:border-blue-900/40 px-4 py-3">
                      <div className="flex items-center gap-2">
                        <CircleDot size={12} className="text-blue-500 shrink-0" />
                        <span className="text-[12px] font-semibold text-blue-700 dark:text-blue-300">
                          {incTables.length} table{incTables.length !== 1 ? 's' : ''} in incremental sync mode
                        </span>
                      </div>
                      <p className="text-[11px] text-blue-600/80 dark:text-blue-400/80 mt-1 pl-5">
                        Each run upserts only rows newer than the last watermark
                        {withWatermark.length > 0 ? ` (${withWatermark.length} already have a watermark)` : ' (first run migrates everything, then tracks the watermark)'}.
                      </p>
                      <div className="mt-2 pl-5 space-y-0.5">
                        {incTables.slice(0, 6).map(t => (
                          <div key={t.id} className="flex items-center gap-2 text-[11px]">
                            <span className="font-mono text-blue-700/90 dark:text-blue-300/90 truncate max-w-[45%]">{t.source.schema}.{t.source.table}</span>
                            <span className="text-blue-400 dark:text-blue-600">on</span>
                            <span className="font-mono text-blue-600 dark:text-blue-400">{t.incrementalCol ?? '—'}</span>
                            {t.lastSyncedValue
                              ? <span className="text-blue-500/80 dark:text-blue-500/80">since {t.lastSyncedValue}</span>
                              : <span className="text-blue-400/70 dark:text-blue-600/70 italic">no watermark yet</span>}
                          </div>
                        ))}
                        {incTables.length > 6 && (
                          <p className="text-[11px] text-blue-400 dark:text-blue-600 italic">+{incTables.length - 6} more…</p>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Run history */}
                <div className="bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-gray-100 dark:border-slate-800 flex items-center gap-3">
                    <span className="text-[12px] font-semibold text-gray-600 dark:text-slate-400 uppercase tracking-wider shrink-0">Run History</span>
                    <div className="relative ml-auto w-64">
                      <Search size={12} className="absolute left-2.5 top-2 text-slate-400" />
                      <input value={tableSearch} onChange={e => setTableSearch(e.target.value)} placeholder="Search tables…"
                        className="w-full rounded-md border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-3 text-[11px] text-gray-700 outline-none focus:border-violet-400 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200" />
                    </div>
                    <div className="relative">
                      <button type="button" onClick={() => setShowStatusFilter(v => !v)} title="Filter table status"
                        className={`rounded-md border p-1.5 ${tableStatusFilter !== 'all' ? 'border-violet-400 text-violet-500' : 'border-gray-200 text-slate-400 dark:border-slate-700'}`}>
                        <MoreVertical size={13} />
                      </button>
                      {showStatusFilter && <div className="absolute right-0 top-8 z-20 w-36 rounded-md border border-gray-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                        {['all', 'completed', 'running', 'paused', 'aborted', 'pending'].map(status => (
                          <button key={status} type="button" onClick={() => { setTableStatusFilter(status); setShowStatusFilter(false); }}
                            className={`block w-full rounded px-2 py-1.5 text-left text-[11px] capitalize ${tableStatusFilter === status ? 'bg-violet-50 text-violet-600 dark:bg-violet-950/40' : 'text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
                            {status === 'aborted' ? 'stopped' : status}
                          </button>
                        ))}
                      </div>}
                    </div>
                    <span className="text-[11px] text-gray-400 dark:text-slate-500 shrink-0">{selectedRuns.length} recent</span>
                  </div>
                  {selectedRuns.length === 0 ? (
                    <div className="flex items-center justify-center py-10 text-[13px] text-gray-400 dark:text-slate-500 italic">
                      {selectedSchedule ? 'No runs yet — click "Run Now" or wait for the cron schedule.' : 'Add a schedule to start running this job.'}
                    </div>
                  ) : selectedRuns.map(run => {
                    const totalRows = run.tableStates.reduce((s, ts) => s + ts.rowsMigrated + ts.rowsSkipped, 0);
                    const completedPct = run.tableStates.length ? Math.round(run.tableStates.filter(t => t.status === 'completed').length / run.tableStates.length * 100) : 0;
                    const hideCompleted = hideCompletedRunIds.has(run.id);
                    return (
                      <div key={run.id} className="border-b border-gray-50 dark:border-slate-800/50 last:border-0">
                        <div
                          className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-slate-800/30 transition-colors">
                          <input type="checkbox" checked={selectedRunIds.has(run.id)} onChange={() => {}}
                            onClick={e => { e.stopPropagation(); setSelectedRunIds(prev => { const next = new Set(prev); next.has(run.id) ? next.delete(run.id) : next.add(run.id); return next; }); }}
                            aria-label={`Select run ${run.id.slice(0, 8)}`} className="h-3.5 w-3.5 accent-violet-600" />
                          <RunStatusBadge status={run.status} />
                          {run.interrupted && (
                            <Tooltip content="The server restarted mid-run. Resume continues from the last saved offset." side="top">
                              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 font-semibold shrink-0">
                                <AlertTriangle size={9} />interrupted
                              </span>
                            </Tooltip>
                          )}
                          {run.restartedFromRunId && (
                            <Tooltip content={`Restarted from run ${run.restartedFromRunId.slice(0, 8)}`} side="top">
                              <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 font-semibold shrink-0">
                                <RotateCcw size={9} />restarted
                              </span>
                            </Tooltip>
                          )}
                          <div className="flex-1 min-w-0">
                            <span className="text-[12px] text-gray-500 dark:text-slate-400 font-mono">{run.id.slice(0, 8)}</span>
                            <span className="text-[12px] text-gray-400 dark:text-slate-500 ml-2">{relativeTime(run.createdAt)}</span>
                          </div>
                          <span className="text-[12px] text-gray-500 dark:text-slate-400 shrink-0">
                            {completedPct}% · {run.tableStates.length} tables · {totalRows.toLocaleString()} rows
                          </span>
                          {(run.status === 'failed' || run.status === 'aborted') && (
                            <Tooltip content="Continue from last saved offset — retries failed tables" side="top">
                              <button
                                onClick={e => { e.stopPropagation(); void handleResume(run.id); }}
                                disabled={resuming === run.id || restarting === run.id}
                                className="flex items-center gap-1 px-2 py-1 rounded border border-violet-300 dark:border-violet-600 text-violet-600 dark:text-violet-300 text-[11px] font-medium hover:bg-violet-50 dark:hover:bg-violet-950/40 disabled:opacity-40 transition-colors shrink-0">
                                {resuming === run.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                                Resume
                              </button>
                            </Tooltip>
                          )}
                          {(run.status === 'failed' || run.status === 'aborted' || run.status === 'completed') && (
                            <>
                              <Tooltip content="Re-run all tables from row 0 — skips duplicates via ON CONFLICT" side="top">
                                <button
                                  onClick={e => { e.stopPropagation(); void handleRestart(run.id, false); }}
                                  disabled={restarting === run.id || resuming === run.id}
                                  className="flex items-center gap-1 px-2 py-1 rounded border border-amber-300 dark:border-amber-700 text-amber-600 dark:text-amber-400 text-[11px] font-medium hover:bg-amber-50 dark:hover:bg-amber-950/40 disabled:opacity-40 transition-colors shrink-0">
                                  {restarting === run.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                                  Restart
                                </button>
                              </Tooltip>
                              <Tooltip content="Truncate target tables then re-migrate from scratch — destructive" side="top">
                                <button
                                  onClick={e => { e.stopPropagation(); void handleRestart(run.id, true); }}
                                  disabled={restarting === run.id || resuming === run.id}
                                  className="flex items-center gap-1 px-2 py-1 rounded border border-rose-300 dark:border-rose-700 text-rose-600 dark:text-rose-400 text-[11px] font-medium hover:bg-rose-50 dark:hover:bg-rose-950/40 disabled:opacity-40 transition-colors shrink-0">
                                  {restarting === run.id ? <Loader2 size={11} className="animate-spin" /> : <RotateCcw size={11} />}
                                  + Truncate
                                </button>
                              </Tooltip>
                            </>
                          )}
                          <div className="relative shrink-0">
                            <button type="button" onClick={() => setRunMenuId(runMenuId === run.id ? null : run.id)}
                              className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200" title="Run summary and display options">
                              <MoreVertical size={14} />
                            </button>
                            {runMenuId === run.id && (
                              <div className="absolute right-0 top-7 z-30 w-60 rounded-lg border border-gray-200 bg-white p-3 shadow-xl dark:border-slate-700 dark:bg-slate-900">
                                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Table summary</p>
                                <div className="space-y-1.5">
                                  {([
                                    ['completed', 'Completed', 'text-emerald-500'], ['running', 'Running', 'text-violet-500'],
                                    ['paused', 'Paused', 'text-amber-500'], ['aborted', 'Stopped', 'text-rose-500'],
                                    ['pending', 'Pending', 'text-slate-400'],
                                  ] as const).map(([status, label, color]) => {
                                    const count = run.tableStates.filter(t => t.status === status).length;
                                    const pct = run.tableStates.length ? Math.round(count / run.tableStates.length * 100) : 0;
                                    return <div key={status} className="flex items-center gap-2 text-[11px]">
                                      <span className={`w-16 ${color}`}>{label}</span>
                                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-current" style={{ width: `${pct}%` }} /></div>
                                      <span className="w-14 text-right tabular-nums text-slate-500">{pct}% ({count})</span>
                                    </div>;
                                  })}
                                </div>
                                <label className="mt-3 flex cursor-pointer items-center justify-between border-t border-gray-100 pt-2.5 text-[11px] text-slate-600 dark:border-slate-800 dark:text-slate-300">
                                  <span>Auto-hide completed tables</span>
                                  <input type="checkbox" checked={hideCompleted} onChange={() => setHideCompletedRunIds(prev => { const next = new Set(prev); next.has(run.id) ? next.delete(run.id) : next.add(run.id); return next; })}
                                    className="h-3.5 w-3.5 accent-violet-600" />
                                </label>
                              </div>
                            )}
                          </div>
                        </div>
                        {(
                          <div className="bg-gray-50 dark:bg-slate-950/50 px-4 pb-3 pt-2">
                            <div className="mb-2 flex items-center justify-end gap-2 text-[10px] text-slate-400">
                              {hideCompleted && <span className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-600 dark:bg-emerald-950/30">Completed tables hidden</span>}
                              <span>Maximum 5 migrations can run concurrently</span>
                            </div>
                            <div className="overflow-x-auto">
                              <div className="min-w-[920px]">
                                <div className="grid grid-cols-[minmax(260px,1.4fr)_minmax(220px,1fr)_110px_90px_160px] gap-3 px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">
                                  <span>Source → target</span>
                                  <span>Progress</span>
                                  <span className="text-right">Rows</span>
                                  <span className="text-right">Errors</span>
                                  <span className="text-right">Actions</span>
                                </div>
                                <div className="max-h-[32rem] space-y-1 overflow-y-auto overscroll-contain pr-1">
                            {run.tableStates.filter(ts => {
                              const query = tableSearch.trim().toLowerCase();
                              const matchesText = !query || ts.sourceKey.toLowerCase().includes(query) || ts.targetKey.toLowerCase().includes(query);
                              return matchesText && (!hideCompleted || ts.status !== 'completed') && (tableStatusFilter === 'all' || ts.status === tableStatusFilter);
                            }).map(ts => {
                              const processed = Math.max(ts.offset, ts.rowsMigrated + ts.rowsSkipped + ts.rowsErrored);
                              const pct = ts.rowsSource > 0 ? Math.min(100, Math.round(processed / ts.rowsSource * 100)) : (ts.status === 'completed' ? 100 : 0);
                              const barColor = ts.status === 'completed' ? 'bg-emerald-500' : ts.status === 'failed' ? 'bg-rose-500' : 'bg-violet-500';
                              const isLogSelected = runLogSelection?.runId === run.id && runLogSelection.tableId === ts.id;
                              return (
                                <div key={ts.id} style={{ contentVisibility: 'auto', containIntrinsicSize: '32px' }} className={`grid grid-cols-[minmax(260px,1.4fr)_minmax(220px,1fr)_110px_90px_160px] items-center gap-3 rounded-md px-2 py-1.5 ${isLogSelected ? 'bg-rose-50 dark:bg-rose-950/20 ring-1 ring-rose-200 dark:ring-rose-900/50' : 'bg-white/70 dark:bg-slate-900/50'}`}>
                                  <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
                                    <span className={`truncate ${ts.status === 'failed' ? 'text-rose-500' : 'text-gray-600 dark:text-slate-300'}`} title={ts.sourceKey}>{ts.sourceKey}</span>
                                    <span className="shrink-0 text-slate-300 dark:text-slate-600">→</span>
                                    <span className="truncate text-slate-400 dark:text-slate-500" title={ts.targetKey}>{ts.targetKey}</span>
                                  </div>
                                  <div className="relative h-5 overflow-hidden rounded-full bg-gray-200 dark:bg-slate-800" title={`${processed.toLocaleString()} of ${ts.rowsSource.toLocaleString()} rows processed`}>
                                    <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
                                    <span className="absolute inset-0 flex items-center justify-center text-[10px] font-semibold tabular-nums text-slate-700 mix-blend-multiply dark:text-slate-100 dark:mix-blend-normal">
                                      {pct}% · {processed.toLocaleString()} / {ts.rowsSource.toLocaleString()}
                                    </span>
                                  </div>
                                  <span className="text-right text-[11px] tabular-nums text-slate-500 dark:text-slate-400">{ts.rowsMigrated.toLocaleString()} rows</span>
                                  <div className="text-right">
                                    {ts.rowsErrored > 0 ? (
                                      <button
                                        type="button"
                                        onClick={() => setRunLogSelection(isLogSelected ? null : { runId: run.id, tableId: ts.id })}
                                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-rose-500 hover:bg-rose-100 hover:text-rose-700 dark:hover:bg-rose-950/50 dark:hover:text-rose-300"
                                        title="Show this table's errors in the run log">
                                        <AlertTriangle size={10} />{ts.rowsErrored.toLocaleString()} errors
                                      </button>
                                    ) : <span className="text-[11px] text-slate-300 dark:text-slate-700">—</span>}
                                  </div>
                                  <div className="flex items-center justify-end gap-1">
                                    {ts.status === 'running' && <Loader2 size={12} className="mr-1 animate-spin text-violet-500" aria-label="Running" />}
                                    {ts.status === 'pending' && <button type="button" title="Run table" onClick={() => void handleTableAction(run.id, ts.id, 'run')} className="rounded p-1 text-emerald-500 hover:bg-emerald-50"><Play size={12} /></button>}
                                    {(ts.status === 'running' || ts.status === 'pending') && <button type="button" title="Pause table" onClick={() => void handleTableAction(run.id, ts.id, 'pause')} className="rounded p-1 text-amber-500 hover:bg-amber-50"><Pause size={12} /></button>}
                                    {ts.status === 'paused' && <button type="button" title="Resume table" onClick={() => void handleTableAction(run.id, ts.id, 'resume')} className="rounded p-1 text-violet-500 hover:bg-violet-50"><Play size={12} /></button>}
                                    {!['completed', 'rolled_back', 'aborted'].includes(ts.status) && <button type="button" title="Stop table" onClick={() => void handleTableAction(run.id, ts.id, 'stop')} className="rounded p-1 text-rose-500 hover:bg-rose-50"><Square size={11} /></button>}
                                    {['completed', 'failed', 'aborted'].includes(ts.status) && <button type="button" title="Restart table" onClick={() => void handleTableAction(run.id, ts.id, 'restart')} className="rounded p-1 text-blue-500 hover:bg-blue-50"><RefreshCw size={12} /></button>}
                                    {tableActionKey?.startsWith(`${run.id}:${ts.id}:`) && <Loader2 size={11} className="animate-spin text-slate-400" />}
                                  </div>
                                </div>
                              );
                            })}
                                </div>
                              </div>
                            </div>

                            <div className="mt-2 flex justify-end">
                              <button type="button"
                                onClick={() => setRunLogSelection(runLogSelection?.runId === run.id && runLogSelection.tableId === null ? null : { runId: run.id, tableId: null })}
                                className="inline-flex items-center gap-1.5 text-[11px] font-medium text-slate-500 hover:text-violet-600 dark:text-slate-400 dark:hover:text-violet-300">
                                <Terminal size={11} />
                                {runLogSelection?.runId === run.id && runLogSelection.tableId === null ? 'Hide run log' : 'View full run log'}
                              </button>
                            </div>

                            {runLogSelection?.runId === run.id && (() => {
                              const selectedTable = runLogSelection.tableId
                                ? run.tableStates.find(ts => ts.id === runLogSelection.tableId) ?? null
                                : null;
                              const tableKeys = selectedTable ? [selectedTable.sourceKey, selectedTable.targetKey] : [];
                              const visibleLogs = selectedTable
                                ? run.logs.filter(line => tableKeys.some(key => line.includes(`[${key}]`)))
                                : run.logs;
                              const extraErrors = [
                                ...(selectedTable?.error ? [selectedTable.error] : []),
                                ...run.errors.filter(error => !selectedTable || tableKeys.some(key => error.includes(key))),
                              ].filter((error, index, all) => all.indexOf(error) === index && !visibleLogs.some(line => line.includes(error)));
                              return (
                                <div className="mt-2 overflow-hidden rounded-md border border-slate-700 bg-slate-950 shadow-inner">
                                  <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
                                    <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                      <Terminal size={12} />
                                      <span>Run Log</span>
                                      {selectedTable && <span className="truncate font-mono font-normal normal-case tracking-normal text-rose-400">— {selectedTable.sourceKey}</span>}
                                    </div>
                                    <button type="button" onClick={() => setRunLogSelection(null)} className="text-slate-500 hover:text-slate-200" title="Close run log"><X size={13} /></button>
                                  </div>
                                  <div className="max-h-56 overflow-auto p-3 font-mono text-[11px] leading-5 text-slate-300">
                                    {visibleLogs.length === 0 && extraErrors.length === 0 && <div className="italic text-slate-500">No log output for this table.</div>}
                                    {visibleLogs.map((line, i) => (
                                      <div key={i} className={line.includes('ERROR') || /\d+ errors/.test(line) ? 'text-rose-400' : line.includes('completed') ? 'text-emerald-400' : line.includes('skipped') ? 'text-amber-400' : ''}>{line}</div>
                                    ))}
                                    {extraErrors.map((error, i) => <div key={`error-${i}`} className="text-rose-400">[error] {error}</div>)}
                                  </div>
                                </div>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Pre-flight result modal */}
        {preflight && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col">
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 dark:border-slate-800">
                <div className="flex items-center gap-2">
                  <ListChecks size={16} className="text-violet-500" />
                  <h2 className="text-[15px] font-semibold text-gray-800 dark:text-slate-100">Pre-flight — {preflight.jobName}</h2>
                </div>
                <button onClick={() => setPreflight(null)} className="text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
                  <X size={16} />
                </button>
              </div>

              <div className="overflow-y-auto px-5 py-4 space-y-4">
                {preflight.loading ? (
                  <div className="flex items-center justify-center py-12 gap-2 text-[13px] text-gray-400">
                    <Loader2 size={16} className="animate-spin" />Checking connections, counting rows…
                  </div>
                ) : preflight.error ? (
                  <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 text-[13px] text-rose-600 dark:text-rose-400">
                    {preflight.error}
                  </div>
                ) : preflight.report ? (() => {
                  const r = preflight.report;
                  const errCount = r.globalIssues.filter(i => i.level === 'error').length + r.tables.reduce((s, t) => s + t.issues.filter(i => i.level === 'error').length, 0);
                  const warnCount = r.globalIssues.filter(i => i.level === 'warning').length + r.tables.reduce((s, t) => s + t.issues.filter(i => i.level === 'warning').length, 0);
                  return (
                    <>
                      {/* Verdict banner */}
                      <div className={`flex items-center gap-2.5 p-3 rounded-lg border ${r.ok ? 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/40' : 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-900/40'}`}>
                        {r.ok ? <CheckCircle2 size={18} className="text-emerald-500 shrink-0" /> : <AlertTriangle size={18} className="text-rose-500 shrink-0" />}
                        <div>
                          <p className={`text-[13px] font-semibold ${r.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-700 dark:text-rose-300'}`}>
                            {r.ok ? 'Ready to run' : `${errCount} blocking issue${errCount !== 1 ? 's' : ''} found`}
                          </p>
                          <p className="text-[11px] text-gray-500 dark:text-slate-400">
                            {warnCount > 0 ? `${warnCount} warning${warnCount !== 1 ? 's' : ''} · ` : ''}review below before scheduling.
                          </p>
                        </div>
                      </div>

                      {/* Summary stats */}
                      <div className="grid grid-cols-4 gap-2">
                        {[
                          { label: 'Tables', value: r.tableCount.toLocaleString() },
                          { label: 'Total rows', value: r.totalRows.toLocaleString() },
                          { label: 'Est. duration', value: fmtDuration(r.estimatedSeconds) },
                          { label: 'Connectivity', value: r.source.reachable && r.target.reachable ? 'OK' : 'Failed' },
                        ].map(s => (
                          <div key={s.label} className="rounded-lg border border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/40 px-3 py-2">
                            <p className="text-[10px] uppercase tracking-wider text-gray-400 dark:text-slate-500">{s.label}</p>
                            <p className="text-[14px] font-semibold text-gray-800 dark:text-slate-200">{s.value}</p>
                          </div>
                        ))}
                      </div>

                      {/* Connectivity detail when failing */}
                      {(!r.source.reachable || !r.target.reachable) && (
                        <div className="space-y-1">
                          {!r.source.reachable && <p className="text-[12px] text-rose-600 dark:text-rose-400">Source: {r.source.error}</p>}
                          {!r.target.reachable && <p className="text-[12px] text-rose-600 dark:text-rose-400">Target: {r.target.error}</p>}
                        </div>
                      )}

                      {/* Global issues */}
                      {r.globalIssues.length > 0 && (
                        <div className="space-y-1.5">
                          {r.globalIssues.map((iss, i) => (
                            <div key={i} className={`flex items-start gap-1.5 text-[12px] ${iss.level === 'error' ? 'text-rose-600 dark:text-rose-400' : iss.level === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-500 dark:text-slate-400'}`}>
                              {iss.level === 'error' ? <AlertTriangle size={12} className="mt-0.5 shrink-0" /> : <Info size={12} className="mt-0.5 shrink-0" />}
                              <span>{iss.message}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Per-table table */}
                      <div className="rounded-lg border border-gray-100 dark:border-slate-800 overflow-hidden">
                        <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-3 py-1.5 bg-gray-50 dark:bg-slate-800/40 text-[10px] uppercase tracking-wider text-gray-400 dark:text-slate-500">
                          <span>Table</span><span className="text-right">Rows</span><span className="text-right pl-3">Target</span>
                        </div>
                        <div className="max-h-64 overflow-y-auto">
                          {r.tables.map(t => (
                            <div key={t.tableId} className="px-3 py-1.5 border-t border-gray-50 dark:border-slate-800/50">
                              <div className="grid grid-cols-[1fr_auto_auto] gap-2 items-center">
                                <span className="text-[12px] font-mono text-gray-600 dark:text-slate-300 truncate">{t.sourceKey}</span>
                                <span className="text-[12px] text-gray-500 dark:text-slate-400 text-right tabular-nums">{t.sourceRows == null ? '—' : t.sourceRows.toLocaleString()}</span>
                                <span className={`text-[11px] text-right pl-3 ${t.targetExists ? 'text-amber-500' : 'text-emerald-500'}`}>{t.targetExists ? 'exists' : 'new'}</span>
                              </div>
                              {t.issues.map((iss, i) => (
                                <div key={i} className={`flex items-start gap-1.5 mt-0.5 pl-2 text-[11px] ${iss.level === 'error' ? 'text-rose-500' : 'text-amber-500'}`}>
                                  {iss.level === 'error' ? <AlertTriangle size={10} className="mt-0.5 shrink-0" /> : <Info size={10} className="mt-0.5 shrink-0" />}
                                  <span>{iss.message}</span>
                                </div>
                              ))}
                            </div>
                          ))}
                        </div>
                      </div>
                      <p className="text-[11px] text-gray-400 dark:text-slate-500">
                        Duration is a rough estimate at ~2,000 rows/s and varies with row width, indexes and network.
                      </p>
                    </>
                  );
                })() : null}
              </div>

              <div className="px-5 py-3 border-t border-gray-100 dark:border-slate-800 flex justify-end">
                <button onClick={() => setPreflight(null)}
                  className="px-3 py-1.5 rounded bg-violet-600 text-white text-[13px] font-medium hover:bg-violet-700 transition-colors">
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add/Edit form dialog */}
        {showForm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4">
            <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 shadow-2xl w-full max-w-md p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-[15px] font-semibold text-gray-800 dark:text-slate-100">
                  {editTarget ? 'Edit Schedule' : 'New Schedule'}
                </h2>
                <button onClick={() => setShowForm(false)} className="text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
                  <X size={16} />
                </button>
              </div>

              {/* Job picker */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-gray-600 dark:text-slate-400">Migration Job</label>
                <select
                  value={formJobId}
                  onChange={e => setFormJobId(e.target.value)}
                  className="w-full px-2.5 py-1.5 rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[13px] text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-400">
                  {jobs.length === 0 && <option value="">No saved jobs</option>}
                  {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
                </select>
              </div>

              {/* Cron preset */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-gray-600 dark:text-slate-400">Schedule Preset</label>
                <select
                  value={formPreset}
                  onChange={e => {
                    setFormPreset(e.target.value);
                    if (e.target.value !== '__custom__') setFormCron(e.target.value);
                  }}
                  className="w-full px-2.5 py-1.5 rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[13px] text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-400">
                  {CRON_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label} — {p.value}</option>)}
                  <option value="__custom__">Custom expression…</option>
                </select>
              </div>

              {/* Cron expression */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-gray-600 dark:text-slate-400">Cron Expression</label>
                <input
                  value={formCron}
                  onChange={e => { setFormCron(e.target.value); setFormPreset('__custom__'); }}
                  placeholder="* * * * *"
                  className="w-full px-2.5 py-1.5 rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[13px] font-mono text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-400" />
                <p className="text-[11px] text-gray-400 dark:text-slate-500 font-mono">
                  {formCron.trim().split(/\s+/).length === 5 ? describeCron(formCron.trim()) : 'min hour dom month dow'}
                </p>
              </div>

              {/* Notify email */}
              <div className="space-y-1">
                <label className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600 dark:text-slate-400">
                  <Mail size={12} />Notify on completion <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <input
                  type="email"
                  value={formNotifyEmail}
                  onChange={e => setFormNotifyEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-2.5 py-1.5 rounded border border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-[13px] text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-400" />
                <p className="text-[11px] text-gray-400 dark:text-slate-500">
                  Emails a run summary when this job finishes or fails. Requires email config in Settings.
                </p>
              </div>

              {/* Buttons */}
              <div className="flex gap-2 pt-1">
                <button onClick={() => setShowForm(false)}
                  className="flex-1 px-3 py-1.5 rounded border border-gray-200 dark:border-slate-700 text-[13px] text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                  Cancel
                </button>
                <button
                  disabled={formSaving || !formJobId || !formCron.trim()}
                  onClick={() => void handleFormSave()}
                  className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded bg-violet-600 text-white text-[13px] font-medium hover:bg-violet-700 disabled:opacity-40 transition-colors">
                  {formSaving && <Loader2 size={12} className="animate-spin" />}
                  {editTarget ? 'Save Changes' : 'Create Schedule'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
