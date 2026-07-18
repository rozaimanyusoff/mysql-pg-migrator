'use client';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Calendar, CheckCircle2,
  Clock, Loader2, Pause, Pencil, Play, Timer,
  Plus, Terminal, Trash2, X,
  AlertTriangle, CircleDot, ListChecks, RotateCcw, Mail, Info,
  FileSpreadsheet, FileText, MoreVertical, Search, Square, RefreshCw,
  ChevronDown, ChevronLeft, ChevronRight, Download,
} from 'lucide-react';
import { Tooltip } from '../components/Tooltip';
import ResizableJobPanel from '../components/ResizableJobPanel';
import { useAlert } from '../lib/alert-context';
import type { CronSchedule, SchedulerJobSummary, MigRun, MigRunTableState, RunStatus } from '../lib/migv2/types';
import type { PreflightReport } from '../lib/migv2/preflight';
import type { PreflightStatus } from '../lib/migv2/preflight-store';
import { describePreflightFailure, type PreflightFailure } from '../lib/migv2/preflight-client-error';
import { MAX_CHUNK_ROWS } from '../lib/migv2/execution-policy';
import { MAX_NOTIFICATION_RECIPIENTS, normalizeNotificationRecipients } from '../lib/migv2/notification-recipients';

function localDateTimeParts(date: Date): { date: string; time: string } {
  const local = date.toLocaleString('sv-SE');
  return { date: local.slice(0, 10), time: local.slice(11, 16) };
}

function defaultRunOnceParts(): { date: string; time: string } {
  const next = new Date(Date.now() + 60 * 60 * 1000);
  next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15, 0, 0);
  return localDateTimeParts(next);
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `~${m}m`;
  const h = Math.floor(m / 60);
  return `~${h}h ${m % 60}m`;
}

function preflightIssueCount(report: PreflightReport | null, level: 'error' | 'warning'): number {
  if (!report) return 0;
  return report.globalIssues.filter(issue => issue.level === level).length
    + report.tables.reduce((sum, table) => sum + table.issues.filter(issue => issue.level === level).length, 0);
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

interface SchedulerWorkerStatus {
  running: boolean;
  startedAt: string | null;
  lastTickAt: string | null;
  lastError: string | null;
  intervalMs: number;
}

// ── Status helpers ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: CronSchedule['lastRunStatus'] }) {
  if (!status) return null;
  if (status === 'completed') return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400 font-semibold">
      <CheckCircle2 size={9} />completed
    </span>
  );
  if (status === 'completed_with_issues') return (
    <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
      <AlertTriangle size={9} />completed with issues
    </span>
  );
  if (status === 'failed') return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-rose-100 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400 font-semibold">
      <AlertTriangle size={9} />failed
    </span>
  );
  if (status === 'interrupted') return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 font-semibold">
      <AlertTriangle size={9} />interrupted
    </span>
  );
  if (status === 'running') return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400 font-semibold">
      <Loader2 size={9} className="animate-spin" />running
    </span>
  );
  if (status === 'paused') return (
    <span className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400 font-semibold">
      <Pause size={9} />paused
    </span>
  );
  return null;
}

function CurrentJobStatus({ status }: { status: RunStatus }) {
  const tone = status === 'running' || status === 'pending'
    ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300'
    : status === 'paused' || status === 'interrupted' || status === 'completed_with_issues'
      ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
      : status === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
        : 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300';
  return <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>{status.replaceAll('_', ' ')}</span>;
}

