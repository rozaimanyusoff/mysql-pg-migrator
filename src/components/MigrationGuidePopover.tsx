import { useState, useRef, useEffect } from 'react';
import { Network, X } from 'lucide-react';

const MIGRATION_GUIDE_SECTIONS = [
  {
    title: 'Overview',
    icon: '①',
    color: 'text-blue-600 dark:text-blue-400',
    body: [
      'This module maps and migrates tables between any two databases (MySQL → PostgreSQL or reverse). It auto-creates the target database, schema, and table if they do not exist.',
      'Serial/auto-increment primary keys are converted to deterministic UUIDs. The original integer is preserved in a separate BIGINT column (e.g. old_id) so parent-table FK references stay intact.',
      'Migration runs in chunks of 1,000 rows. Each run can be rolled back by deleting inserted PKs, or by TRUNCATE if more than 5,000 rows were inserted.',
    ],
  },
  {
    title: 'Connect source & target',
    icon: '②',
    color: 'text-violet-600 dark:text-violet-400',
    body: [
      'Pick a saved connection for Source (MySQL) and Target (PostgreSQL). Passwords are resolved from the stored connection record.',
      'Select the source database from the dropdown — only tables belonging to that database are listed.',
      'For the target, select an existing database or click "+ New DB" to create one on the fly. Click "+ New Schema" to type a custom schema name — the runner runs CREATE SCHEMA IF NOT EXISTS automatically.',
      'The target table list refreshes automatically after a completed migration run.',
    ],
  },
  {
    title: 'Select tables',
    icon: '③',
    color: 'text-amber-600 dark:text-amber-400',
    body: [
      'Check the tables you want to migrate. Clicking a table row opens the column mapping panel.',
      'After a completed run, migrated tables show a strikethrough name and a green ✓ badge — but only when the job is saved. Unsaved jobs never show strikethrough.',
      'The strikethrough resets when you load a different saved job.',
    ],
  },
  {
    title: 'Column mapping',
    icon: '④',
    color: 'text-teal-600 dark:text-teal-400',
    body: [
      'Src Col → Tgt Col — map each source column to the corresponding target column. Set to "— none —" to exclude a column from the INSERT.',
      'Tgt Type — auto-inferred from the source type; editable. UUID is set automatically for serial_to_uuid columns.',
      'Conv — transformation applied per-value: keep (copy as-is), →UUID (serial int → UUID v4), →TEXT/INT/BIGINT/NUMERIC/BOOL/TIMESTAMPTZ/DATE/JSONB.',
      'Keep Orig — only for →UUID columns. Auto-set to old_<colname> on load. Stores the original MySQL integer in a separate BIGINT column alongside the UUID. Clear with ✕ to disable.',
      'FK Ref — if this is a FK column pointing to a UUID-converted PK in another table, enter the source schema.table (e.g. public.users). The migrator derives the same deterministic UUID for the FK value.',
      'Include checkbox — uncheck to exclude a column entirely from the migration.',
    ],
  },
  {
    title: 'UUID conversion',
    icon: '⑤',
    color: 'text-pink-600 dark:text-pink-400',
    body: [
      'serial_to_uuid converts MySQL INT/BIGINT PKs to UUID v4 using SHA-256(schema.table + "\\0" + id). The same integer always produces the same UUID across runs.',
      'The old_<colname> BIGINT column is created in the target table alongside the UUID PK. Other tables can FK via this column if they have not been migrated yet.',
      'For child tables: set fkRef = "source_schema.parent_table" on the FK column. The migrator applies the same seqToUUID() function, so the FK resolves to the correct UUID without a pre-pass.',
    ],
  },
  {
    title: 'Jobs',
    icon: '⑥',
    color: 'text-green-600 dark:text-green-400',
    body: [
      'Save Job — saves the current source/target connection meta and full column mapping config. Unsaved changes are tracked with an "unsaved changes" badge in the header.',
      'Save as existing — in the Save dialog, pick any saved job from the list to overwrite it with the current table mappings. The button label changes to "Update Job". Use this to consolidate multiple migration sessions under one job for export.',
      'Load — restores the full column mapping from a saved job, including source/target connection, schema, and per-column conversions.',
      'Export MD — downloads the current job mapping as a Markdown document (table list, column mapping, source/target meta).',
    ],
  },
  {
    title: 'Run & rollback',
    icon: '⑦',
    color: 'text-rose-600 dark:text-rose-400',
    body: [
      'Click Run All to start. The run console appears at the bottom showing per-table progress, row counts, and logs.',
      'The runner processes tables sequentially in chunks of 1,000 rows. INSERT ON CONFLICT DO NOTHING prevents duplicate row errors on re-runs.',
      'Rollback — deletes inserted rows by their PK list (tracked up to 5,000 rows). If more than 5,000 rows were inserted, rollback falls back to TRUNCATE CASCADE. The rollback SQL is included in the Export MD report.',
      'After a completed run the target table list refreshes automatically and migrated source tables are marked with strikethrough.',
    ],
  },
  {
    title: 'Incremental sync & zero-downtime cutover',
    icon: '⑧',
    color: 'text-cyan-600 dark:text-cyan-400',
    body: [
      'Incremental sync lets you keep the target in sync with the source while your app is still running on the old DB — so the final cutover window is seconds, not hours.',
      'Enable it per-table: click the ⟳ Full toggle on any table row to switch to ⟳ Incremental. Pick a tracking column (e.g. id or updated_at) so the app can identify new data, then choose "by ID" for append-only tables or "by Timestamp" for tables that can be updated.',
      'Phase 1 — Full migration: run a normal full migration to copy all existing rows to the target. Save the job once done.',
      'Phase 2 — Update syncs: with Incremental mode on, each later run only fetches data added or changed after the last successful sync. The saved sync position updates automatically after every run.',
      'Phase 3 — Cutover: stop writes to the source (put app in maintenance mode or pause writes), run one final incremental sync to capture the last few rows, verify row counts match, then switch the app connection to PostgreSQL.',
      'Clear the last synced position — click the ✕ next to the saved value to sync all rows again on the next run. Use this if older rows were changed and may have been missed.',
      'Strategy choice — use "by ID" when rows are only ever inserted (never updated). Use "by Timestamp" when rows can be updated after insert; this will UPSERT on conflict using the target PK.',
    ],
  },
  {
    title: 'CLI script — large migrations (1000+ tables)',
    icon: '⑨',
    color: 'text-amber-600 dark:text-amber-400',
    body: [
      'For databases with hundreds or thousands of tables, the web runner can be resource-constrained (browser polling, server memory, long-lived HTTP). The CLI script runs the same migration logic directly on any machine — no browser, no server process needed.',
      'Export — save the job first, then click the terminal (⌨) icon in the Jobs panel. A standalone Python 3 script is downloaded as migrate_<jobname>.py. The script embeds all connection config and column mappings from the saved job.',
      'Install dependencies (once): pip install psycopg2-binary mysql-connector-python',
      'Run — supply passwords via env vars to avoid interactive prompts: SRC_PASSWORD=... TGT_PASSWORD=... python3 migrate_myjob.py',
      '--batch START-END — process only a slice of tables (1-based). Split a 1000-table job into manageable runs: --batch 1-100, then --batch 101-200, etc. Each batch runs independently and can be parallelised across machines.',
      '--chunk-size N — rows processed per cycle. Default is 1,000 (same as the web runner). Use the Pre-flight capability report before selecting a larger value.',
      '--dry-run — counts source rows and applies all transforms but writes nothing to the target. Use to verify connectivity and estimate run time before committing.',
      '--reset — ignores the saved state file and restarts all tables from offset 0.',
      'Resume — after every chunk, progress is written to <jobId>_state.json. If the script is interrupted, re-running it skips completed tables and resumes from the last saved offset. Keep this file alongside the script.',
      'Passwords — never stored in the script. Supply via SRC_PASSWORD / TGT_PASSWORD environment variables, or the script will prompt interactively. For scheduled/automated runs, inject via your CI/CD secrets or a .env file sourced before execution.',
    ],
  },
] as const;

export default function MigrationGuidePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouse = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as globalThis.Node)) setOpen(false); };
    const onKey   = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onMouse);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onMouse); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[13px] font-medium transition-colors
          ${open
            ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-600 dark:bg-blue-950/40 dark:text-blue-300'
            : 'border-gray-200 dark:border-slate-700 text-gray-500 dark:text-slate-400 hover:border-blue-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50/60 dark:hover:bg-blue-950/20'}`}
      >
        <span className="font-bold">?</span> Guide
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 z-[9999] w-[440px] bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-slate-800 bg-gray-50 dark:bg-slate-800/50">
            <div className="flex items-center gap-2">
              <Network size={15} className="text-blue-500" />
              <p className="text-base font-semibold text-gray-800 dark:text-slate-100">Migration — Guide</p>
            </div>
            <button onClick={() => setOpen(false)} className="p-0.5 rounded text-gray-400 hover:text-gray-600 dark:hover:text-slate-200">
              <X size={15} />
            </button>
          </div>
          <div className="overflow-y-auto max-h-[70vh] divide-y divide-gray-100 dark:divide-slate-800">
            {MIGRATION_GUIDE_SECTIONS.map(sec => (
              <div key={sec.title} className="px-4 py-3.5 space-y-2">
                <p className={`text-[13px] font-bold uppercase tracking-wider flex items-center gap-1.5 ${sec.color}`}>
                  <span>{sec.icon}</span> {sec.title}
                </p>
                <ul className="space-y-1.5">
                  {sec.body.map((line, i) => (
                    <li key={i} className="flex gap-2 text-sm text-gray-600 dark:text-slate-300 leading-relaxed">
                      <span className="text-gray-300 dark:text-slate-600 shrink-0 mt-0.5">–</span>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