function RunStatusBadge({ status }: { status: MigRun['status'] }) {
  const map: Record<string, string> = {
    completed: 'bg-emerald-100 dark:bg-emerald-950/40 text-emerald-600 dark:text-emerald-400',
    completed_with_issues: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400',
    failed: 'bg-rose-100 dark:bg-rose-950/40 text-rose-600 dark:text-rose-400',
    interrupted: 'bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400',
    running: 'bg-violet-100 dark:bg-violet-950/40 text-violet-600 dark:text-violet-400',
    pending: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
    aborted: 'bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400',
    paused: 'bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400',
    rolled_back: 'bg-amber-100 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400',
  };
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full font-semibold ${map[status] ?? map.pending}`}>
      {status === 'running' && <Loader2 size={9} className="animate-spin" />}
      {status === 'completed' && <CheckCircle2 size={9} />}
      {status === 'completed_with_issues' && <AlertTriangle size={9} />}
      {status === 'failed' && <AlertTriangle size={9} />}
      {status === 'interrupted' && <AlertTriangle size={9} />}
      {status === 'paused' && <Pause size={9} />}
      {status === 'completed_with_issues' ? 'completed with issues' : status}
    </span>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SchedulerPage() {
  const router = useRouter();
  const { showError, showConfirm } = useAlert();
  const [schedules, setSchedules] = useState<CronSchedule[]>([]);
  const [jobs, setJobs] = useState<SchedulerJobSummary[]>([]);
  const [runs, setRuns] = useState<MigRun[]>([]);
  const [activeRunJobIds, setActiveRunJobIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editTarget, setEditTarget] = useState<CronSchedule | null>(null);
  const [schedulerWorker, setSchedulerWorker] = useState<SchedulerWorkerStatus | null>(null);
  const [runLogSelection, setRunLogSelection] = useState<{ runId: string; tableId: string | null } | null>(null);
  const [tableRunLogs, setTableRunLogs] = useState<Record<string, { logs: string[]; errors: string[] }>>({});
  const [resuming, setResuming] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [tableSearch, setTableSearch] = useState('');
  const [tableStatusFilter, setTableStatusFilter] = useState('all');
  const [showStatusFilter, setShowStatusFilter] = useState(false);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set());
  const [tableActionKey, setTableActionKey] = useState<string | null>(null);
  const [bulkTableAction, setBulkTableAction] = useState<'run' | 'pause' | 'stop' | null>(null);
  const [runMenuId, setRunMenuId] = useState<string | null>(null);
  const [hideCompletedRunIds, setHideCompletedRunIds] = useState<Set<string>>(new Set());
  const [preflight, setPreflight] = useState<{ jobName: string; loading: boolean; report: PreflightReport | null; error: PreflightFailure | null } | null>(null);
  const [preflightStatus, setPreflightStatus] = useState<PreflightStatus | null>(null);
  const [lastPreflightReport, setLastPreflightReport] = useState<PreflightReport | null>(null);
  const [runChunkMode, setRunChunkMode] = useState<'auto' | 'fixed'>('auto');
  const [runChunkRows, setRunChunkRows] = useState(1_000);
  const [jobsPanelCollapsed, setJobsPanelCollapsed] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const highlightHandledRef = useRef(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const runDateInputRef = useRef<HTMLInputElement>(null);
  const runTimeInputRef = useRef<HTMLInputElement>(null);

  // ── Form state ───────────────────────────────────────────────────────────────
  const [formJobId, setFormJobId] = useState('');
  const [formCron, setFormCron] = useState('0 2 * * *');
  const [formPreset, setFormPreset] = useState('0 2 * * *');
  const [formScheduleMode, setFormScheduleMode] = useState<'once' | 'recurring'>('recurring');
  const [formTimezone, setFormTimezone] = useState('Asia/Kuala_Lumpur');
  const [formRunDate, setFormRunDate] = useState('');
  const [formRunTime, setFormRunTime] = useState('');
  const [formNotifyEmail, setFormNotifyEmail] = useState('');
  const [formChunkMode, setFormChunkMode] = useState<'auto' | 'fixed'>('auto');
  const [formChunkRows, setFormChunkRows] = useState(1_000);
  const [formSaving, setFormSaving] = useState(false);

  // selectedId is now a JOB id, not a schedule id
  const selectedJob = jobs.find(j => j.id === selectedId) ?? null;
  const selectedSchedule = schedules.find(s => s.jobId === selectedId) ?? null;
  const selectedRuns = runs
    .filter(r => r.jobId === selectedId)
    .slice(0, 10);
  const selectedHistoryRun = selectedRuns[0] ?? null;
  const selectedHistoryTableStates: MigRunTableState[] = selectedHistoryRun && selectedJob
    ? selectedJob.executionTables.map(table => selectedHistoryRun.tableStates.find(state => state.id === table.id) ?? ({
      id: table.id,
      sourceKey: table.sourceKey,
      targetKey: table.targetKey,
        status: 'pending', rowsSource: 0, rowsMigrated: 0, rowsSkipped: 0, rowsErrored: 0,
        offset: 0, hasMore: true, error: null, insertedPks: [], pkOverflow: false, targetPkCol: null,
      } satisfies MigRunTableState))
    : [];
  const isCurrentRunRunning = selectedHistoryRun?.status === 'running' || selectedSchedule?.lastRunStatus === 'running';
  const hasPausableJobTables = selectedHistoryTableStates.some(t => t.status === 'running' || t.status === 'pending');
  const hasActiveJobRun = Boolean(
    selectedHistoryRun &&
    (selectedHistoryRun.status === 'running' || selectedHistoryRun.status === 'pending' || selectedHistoryRun.status === 'paused') &&
    selectedHistoryTableStates.some(t => t.status === 'running' || t.status === 'pending' || t.status === 'paused')
  );
  const canResumePausedRun = Boolean(
    selectedHistoryRun &&
    (selectedHistoryRun.status === 'paused' || selectedSchedule?.lastRunStatus === 'paused') &&
    selectedHistoryTableStates.some(t => t.status === 'pending' || t.status === 'paused')
  );
  const canResumeInterruptedRun = Boolean(selectedHistoryRun?.status === 'interrupted' || selectedHistoryRun?.interrupted || selectedSchedule?.lastRunStatus === 'interrupted');
  const canResumeExistingRun = canResumePausedRun || canResumeInterruptedRun;
  const runNowLabel = canResumeExistingRun ? 'Resume Run' : 'Run Now';
  const primaryJobAction = isCurrentRunRunning ? 'pause' : 'run';
  const primaryJobLabel = isCurrentRunRunning ? 'Pause Run' : runNowLabel;
  const preflightBlockers = preflightIssueCount(lastPreflightReport, 'error');
  const activeCapability = preflight?.report?.capabilities ?? lastPreflightReport?.capabilities ?? null;
  const autoChunkRows = activeCapability?.recommendedBatchRows ?? 1_000;
  const effectiveChunkCeiling = activeCapability?.concurrencyAdjustedMaxChunkRows ?? activeCapability?.maxSafeBatchRows ?? 5_000;
  const manualChunkCeiling = activeCapability?.singleRunMaxChunkRows ?? MAX_CHUNK_ROWS;
  const formRunAt = formRunDate && formRunTime ? `${formRunDate}T${formRunTime}` : '';
  const formRunDateTime = formRunAt ? new Date(formRunAt) : null;
  const formRunOnceValid = Boolean(formRunDateTime && Number.isFinite(formRunDateTime.getTime()) && formRunDateTime.getTime() > Date.now());
  const generatedOnceCron = formRunDateTime && Number.isFinite(formRunDateTime.getTime())
    ? `${formRunDateTime.getMinutes()} ${formRunDateTime.getHours()} ${formRunDateTime.getDate()} ${formRunDateTime.getMonth() + 1} *`
    : '';
  const formRecipients = normalizeNotificationRecipients(formNotifyEmail);
  const hasCompatibilityWarnings = Boolean(preflight?.report?.tables.some(table =>
    table.issues.some(issue => issue.code === 'target_schema_compatibility')
  ));
  const hasReviewablePreflight = Boolean(lastPreflightReport && preflightStatus && preflightStatus.reason !== 'job_changed');
  const runJobTooltip = primaryJobAction === 'pause'
    ? 'Pause this migration job only'
    : canResumeExistingRun
      ? 'Resume this interrupted or paused migration from its last checkpoint'
      : selectedJob && !selectedJob.scheduleReady
        ? `Complete ${selectedJob.scheduleIssues} Migration setup issue${selectedJob.scheduleIssues !== 1 ? 's' : ''} before using Scheduler execution`
        : preflightStatus?.reason === 'failed'
          ? `Run blocked by ${preflightBlockers} operational Pre-flight issue${preflightBlockers !== 1 ? 's' : ''}; review the result first`
          : !preflightStatus?.ready
            ? 'Click Run Now to perform the operational Pre-flight check first'
            : 'Run this entire saved job immediately; a schedule is not required';
  const primaryJobDisabled = Boolean(
    bulkTableAction ||
    (primaryJobAction === 'pause'
      ? !hasPausableJobTables
      : (!selectedJob || !selectedJob.scheduleReady ||
        ((selectedHistoryRun?.status === 'paused' || selectedSchedule?.lastRunStatus === 'paused') && !canResumePausedRun) ||
        (canResumeInterruptedRun && !selectedHistoryRun)))
  );

  // ── Data fetching ─────────────────────────────────────────────────────────────
  const loadAll = async () => {
    try {
      const [schRes, jobRes] = await Promise.all([
        axios.get<{ schedules: CronSchedule[]; activeRunJobIds: string[]; schedulerWorker: SchedulerWorkerStatus }>('/api/scheduler'),
        axios.get<{ jobs: SchedulerJobSummary[] }>('/api/scheduler/jobs'),
      ]);
      setSchedules(schRes.data.schedules);
      setJobs(jobRes.data.jobs);
      setActiveRunJobIds(new Set(schRes.data.activeRunJobIds ?? []));
      setSchedulerWorker(schRes.data.schedulerWorker ?? null);
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  const loadRunsForJob = async (jobId: string) => {
    try {
      const { data } = await axios.get<{ runs: MigRun[] }>('/api/migv2/run/status', { params: { jobId, limit: 10, compact: 1 } });
      setRuns(data.runs);
    } catch { /* ignore */ }
  };

  const toggleTableRunLog = async (runId: string, tableId: string) => {
    const key = `${runId}:${tableId}`;
    if (runLogSelection?.runId === runId && runLogSelection.tableId === tableId) {
      setRunLogSelection(null);
      return;
    }
    setRunLogSelection({ runId, tableId });
    if (tableRunLogs[key]) return;
    try {
      const { data } = await axios.get<{ logs: string[]; errors: string[] }>('/api/migv2/run/status', {
        params: { id: runId, tableLogId: tableId },
      });
      setTableRunLogs(previous => ({ ...previous, [key]: data }));
    } catch {
      setTableRunLogs(previous => ({ ...previous, [key]: { logs: [], errors: ['Unable to load table run log.'] } }));
    }
  };

  const pollRuns = async () => {
    try {
      const [schRes, jobRes, runRes] = await Promise.all([
        axios.get<{ schedules: CronSchedule[]; activeRunJobIds: string[]; schedulerWorker: SchedulerWorkerStatus }>('/api/scheduler'),
        axios.get<{ jobs: SchedulerJobSummary[] }>('/api/scheduler/jobs'),
        selectedId
          ? axios.get<{ runs: MigRun[] }>('/api/migv2/run/status', { params: { jobId: selectedId, limit: 10, compact: 1 } })
          : Promise.resolve(null),
      ]);
      setSchedules(schRes.data.schedules);
      setJobs(jobRes.data.jobs);
      if (runRes) setRuns(runRes.data.runs);
      setActiveRunJobIds(new Set(schRes.data.activeRunJobIds ?? []));
      setSchedulerWorker(schRes.data.schedulerWorker ?? null);
    } catch { /* ignore */ }
  };

  useEffect(() => { void loadAll(); }, []);
  useEffect(() => { if (selectedId) void loadRunsForJob(selectedId); }, [selectedId]);
  useEffect(() => {
    if (!showExportMenu) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) setShowExportMenu(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [showExportMenu]);
  useEffect(() => {
    setPreflightStatus(null);
    setLastPreflightReport(null);
    setRunChunkMode('auto');
    if (!selectedId || !selectedJob?.scheduleReady) return;
    void axios.get<{ status: PreflightStatus; report: PreflightReport | null }>('/api/migv2/preflight', { params: { jobId: selectedId } })
      .then(({ data }) => {
        setPreflightStatus(data.status);
        setLastPreflightReport(data.report);
      })
      .catch(() => setPreflightStatus({ ready: false, reason: 'missing', completedAt: null, expiresAt: null }));
  }, [selectedId, selectedJob?.version]);
  useEffect(() => {
    if (runChunkMode === 'auto') setRunChunkRows(autoChunkRows);
  }, [autoChunkRows, runChunkMode]);

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
    if (!hasSchedule && job.scheduleReady) void handlePreflight(job.id, job.name);
    // Clean the URL so a refresh doesn't re-trigger
    void router.replace('/scheduler', undefined, { shallow: true });
  }, [loading, jobs, schedules, router.isReady]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasActiveRun = schedules.some(s => s.lastRunStatus === 'running') ||
    runs.some(r => r.status === 'running' || r.status === 'pending') || activeRunJobIds.size > 0;

  // Poll quickly while work is active, and periodically while idle so runs
  // started from another tab or cron still update the job-row spinner.
  useEffect(() => {
    const interval = setInterval(() => void pollRuns(), hasActiveRun ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [hasActiveRun, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ───────────────────────────────────────────────────────────────────
  const handleToggleEnabled = async (s: CronSchedule) => {
    const updated = { ...s, enabled: !s.enabled };
    setSchedules(prev => prev.map(x => x.id === s.id ? updated : x));
    try {
      await axios.patch(`/api/scheduler/${s.id}`, { enabled: !s.enabled });
    } catch (err) {
      setSchedules(prev => prev.map(x => x.id === s.id ? s : x));
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Could not update schedule') : 'Could not update schedule';
      showError('Schedule update failed', msg);
    }
  };

  const handlePreflight = async (jobId: string, jobName: string) => {
    setPreflight({ jobName, loading: true, report: null, error: null });
    try {
      const { data } = await axios.post<{ report: PreflightReport; status: PreflightStatus }>('/api/migv2/preflight', { jobId });
      setPreflight({ jobName, loading: false, report: data.report, error: null });
      setPreflightStatus(data.status);
      setLastPreflightReport(data.report);
    } catch (err) {
      setPreflight({ jobName, loading: false, report: null, error: describePreflightFailure(err) });
    }
  };

  const handleAddScheduleIntent = async () => {
    if (!selectedJob || !selectedJob.scheduleReady) return;
    if (!preflightStatus?.ready) {
      if (hasReviewablePreflight) {
        setPreflight({ jobName: selectedJob.name, loading: false, report: lastPreflightReport, error: null });
      } else {
        await handlePreflight(selectedJob.id, selectedJob.name);
      }
      return;
    }
    openAddForm(selectedJob.id);
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

  const handleBulkTableAction = async (action: 'run' | 'pause' | 'stop') => {
    if (action === 'run') {
      if (!selectedJob) return;
      const resumePausedRun = canResumePausedRun && selectedHistoryRun;
      const resumeInterruptedRun = canResumeInterruptedRun && selectedHistoryRun;
      const tableIds = resumePausedRun
        ? selectedHistoryTableStates
            .filter(table => table.status === 'pending' || table.status === 'paused')
            .map(table => table.id)
        : [];
      if (resumePausedRun && !tableIds.length) return;
      if (resumeInterruptedRun) {
        setBulkTableAction(action);
        try {
          await axios.post('/api/migv2/run/resume', { runId: selectedHistoryRun.id });
          await pollRuns();
        } catch (err) {
          const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Resume failed') : 'Resume failed';
          showError('Resume failed', msg);
        } finally { setBulkTableAction(null); }
        return;
      }
      if (!resumePausedRun && !preflightStatus?.ready) {
        if (hasReviewablePreflight) {
          setPreflight({ jobName: selectedJob.name, loading: false, report: lastPreflightReport, error: null });
        } else {
          await handlePreflight(selectedJob.id, selectedJob.name);
        }
        return;
      }
      setBulkTableAction(action);
      try {
        if (resumePausedRun) {
          await axios.post('/api/migv2/run/control-tables', { jobId: selectedJob.id, runId: selectedHistoryRun.id, tableIds, action });
        } else {
          await axios.post('/api/migv2/run/start-job', {
            jobId: selectedJob.id,
            chunkRows: runChunkMode === 'fixed' ? runChunkRows : null,
          });
        }
        await pollRuns();
      } catch (err) {
        const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? 'Run Now failed') : 'Run Now failed';
        showError('Run Now failed', msg);
      } finally { setBulkTableAction(null); }
      return;
    }
    if (!selectedJob || !selectedHistoryRun || selectedHistoryRun.jobId !== selectedJob.id) return;
    const tableIds = selectedHistoryTableStates
      .filter(table => action === 'pause'
        ? (table.status === 'running' || table.status === 'pending')
        : (table.status === 'running' || table.status === 'pending' || table.status === 'paused'))
      .map(table => table.id);
    if (!tableIds.length) return;
    setBulkTableAction(action);
    try {
      await axios.post('/api/migv2/run/control-tables', { jobId: selectedJob.id, runId: selectedHistoryRun.id, tableIds, action });
      await pollRuns();
    } catch (err) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? `${action} failed`) : `${action} failed`;
      showError(`Bulk ${action} failed`, msg);
    } finally { setBulkTableAction(null); }
  };

  const handleStopSelectedJob = () => {
    if (!selectedJob || !selectedHistoryRun) return;
    showConfirm({
      title: `Stop ${selectedJob.name}?`,
      description: `Only the active run for “${selectedJob.name}” will be stopped. Other migration jobs will continue running.`,
      confirmLabel: 'Stop Job',
      onConfirm: async () => { await handleBulkTableAction('stop'); },
    });
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

  // ── Form ──────────────────────────────────────────────────────────────────────
  const openAddForm = (preselectedJobId?: string) => {
    const runOnce = defaultRunOnceParts();
    setEditTarget(null);
    setFormJobId(preselectedJobId ?? jobs[0]?.id ?? '');
    setFormCron('0 2 * * *');
    setFormPreset('0 2 * * *');
    setFormScheduleMode('recurring');
    setFormTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kuala_Lumpur');
    setFormRunDate(runOnce.date);
    setFormRunTime(runOnce.time);
    setFormNotifyEmail('');
    setFormChunkMode('auto');
    setFormChunkRows(autoChunkRows);
    setShowForm(true);
  };

  const openEditForm = (s: CronSchedule) => {
    const runOnce = s.runAt ? localDateTimeParts(new Date(s.runAt)) : defaultRunOnceParts();
    setEditTarget(s);
    setFormJobId(s.jobId);
    setFormCron(s.cronExpr);
    setFormPreset(CRON_PRESETS.find(p => p.value === s.cronExpr)?.value ?? '__custom__');
    setFormScheduleMode(s.scheduleMode === 'once' ? 'once' : 'recurring');
    setFormTimezone(s.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kuala_Lumpur');
    setFormRunDate(runOnce.date);
    setFormRunTime(runOnce.time);
    setFormNotifyEmail(s.notifyEmail ?? '');
    setFormChunkMode(s.chunkMode === 'fixed' ? 'fixed' : 'auto');
    setFormChunkRows(s.chunkRows ?? autoChunkRows);
    setShowForm(true);
  };

  const handleFormSave = async () => {
    if (!formJobId || (formScheduleMode === 'recurring' ? !formCron.trim() : !formRunOnceValid)) return;
    if (formRecipients.invalid.length) {
      showError('Invalid notification email', formRecipients.invalid.join(', '));
      return;
    }
    if (formRecipients.tooMany) {
      showError('Too many notification recipients', `A maximum of ${MAX_NOTIFICATION_RECIPIENTS} recipients is allowed.`);
      return;
    }
    setFormSaving(true);
    try {
      const job = jobs.find(j => j.id === formJobId);
      if (!job) throw new Error('Job not found');
      const notifyEmail = formRecipients.value;
      const chunkMode = formChunkMode;
      const chunkRows = chunkMode === 'fixed' ? formChunkRows : null;
      const runAt = formScheduleMode === 'once' ? new Date(formRunAt).toISOString() : null;
      const runDate = formScheduleMode === 'once' ? new Date(formRunAt) : null;
      const cronExpr = runDate ? generatedOnceCron : formCron.trim();
      if (editTarget) {
        const { data } = await axios.patch<{ schedule: CronSchedule }>(`/api/scheduler/${editTarget.id}`, {
          jobId: formJobId, jobName: job.name, cronExpr, scheduleMode: formScheduleMode, runAt, timezone: formTimezone, notifyEmail, chunkMode, chunkRows,
        });
        setSchedules(prev => prev.map(s => s.id === editTarget.id ? data.schedule : s));
      } else {
        const { data } = await axios.post<{ schedule: CronSchedule }>('/api/scheduler', {
          jobId: formJobId, jobName: job.name, cronExpr, scheduleMode: formScheduleMode, runAt, timezone: formTimezone, notifyEmail, chunkMode, chunkRows,
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

  return (
    <>
      <Head><title>Scheduler — DB Maintenance</title></Head>
      <div className="bg-gray-50 dark:bg-slate-950">

        {/* Body */}
        <div className="flex h-[calc(100vh-6rem)] overflow-hidden">

          {/* Right — resizable migration jobs list */}
          <ResizableJobPanel storageKey="panel_width_scheduler_jobs" defaultWidth={288}
            className="order-2 border-l border-gray-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col overflow-hidden">
            <div className={`${jobsPanelCollapsed ? 'justify-center px-1' : 'justify-between px-3'} flex items-center py-2 border-b border-gray-100 dark:border-slate-800 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-slate-500`}>
              {!jobsPanelCollapsed && <span>MIGRATION JOBS</span>}
              <div className="flex items-center gap-2">
                {!jobsPanelCollapsed && <span>{jobs.length}</span>}
                {!jobsPanelCollapsed && <button onClick={() => void loadAll()} title="Refresh migration jobs"
                  className="p-0.5 rounded text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
                  <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
                </button>}
                <span className="text-[10px] font-normal normal-case tracking-normal text-slate-400" title="Drag the left edge to resize">resize</span>
              </div>
            </div>
            {!jobsPanelCollapsed && <div className="flex-1 overflow-y-auto">
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
                const isJobRunning = activeRunJobIds.has(job.id) || sched?.lastRunStatus === 'running';
                return (
                  <div key={job.id}
                    onClick={() => setSelectedId(job.id)}
                    className={`px-3 py-2.5 border-b border-gray-50 dark:border-slate-800/50 cursor-pointer transition-colors ${isSelected ? 'bg-violet-50 dark:bg-violet-950/30' : 'hover:bg-gray-50 dark:hover:bg-slate-800/30'}`}>
                    {/* Job name */}
                    <div className="flex items-center gap-2">
                      <span className={`text-[13px] font-medium truncate flex-1 ${isSelected ? 'text-violet-700 dark:text-violet-300' : 'text-gray-800 dark:text-slate-200'}`}>
                        {job.name}
                      </span>
                      {isJobRunning && (
                        <Tooltip content="Migration job is running" side="left">
                          <Loader2 size={11} className="shrink-0 animate-spin text-violet-500" aria-label="Migration job running" />
                        </Tooltip>
                      )}
                      {job.currentStatus && <CurrentJobStatus status={job.currentStatus} />}
                      <span className="text-[11px] text-gray-400 dark:text-slate-500 shrink-0">{job.tableCount} tables</span>
                    </div>
                    {/* Schedule info or "not scheduled" */}
                    {sched ? (
                      <>
                        <div className="flex items-center gap-1.5 mt-1 pl-0">
                          <Timer size={10} className={sched.enabled ? 'shrink-0 text-blue-500 dark:text-blue-400' : 'shrink-0 text-gray-300 dark:text-slate-600'} />
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
                      <div className="mt-1 text-[11px] italic text-gray-300 dark:text-slate-600">not scheduled</div>
                    )}
                  </div>
                );
              })}
            </div>}
          </ResizableJobPanel>

          {/* Main — selected job detail */}
          <div className="order-1 flex-1 overflow-y-auto bg-gray-50 dark:bg-slate-950">
            {!selectedJob ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
                <Calendar size={36} className="text-slate-300 dark:text-slate-700" />
                <p className="text-[14px] text-gray-400 dark:text-slate-500">Select a job to view its schedule and run history</p>
              </div>
            ) : (
              <div className="w-full max-w-none px-4 py-5 space-y-5">

                {/* Job + schedule header */}
                <div className="bg-white dark:bg-slate-900 rounded-lg border border-gray-200 dark:border-slate-800 p-4 space-y-3">
                  <div className="-mx-4 -mt-4 flex items-center border-b border-gray-100 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:border-slate-800 dark:text-slate-500">
                    Selected Migration Job
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[15px] font-semibold text-gray-800 dark:text-slate-100">{selectedJob.name}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400">{selectedJob.tableCount} tables</span>
                        {!selectedJob.scheduleReady && (
                          <span className="inline-flex items-center gap-1 rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-semibold text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
                            <AlertTriangle size={10} />Setup incomplete
                          </span>
                        )}
                        {selectedSchedule && <StatusBadge status={selectedSchedule.lastRunStatus} />}
                      </div>
                      {selectedSchedule ? (
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <CircleDot size={10} className={selectedSchedule.enabled ? 'text-violet-400' : 'text-gray-300 dark:text-slate-600'} />
                          <Clock size={10} className="text-slate-400" />
                          <span className="text-[12px] text-gray-500 dark:text-slate-400">{selectedSchedule.scheduleMode === 'once' && selectedSchedule.runAt ? `Run once · ${new Date(selectedSchedule.runAt).toLocaleString()}` : `${describeCron(selectedSchedule.cronExpr)} · ${selectedSchedule.timezone || 'Asia/Kuala_Lumpur'}`}</span>
                          <code className="text-[11px] text-slate-400 dark:text-slate-500 font-mono">({selectedSchedule.cronExpr})</code>
                          <span className="rounded-full bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:bg-blue-950/40 dark:text-blue-300">
                            Chunk {selectedSchedule.chunkMode === 'fixed' ? `${(selectedSchedule.chunkRows ?? autoChunkRows).toLocaleString()} requested` : 'Auto'}
                          </span>
                          {!selectedSchedule.enabled && (
                            <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-500">disabled</span>
                          )}
                          {selectedSchedule.missedAt && !selectedSchedule.triggeredAt && (
                            <Tooltip content="The scheduled time passed before a run was accepted. The server worker will recover and execute it automatically when capacity is available." side="bottom">
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
                                <AlertTriangle size={9} />recovery queued
                              </span>
                            </Tooltip>
                          )}
                        </div>
                      ) : (
                        <p className="text-[12px] text-gray-400 dark:text-slate-500 mt-0.5">
                          <span className="italic">No schedule configured.</span> Run Now executes immediately; Add Schedule can create a run-once or recurring cron trigger.
                        </p>
                      )}
                    </div>
                    <div className="flex max-w-[72%] shrink-0 flex-wrap items-center justify-end gap-1.5">
                      <Tooltip content={runJobTooltip} side="bottom">
                        <button type="button" onClick={() => void handleBulkTableAction(primaryJobAction)}
                          disabled={primaryJobDisabled}
                          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-40 ${primaryJobAction === 'pause' ? 'border-amber-300 text-amber-600 hover:bg-amber-50 dark:border-amber-800 dark:hover:bg-amber-950/30' : 'border-emerald-300 text-emerald-600 hover:bg-emerald-50 dark:border-emerald-800 dark:hover:bg-emerald-950/30'}`}>
                          {bulkTableAction === primaryJobAction ? <Loader2 size={11} className="animate-spin" /> : primaryJobAction === 'pause' ? <Pause size={11} /> : <Play size={11} />}{primaryJobLabel}
                        </button>
                      </Tooltip>
                      <button type="button" onClick={handleStopSelectedJob}
                        disabled={!!bulkTableAction || !hasActiveJobRun}
                        className="inline-flex items-center gap-1 rounded-md border border-rose-300 px-2.5 py-1.5 text-[11px] font-medium text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-35 dark:border-rose-800 dark:hover:bg-rose-950/30" title={hasActiveJobRun ? 'Stop the active run for this saved job' : 'Stop is available only while this job has an active run'}>
                        {bulkTableAction === 'stop' ? <Loader2 size={11} className="animate-spin" /> : <Square size={10} />}Stop Run
                      </button>
                      <div ref={exportMenuRef} className="relative">
                        <button type="button" onClick={() => setShowExportMenu(value => !value)}
                          aria-expanded={showExportMenu} aria-haspopup="menu"
                          className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 px-2.5 py-1.5 text-[11px] font-medium text-blue-600 transition-colors hover:bg-blue-50 dark:border-blue-800 dark:text-blue-400 dark:hover:bg-blue-950/30">
                          <Download size={11} />Export<ChevronDown size={11} className={`transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                        </button>
                        {showExportMenu && (
                          <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-44 overflow-hidden rounded-md border border-gray-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                            <a role="menuitem" href={`/api/scheduler/export-logs?jobId=${encodeURIComponent(selectedJob.id)}`}
                              onClick={() => setShowExportMenu(false)}
                              className="flex items-center gap-2 px-3 py-2 text-[11px] text-gray-600 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-slate-800">
                              <FileSpreadsheet size={12} className="text-emerald-500" />Logs XLSX
                            </a>
                            <a role="menuitem" href={`/api/scheduler/export-schema-md?jobId=${encodeURIComponent(selectedJob.id)}`}
                              onClick={() => setShowExportMenu(false)}
                              className="flex items-center gap-2 px-3 py-2 text-[11px] text-gray-600 hover:bg-gray-50 dark:text-slate-300 dark:hover:bg-slate-800">
                              <FileText size={12} className="text-blue-500" />Schema Markdown
                            </a>
                          </div>
                        )}
                      </div>
                      {selectedSchedule && selectedJob.scheduleReady && <Tooltip content={hasReviewablePreflight ? 'Open the latest operational Pre-flight result' : 'Check connectivity, row counts and server capacity for scheduled execution'} side="bottom">
                        <button onClick={() => hasReviewablePreflight
                          ? setPreflight({ jobName: selectedJob.name, loading: false, report: lastPreflightReport, error: null })
                          : void handlePreflight(selectedJob.id, selectedJob.name)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-[12px] font-medium transition-colors ${preflightStatus?.reason === 'expired' ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300' : preflightStatus?.ready ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300' : preflightStatus?.reason === 'failed' ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300' : 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300'}`}>
                          {preflightStatus?.reason === 'expired' ? <Timer size={13} /> : preflightStatus?.ready ? <CheckCircle2 size={13} /> : preflightStatus?.reason === 'failed' ? <AlertTriangle size={13} /> : <ListChecks size={13} />}
                          {preflightStatus?.reason === 'expired' ? 'Pre-flight passed · report stale' : preflightStatus?.ready ? 'Pre-flight passed' : preflightStatus?.reason === 'failed' ? `${preflightBlockers} blocker${preflightBlockers !== 1 ? 's' : ''}` : preflightStatus?.reason === 'job_changed' ? 'Pre-flight outdated' : 'Pre-flight'}
                        </button>
                      </Tooltip>}
                      {selectedSchedule ? (
                        <>
                          <button onClick={() => handleToggleEnabled(selectedSchedule)}
                            disabled={!selectedSchedule.enabled && (!selectedJob.scheduleReady || !preflightStatus?.ready)}
                            title={selectedSchedule.enabled ? 'Disable schedule' : 'Enable schedule'}
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
                        selectedJob.scheduleReady ? (
                          <button onClick={() => void handleAddScheduleIntent()}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-violet-300 dark:border-violet-600 bg-violet-50 dark:bg-violet-950/30 text-violet-700 dark:text-violet-300 text-[12px] font-medium hover:bg-violet-100 dark:hover:bg-violet-900/40 transition-colors">
                            <Plus size={12} />Add Schedule
                          </button>
                        ) : (
                          <button onClick={() => void router.push(`/migration?job=${encodeURIComponent(selectedJob.id)}`)}
                            className="flex items-center gap-1.5 rounded border border-rose-300 bg-rose-50 px-3 py-1.5 text-[12px] font-medium text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-300">
                            Edit Setup
                          </button>
                        )
                      )}
                    </div>
                  </div>

                  {!selectedJob.scheduleReady && (
                    <div className="flex items-start gap-2.5 rounded-lg border border-rose-300 bg-rose-50 px-3 py-2.5 dark:border-rose-800 dark:bg-rose-950/25">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-semibold text-rose-800 dark:text-rose-300">Migration setup incomplete</p>
                        <p className="mt-0.5 text-[11px] leading-4 text-rose-700 dark:text-rose-400">
                          This saved job has {selectedJob.scheduleIssues} configuration issue{selectedJob.scheduleIssues !== 1 ? 's' : ''}. Scheduler execution and cron setup are unavailable until the job is validated in Migration.
                        </p>
                      </div>
                      <button type="button" onClick={() => void router.push(`/migration?job=${encodeURIComponent(selectedJob.id)}`)}
                        className="shrink-0 rounded-md border border-rose-400 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300">
                        Edit Setup
                      </button>
                    </div>
                  )}

                  {selectedJob.scheduleReady && selectedSchedule && !preflightStatus?.ready && (
                    <div className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${preflightStatus?.reason === 'failed' ? 'border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/25' : 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/25'}`}>
                      <AlertTriangle size={15} className={`mt-0.5 shrink-0 ${preflightStatus?.reason === 'failed' ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`} />
                      <div className="min-w-0 flex-1">
                        <p className={`text-[12px] font-semibold ${preflightStatus?.reason === 'failed' ? 'text-rose-800 dark:text-rose-300' : 'text-amber-800 dark:text-amber-300'}`}>
                          {preflightStatus?.reason === 'failed' ? `Operational Pre-flight checked — ${preflightBlockers} blocking issue${preflightBlockers !== 1 ? 's' : ''}` : preflightStatus?.reason === 'expired' ? 'Pre-flight capability report is stale' : preflightStatus?.reason === 'job_changed' ? 'Job changed after Pre-flight' : 'Operational Pre-flight required to enable this schedule'}
                        </p>
                        <p className={`mt-0.5 text-[11px] leading-4 ${preflightStatus?.reason === 'failed' ? 'text-rose-700 dark:text-rose-400' : 'text-amber-700 dark:text-amber-400'}`}>
                          {preflightStatus?.reason === 'failed'
                            ? `The check completed${preflightStatus.completedAt ? ` at ${new Date(preflightStatus.completedAt).toLocaleString()}` : ''}. Review the operational result before enabling the schedule or running now.`
                            : preflightStatus?.reason === 'job_changed'
                              ? 'The saved configuration or operational check changed. Run Pre-flight again.'
                            : preflightStatus?.reason === 'expired'
                                ? 'The previous result is no longer current. Run Pre-flight again before starting the migration.'
                                : 'Check source, target connectivity and server capacity before starting the migration.'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {preflightStatus?.reason === 'failed' && lastPreflightReport && (
                          <button type="button" onClick={() => setPreflight({ jobName: selectedJob.name, loading: false, report: lastPreflightReport, error: null })}
                            className="rounded-md border border-rose-400 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300">
                            View result
                          </button>
                        )}
                        <button type="button" onClick={() => void handlePreflight(selectedJob.id, selectedJob.name)}
                          className={`rounded-md border bg-white px-2.5 py-1.5 text-[11px] font-semibold ${preflightStatus?.reason === 'failed' ? 'border-rose-400 text-rose-700 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300' : 'border-amber-400 text-amber-700 hover:bg-amber-100 dark:bg-amber-950/40 dark:text-amber-300'}`}>
                          Run Pre-flight
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Server scheduler status — only when schedule exists */}
                  {selectedSchedule && (
                    <div className="rounded-md bg-slate-900 dark:bg-slate-950 border border-slate-700 dark:border-slate-800 p-3">
                      <div className="flex items-center gap-2 text-[11px]">
                        <CircleDot size={11} className={schedulerWorker?.running ? 'text-emerald-400' : 'text-amber-400'} />
                        <span className="font-medium uppercase tracking-wider text-slate-300">Server-managed scheduler</span>
                        <span className={`rounded-full px-1.5 py-0.5 font-semibold ${schedulerWorker?.running ? 'bg-emerald-950 text-emerald-300' : 'bg-amber-950 text-amber-300'}`}>
                          {schedulerWorker?.running ? 'active' : 'unavailable'}
                        </span>
                      </div>
                      <p className="mt-1.5 text-[11px] text-slate-400">
                        Runs automatically on the production server. You may close this browser; navigation and remote disconnection do not stop the schedule.
                      </p>
                      <p className="mt-1 text-[10px] text-slate-500">
                        {schedulerWorker?.lastTickAt ? `Last scheduler heartbeat ${relativeTime(schedulerWorker.lastTickAt)}.` : 'Waiting for the first scheduler heartbeat.'}
                        {schedulerWorker?.lastError ? ` Latest issue: ${schedulerWorker.lastError}` : ''}
                      </p>
                    </div>
                  )}
                </div>

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
                      {showStatusFilter && <div className="absolute right-0 top-8 z-20 w-56 rounded-md border border-gray-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                        {['all', 'completed', 'completed_with_issues', 'failed', 'interrupted', 'running', 'paused', 'aborted', 'pending'].map(status => (
                          <button key={status} type="button" onClick={() => { setTableStatusFilter(status); setShowStatusFilter(false); }}
                            className={`block w-full rounded px-2 py-1.5 text-left text-[11px] capitalize ${tableStatusFilter === status ? 'bg-violet-50 text-violet-600 dark:bg-violet-950/40' : 'text-slate-500 hover:bg-gray-50 dark:hover:bg-slate-800'}`}>
                            {status === 'aborted' ? 'stopped' : status === 'completed_with_issues' ? 'completed with issues' : status}
                          </button>
                        ))}
                        {selectedHistoryRun && <>
                          <div className="my-2 border-t border-gray-100 dark:border-slate-800" />
                          <div className="space-y-1 px-1 text-[10px] text-slate-500">
                            {(['completed', 'completed_with_issues', 'failed', 'interrupted', 'running', 'paused', 'aborted', 'pending'] as const).map(status => {
                              const count = selectedHistoryTableStates.filter(t => t.status === status).length;
                              const pct = selectedHistoryTableStates.length ? Math.round(count / selectedHistoryTableStates.length * 100) : 0;
                              return <div key={status} className="flex justify-between capitalize"><span>{status === 'aborted' ? 'stopped' : status === 'completed_with_issues' ? 'completed with issues' : status}</span><span>{pct}% ({count})</span></div>;
                            })}
                          </div>
                          <label className="mt-2 flex cursor-pointer items-center justify-between border-t border-gray-100 px-1 pt-2 text-[11px] text-slate-600 dark:border-slate-800 dark:text-slate-300">
                            <span>Auto-hide completed</span>
                            <input type="checkbox" checked={hideCompletedRunIds.has(selectedHistoryRun.id)}
                              onChange={() => setHideCompletedRunIds(prev => { const next = new Set(prev); next.has(selectedHistoryRun.id) ? next.delete(selectedHistoryRun.id) : next.add(selectedHistoryRun.id); return next; })}
                              className="h-3.5 w-3.5 accent-violet-600" />
                          </label>
                          <div className="mt-2 flex gap-1 border-t border-gray-100 pt-2 dark:border-slate-800">
                            {(selectedHistoryRun.status === 'failed' || selectedHistoryRun.status === 'interrupted' || selectedHistoryRun.status === 'aborted') &&
                              <button type="button" onClick={() => void handleResume(selectedHistoryRun.id)} className="flex-1 rounded border border-violet-300 px-2 py-1 text-[10px] text-violet-600">Resume run</button>}
                            <button type="button" onClick={() => void handleRestart(selectedHistoryRun.id, false)} className="flex-1 rounded border border-amber-300 px-2 py-1 text-[10px] text-amber-600">Restart</button>
                            <button type="button" onClick={() => void handleRestart(selectedHistoryRun.id, true)} className="flex-1 rounded border border-rose-300 px-2 py-1 text-[10px] text-rose-600">Truncate</button>
                          </div>
                        </>}
                      </div>}
                    </div>
                    <span className="text-[11px] text-gray-400 dark:text-slate-500 shrink-0">{selectedRuns.length} recent</span>
                  </div>
                  {selectedRuns.length === 0 ? (
                    <div className="flex items-center justify-center py-10 text-[13px] text-gray-400 dark:text-slate-500 italic">
                      {selectedSchedule ? 'No runs yet — click "Run Now" for an immediate run or wait for the cron schedule.' : 'Click "Run Now" to execute this saved job once without creating a schedule.'}
                    </div>
                  ) : selectedRuns.filter(run => run.id === selectedHistoryRun?.id).map(run => {
                    const totalRows = run.tableStates.reduce((s, ts) => s + ts.rowsMigrated + ts.rowsSkipped, 0);
                    const completedPct = run.tableStates.length ? Math.round(run.tableStates.filter(t => t.status === 'completed' || t.status === 'completed_with_issues').length / run.tableStates.length * 100) : 0;
                    const hideCompleted = hideCompletedRunIds.has(run.id);
                    return (
                      <div key={run.id}>
                        <div
                          className="hidden">
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
                          {(run.status === 'failed' || run.status === 'interrupted' || run.status === 'aborted') && (
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
                          {(run.status === 'failed' || run.status === 'interrupted' || run.status === 'aborted' || run.status === 'completed' || run.status === 'completed_with_issues') && (
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
                                    ['completed', 'Completed', 'text-emerald-500'], ['completed_with_issues', 'Issues', 'text-amber-500'], ['failed', 'Failed', 'text-rose-500'], ['running', 'Running', 'text-violet-500'],
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
                          <div className="px-3 py-2">
                            {run.performance?.actualRowsPerSecond != null && run.performance.elapsedSeconds != null && (
                              <div className={`mb-2 flex items-center justify-between rounded-md border px-2.5 py-1.5 text-[11px] ${run.performance.meetsTarget ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300'}`}>
                                <span className="font-semibold">15-minute target {run.performance.meetsTarget ? 'met' : 'missed'}</span>
                                <span>{run.performance.actualRowsPerSecond.toLocaleString()} rows/s · {fmtDuration(Math.ceil(run.performance.elapsedSeconds))} elapsed · required {Math.ceil(run.performance.requiredRowsPerSecond).toLocaleString()} rows/s</span>
                              </div>
                            )}
                            <div className="w-full min-w-0">
                                <div className="grid grid-cols-[minmax(260px,1.4fr)_minmax(220px,1fr)_110px_130px] items-center gap-3 px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-600">
                                  <span>Source → target</span>
                                  <span>Progress</span>
                                  <span className="text-right">Rows</span>
                                  <span className="text-right">Actions</span>
                                </div>
                                <div className="max-h-[32rem] space-y-1 overflow-y-auto overscroll-contain pr-1">
                            {selectedHistoryTableStates.filter(ts => {
                              const query = tableSearch.trim().toLowerCase();
                              const matchesText = !query || ts.sourceKey.toLowerCase().includes(query) || ts.targetKey.toLowerCase().includes(query);
                              return matchesText && (!hideCompleted || ts.status !== 'completed') && (tableStatusFilter === 'all' || ts.status === tableStatusFilter);
                            }).map(ts => {
                              const processed = Math.max(ts.offset, ts.rowsMigrated + ts.rowsSkipped + ts.rowsErrored);
                              const pct = ts.rowsSource > 0 ? Math.min(100, Math.round(processed / ts.rowsSource * 100)) : (ts.status === 'completed' || ts.status === 'completed_with_issues' ? 100 : 0);
                              const barColor = ts.status === 'completed' ? 'bg-emerald-500' : ts.status === 'completed_with_issues' ? 'bg-amber-500' : ts.status === 'failed' ? 'bg-rose-500' : 'bg-violet-500';
                              const isLogSelected = runLogSelection?.runId === run.id && runLogSelection.tableId === ts.id;
                              return (
                                <div key={ts.id} className="w-full">
                                  <div style={{ contentVisibility: 'auto', containIntrinsicSize: '34px' }} className={`grid w-full grid-cols-[minmax(260px,1.4fr)_minmax(220px,1fr)_110px_130px] items-center gap-3 rounded-md px-2 py-1.5 ${isLogSelected ? 'bg-violet-50 ring-1 ring-violet-200 dark:bg-violet-950/20 dark:ring-violet-900/50' : 'bg-gray-50 dark:bg-slate-900/70'}`}>
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
                                  <span
                                    title={`${ts.rowsMigrated.toLocaleString()} written · ${ts.rowsSkipped.toLocaleString()} skipped · ${ts.rowsErrored.toLocaleString()} errors`}
                                    className={`text-right text-[11px] tabular-nums ${ts.rowsErrored > 0 ? 'text-rose-500' : 'text-slate-500 dark:text-slate-400'}`}>
                                    {(ts.rowsMigrated + ts.rowsSkipped + ts.rowsErrored).toLocaleString()} rows{ts.rowsSkipped > 0 ? ` · ${ts.rowsSkipped.toLocaleString()} skipped` : ''}{ts.rowsErrored > 0 ? ` · ${ts.rowsErrored} errors` : ''}
                                  </span>
                                  <div className="flex items-center justify-end gap-0.5">
                                    {ts.status === 'running' && <Loader2 size={12} className="mr-1 animate-spin text-violet-500" aria-label="Running" />}
                                    {ts.status === 'pending' && <button type="button" title="Run table" onClick={() => void handleTableAction(run.id, ts.id, 'run')} className="rounded p-1 text-emerald-500 hover:bg-emerald-50"><Play size={12} /></button>}
                                    {(ts.status === 'running' || ts.status === 'pending') && <button type="button" title="Pause table" onClick={() => void handleTableAction(run.id, ts.id, 'pause')} className="rounded p-1 text-amber-500 hover:bg-amber-50"><Pause size={12} /></button>}
                                    {(ts.status === 'paused' || ts.status === 'interrupted') && <button type="button" title="Resume table from checkpoint" onClick={() => void handleTableAction(run.id, ts.id, 'resume')} className="rounded p-1 text-violet-500 hover:bg-violet-50"><Play size={12} /></button>}
                                    {!['completed', 'completed_with_issues', 'rolled_back', 'aborted', 'interrupted'].includes(ts.status) && <button type="button" title="Stop table" onClick={() => void handleTableAction(run.id, ts.id, 'stop')} className="rounded p-1 text-rose-500 hover:bg-rose-50"><Square size={11} /></button>}
                                    {['completed', 'completed_with_issues', 'failed', 'aborted'].includes(ts.status) && <button type="button" title={ts.status === 'completed_with_issues' ? 'Restart table to retry unresolved rows' : 'Restart table'} onClick={() => void handleTableAction(run.id, ts.id, 'restart')} className="rounded p-1 text-blue-500 hover:bg-blue-50"><RefreshCw size={12} /></button>}
                                    {tableActionKey?.startsWith(`${run.id}:${ts.id}:`) && <Loader2 size={11} className="animate-spin text-slate-400" />}
                                    <button type="button" onClick={() => void toggleTableRunLog(run.id, ts.id)}
                                      className={`rounded p-1 ${isLogSelected ? 'bg-violet-100 text-violet-600 dark:bg-violet-950/50' : ts.rowsErrored > 0 ? 'text-rose-500 hover:bg-rose-50' : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`} title="View table run log">
                                      <Terminal size={12} />
                                    </button>
                                  </div>
                                  </div>

                                  {isLogSelected && (() => {
                                    const logDetail = tableRunLogs[`${run.id}:${ts.id}`];
                                    const visibleLogs = logDetail?.logs ?? [];
                                    const extraErrors = [
                                      ...(ts.error ? [ts.error] : []),
                                      ...(logDetail?.errors ?? []),
                                    ].filter((error, index, all) => all.indexOf(error) === index && !visibleLogs.some(line => line.includes(error)));
                                    return (
                                      <div className="mt-1 overflow-hidden rounded-md border border-slate-700 bg-slate-950 shadow-inner">
                                        <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
                                          <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                                            <Terminal size={12} />
                                            <span>Run Log</span>
                                            <span className="truncate font-mono font-normal normal-case tracking-normal text-violet-400">— {ts.sourceKey}</span>
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
                              );
                            })}
                                </div>
                            </div>

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
                {!hasCompatibilityWarnings && (
                  <button onClick={() => setPreflight(null)} className="text-gray-400 hover:text-gray-700 dark:hover:text-slate-200 transition-colors">
                    <X size={16} />
                  </button>
                )}
              </div>

              <div className="overflow-y-auto px-5 py-4 space-y-4">
                {preflight.loading ? (
                  <div className="flex items-center justify-center py-12 gap-2 text-[13px] text-gray-400">
                    <Loader2 size={16} className="animate-spin" />Checking connections, rows and server capabilities…
                  </div>
                ) : preflight.error ? (
                  <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-900/40 text-rose-700 dark:text-rose-300">
                    <p className="text-[13px] font-semibold">{preflight.error.message}</p>
                    {preflight.error.detail && (
                      <p className="mt-1 text-[12px] whitespace-pre-wrap break-words text-rose-600 dark:text-rose-400">{preflight.error.detail}</p>
                    )}
                    {(preflight.error.stage || preflight.error.requestId) && (
                      <p className="mt-2 text-[10px] font-mono text-rose-500 dark:text-rose-500">
                        {[preflight.error.stage && `stage=${preflight.error.stage}`, preflight.error.requestId && `diagnostic=${preflight.error.requestId}`].filter(Boolean).join(' · ')}
                      </p>
                    )}
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
                            {warnCount > 0 ? `${warnCount} warning${warnCount !== 1 ? 's' : ''} · ` : ''}review below before Scheduler execution.
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

                      {/* Server and database capability report for IT/developers */}
                      <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 dark:border-blue-900/60 dark:bg-blue-950/20 space-y-3">
                        <div className="flex items-center gap-2">
                          <Info size={13} className="text-blue-500" />
                          <p className="text-[12px] font-semibold text-blue-800 dark:text-blue-300">Transfer capability</p>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { label: 'Auto-selected', value: `${r.capabilities.recommendedBatchRows.toLocaleString()} rows` },
                            { label: 'Concurrent ceiling', value: `${(r.capabilities.concurrencyAdjustedMaxChunkRows ?? r.capabilities.maxSafeBatchRows).toLocaleString()} rows` },
                            { label: 'Single-run ceiling', value: `${(r.capabilities.singleRunMaxChunkRows ?? r.capabilities.maxSafeBatchRows).toLocaleString()} rows` },
                            { label: 'Concurrency assumed', value: `Up to ${r.capabilities.assumedConcurrentRuns ?? 1} runs` },
                            { label: 'Estimated row memory', value: `${Math.max(1, Math.ceil((r.capabilities.estimatedWorkingRowBytes ?? 0) / 1024)).toLocaleString()} KB` },
                            { label: 'Table workers', value: `Up to ${r.capabilities.recommendedConcurrentTables ?? 1}` },
                            { label: 'Current writer', value: r.capabilities.currentWriter === 'copy-staging' ? 'COPY staging' : r.capabilities.currentWriter === 'multi-row' ? 'Multi-row' : 'Row-by-row' },
                          ].map(item => (
                            <div key={item.label} className="rounded border border-blue-100 bg-white/80 px-2 py-1.5 dark:border-blue-900/50 dark:bg-slate-900/60">
                              <p className="text-[9px] uppercase tracking-wide text-blue-500">{item.label}</p>
                              <p className="text-[12px] font-semibold text-slate-700 dark:text-slate-200">{item.value}</p>
                            </div>
                          ))}
                        </div>
                        <div className="grid grid-cols-3 gap-2 text-[10px]">
                          <div className="rounded border border-blue-100 bg-white/70 p-2 dark:border-blue-900/50 dark:bg-slate-900/50">
                            <p className="font-semibold text-slate-600 dark:text-slate-300">Application server</p>
                            <p className="text-slate-500">{r.capabilities.runtime.cpuCores} CPU · {r.capabilities.runtime.freeMemoryMb.toLocaleString()} MB free</p>
                            <p className="truncate text-slate-400" title={r.capabilities.runtime.platform}>{r.capabilities.runtime.platform}</p>
                          </div>
                          {([['Source', r.capabilities.source], ['Target', r.capabilities.target]] as const).map(([label, capability]) => (
                            <div key={label} className="rounded border border-blue-100 bg-white/70 p-2 dark:border-blue-900/50 dark:bg-slate-900/50">
                              <p className="font-semibold text-slate-600 dark:text-slate-300">{label} · {capability.type}</p>
                              <p className="text-slate-500">Latency: {capability.latencyMs == null ? '—' : `${capability.latencyMs} ms`}</p>
                              <p className="truncate text-slate-400" title={capability.version ?? ''}>{capability.version ?? 'Version unavailable'}</p>
                            </div>
                          ))}
                        </div>
                        {r.performanceTarget && (
                          <div className={`rounded border px-2 py-1.5 text-[10px] ${r.performanceTarget.status === 'expected' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/20 dark:text-emerald-300' : 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-400'}`}>
                            <p className="font-semibold">15-minute target: {r.performanceTarget.status === 'expected' ? 'expected under the planning envelope' : 'at risk'}</p>
                            <p className="mt-1">{r.totalRows.toLocaleString()} rows require {Math.ceil(r.performanceTarget.requiredRowsPerSecond).toLocaleString()} rows/s. Baseline: {r.performanceTarget.planningRowsPerSecond.toLocaleString()} rows/s · projected {fmtDuration(r.performanceTarget.projectedSeconds)}.</p>
                            <p className="mt-1">{r.capabilities.currentWriter === 'copy-staging' ? 'COPY staging + conflict-safe merge' : r.capabilities.currentWriter} · up to {r.capabilities.recommendedConcurrentTables ?? 1} dependency-safe table workers.</p>
                            {r.performanceTarget.reasons.map((reason, index) => <p key={index} className="mt-1">• {reason}</p>)}
                          </div>
                        )}
                        {(r.capabilities.chunkRecommendationReasons ?? []).length > 0 && (
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-blue-600">Why this chunk</p>
                            {r.capabilities.chunkRecommendationReasons.map((item, index) => <p key={index} className="text-[10px] text-blue-700 dark:text-blue-300">• {item}</p>)}
                          </div>
                        )}
                        {r.ok && (
                          <div className="rounded border border-blue-200 bg-white/80 p-2 dark:border-blue-900/50 dark:bg-slate-900/60">
                            <div className="flex items-end gap-2">
                              <div className="flex-1 space-y-1">
                                <label className="text-[10px] font-semibold uppercase tracking-wide text-blue-600">Next Run Now chunk</label>
                                <select value={runChunkMode} onChange={event => setRunChunkMode(event.target.value as 'auto' | 'fixed')}
                                  className="w-full rounded border border-blue-200 bg-white px-2 py-1.5 text-[11px] text-slate-700 dark:border-blue-900 dark:bg-slate-900 dark:text-slate-200">
                                  <option value="auto">Auto · {r.capabilities.recommendedBatchRows.toLocaleString()} rows</option>
                                  <option value="fixed">Manual override</option>
                                </select>
                              </div>
                              {runChunkMode === 'fixed' && (
                                <div className="w-36 space-y-1">
                                  <label className="text-[10px] font-semibold uppercase tracking-wide text-blue-600">Rows</label>
                                  <input type="number" min={100} max={r.capabilities.singleRunMaxChunkRows ?? MAX_CHUNK_ROWS}
                                    value={runChunkRows}
                                    onChange={event => setRunChunkRows(Math.max(100, Math.min(r.capabilities.singleRunMaxChunkRows ?? MAX_CHUNK_ROWS, Number(event.target.value) || 100)))}
                                    className="w-full rounded border border-blue-200 bg-white px-2 py-1.5 text-[11px] text-slate-700 dark:border-blue-900 dark:bg-slate-900 dark:text-slate-200" />
                                </div>
                              )}
                            </div>
                            <p className="mt-1 text-[10px] text-slate-400">Applies only to the next Run Now. Manual may exceed the concurrent ceiling up to the single-run ceiling and can increase resource contention. Configure recurring runs separately in Add/Edit Schedule.</p>
                          </div>
                        )}
                        {r.capabilities.limitingFactors.length > 0 && (
                          <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-600">Limiting factors</p>
                            {r.capabilities.limitingFactors.map((item, index) => <p key={index} className="text-[10px] text-amber-700 dark:text-amber-400">• {item}</p>)}
                          </div>
                        )}
                        <details className="text-[10px] text-slate-500 dark:text-slate-400">
                          <summary className="cursor-pointer font-semibold text-blue-600 dark:text-blue-400">Server configuration and IT recommendations</summary>
                          <div className="mt-2 grid grid-cols-2 gap-3">
                            {([['Source', r.capabilities.source], ['Target', r.capabilities.target]] as const).map(([label, capability]) => (
                              <div key={label}>
                                <p className="mb-1 font-semibold text-slate-600 dark:text-slate-300">{label} configuration</p>
                                {Object.entries(capability.settings).length === 0 && <p className="italic text-slate-400">Settings unavailable</p>}
                                {Object.entries(capability.settings).map(([name, value]) => (
                                  <div key={name} className="flex justify-between gap-2 border-b border-blue-100/70 py-0.5 dark:border-blue-900/30">
                                    <code>{name}</code><span className="font-mono text-slate-700 dark:text-slate-300">{value}</span>
                                  </div>
                                ))}
                              </div>
                            ))}
                          </div>
                          <div className="mt-2 space-y-0.5">
                            {r.capabilities.recommendations.map((item, index) => <p key={index}>• {item}</p>)}
                            {r.capabilities.limitations.map((item, index) => <p key={`limit-${index}`} className="italic text-slate-400">• {item}</p>)}
                          </div>
                        </details>
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
                        Duration remains a conservative estimate until write benchmarking and the batched writer are enabled.
                      </p>
                    </>
                  );
                })() : null}
              </div>

              <div className="px-5 py-3 border-t border-gray-100 dark:border-slate-800 flex justify-end gap-2">
                {!preflight.loading && (preflight.error || (preflight.report && !preflight.report.ok)) && selectedJob && (
                  <button onClick={() => void handlePreflight(selectedJob.id, selectedJob.name)}
                    className="px-3 py-1.5 rounded border border-violet-300 text-violet-700 text-[13px] font-medium hover:bg-violet-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-950/30">
                    Run Pre-flight again
                  </button>
                )}
                {hasCompatibilityWarnings && selectedJob && (
                  <button onClick={() => { setPreflight(null); void router.push(`/migration?job=${encodeURIComponent(selectedJob.id)}`); }}
                    className="px-3 py-1.5 rounded border border-emerald-300 text-emerald-700 text-[13px] font-medium hover:bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:hover:bg-emerald-950/30">
                    Apply in Migration
                  </button>
                )}
                <button onClick={() => setPreflight(null)}
                  className="px-3 py-1.5 rounded bg-violet-600 text-white text-[13px] font-medium hover:bg-violet-700 transition-colors">
                  {hasCompatibilityWarnings ? 'Ignore for now' : 'Close'}
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
                  {jobs.filter(j => j.scheduleReady || j.id === formJobId).map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
                </select>
              </div>

              {/* Cron preset */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-gray-600 dark:text-slate-400">Run pattern</label>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" onClick={() => setFormScheduleMode('once')} className={`rounded border px-3 py-2 text-[12px] font-medium ${formScheduleMode === 'once' ? 'border-violet-400 bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300' : 'border-gray-200 text-gray-500 dark:border-slate-700 dark:text-slate-400'}`}>Run once</button>
                  <button type="button" onClick={() => setFormScheduleMode('recurring')} className={`rounded border px-3 py-2 text-[12px] font-medium ${formScheduleMode === 'recurring' ? 'border-violet-400 bg-violet-50 text-violet-700 dark:bg-violet-950/30 dark:text-violet-300' : 'border-gray-200 text-gray-500 dark:border-slate-700 dark:text-slate-400'}`}>Recurring</button>
                </div>
              </div>

              {formScheduleMode === 'once' ? (
                <div className="space-y-1">
                  <label className="text-[12px] font-medium text-gray-600 dark:text-slate-400">Run date &amp; time</label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-1">
                      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400"><Calendar size={10} />Date</span>
                      <span className="relative block">
                        <input ref={runDateInputRef} type="date" value={formRunDate} min={localDateTimeParts(new Date()).date} onChange={event => setFormRunDate(event.target.value)}
                          className="w-full rounded border border-gray-200 bg-white px-2.5 py-1.5 pr-8 text-[13px] text-gray-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" />
                        <button type="button" aria-label="Open date picker" onClick={() => { try { runDateInputRef.current?.showPicker(); } catch { runDateInputRef.current?.focus(); } }}
                          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-gray-100 hover:text-violet-500 dark:hover:bg-slate-700"><Calendar size={13} /></button>
                      </span>
                    </label>
                    <label className="space-y-1">
                      <span className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400"><Clock size={10} />Time</span>
                      <span className="relative block">
                        <input ref={runTimeInputRef} type="time" value={formRunTime} step={60} onChange={event => setFormRunTime(event.target.value)}
                          className="w-full rounded border border-gray-200 bg-white px-2.5 py-1.5 pr-8 text-[13px] text-gray-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" />
                        <button type="button" aria-label="Open time picker" onClick={() => { try { runTimeInputRef.current?.showPicker(); } catch { runTimeInputRef.current?.focus(); } }}
                          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-gray-100 hover:text-violet-500 dark:hover:bg-slate-700"><Clock size={13} /></button>
                      </span>
                    </label>
                  </div>
                  {formRunAt && !formRunOnceValid && <p className="text-[11px] font-medium text-rose-500">Choose a future date and time.</p>}
                  <p className="text-[11px] text-gray-400 dark:text-slate-500">The production server starts it once at this instant, then auto-disables the schedule. If the server restarts, an overdue run is recovered automatically.</p>
                </div>
              ) : <>
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
              </>}

              {/* Cron expression */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-gray-600 dark:text-slate-400">{formScheduleMode === 'once' ? 'Generated cron trigger' : 'Cron Expression'}</label>
                <input
                  value={formScheduleMode === 'once' ? generatedOnceCron : formCron}
                  readOnly={formScheduleMode === 'once'}
                  onChange={e => { setFormCron(e.target.value); setFormPreset('__custom__'); }}
                  placeholder="* * * * *"
                  className="w-full px-2.5 py-1.5 rounded border border-gray-200 dark:border-slate-700 bg-white read-only:bg-gray-50 dark:bg-slate-800 dark:read-only:bg-slate-900 text-[13px] font-mono text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-400" />
                <p className="text-[11px] text-gray-400 dark:text-slate-500 font-mono">
                  {formScheduleMode === 'once'
                    ? formRunOnceValid ? `One-shot trigger · ${formRunDate} ${formRunTime}` : 'Select a future date and time'
                    : formCron.trim().split(/\s+/).length === 5 ? describeCron(formCron.trim()) : 'min hour dom month dow'}
                </p>
              </div>

              {/* Schedule timezone */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-gray-600 dark:text-slate-400">Schedule timezone</label>
                <input
                  value={formTimezone}
                  onChange={event => setFormTimezone(event.target.value)}
                  placeholder="Asia/Kuala_Lumpur"
                  className="w-full rounded border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 focus:outline-none focus:ring-1 focus:ring-violet-400 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" />
                <p className="text-[11px] text-gray-400 dark:text-slate-500">IANA timezone used by recurring cron, for example Asia/Kuala_Lumpur. Run-once uses the exact selected instant.</p>
              </div>

              {/* Chunk policy */}
              <div className="space-y-1">
                <label className="text-[12px] font-medium text-gray-600 dark:text-slate-400">Scheduled run chunk</label>
                <div className="grid grid-cols-2 gap-2">
                  <select value={formChunkMode} onChange={event => setFormChunkMode(event.target.value as 'auto' | 'fixed')}
                    className="w-full rounded border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    <option value="auto">Auto · {autoChunkRows.toLocaleString()}</option>
                    <option value="fixed">Manual override</option>
                  </select>
                  <input type="number" min={100} max={manualChunkCeiling} disabled={formChunkMode === 'auto'} value={formChunkMode === 'auto' ? autoChunkRows : formChunkRows}
                    onChange={event => setFormChunkRows(Math.max(100, Math.min(manualChunkCeiling, Number(event.target.value) || 100)))}
                    className="w-full rounded border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] text-gray-800 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200" />
                </div>
                <p className="text-[11px] text-gray-400 dark:text-slate-500">Auto stays within the current concurrent ceiling of {effectiveChunkCeiling.toLocaleString()} rows. Manual may override it up to the single-run ceiling of {manualChunkCeiling.toLocaleString()} rows and can increase resource contention.</p>
              </div>

              {/* Notify email */}
              <div className="space-y-1">
                <label className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600 dark:text-slate-400">
                  <Mail size={12} />Notify on completion <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <input
                  type="text"
                  value={formNotifyEmail}
                  onChange={e => setFormNotifyEmail(e.target.value)}
                  placeholder="ops@example.com, owner@example.com"
                  aria-invalid={formRecipients.invalid.length > 0 || formRecipients.tooMany}
                  className={`w-full px-2.5 py-1.5 rounded border bg-white dark:bg-slate-800 text-[13px] text-gray-800 dark:text-slate-200 focus:outline-none focus:ring-1 ${formRecipients.invalid.length || formRecipients.tooMany ? 'border-rose-400 focus:ring-rose-400' : 'border-gray-200 dark:border-slate-700 focus:ring-violet-400'}`} />
                {formRecipients.invalid.length > 0 && <p className="text-[11px] font-medium text-rose-500">Invalid: {formRecipients.invalid.join(', ')}</p>}
                {formRecipients.tooMany && <p className="text-[11px] font-medium text-rose-500">Maximum {MAX_NOTIFICATION_RECIPIENTS} recipients.</p>}
                <p className="text-[11px] text-gray-400 dark:text-slate-500">
                  Separate multiple recipients with commas. Emails a run summary when this job finishes or fails. Requires email config in Settings.
                </p>
              </div>

              {/* Buttons */}
              <div className="flex gap-2 pt-1">
                <button onClick={() => setShowForm(false)}
                  className="flex-1 px-3 py-1.5 rounded border border-gray-200 dark:border-slate-700 text-[13px] text-gray-600 dark:text-slate-400 hover:bg-gray-50 dark:hover:bg-slate-800 transition-colors">
                  Cancel
                </button>
                <button
                  disabled={formSaving || !formJobId || (formScheduleMode === 'recurring' ? !formCron.trim() : !formRunOnceValid)}
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
