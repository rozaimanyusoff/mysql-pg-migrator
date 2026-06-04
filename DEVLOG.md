# DEVLOG — DB Maintenance Tools

---

## 2026-06-05
- **fix** — Export-Import: SQL export auto-downloads + Jobs panel restyled
  - Bug: SQL export set `exportResult` state and saved history but never triggered file download; user had to click Download manually in the preview panel; fix: immediately create Blob + anchor click after receiving SQL data — same pattern as CSV export
  - Jobs panel: restyled `SavedJobsPanel` history cards to match migration/schema studio style — status badge + format badge + time in row 1, connection label as primary text, database in monospace row 3, meta pills (tables count, include mode, WHERE clause, conflict) in row 4; card border matches status color; delete button right-aligned in row 1
  - Affects: `src/pages/export-import.tsx` → `handleExport`, `SavedJobsPanel`
  - Status: done
- **improve** — Export-Import: Saved Jobs panel matches migration/schema studio layout
  - Replaced left-notch + right-content pattern with header-toggle pattern (same as migration `w-9`/`w-60` transition, toggle arrow in header row)
  - Extracted `HistoryCard` component with migration-style 4-row structure: name + status badge, DB path, count + date + expand toggle, actions row (delete)
  - Expand reveals detail panel: format, include mode, conflict mode, WHERE clause
  - Added `ChevronUp`, `ChevronDown`, `Save` to lucide imports
  - Affects: `src/pages/export-import.tsx` → `SavedJobsPanel`, new `HistoryCard`
  - Status: done

## 2026-06-04
- **fix** — Schema Studio: export dropdown still clipped by overflow ancestors
  - Root cause: CSS `overflow: hidden/auto` clips absolutely-positioned children regardless of z-index — previous `relative z-10` fix only addressed stacking context, not the clipping
  - Fix: extracted `ExportDropdown` component using React `createPortal` to mount the dropdown on `document.body`; position computed via `getBoundingClientRect()` → `position: fixed`; dropdown now fully escapes all `overflow-hidden` / `overflow-auto` ancestors
  - Click-outside handler added via `useEffect` + `mousedown` on `document` with `data-export-portal` attribute guard
  - Affects: `src/pages/schema-studio.tsx` → new `ExportDropdown` component, `JobGroupCard`
  - Status: done
- **improve** — Schema Studio export: JSON export + Drizzle pgSchema fix + ALTER job hint
  - `src/lib/orm-generator.ts` — `generateDrizzle`: non-public schemas now emit `pgSchema('name')` declaration and use `schemaVar.table(...)` syntax instead of bare `pgTable`; adds `pgSchema` to imports automatically
  - `src/pages/schema-studio.tsx` — added `generateJsonSchema()` function: exports structured JSON (`job`, `generated`, `tables[]` with columns, types, FK references) suitable for AI consumption
  - Jobs Export dropdown: added JSON option (amber badge, always shown for DDL jobs); ORM exports (drizzle/prisma/typeorm) now grouped below a divider; for ALTER/refactor jobs, ORM options replaced with "Load into designer for ORM export" hint instead of silently hidden
  - DDL Preview panel toolbar: added JSON button (amber, between ORM buttons and download icon)
  - Status: done
- **fix** — Schema Studio: job status stays `pending` after ALTER apply
  - Root cause: `applyAlterDDL` executed ALTER SQL against live DB but never wrote a new run record — job status was never updated from `pending`
  - Fix: after `applyAlterDDL` completes, POST a new run record to `/api/schema-generator/jobs` with `status: 'success'`/`'failed'` matching execution log, then call `loadJobs()` to refresh sidebar
  - Affects: `src/pages/schema-studio.tsx` → `applyAlterDDL`
  - Status: done
- **implement** — Schema Studio: job sync/verify against live DB
  - Added Verify button (RefreshCw icon) on each `JobGroupCard` — visible only when job has `connection_label` + `target_database`
  - On click: queries `/api/schema-explorer/tables` using the saved connection; compares expected tables (parsed from `schema_sql`) against actual tables in live DB
  - DDL jobs: parses `CREATE TABLE` statements for expected tables; ALTER jobs: extracts schema.table pairs from `ALTER TABLE` statements
  - Inline result row below action buttons: green `N tables verified in DB`, amber `M/N found — X missing`, red `Connection failed`
  - `connections` prop added to `JobGroupCard`; passed at all sidebar render sites; not passed in `ExecutePanel` so verify is hidden there
  - Affects: `src/pages/schema-studio.tsx` → `JobGroupCard`, `SyncResult` type
  - Status: done
- **improve** — Schema Studio: deep verification (columns, FK, constraints) + auto-update status on pass
  - Previous verify only checked table existence; now performs full deep scan: columns present, type match (normalized: bigserial→int8, timestamptz, varchar/character varying, etc.), nullable match, FK constraints present in DB
  - `TableSyncIssue` type added; `SyncResult` extended with `issues: TableSyncIssue[]`; `normalizeColType()` helper maps designer/PG types to canonical form
  - On full pass (all tables, columns, FK match) → calls `onVerifyPass(jobName)` callback; parent `handleVerifyPass` creates a new run record with `status: 'success'` and log entry → job badge changes from `pending` to `success` automatically
  - UI: summary line stays for quick reading; click to expand detailed issue panel showing per-table problem list (missing columns, type mismatches, missing FK constraints)
  - `onVerifyPass` prop passed at both sidebar render sites
  - Affects: `src/pages/schema-studio.tsx` → `JobGroupCard`, `handleVerifyPass`, `normalizeColType`
  - Status: done
- **fix** — Schema Studio: column types become BIGSERIAL on job load
  - Root cause A: `handleLoadJob` called `setRefactorConnId` even for DDL jobs → triggered `loadRefactorSchema` which overwrote correctly-parsed DDL tables with live-DB data
  - Root cause B: `loadRefactorSchema` mapped PG udt_names (int8, int4, int2, bool, bpchar) that are NOT in `PG_TYPES` → `<select>` showed first option (BIGSERIAL) for all unrecognised types
  - Fix A: `handleLoadJob` now only sets `refactorConnId` (triggering live-DB load) for ALTER jobs; DDL jobs use parsed tables only
  - Fix B: `loadRefactorSchema` adds explicit replacements: `INT8→BIGINT`, `INT4→INTEGER`, `INT2→SMALLINT`, `BOOL→BOOLEAN`, `BPCHAR→CHAR`, `FLOAT4→REAL`
  - Affects: `src/pages/schema-studio.tsx` → `handleLoadJob`, `loadRefactorSchema`
  - Status: done
- **implement** — Schema Studio: "Save to existing job" picker in SaveJobModal
  - `SaveJobModal` now accepts `existingNames?: string[]` prop — shows clickable job name chips above the input
  - Current loaded job shown first (highlighted if selected); other existing job names shown as secondary chips
  - Button label changes: "Save Revision" when saving to an existing name, "Save New" for a new job name
  - Parent passes `[...new Set(jobs.map(j => j.job_name))]` to the modal
  - Affects: `src/pages/schema-studio.tsx` → `SaveJobModal`
  - Status: done
- **implement** — Schema Studio: pre-load migrated schema from migration module
  - `migration.tsx` → `handleOpenInSchemaStudio`: adds `migJobId=${jobId}` to the `/schema-studio` navigation URL alongside existing `connId`, `database`, `schema` params
  - `schema-studio.tsx` → `urlParamsApplied` useEffect: detects `migJobId` query param; fetches DDL from `/api/migv2/jobs/export-sql?id=...` as text; parses with `parseSqlToTables`; sets tables in design mode (NOT refactor mode — avoids overwriting with live DB data)
  - Shows dismissable violet notice banner: "N tables loaded from migration job — review, then Save Job."
  - Existing `connId`+`database`-only path unchanged (opens in refactor mode as before)
  - Affects: `src/pages/migration.tsx` → `handleOpenInSchemaStudio`, `src/pages/schema-studio.tsx` → URL params effect, `migNotice` state
  - Status: superseded — see revision below
- **revision** — Schema Studio: migration link opens in live-DB refactor mode (not static DDL)
  - Previous approach (load DDL from export-sql into designer as static tables) was wrong — tables/rows already migrated to target DB; Schema Studio should connect live, not load from localStorage-like snapshot
  - Removed `migJobId` DDL loading block; reverted URL params effect to standard refactor mode flow: `connId` + `database` + `schema` → `loadRefactorSchema` pulls actual live DB state
  - `migJobId` retained in URL only for the notice banner (fetches migration job name via `/api/migv2/jobs/${migJobId}` and shows "Schema Studio linked to target DB from migration job X")
  - Dirty tracking, suggestions, ALTER flow all work correctly since we're in proper refactor mode
  - Affects: `src/pages/schema-studio.tsx` → `urlParamsApplied` useEffect
  - Status: done
- **fix** — Schema Studio: export dropdown hidden behind middle panel + Jobs as default tab
  - Dropdown fix: right panel wrapper had no stacking context — absolute dropdown inside it rendered behind the middle panel's painting layer; added `relative z-10` to right panel wrapper so its stacking context sits above the middle panel
  - Default tab: `setRightPanelTab('suggest')` in URL params effect was overriding the `'jobs'` default on every migration navigation; removed the override — Jobs tab is now always the default active tab
  - Status: done
- **fix** — Schema Studio: `parseSqlToTables` captures only first character of column type
  - Root cause: `parseOneCol` regex `/([\w ]+?)/` uses lazy quantifier — captures minimum chars, always returning a single character ("U" for UUID, "V" for VARCHAR, "T" for TEXT)
  - Type single-char is not in `PG_TYPES` → `<select>` shows first option = BIGSERIAL for all columns
  - Fix: replace lazy pattern with greedy pattern using negative lookahead to stop before SQL constraint keywords (`NOT`, `NULL`, `DEFAULT`, `PRIMARY`, `UNIQUE`, `REFERENCES`, `CHECK`, `AUTO_INCREMENT`)
  - New regex: `/([\w]+(?:\s+(?!NOT\b|NULL\b|DEFAULT\b|...)[\w]+)*)(?:\s*\(([^)]+)\))?/` — correctly captures `UUID`, `VARCHAR(255)`, `TIMESTAMP WITH TIME ZONE`, `CHARACTER VARYING` etc.
  - Affects all load paths: saved DDL jobs, migration schema import, SQL paste import
  - Affects: `src/pages/schema-studio.tsx` → `parseOneCol`
  - Status: done
- **fix** — Schema Studio: migration-loaded schema — no suggestions + no dirty tracking
  - Issue 1 (no suggestions): `migJobId` load stayed in design mode without setting `refactorConnId`/`refactorDatabase`/`refactorSchema` → Suggest tab not rendered; fix: after loading tables, set `pendingRefactorDb`, `refactorConnId`, `refactorSchema` from URL params, switch to `'refactor'` mode + `'suggest'` tab. Crucially `pendingAutoLoad` is NOT set → `loadRefactorSchema` is not triggered → parsed tables not overwritten
  - Issue 2 (no dirty tracking): `loadedJob` was `null` after migration load → dirty useEffect always returned `isDirty = false`; fix: set a synthetic `loadedJob` with `schema_sql = generateDDL(parsed)` as baseline — dirty tracking now compares current DDL vs migration baseline correctly
  - Affects: `src/pages/schema-studio.tsx` → `migJobId` URL params handler
  - Status: done

## 2026-06-03
- **implement** — Schema Studio ERD: canvas control panel + orientation + hide refs + hide nodes
  - `src/pages/schema-studio.tsx` — `computeDesignerErdLayout`: added `orientation: 'LR' | 'TB'` param; TB mode stacks levels along Y axis with nodes arranged horizontally per level
  - `DesignerErdTableNode`: handle positions now dynamic (`Position.Left/Right` for LR, `Position.Top/Bottom` for TB); added hide button (×) in node title bar — appears on hover, calls `data.onHide()`
  - `ErdPreviewInner`: state added (`orientation`, `showEdges`, `hiddenNodes`); nodes rebuilt with `orientation` + `onHide` callback on each orientation change; `visibleNodes` and `visibleEdges` derived with `useMemo` filtering hidden nodes and optionally empty edges; header simplified to title + count only; controls moved to `<Panel position="top-right">`: LR/TB toggle, Hide/Show refs button, "Show hidden (N)" restore button, Back button
  - Added `Panel` to `@xyflow/react` imports
  - Status: done
- **revision** — Schema Studio: `TableTreePanel` — remove collapsible schema groups
  - `src/pages/schema-studio.tsx` — removed `expanded` Set state and `toggleSchema`; schema header changed from clickable toggle button to plain label; tables under each schema always visible (no expand/collapse); `+` add-table button retained on hover
  - Status: done
- **revision** — Migration: saved job card layout & icon UX
  - `src/pages/migration.tsx` — card restructured: distinct header section (name + version), meta row (count · date + active badge + expand toggle), expanded table list, and actions row (Load button left + icon group right)
  - Icons bumped to `size={12}`, colour changed from `text-gray-400` to `text-slate-500 dark:text-slate-400` for better dark-mode visibility; hover colours retained per action (violet/emerald/blue/rose)
  - All icon buttons wrapped in `<Tooltip>` (Radix-based, from `../components/Tooltip`) — tooltips: Analyze in Schema Studio, Export DDL SQL, Export Markdown, Rename job, Delete job, Remove from job
  - Status: done
- **fix** — Migration v2: preview 500 on saved job load
  - `src/pages/migration.tsx` — target preview useEffect: added `tgtTables.some(...)` check before calling preview API; if target table doesn't exist in target DB yet (not migrated / dropped), skip the preview call entirely — was causing 500 "table not found" whenever a saved job was loaded with unmigrated target tables
  - Status: done
- **fix** — Migration v2: 3 bugs + 2 enhancements (multi-DB follow-up)
  - `src/pages/migration.tsx` — fix stale `colsCache` key in Src Type column display (was `schema.table`, now `database.schema.table` consistent with cache write)
  - `src/pages/migration.tsx` — fix preview 500: added `!srcConn.host` guard in `srcConnForMap` and preview useEffect to prevent API call with uninitialised connection
  - `src/pages/migration.tsx` — `handleLoadJob`: collect all unique `sourceDatabase` values from job tables → set all into `srcDbsSelected` (not just `sourceMeta.database`); `loadSrcDbs` also uses full job DB list when restoring
  - `src/pages/migration.tsx` — added `DbMultiSelect` combobox component (trigger button shows selected count/name, dropdown with checkboxes, Select-all/Clear, closes on outside click); replaced inline checkbox list
  - Status: done
- **implement** — Migration → Schema Studio integration (push flow)
  - `src/pages/migration.tsx` — `handleOpenInSchemaStudio(jobId)`: loads full job, matches target connection by host/port/username, navigates to `/schema-studio?connId=X&database=Y&schema=Z`; added `ExternalLink` icon button on each saved job card (title: "Analyze in Schema Studio")
  - `src/pages/schema-studio.tsx` — added `useRouter`; URL param handler useEffect watches `[connections, router.isReady]`; on first load with params: sets `pendingRefactorDb.current`, `pendingAutoLoad.current`, `refactorConnId`, switches mode to `refactor` + tab to `suggest`; cascades through existing useEffects to auto-load the target schema
  - Status: done
- **implement** — Migration v2: multi-source DB selection + cross-DB FK Ref
  - `src/pages/api/migv2/tables.ts` — added `database` field to `MigTableInfo` and each returned table row
  - `src/lib/migv2/runner.ts` — `coerceValue`: FK UUID namespace uses `fkRef.split('.').slice(-2).join('.')` so 3-part cross-DB refs (`db.schema.table`) generate same UUID as 2-part refs (backward compatible)
  - `src/pages/migration.tsx`:
    - Replaced `srcDb: string` with `srcDbsSelected: string[]`; DB selector is now a scrollable checkbox list with Select-all/Clear; `loadSrcDbs` auto-selects the default DB on load
    - Table loading useEffect: `Promise.all` loads tables from all selected DBs in parallel and merges results; each table stamped with `database` field
    - `reloadSrcTables` updated for multi-DB
    - `toggleTable` now accepts full `MigTableInfo` object; uses per-table DB for column API call; column cache key changed from `schema.table` → `database.schema.table` to prevent cross-DB collisions
    - `isTableIncluded` and table list `mapEntry` lookup now consider `sourceDatabase`
    - Table list: grouped by DB header when multiple DBs selected; unique key is `database.schema.table`
    - FK Ref picker: grouped by DB; stores `db.schema.table` (PG) or `db.table` (MySQL); placeholder text updated
    - Job restore: `sameSrcConn` check uses `srcDbsSelected.includes(...)` instead of strict equality
  - Status: done
- **implement** — Migration v2: target table alias (rename) feature
  - `src/lib/migv2/types.ts` — added `targetAlias?: string | null` to `TableMap` and `MigJobTableSummary`
  - `src/lib/migv2/runner.ts` — added `resolveTargetTable()` helper; replaced all SQL operation sites (CREATE TABLE, TRUNCATE, INSERT, DELETE, DROP, rollback SQL in migration report) to use the alias when set
  - `src/pages/api/migv2/jobs/export-sql.ts` — TRUNCATE and comment header now use resolved table name
  - `src/lib/migv2/job-store.ts` — `listJobs` now includes `targetAlias` in table summary
  - `src/pages/migration.tsx` — column mapping header: alias input (text field, placeholder = target.table, disabled + tooltip when `lastSyncedValue` is set); path display shows alias; saved jobs sidebar shows alias with ✎ badge if renamed; job summary markdown export uses alias
  - Fully backward compatible — old jobs without `targetAlias` fall through to `target.table`
  - Status: done

## 2026-06-04
- **implement** — Migration: re-apply full session changes to migration.tsx after accidental revert
  - `src/pages/migration.tsx` — added `ExternalLink` to lucide imports
  - Replaced `srcDb: string` state with `srcDbsSelected: string[]`; added `DbMultiSelect` combobox component (trigger shows selected count/name, dropdown with checkboxes + Select-all/Clear, closes on outside click)
  - `loadSrcDbs`: reset logic uses `setSrcDbsSelected([])`; on restore, collects all unique `sourceDatabase` values from job tables and pre-selects them
  - `[srcDbsSelected]` useEffect: `Promise.all` loads tables from all selected DBs in parallel and merges results; `srcConn` set to first DB's conn; column cache key on restore now uses `database.schema.table`
  - `reloadSrcTables`: updated for multi-DB parallel load
  - `isTableIncluded`: added optional `database` param for cross-DB awareness
  - `toggleTable`: accepts `MigTableInfo` object (not schema+table strings); uses `sourceDatabase` for colsCache key (`database.schema.table`) and `mapEntry` lookup
  - `srcColsForSelected` and Src Type column display: cache key updated to `database.schema.table`
  - `srcConnForMap`: added `if (!srcConn.host) return srcConn` guard
  - Source preview useEffect: added `!srcConn.host` guard
  - Target preview useEffect: added `tgtTableExists` check; preview API only called when target table exists (fixes 500 on saved-job load)
  - `handleLoadJob`: collects `jobSrcDbs` from all included `sourceDatabase` fields; `allDbsAlreadySelected` check replaces single-DB equality; sets `setSrcDbsSelected(jobSrcDbs)` instead of `setSrcDb`
  - Added `handleOpenInSchemaStudio(jobId)`: matches target connection → navigates to `/schema-studio?connId=X&database=Y&schema=Z`
  - Source DB selector replaced with `<DbMultiSelect>` component
  - Source table list: grouped by DB header (sticky) when multiple DBs selected; `key` is `database.schema.table`
  - FK Ref picker: grouped by DB; key format `db.schema.table` (PG) or `db.table` (MySQL); placeholder updated
  - Column mapping header: path display shows `targetAlias` when set; alias text input added (disabled + tooltip when `lastSyncedValue` exists)
  - Job summary markdown export: uses `resolvedTable` (alias or table name)
  - Saved jobs sidebar: shows `targetAlias` with ✎ badge when renamed
  - Job card actions row: Load button `bg-gray-100`, icon buttons wrapped in `<Tooltip>`, `ExternalLink` button added, icons bumped to `size={12}`, color `text-slate-500 dark:text-slate-400`
  - Status: done

- **fix** — Migration: source DB not restored on job load; run panel missing after refresh
  - `src/pages/migration.tsx` `handleLoadJob` — source restore: when auto-connect had already set `srcConnId` to the same connection, `setSrcConnId(same)` was a no-op so `loadSrcDbs` never fired; fix: detect `srcMatch.id === srcConnId` and call `setSrcDb(job.sourceMeta.database)` directly to trigger the `[srcDb]` useEffect instead
  - `src/pages/migration.tsx` `handleLoadJob` — run panel: after loading a job only `migratedTableKeys` was restored, `currentRun` stayed null so the run/rollback panel was invisible; fix: restore `currentRun` to the most recent run for that job from run-store


- **implement** — Migration full-run rollback: prompt with optional DROP ALL tables
  - `src/lib/migv2/runner.ts` — `rollbackRun` accepts `dropTable` param; DROP runs per-table inside the loop with its own try/catch so one failure doesn't abort others
  - `src/pages/api/migv2/run/rollback.ts` — passes `dropTable` from request body
  - `src/pages/migration.tsx` — global Rollback button now opens `runRollbackPrompt` dialog; shows table count, same DROP checkbox pattern; button label **Rollback All** / **Rollback & Drop All**
  - Status: done

- **implement** — Migration per-table rollback: prompt with optional DROP TABLE
  - `src/lib/migv2/runner.ts` — `rollbackTable` accepts new `dropTable` param; after DELETE/TRUNCATE runs `DROP TABLE IF EXISTS … CASCADE` when flag is true
  - `src/pages/api/migv2/run/rollback-table.ts` — passes `dropTable` from request body
  - `src/pages/migration.tsx` — rollback button now calls `openRollbackPrompt` → shows modal with table name, checkbox "Also DROP the target table", Cancel + Rollback / Rollback & Drop buttons; button turns rose-red when DROP is checked
  - Status: done

## 2026-06-03
- **implement** — Schema Studio saved jobs: Export SQL / Markdown / ORM per card
  - `src/pages/schema-studio.tsx` — added `downloadBlob` + `generateSchemaMd` module-level helpers; `JobGroupCard` gets an "Export ▾" dropdown button (shown when `schema_sql` exists); SQL always available; Markdown + Drizzle/Prisma/TypeORM shown for DDL jobs only (hidden for ALTER-only refactor jobs); ORM tables built inline from `parseSqlToTables` + `generateOrm`
  - Status: done

- **fix** — Schema Studio: schema not auto-loaded after job restore
  - `src/pages/schema-studio.tsx` — `loadRefactorSchema` now accepts optional `schemaOverride` param to bypass stale closure on `refactorSchema`; added `pendingAutoLoad` ref (stores target schema across async chain); `handleLoadJob` extracts schema from first `ALTER/CREATE TABLE "schema"."table"` pattern in saved SQL (falls back to `public`); new `useEffect` watching `refactorSchemas` consumes the ref and fires `loadRefactorSchema(schemaToLoad)` automatically once schemas list is ready
  - Status: done

- **fix** — Schema Studio: connection not restored on saved job load
  - `src/pages/schema-studio.tsx` — `handleLoadJob` now matches `job.connection_label` against loaded connections and restores `refactorConnId`; `job.target_database` is stored in a `pendingRefactorDb` ref (consumed by the database-load useEffect) so the correct database is selected after the async connection→database chain resolves
  - Status: done

- **fix** — Schema Studio analyzer: `could not create unique index "uq_*"` on apply
  - `src/pages/api/schema-studio/analyze.ts` — unique-column detection now also queries `pg_index` to catch unique indexes created via `CREATE UNIQUE INDEX` (invisible to `information_schema.table_constraints`); added duplicate-value check before emitting `missing_unique` suggestion — if dupes exist, `alterSql` is omitted and message warns to clean duplicates first
  - Status: done

- **fix** — Schema Studio FK reference: `relation * does not exist` for non-public schemas
  - `src/pages/schema-studio.tsx` — added `fkRefTable()` + `fkRefToSQL()` helpers to handle both 2-part (`table.col`) and 3-part (`schema.table.col`) fkRef strings; DDL generation now emits schema-qualified `REFERENCES "schema"."table"("col")`; FK picker now stores `schema.table.col` when referenced table is in a non-public schema; ERD edge drawing, incoming FK checks, and drag-to-create-FK all updated; refactor-load no longer strips schema from fkRef
  - Status: done

- **fix** — UUID FK column DDL: `DEFAULT 0` rejected by PostgreSQL
  - `src/lib/migv2/runner.ts` `buildCreateTableSQL` — skip DEFAULT clause entirely when `targetType` is `uuid`; MySQL integer defaults (e.g. `0`) are not valid for UUID columns and caused `column "role_id" is of type uuid but default expression is of type integer`
  - Status: done

- **fix** — `/connections` 404; restore Settings icon in Navbar
  - `src/pages/export-import.tsx`, `src/pages/migration.tsx` — changed 3 dead links from `/connections` (no such page) to `/settings`
  - `src/components/Navbar.tsx` — added `Settings2` icon link on the right side of the global nav bar; highlights when active on `/settings`
  - Status: done

## 2026-06-02
- **fix** — Pending Save accumulates across multiple runs; FK picker uses source tables
  - `src/pages/migration.tsx` — added `accumulatedTableStates` + `accumulatedTableMaps` state; `completedMigratedStates` now derives from accumulated state — tables from all runs stay in Pending Save until saved/cleared; `advanceMigration` merges per run (latest entry wins per sourceKey); removed `savedMigratedSources` reset in `startMigration`; `handleSaveMigratedTables` reads from `accumulatedTableMaps`; rollback handlers remove from accumulator; page-load restore populates accumulator
  - FK picker changed from target tables (requires target to exist before migration) to source tables — user can set `fkRef = source_schema.table` before any migration, enabling all tables to migrate in one single run; `fkRef` value format unchanged
  - Status: done

- **remove** — Authentication system fully removed
  - Deleted: `src/lib/auth-store.ts`, `src/lib/auth-context.tsx`, `src/pages/api/auth/` (login, logout, verify, refresh, profile, update-account, verify-otp)
  - All 34 API routes stripped of `verifyAccessToken` import and 401 check block
  - `_app.tsx` — `AuthProvider` wrapper removed; `Navbar.tsx` — user/logout/settings block removed
  - `index.tsx` — login modal, OTP form, blur gate and all related state removed
  - All page files — auth header helpers (`authHeaders`, `authH`, `authHeader`) and their usages removed from axios/fetch calls
  - Status: done

## 2026-06-02
- **remove** — Strip all authentication from the application (zero-auth)
  - Deleted `src/lib/auth-store.ts`, `src/lib/auth-context.tsx`, and entire `src/pages/api/auth/` folder (login, logout, verify, refresh, profile, update-account, verify-otp)
  - Removed `verifyAccessToken` import + token check from all 34 API routes: `create-database.ts`, `export-import/{export,history,import,sync,tables}.ts`, `migv2/{columns,create-db,export-md,preview,tables}.ts`, `migv2/jobs/{[id],export-sql,index,restore,table-refs}.ts`, `migv2/run/{advance,rollback-table,rollback,start,status}.ts`, `normalizer/{execute,export,parse}.ts`, `schema-designer/{create-db,databases,execute}.ts`, `schema-explorer/{columns,export,records,schemas,tables}.ts`, `schema-generator/{jobs,upload}.ts`, `schema-generator/jobs/[id].ts`; routes that used `username` from the token now default to `'system'`
  - `src/pages/_app.tsx` — removed `AuthProvider` wrapper; `src/components/Navbar.tsx` — removed user info / logout block
  - `src/pages/index.tsx` — removed login/OTP overlay, blur gate, all login state and handlers; `src/pages/migration.tsx` — removed `getToken`, `authHeaders`, `useAuth`; replaced all `{ headers: authHeaders() }` in axios calls
  - `src/pages/settings.tsx` — removed `useAuth`, auth redirect guard, Account tab (username/password/email change form), profile-load effect; `src/pages/schema-designer.tsx`, `schema-explorer.tsx`, `export-import.tsx`, `normalizer.tsx`, `flow-designer.tsx` — removed all auth helper functions and `{ headers: authH() }` from axios calls
  - Cleared `.next` cache; `npx tsc --noEmit` passes with zero errors
  - Status: done

- **revision** — Move Export MD to per-saved-job; remove global Export MD buttons
  - `src/pages/migration.tsx` — removed Export MD button from main toolbar and run console header; removed `handleExportMd` (run-level) and old `handleExportJobMd` (in-memory state); rewrote `handleExportJobMd(jobId)` to load the saved job from API and generate MD from persisted job data (includes incremental sync config if set); added `FileText` Export MD button per saved job card alongside existing Export SQL (`FileCode`) button
  - Status: done

## 2026-06-01
- **implement** — Per-table rollback replacing global rollback in Pending Save
  - `src/lib/migv2/runner.ts` — added `rollbackTable(run, tableId, target)` — same DELETE/TRUNCATE logic as `rollbackRun` but for a single table only; run-level status is NOT changed so other tables are unaffected
  - `src/pages/api/migv2/run/rollback-table.ts` — new `POST /api/migv2/run/rollback-table` endpoint accepting `{ runId, tableId, target }`
  - `src/pages/migration.tsx` — added `rollingBackTableId` state + `handleRollbackTable(tableId)` handler; removed global Rollback button from Pending Save header; added per-row `RotateCcw` rollback button on each Pending Save entry (visible when run is completed/failed); added per-row rollback button in run console per-table progress list; global Rollback in run console header also now clears `migratedTableKeys` on success
  - Status: done

- **implement** — Incremental sync for live production DB migration
  - `src/lib/migv2/types.ts` — added `syncMode`, `incrementalCol`, `incrementalStrategy`, `lastSyncedValue` (optional) to `TableMap`; added `newWatermark` to `MigRunTableState`
  - `src/lib/migv2/runner.ts` — added `IncrementalFilter` type; `countRows` + `readChunk` accept optional filter (`WHERE col > value`) with `ORDER BY col ASC` for stable pagination; `insertRows` accepts `upsert` flag — PG uses `ON CONFLICT (pk) DO UPDATE SET ...`, MySQL uses `ON DUPLICATE KEY UPDATE ...`; `advanceRun` derives filter from `tableMap.syncMode/incrementalCol/lastSyncedValue`, queries `getMaxValue()` on source after table completes and stores result in `ts.newWatermark`
  - `src/pages/api/migv2/run/advance.ts` — after each advance, if run has a `jobId`, write `ts.newWatermark` back to `job.tables[].lastSyncedValue` and save the job so the next run starts from the correct high-water mark
  - `src/pages/migration.tsx` — column mapping header: added `⟳ Full / ⟳ Incremental` toggle button per table; when incremental: watermark column picker (from source columns), strategy selector (`by ID` = append-only insert, `by Timestamp` = upsert), current watermark display with reset (×) button
  - Status: done


- **implement** — Global fixed Navbar across all modules
  - `src/components/Navbar.tsx` — new component; `fixed top-0 left-0 right-0 h-12 z-[60]`; shows app name (links to `/`), current module breadcrumb chip (derived from `useRouter().pathname`), user info (username, Settings link, Logout) via `useAuth()`
  - `src/pages/_app.tsx` — import and render `<Navbar />`; added `pt-12` to global wrapper div so page content starts below the fixed bar
  - `h-screen` pages (`migration`, `schema-designer`, `export-import`, `schema-explorer`, `normalizer`, `flow-designer` canvas) — changed to `h-[calc(100vh-48px)]` to account for navbar height
  - `min-h-screen` pages (`settings`, `audit`, `schema-generate`, `docs`) — per-page `sticky` headers moved from `top-0 z-50` to `top-12 z-40` so they stick below the global navbar
  - `flow-designer` projects view — per-page header changed to `sticky top-12 z-40`
  - All module pages — removed inline `Home → Module` breadcrumb nav from per-page headers (handled by global Navbar); `docs.tsx` and `schema-generate.tsx` retain their multi-step breadcrumbs with the Home step removed
  - `src/pages/index.tsx` — removed entire inline `<header>` (Navbar now handles app name + user info + settings); cleaned up unused imports (`Settings2`, `LogOut`, `User`, `logout`, `username`)
  - Status: done


- **fix** — Target tables panel not reloading after every migration run
  - `src/pages/migration.tsx` — `reloadTgtTables()` was only called when overall run status was `completed`; individual table states can be `completed` even when the run ends as `failed`; moved `reloadSrcTables()` + `reloadTgtTables()` outside the `completed`-only guard so they fire on any run-end (completed or failed); also call `reloadTgtTables()` after rollback since rolled-back rows are deleted from target
  - Status: done

- **fix** — Restore Pending Save list after accidental page refresh
  - `src/pages/migration.tsx` — on page load, fetch most recent finished run (`completed`/`failed`) from `/api/migv2/run/status`; if it has any completed tableStates, restore it as `currentRun` (run console + Pending Save section reappear); also read `localStorage.mig_saved_<runId>` to re-apply which tables were already saved in the previous session so they don't re-appear as unsaved; `handleSaveMigratedTables` now writes saved keys back to localStorage keyed by run ID; starting a new migration clears the old run's localStorage entry
  - Status: done

- **revision** — Rename "Migrated Tables" section to "Pending Save"; clear entries after save
  - `src/pages/migration.tsx` — renamed section header/dialog title to "PENDING SAVE" / "Save to Job"; added `savedMigratedSources` Set state to track which source keys have been saved; `completedMigratedStates` now filters out saved entries so list clears incrementally after each save; `savedMigratedSources` resets on each new migration run start
  - Status: done

- **implement** — Migration module: Migrated Tables log section with multi-select save
  - `src/pages/migration.tsx` — added "Migrated Tables" section below Saved Jobs in the right jobs panel; derived from `currentRun.tableStates` filtered to `status === 'completed'`; supports select-all and per-row checkbox toggle; "Save N" button opens a dialog to create a new job or append to an existing one; handler `handleSaveMigratedTables` fetches selected `TableMap` entries from `currentRun.tables`, merges into existing job (deduplicating by id) or posts a new job; dialog reuses the same list-picker pattern as the existing Save Job dialog
  - Status: done

## 2026-05-31
- **implement** — Export DDL SQL per saved job
  - `src/lib/migv2/runner.ts` — exported `buildCreateTableSQL` (was unexported private function); generates `CREATE SCHEMA IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS` for each target table including PK, legacy BIGINT columns, and NOT NULL/DEFAULT constraints
  - `src/pages/api/migv2/jobs/export-sql.ts` — new `GET /api/migv2/jobs/export-sql?id=` endpoint; loads the job, generates DDL SQL for all included tables with header comment block (job name, source/target meta, table count), appends excluded table list as comments, returns as `attachment; filename="<job-name>.sql"`
  - `src/pages/migration.tsx` — added `FileCode` icon import; added `handleExportJobSql(jobId)` handler that fetches the endpoint and triggers browser download; added Export SQL button (emerald `FileCode` icon) per saved job card, between Load and Rename buttons
  - Status: done

## 2026-05-30
- **fix** — Saved job shows 0 tables / "No tables" — corruption guard + run-history restore
  - Root cause: `useEffect` at src/pages/migration.tsx clears `tableMaps` when `srcDb` changes and `pendingRestoreRef.current` is null; if user saves at that moment the job file is written with `tables: []`; the `assetdata` job (v10, 30/05/2026) had this happen
  - `src/lib/migv2/run-store.ts` — added `listRunsForJob(jobId)` to scan all run files for a specific job without the 20-run global cap
  - `src/pages/api/migv2/jobs/restore.ts` — new `POST /api/migv2/jobs/restore?id=` endpoint: collects unique tables from all completed runs for the job (newest snapshot wins per source key), writes back to job file
  - `src/pages/migration.tsx` — `handleSaveJob` split into `doSaveJob` + guard: if `tableMaps` is empty and the existing job has saved tables, shows `showWarning` before overwriting; added `handleRestoreJobFromRuns`; job card now shows amber "No tables — job may be corrupted" + "Restore" button when `tables.length === 0`
  - Status: done — `assetdata` job can be recovered via the Restore button in Saved Jobs

- **implement** — Warning AlertDialog on all destructive actions across modules
  - `src/pages/migration.tsx` — `handleDeleteJob` + `handleRemoveTableFromJob` now call `showWarning` with title/description before executing; no longer use `void` async directly
  - `src/pages/schema-designer.tsx` — added `useAlert` import + `showWarning` hook; wrapped `handleDeleteTable` + `handleDeleteParsedTable`; added delete button (Trash2) to `JobGroupCard` with `onDelete` prop; added `handleDeleteJobGroup` in parent
  - `src/pages/api/schema-generator/jobs.ts` — added `DELETE ?jobName=` handler to remove all runs in a job group for the current user
  - `src/pages/flow-designer.tsx` — added `useAlert` import + `showWarning` hook; replaced native `confirm()` in `deleteProject` with `showWarning` dialog
  - Status: done

- **implement** — Migration module: expand saved job to list tables & remove individual entries
  - `src/lib/migv2/types.ts` — added `MigJobTableSummary` interface; added `tables: MigJobTableSummary[]` to `MigJobSummary`
  - `src/lib/migv2/job-store.ts` — `listJobs()` now includes compact table list (id, include, source, target) in each summary
  - `src/pages/migration.tsx` — added `expandedJobId` state; added `handleRemoveTableFromJob` (GET full job → filter → PUT); job card now has chevron toggle to expand/collapse table list; each table row shows `schema.table → schema.table` with X remove button; excluded tables (include=false) shown dimmed; removing from active job also updates live `tableMaps`
  - Root cause for the feature: tables that were executed but don't exist in target schema couldn't be cleaned up from the saved job
  - Status: done

- **fix** — Migration module: reload both source and target tables after execution completes
  - `src/pages/migration.tsx` — added `reloadSrcTables` callback (mirrors existing `reloadTgtTables`); both are now called in `advanceMigration` when `run.status === 'completed'`
  - Root cause: only `reloadTgtTables` was called on completion; source table list stayed stale
  - Status: done

- **implement** — Inline rename for saved jobs across all modules
  - `src/pages/migration.tsx` — pencil button per job card → inline input; `handleRenameJob` calls `PUT /api/migv2/jobs/[id]`; Enter confirms, Escape cancels; active job name synced on rename
  - `src/pages/schema-designer.tsx` — `JobGroupCard` gains `onRename` prop + local editing state; pencil button in card header; renames all runs under the same `job_name`; `handleRenameGroup` calls `PATCH /api/schema-generator/jobs`
  - `src/pages/api/schema-generator/jobs.ts` — added `PATCH` handler: `UPDATE dbt_schema_jobs SET job_name=$1 WHERE job_name=$2 AND username=$3`
  - `src/pages/flow-designer.tsx` — Edit3 pencil button per project card → inline input; `renameProject` calls `PUT /api/flow-designer/projects` (existing endpoint); local state updated optimistically
  - Status: done

- **fix** — Auth: auto-seed default admin user on first login if `dbt_users` is empty
  - `src/lib/auth-store.ts` — `validateCredentials` now checks if table is empty when default credentials are used; auto-inserts the admin row via `ON CONFLICT DO NOTHING`, so login works on fresh setups without needing `npm run db:seed`
  - Root cause: fallback hash only activated on DB exception; reachable-but-unseeded DB returned 0 rows → "Invalid credentials" on any new machine
  - Status: done

## 2026-05-27
- **fix** — Migration module: FK Ref picker resolves source namespace across all saved jobs
  - `src/pages/api/migv2/jobs/table-refs.ts` (new): `GET /api/migv2/jobs/table-refs` scans all saved job files and returns `{targetKey, sourceKey}[]` pairs (e.g. `assetdata.types → assets.types`); deduplicates by targetKey
  - `src/pages/migration.tsx` — added `tgtToSrcRef: Record<string, string>` state; loaded at mount via `loadTableRefs()` and refreshed after every save; picker now resolves source namespace using `tgtToSrcRef[targetKey]` first (cross-job lookup), then `tableMaps` fallback (current job); annotation shows green `↩ src: assets.types` when resolved, amber `(unresolved)` when not found in any saved job
  - Root cause: previous fallback used target namespace (`assetdata.types`) when table not in current tableMaps; now correctly resolved from run history across all jobs
  - Status: done

- **implement** — Migration module: FK Ref picker — schema → table hierarchy from target DB
  - `src/pages/migration.tsx` — replaced FK Ref text input with a dropdown picker button; clicking opens a popover grouped by target schema listing all tables in the target DB; each table row shows the table name + auto-resolved source namespace annotation (`↩ src: assets.types`) when the table exists in current `tableMaps`; on selection stores `source.schema.source.table` (resolved from tableMaps) instead of target namespace, preventing the `assetdata.types` vs `assets.types` mistake; falls back to `target.schema.target.table` if table not in current job maps
  - Also auto-sets `targetType: UUID` on selection (same as before); picker closes on item select, outside click (backdrop overlay), or table switch (useEffect on selectedMapId)
  - `fkPickerIdx: number | null` state tracks which column row has the picker open
  - Status: done

- **fix** — Migration module: FK Ref auto-sets targetType to UUID on PostgreSQL target
  - `src/pages/migration.tsx` — FK Ref `onChange` now also sets `targetType: 'UUID'` when a `fkRef` value is entered and target is PostgreSQL; prevents INSERT type mismatch where `seqToUUID()` returns a UUID string but the DDL column was still typed as BIGINT/INTEGER
  - Status: done

- **fix** — Migration module: FK Ref field disabled for non-UUID columns
  - `src/pages/migration.tsx` — FK Ref `disabled` condition was `col.conversion !== 'serial_to_uuid' && !col.fkRef`, which blocked FK columns with `keep` conversion (e.g. `type_id`) from being editable; fixed to `col.conversion === 'serial_to_uuid'` — disables only on the PK column that generates the UUID (it is the source, not a consumer), enables for all other columns
  - Status: done

- **fix** — Migration module: strikethrough not restored on job load + column mapping not appearing for new tables
  - `src/pages/migration.tsx` — `handleLoadJob`: instead of resetting `migratedTableKeys` to empty, now fetches run history via `GET /api/migv2/run/status`, filters runs where `jobId === id && status === 'completed'`, and rebuilds the set from completed `tableStates.sourceKey`; strikethrough now correctly reflects previous sessions
  - `src/pages/migration.tsx` — `toggleTable`: replaced `tgtConnected && tgtTables.length === 0` condition with `!existsInTarget` check (looks up whether the same table name exists in `tgtDefaultSchema`); new tables not yet in target get `autoTargetTable = table` so column mapping appears immediately; existing target tables stay blank to avoid accidental overwrite
  - Status: done


- **implement** — Migration module: ? Guide popover
  - `src/pages/migration.tsx` — added `MIGRATION_GUIDE_SECTIONS` (7 sections: Overview, Connect source & target, Select tables, Column mapping, UUID conversion, Jobs, Run & rollback) and `MigrationGuidePopover` component; follows same pattern as FlowGuidePopover; button placed in header before Save Job; popover dismisses on outside click or Escape
  - Guide content reflects all latest implementation: auto-DB/schema creation, strikethrough for migrated tables (job-save condition), keepLegacyAs auto-set, fkRef for FK columns, Save as existing job, rollback behaviour (PK list vs TRUNCATE fallback)
  - Status: done

## 2026-05-26
- **fix** — Migration module: MySQL source table filtering + target DB/schema creation
  - `src/pages/api/migv2/tables.ts`: MySQL query now filters `TABLE_SCHEMA = ?` using `conn.database` so only tables from the selected source DB are listed (previously showed tables from all non-system databases)
  - `src/pages/api/migv2/create-db.ts` (new): POST endpoint to create a new database on the target connection; supports PostgreSQL (connects to `postgres` DB then runs `CREATE DATABASE`) and MySQL; validates DB name is alphanumeric/underscore/hyphen only
  - `src/pages/migration.tsx` — Source table list: each row now shows `schema.tablename` (schema in dim text) so the user can see which DB/schema each table belongs to
  - `src/pages/migration.tsx` — Target panel: added "+ New DB" button next to the DB dropdown; opens an inline text input + "Create" button that calls `/api/migv2/create-db`, then refreshes the DB list and auto-selects the new DB
  - `src/pages/migration.tsx` — Target panel: added "+ New Schema" button next to the PG schema dropdown; opens an inline text input that sets `tgtDefaultSchema` to the typed value; migration runner already handles `CREATE SCHEMA IF NOT EXISTS` automatically
  - Status: done

- **implement** — Migration module: keep original serial ID alongside UUID (`keepLegacyAs`)
  - `src/lib/migv2/types.ts` — added `keepLegacyAs?: string | null` to `ColumnMap`; when set on a `serial_to_uuid` column, the original MySQL integer is also written to a separate BIGINT column
  - `src/lib/migv2/runner.ts` — `buildCreateTableSQL`: injects the extra BIGINT column (e.g. `"old_id" BIGINT NULL`) before the PK constraint; `transformRow`: writes `Number(originalVal)` to `out[keepLegacyAs]` alongside the converted UUID
  - `src/pages/migration.tsx` — added "Keep Orig" column to the mapping table header (with tooltip); cell shows `—` for non-UUID conversions; for `serial_to_uuid` shows `+ keep` button (defaults to `old_<srcCol>`) that expands to an editable name input + X to clear; switching Conv away from →UUID auto-clears the field
  - Status: done

- **implement** — Migration module: strike-through migrated source tables + Save as existing job
  - `src/pages/migration.tsx` — added `migratedTableKeys: Set<string>` state; populated in `advanceMigration` when run status is `completed` (accumulates `sourceKey` of each completed table); cleared in `handleLoadJob` when switching jobs
  - `src/pages/migration.tsx` — source table list: `isMigrated` flag applied only when `activeJobId` is set (job saved); migrated rows show `line-through` text, green table icon, and a `✓` badge; unsaved jobs never show strike-through
  - `src/pages/migration.tsx` — added `saveAsTarget: string | null` state; Save Job dialog now shows a scrollable "Save as existing job" picker listing all saved jobs; selecting one prefills name/desc and sets `saveAsTarget`; `handleSaveJob` uses `saveAsTarget ?? activeJobId` as the payload ID, overwriting the selected job with current table mappings; save button label changes to "Update Job" when a target is selected; typing in the name field clears the selection
  - Status: done

- **implement** — Migration module: auto-reload target schema & tables after migration completes
  - `src/pages/migration.tsx` — added `reloadTgtTables` callback; calls `/api/migv2/tables` with current `tgtConn` and silently updates `tgtTables` + `tgtSchemas` without resetting connection state; called from `advanceMigration` when run status is `completed`
  - Status: done

- **fix** — Migration module: `keepLegacyAs` not auto-populated on column load
  - `src/pages/migration.tsx` — column initialization block (line ~394): when a PK column is detected as serial (`isSerial === true`), `keepLegacyAs` is now auto-set to `old_<colName>` instead of `undefined`; previously the `+ keep` button had to be clicked manually, meaning users who skipped it got no legacy column in PostgreSQL
  - Status: done

- **fix** — Migration module: auto-map target table name when target is empty
  - `src/pages/migration.tsx` — `toggleTable`: when `tgtConnected && tgtTables.length === 0`, auto-sets `target.table` to the same name as the source table so no manual target assignment is needed
  - Column mapping uses free-text inputs (no dropdown) since no target columns exist yet; the runner's `ensureTargetTable` creates the table on first run using the DDL from the mapping
  - Target panel empty-state updated: when target has no tables, shows "Empty target — source table names will be used" instead of generic "No tables found"; search-filtered empty state shows "No tables match"
  - Status: done

## 2026-05-22
- **implement** — Data Normalizer: Drizzle ORM export + build schema in PostgreSQL
  - Added `'drizzle'` export mode to `ExportMode` type and export grid (4 cards, 2-col grid)
  - `generateDrizzle()` in `src/pages/api/normalizer/export.ts`: generates `pgTable` definitions with `serial`, `text`, `integer`, `bigint`, `numeric`, `boolean`, `timestamp`, `date` mapped from inferred PG types; lookup tables get `text('value').notNull().unique()`; FK columns reference parent table via `.references()`; downloads as `.ts`
  - New API route `src/pages/api/normalizer/execute.ts`: accepts `{ conn: ExplorerConn, sheet, confirmedLookups }`, generates CREATE TABLE IF NOT EXISTS statements (no INSERTs), executes via `withPg`, returns per-statement log with ok/error status
  - `ExportStep` component updated: added "Build Schema in PostgreSQL" section — fetches saved PG connections on mount, connection picker, Execute button, execution log panel showing success/error per statement
  - Status: done


- **implement** — Flow-to-Database Designer module (`/flow-designer`)
  - 6-step guided wizard: Business Flow Canvas → Data Flow Review → Entities → Relationships → ERD → Outputs
  - **Business Flow Canvas**: React Flow canvas with 6 custom node types (Start, Process, Decision, Approval, Data Object, End); node metadata editor panel (actor, action, business object, operation type, input/output data, status before/after, decision condition, related document, remarks)
  - **Data Flow Generator** (`src/lib/flow-analyzer.ts`): rule-based analysis converts canvas nodes into DataFlow objects; infers operation type from node label keywords when not set; enriches output fields with standard approval/verify/cancel patterns
  - **Entity Extractor** (`src/lib/entity-extractor.ts`): groups data flows by business object → candidate entities; infers PostgreSQL column types from field name patterns; classifies entity category (master/transaction/detail/junction/log/audit/config); injects `users` and `status_logs` entities when needed
  - **Relationship Engine** (`src/lib/relationship-engine.ts`): scans FK fields (_id, _by suffixes) → one_to_many; detects junction table pattern → many_to_many
  - **ERD Generator**: React Flow canvas from confirmed entities + relationships; custom `erd_table` node with columns, PK/FK indicators
  - **DDL Generator** (`src/lib/flow-ddl-generator.ts`): `CREATE SCHEMA` + `CREATE TABLE` + FK constraints + indexes
  - **Drizzle Generator** (`src/lib/flow-drizzle-generator.ts`): full drizzle-orm/pg-core schema with `pgSchema`, `references()`, `relations()`
  - **Dictionary + Validation** (`src/lib/flow-dict-validator.ts`): data dictionary table + design issue detection
  - **DB migration** `006_flow_designer.sql`: 7 tables (`dbt_ftd_projects`, `dbt_ftd_nodes`, `dbt_ftd_edges`, `dbt_ftd_data_flows`, `dbt_ftd_entities`, `dbt_ftd_relationships`, `dbt_ftd_outputs`, `dbt_ftd_validations`)
  - **API routes** (`src/pages/api/flow-designer/`): `projects.ts`, `canvas.ts`, `analyze.ts`, `entities.ts`, `relationships.ts`, `generate.ts`, `dataflows.ts`
  - **Outputs**: PostgreSQL DDL, Drizzle ORM schema, Data Dictionary, Validation — copy + download per tab
  - Domain-agnostic — works for any business domain
  - Status: done

- **implement** — Live DB import tab in Schema Designer
  - Added `'db'` (Live DB) source tab to the inline import area in Schema Designer, alongside Paste SQL / .sql / CSV / XLSX
  - **Sub-toolbar**: connection dropdown (all saved connections) + database dropdown (loaded automatically when connection is selected via `POST /api/schema-designer/databases`) + Load button (calls `/api/schema-explorer/schemas`)
  - **Schema tree**: expandable schemas with `ChevronDown`/`ChevronRight`, per-schema select-all checkbox (with indeterminate state), per-table checkbox; row count shown from `rowCount`
  - **Import Selected (N)** button in toolbar (emerald, visible only when ≥1 table selected): calls `importFromLiveDb()` which fetches columns for each selected table via `/api/schema-explorer/columns`, converts via `colInfoToDesigner()`, merges into designer tables + `designerSchemas`, switches to create mode
  - Import area height dynamically expands to 340 px when `importSource === 'db'` (vs 200 px for other sources)
  - Mode toggle label changed from "Import SQL" → "Import" to reflect broader import options
  - TypeScript clean — all field names corrected to `SchemaInfo.schema`, `SchemaInfo.tableCount`, `TableInfo.rowCount`, `ConnectionRow.label`
  - Files: `src/pages/schema-designer.tsx` only — no new API endpoints (reuses schema-explorer and schema-designer/databases APIs)
  - Status: done

- **implement** — FK Advisor tab in Schema Explorer
  - Use case: production DBs with isolated tables (no FK constraints defined) where `*_id` columns imply relationships; advisor surfaces them so developer can apply, save, and generate ORM
  - New `'advisor'` tab in Schema Explorer (4th tab, amber badge when suggestions exist)
  - **FK inference** (frontend-only, uses `columnsCache`): for each `*_id` column without `isFk`, tries `prefix`, `prefix+s`, `prefix+es`, `prefix[y→ies]` against all loaded table names; assigns `high` (exact/simple plural match), `low` (heuristic guess), or `unresolved` confidence
  - **Suggestion list UI**: checkbox toggle per row, ArrowRight divider, target column; unresolved rows show a `<select>` dropdown to manually pick the target table; confidence badge (emerald/amber/gray)
  - **Send to Designer**: generates CREATE TABLE DDL with accepted FK suggestions applied as inline `REFERENCES "table"("col")` + preserves existing `isFk` constraints; saves via `POST /api/schema-generator/jobs`; redirects to `/schema-designer`; Schema Designer's `parseSqlToTables()` picks up inline REFERENCES and populates `fkRef` automatically
  - Full workflow: Advisor → accept → Send to Designer → load job → ORM export (Drizzle/Prisma/TypeORM)
  - Files: `src/pages/schema-explorer.tsx` only — no new API endpoints (inference is pure frontend)
  - Status: done

- **implement** — ORM export (Drizzle, Prisma, TypeORM) for Schema Explorer + Schema Designer
  - New `src/lib/orm-generator.ts`: pure codegen module with full PG + MySQL type mapping for all three ORM targets
    - **Drizzle**: generates `pgTable`/`mysqlTable` schema with chained modifiers (`.primaryKey()`, `.notNull()`, `.unique()`, `.defaultNow()`, `.references()`); bigint/bigserial uses `{ mode: 'number' }`; timestamptz uses `{ withTimezone: true }`
    - **Prisma**: generates full `schema.prisma` with `datasource`, `generator`, `model` blocks, `@relation` for FK fields, back-ref arrays, `@@map` for snake_case table names
    - **TypeORM**: generates `@Entity` classes with `@PrimaryGeneratedColumn`, `@Column`, `@ManyToOne`/`@OneToMany`/`@JoinColumn` decorators; FK columns get both raw column prop and relation prop
  - `src/pages/api/schema-explorer/export.ts`: added `ExportFormat = 'drizzle' | 'prisma' | 'typeorm'`; new ORM branch queries PK/unique/FK per-table (separate from XLSX/SQL paths) and streams plain-text response
  - `src/pages/schema-explorer.tsx`: export format state extended to 5 options; format picker split into "Schema files" row (SQL, XLSX) + "ORM Schema" row (Drizzle, Prisma, TypeORM) with violet accent; button label dynamically reflects selected format
  - `src/pages/schema-designer.tsx`: `ExecutePanel` — added `downloadOrm()` converting `DesignerColumn[]` → `OrmColDef[]`; three violet ORM buttons (drizzle / prisma / typeorm) added in DDL header bar next to existing download/copy buttons
  - Status: done

## 2026-05-21
- **fix** — Replace `xlsx` with `exceljs` (security fix)
  - `xlsx` (SheetJS community edition) had 2 unpatched CVEs: Prototype Pollution (GHSA-4r6h-8v6p-xvw6) and ReDoS (GHSA-5pgg-2g8v-p4x9); package abandoned, no fix available
  - Replaced with `exceljs` — actively maintained, no known CVEs
  - Files updated: `src/pages/api/schema-explorer/export.ts` (server-side styled XLSX export), `src/lib/excel-parser.ts` (browser-side file parse via dynamic import)
  - `export.ts`: rewrote workbook builder using `ExcelJS.Workbook`, `ws.getCell(row, col)`, `wb.xlsx.writeBuffer()`; colors converted from RGB to ARGB; freeze pane via `ws.views`
  - `excel-parser.ts`: replaced `XLSX.read()` + `sheet_to_json()` with `workbook.xlsx.load(buffer)` + `worksheet.eachRow()`; added `cellToStr()` to handle formula/richText/Date cell values
  - `npm uninstall xlsx && npm install exceljs`; `tsc --noEmit` clean
  - Status: done

- **implement** — Data Normalization module (new module)
  - 4-step wizard: Upload → Profile → Schema → Export; layout consistent with existing modules (sticky header, `max-w-6xl`, dark mode)
  - **File ingestion**: drag-drop or click-to-browse; supports XLSX, CSV, JSON; file read as base64 (XLSX) or text (CSV/JSON) then POST to parse API
  - **Data profiling**: per-column stats (null count, distinct count, top 8 values, inferred type); FK candidate detection via low-cardinality heuristic (distinctCount ≤ min(50, 20% of rows))
  - **Normalization suggestions**: toggle-button UI per FK candidate; user includes/dismisses each before building schema
  - **Schema builder**: displays lookup tables (SERIAL PK + TEXT UNIQUE value) and main table with FK columns; data preview table
  - **Export**: SQL (CREATE TABLE + INSERT with lookup subqueries), CSV (FK replaced with id), JSON (all tables as arrays in one file)
  - **New files**:
    - `src/lib/normalizer/csv-parser.ts` — RFC-4180-compliant CSV parser (handles quotes, escaped quotes, multi-line)
    - `src/lib/normalizer/profiler.ts` — column profiling, FK suggestion, `buildSheetResult()`
    - `src/pages/api/normalizer/parse.ts` — parse XLSX/CSV/JSON → profile → return `SheetResult[]`
    - `src/pages/api/normalizer/export.ts` — generate SQL/CSV/JSON from confirmed schema
    - `src/pages/normalizer.tsx` — main 4-step wizard page
  - **Updated**: `src/pages/index.tsx` — normalizer card `href` set to `/normalizer`, `available: true`
  - `tsc --noEmit` clean; `npm install exceljs` already done in Plan 1
  - Status: done

- **fix** — Migration tracking, seed completeness, README accuracy
  - `scripts/db-push.js`: rewrote to check `dbt_migrations` before applying each file — skips already-applied migrations, wraps each in `BEGIN/COMMIT/ROLLBACK`; old script applied all files blindly every run
  - `db/migrations/005_export_history.sql`: added missing `INSERT INTO dbt_migrations (name) VALUES ('005_export_history') ON CONFLICT DO NOTHING` + header comment block
  - `README.md` — three sections corrected:
    - **Windows instructions**: added `python` (not `python3`) variant, note about Git Bash/WSL for `openssl`, clarified `npm run *` works on CMD/PowerShell
    - **Core Database Tables**: added missing `dbt_schema_jobs` and `dbt_export_history`, added Migration column
    - **App Structure tree**: added `normalizer.tsx`, `schema-explorer.tsx`, `export-import.tsx`, `normalizer/` API + lib; updated migrations list to all 5 files; updated `db-push.js` description
  - Status: done

- **revision** — Migration module layout restructure
  - Removed the source/target partition ownership of COLUMNS and COLUMN MAPPING sections
  - **Before**: outer horizontal `PanelGroup` (source panel | target panel); each panel had its own vertical sub-group with tables on top and columns/mapping below — tightly coupled to their respective sides
  - **After**: outer vertical `PanelGroup`; top Panel = horizontal source‑tables | target‑tables; bottom Panel = horizontal COLUMNS (35%) | COLUMN MAPPING (65%) — shared, not owned by either side
  - Source and target panels now contain only: connection header + search box + tables list
  - COLUMNS panel (bottom-left): shows columns for the selected source table + Records preview — unchanged content, new position
  - COLUMN MAPPING panel (bottom-right): mapping editor only; header updated to show `source.schema.table → target.schema.table` breadcrumb
  - TARGET RECORDS section removed entirely (was a duplicated records view inside the target panel)
  - Resize handles: horizontal row-resize between top/bottom panels; vertical col-resize between columns/mapping
  - File: `src/pages/migration.tsx`; `tsc --noEmit` clean
  - Status: done

- **fix** — Normalizer DB picker: support MySQL + PostgreSQL
  - Removed PG-only filter (`c.db_type === 'postgres'`); connection dropdown now shows all saved connections
  - `<optgroup>` groups connections by type (PostgreSQL / MySQL)
  - `connPayload()` helper maps `db_type === 'postgres'` → `type: 'postgresql'`, else `type: 'mysql'`
  - State renamed from `pgSchemas/pgSchema/pgTables/pgTable` → `dbSchemas/dbSchema/dbTables/dbTable`
  - `tsc --noEmit` clean; file: `src/pages/normalizer.tsx`
  - Status: done

- **revision** — Normalizer page: navbar + sub-header tab bar
  - **Navbar**: clean title + Reset button + Home › Normalizer breadcrumb — matches other modules exactly
  - **Sub-header strip** (sticky below navbar): DB picker on left | step tabs on right
    - DB picker: PG connection → schema → table dropdowns + Load button; shows progressively as selections are made
    - Step tabs: Upload | Profile | Schema | Export with `border-b-2 border-blue-500` active style (same as schema-explorer); done steps show ✓ icon; inaccessible steps are dimmed + disabled
    - Active source badge (right of sub-header): shows sheet name + row count once data is loaded
  - StepIndicator circle component no longer used in page render (tabs replace it visually)
  - `tsc --noEmit` clean; file: `src/pages/normalizer.tsx`
  - Status: done

- **revision** — Normalizer page: header redesign + DB connection picker
  - Header rebuilt to match other modules: `px-4 py-2.5`, icon + title, separators, steps inside header, breadcrumb nav (Home → Normalizer)
  - DB connection picker added (leftmost, PG-only): connection → schema → table dropdowns; schema list auto-loads on connection pick, table list on schema pick; Load button fetches up to 5000 rows via schema-explorer APIs, packages as JSON and passes to `/api/normalizer/parse`
  - `StepIndicator` moved from main content into header (centred)
  - `Reset` button replaces "New File" (outline style, right side of header)
  - Active-source badge + step breadcrumb remain in main content area
  - `tsc --noEmit` clean; file: `src/pages/normalizer.tsx`
  - Status: done

- **implement** — AlertDialog system + unsaved-changes guard
  - Installed `@radix-ui/react-alert-dialog`
  - `src/components/AlertDialog.tsx` — reusable dialog with 4 variants: `confirm` (blue), `warning` (amber), `destructive` (red), `error` (red, OK-only, no cancel)
  - `src/lib/alert-context.tsx` — `AlertProvider` + `useAlert()` hook exposing `showConfirm()`, `showWarning()`, `showError()`; single dialog instance mounted at app root
  - `src/hooks/useUnsavedGuard.ts` — intercepts `routeChangeStart`, aborts navigation, shows confirm dialog; also handles browser tab close via `beforeunload`; if confirmed, resumes navigation to the originally intended URL
  - `src/pages/_app.tsx` — wrapped with `<AlertProvider>` inside `<AuthProvider>`
  - `src/pages/migration.tsx` — `useUnsavedGuard(dirty, message)` active; `showError` + `showWarning` imported for API error feedback
  - Toast (sonner) unchanged — still used for success responses
  - `tsc --noEmit` clean
  - Status: done

- **revision** — Light mode: Mist / Sage theme
  - Replaced pure white/gray light mode with a subtle sage-tinted palette (barely perceptible green tint, feels softer not green)
  - `tailwind.config.js`: extended `gray` palette with sage values (gray-50 #f4f6f4 → gray-950 #0b150b); dark mode unaffected (uses slate-*)
  - `globals.css`: body canvas → `#edf0ed`; `bg-white` panels → `#f4f6f4` in light mode; dark mode `bg-white` override unchanged
  - No component changes needed — all existing `bg-gray-*`, `text-gray-*`, `border-gray-*` classes pick up the tint automatically
  - Status: done

- **revision** — Column mapping table — TGT NAME, TGT TYPE label, CONV PG casts, button layout
  - **TGT NAME column** (new, after Tgt Col): shows "keep" text-button by default; click to enter rename mode — amber input + ×-revert button; `targetName: string | null` added to `ColumnMap` type
  - **TGT TYPE**: changed from editable input to read-only label — auto-updated by Tgt Col selection or Conv change
  - **CONV**: extended `IdConversion` union + select now has `<optgroup label="Cast to PG type">` with →TEXT, →INT, →BIGINT, →NUMERIC, →BOOL, →TIMESTAMPTZ, →DATE, →JSONB; each cast updates `targetType` automatically
  - **"+ Add target-only column"**: moved to right-aligned outline button (violet border, hover fill)
  - Files: `src/lib/migv2/types.ts`, `src/pages/migration.tsx`; `tsc --noEmit` clean
  - Status: done

- **implement** — Column mapping table header tooltips
  - Installed `@radix-ui/react-tooltip`; created `src/components/Tooltip.tsx` (Radix-based, Tailwind-styled, arrow + fade-in animation)
  - Each column mapping header (`Src Col`, `Src Type`, `Tgt Col`, `Tgt Type`, `Conv`, `FK Ref`, `✓`) now has a dashed underline and tooltip on hover
  - Tooltip content: full column name + description + usage example, formatted as multi-line text
  - Empty/arrow columns (`→`, delete) have no tooltip
  - `tsc --noEmit` clean; files: `src/components/Tooltip.tsx`, `src/pages/migration.tsx`
  - Status: done

- **revision** — Migration module layout — 3-row vertical split
  - Final layout: outer vertical `PanelGroup` with **3 Panels** — Tables (top), Column Mapping (middle, full width), Records (bottom, full width)
  - Top Panel: horizontal source | target table panels — connection header + search + table list only
  - Middle Panel (Column Mapping, 38%): full-width mapping editor; PK/FK/NN badges merged inline into Src Col cell; breadcrumb `source → target` in header
  - Bottom Panel (Records, 22%): full-width source table data preview; source table name in header
  - Removed the previous horizontal inner PanelGroup that paired Records (left) with Column Mapping (right)
  - `tsc --noEmit` clean; file: `src/pages/migration.tsx`
  - Status: done


- **fix** — Migration: job load now fully restores tableMaps, selectedMapId, srcSchema, tgtDefaultSchema, and target table highlight
  - Root cause (source): `loadSrcDbs` + `[srcDb]` effect both called `setTableMaps([])`, overriding `setTableMaps(job.tables)` in `handleLoadJob`
  - Root cause (target): `loadTgtDbs` overwrote the job's target database with the connection default; `[tgtDb]` effect reset `tgtDefaultSchema` to `public` instead of the job's target schema, causing the target table filter to hide the restored table and preventing the highlight
  - Fix (source): `pendingRestoreRef = useRef<MigJob | null>(null)` — `loadSrcDbs` skips tableMaps/colsCache/selectedMapId reset; uses job db; `[srcDb]` effect skips reset, restores tableMaps + selectedMapId + srcSchema in `.then()`, nulls ref
  - Fix (target): `pendingTgtRef = useRef<{ database: string; schema: string } | null>(null)` — `loadTgtDbs` uses job db; `[tgtDb]` effect sets `tgtDefaultSchema` from ref (so filtered table list shows the right schema), nulls ref
  - `handleLoadJob`: handles "same connection already active" fast-path for both src and tgt; otherwise sets refs before triggering effects
  - Files: `src/pages/migration.tsx`
  - Status: done

- **implement** — Migration: export mapping configuration as Markdown
  - Added `handleExportJobMd()`: generates a `.md` file with job name, source/target connection metadata (no password), and a markdown table per `TableMap` showing source column → target column, types, conversion, and include flag
  - Column source types are resolved from `colsCache` (already fetched when table was selected)
  - Download triggered client-side via `Blob` + `URL.createObjectURL` + `<a>` click; filename is `<job-name-slugified>.md`
  - Added "Export MD" button to header bar (disabled when no table maps configured)
  - Files: `src/pages/migration.tsx`
  - Status: done


- **fix** — Migration: column mapping hidden until target table explicitly selected
  - `toggleTable` now initializes `target: { schema: tgtDefaultSchema || '', table: '' }` — no target table is auto-assumed on source click
  - Column mapping header badge (`schema.table` + Truncate) and target preview effect both guard on `selectedMap.target.table !== ''`
  - Column mapping editor body: three states — no source selected → "Select a source table first"; source selected but no target → "Select a target table above to map columns"; both selected → show mapping editor
  - Target preview `useEffect` also checks `selectedMap.target.table` before fetching to avoid spurious API calls with empty key
  - Files: `src/pages/migration.tsx`
  - Status: done

- **revision** — Migration: target table selection + real column mapping
  - Added `tgtColsCache: Record<string, MigColumnInfo[]>` state to cache target table column metadata
  - Added `tgtColsForSelected` derived value (lookups from `tgtColsCache` for current map's target)
  - Added `selectTargetTable(schema, table)` — updates `selectedMap.target`, fetches target columns (if not cached), refreshes target preview; allows any target table to be assigned as migration destination for the current source map
  - Target table list: all rows clickable when a source map is active; click calls `selectTargetTable` if `selectedMapId` is set, else `setSelectedMapId` for existing mappings; added "target" badge for current target, "assign" hint on hover for unmapped rows, preserved "mapped" badge for cross-mapped tables
  - Target preview `useEffect` extended to also fetch target column metadata (`/api/migv2/columns`) on map selection change
  - Column mapping editor: target col cell replaced with `<select>` dropdown populated from `tgtColsForSelected` when available; selecting a target col auto-fills `targetType` from that column's `rawType`; falls back to text input when target columns not yet fetched
  - Files: `src/pages/migration.tsx`
  - Status: done

- **revision** — Migration: remove schema/table dropdowns from Column Mapping header
  - Replaced schema select + dot + table select/input in the Column Mapping separator with a readonly `schema.table` label — target DB and schema are already chosen in the target connection panel, so the extra pickers were redundant
  - Kept only the Truncate checkbox alongside the label
  - Files: `src/pages/migration.tsx`
  - Status: done

- **fix** — Migration records panel: scrollbar position and column width
  - Removed nested `<div className="overflow-x-auto">` wrapper from both source and target records sections — the horizontal scrollbar was appearing at the bottom of the *content* (below the last row) instead of the bottom of the *visible container*; now the single `overflow-auto panel-scroll` container handles both axes so the scrollbar sits at the container edge and shows on hover
  - Removed `w-full` from both records `<table>` elements so table columns size to their content (`whitespace-nowrap` on cells already prevents wrapping); table expands naturally to fit data, container scrolls horizontally
  - Removed ineffective `max-w-[120px]` from `<td>` cells (auto table layout ignores `max-width`)
  - Files: `src/pages/migration.tsx`
  - Status: done

- **fix** — Preview API: MySQL qualified table name, PG identifier quoting, BigInt safety
  - MySQL query changed from `` `table` `` to `` `schema`.`table` `` — tables API returns `TABLE_SCHEMA` as the schema (database name), which may differ from `conn.database`, so the simple form queried the wrong database
  - PostgreSQL identifier quoting replaced `JSON.stringify(s)` (JSON string hack) with a proper `pgIdent(s)` helper that double-quotes identifiers and escapes embedded `"` by doubling them
  - Added `sanitize()` helper on both PG and MySQL branches: converts `BigInt` column values to `String` so `JSON.stringify` doesn't throw (mysql2 returns BIGINT columns as JS `BigInt` by default)
  - Files: `src/pages/api/migv2/preview.ts`
  - Status: done

- **fix** — Migration module: inline records immediate population + scrollbar visibility
  - **Records delay fix**: `toggleTable` now creates a placeholder map with empty columns and calls `setTableMaps` + `setSelectedMapId` synchronously (before the async column fetch). The preview `useEffect` fires immediately on table click, not after column fetch completes. After columns arrive, `setTableMaps` patches only the `columns` field on the existing map entry
  - **Column mapping loading state**: added `loadingCols && selectedMap.columns.length === 0` guard in the column mapping editor to show "Loading column mapping…" instead of empty table while columns are in flight
  - **Scrollbar visibility**: added `.panel-scroll` CSS class to `globals.css` (same hover-reveal pattern as `.sidebar-scroll`; adds `height: 5px` for horizontal scrollbars too); applied to all scrollable panel divs in `migration.tsx` — source/target table lists, columns, records, column-mapping editor, jobs panel, run-console progress and logs
  - Files: `src/pages/migration.tsx`, `src/styles/globals.css`
  - Status: done

- **revision** — Migration module: inline record preview (replaces modal)
  - Removed `PreviewModal` component, `Eye` lucide import, `openPreview()` function, and all modal-related state (`previewOpen`, `previewLabel`, `previewLoading`, `previewCols`, `previewRows`)
  - Removed hover Eye-icon buttons from both source and target table rows
  - Added `srcPreviewCols/Rows/Loading` + `tgtPreviewCols/Rows/Loading` state
  - Two `useEffect` hooks on `selectedMapId`: auto-fetch source records via `POST /api/migv2/preview` using `srcConn` + `selectedMap.source.schema/table`, and target records using `tgtConn` + `selectedMap.target.schema/table`; both clear on deselect
  - Source panel lower Panel: columns list uses `flex-[2]`, records section below uses `flex-[3]` with "Records" separator header (row count / loading spinner) + sticky-header inline table
  - Target panel lower Panel: column mapping editor uses `flex-[2]`, "Target Records" section uses `flex-[3]` with same inline table pattern
  - Module-level `fmtVal()` helper (replaces per-component `fmt`): truncates strings >60 chars, renders NULL in muted italic, JSON-stringifies objects
  - Files: `src/pages/migration.tsx`, `src/pages/api/migv2/preview.ts` (kept, no changes)
  - Status: done

- **revision** — Migration module: revert sync resize, add record preview
  - **Reverted sync resize**: removed `usePanelRef`, `PanelSize`, sync refs/handlers (`onSrcTablesResize`, `onTgtTablesResize`, `isSyncing`); both source and target panels now resize independently (individual `PanelGroup orientation="vertical"`)
  - **Record preview**: new API `POST /api/migv2/preview` accepts `{ conn: ExplorerConn, tableKey, limit? }`, queries `SELECT * FROM ... LIMIT N` (PG uses quoted schema.table, MySQL uses backtick table in connected db), returns `{ columns, rows }` capped at 200 rows; `PreviewModal` component renders sticky column-header table with row numbers, truncates values >60 chars, shows NULL in muted italic; `Eye` icon button appears on hover for every row in both source and target table lists; clicks `openPreview()` which fetches data and opens modal; clicking backdrop closes
  - Files: `src/pages/migration.tsx`, `src/pages/api/migv2/preview.ts` (new)
  - Status: done

- **revision** — Migration module: synced resize, Migrate button outline, target table search
  - **Synced vertical resize**: source and target panels' tables/columns split is synchronized — dragging one handle moves both; implemented with `usePanelRef()` (`panelRef` prop) + `onResize: (PanelSize) => void` callbacks; `isSyncing` ref prevents infinite feedback loop; both panels now start at `defaultSize={50}`
  - **Migrate button**: changed from solid `bg-blue-600` to outline variant (`border border-blue-500 text-blue-600 bg-transparent hover:bg-blue-50`)
  - Files: `src/pages/migration.tsx`
  - Status: done

- **revision** — Migration module: target table list, search fields, vertical resize handles
  - Added `tgtSearch` state + search input in target panel (same style as source, focus ring violet)
  - Target panel "Tables" section now shows actual target DB tables (`filteredTgtTables` derived from `tgtTables`, filtered by `tgtDefaultSchema` when PG, and by `tgtSearch`); tables with an existing source→target mapping show a violet "mapped" badge and a checkbox (include/exclude); clicking a mapped table selects the mapping (shows column editor); unmapped tables are read-only/dimmed
  - Replaced `flex-[3]/flex-[2]` static split with nested `PanelGroup orientation="vertical"` inside both source and target panels; horizontal `PanelResizeHandle` (`cursor-row-resize`, blue for source, violet for target) between tables panel and columns/mapping panel; each sub-panel has `minSize={15}` to prevent full collapse
  - Files: `src/pages/migration.tsx`
  - Status: done

- **revision** — Migration module: full UI overhaul — 3-panel layout, remove tabs
  - Removed "Jobs" and "Execute" tabs; page is now a single flat layout with no tab bar
  - **Source panel** (left, blue accent): connection picker → DB picker → schema picker (PG only, auto-detected) → flat table list with search + checkboxes; separator + source columns read-only view (name, type, PK/FK/NN badges) for selected table
  - **Target panel** (right, violet accent): connection picker → DB picker → schema picker (PG only, `tgtDefaultSchema`) → mapped tables list (source→target pairs, include checkbox); separator + column mapping editor (same as old "Column Mapping" tab but now inline) with per-row target schema/table pickers + truncate checkbox
  - **Saved Jobs panel** (collapsible right sidebar, `w-60`/`w-9`): toggles with chevron button; collapsed state shows vertical "Saved Jobs" label; lists all saved jobs with load/delete; active job highlighted
  - **Run console** (bottom drawer, `h-260px`): appears when `currentRun` is set; shows status badge, row counts, rollback + export-md buttons, per-table progress bars + live log terminal; dismissed with X button
  - Source panel uses `srcSchema` state (auto-set to first schema on table load) to filter tables; schema picker only shown for PG sources
  - Replaced `expandedSchemas` tree with flat filtered table list; removed `activeTab` state and `ActiveTab` type
  - Used `react-resizable-panels` PanelGroup (orientation="horizontal") for source + target; jobs panel uses CSS `transition-[width]` for collapse animation
  - Files: `src/pages/migration.tsx`
  - Status: done

- **fix** — Sync: remove dual DB/Schema panel state, clean up TypeScript errors
  - Cancelled dual DB/Schema panel mode: source and target use identical DB/schema, so separate selection is unnecessary; reverted `DatabasePanel` and `SchemaPanel` to single-mode signatures
  - Removed `tgtSchema` and `tgtDb` state variables; `tgtConnId` remains for target connection selection
  - Removed leftover dual-mode props (`tgtConn`, `tgtValue`, `onTgtChange`, `tgtDatabase`) from `DatabasePanel` and `SchemaPanel` render calls
  - `handleSync` now passes `database` (not `tgtDb`) for both source and target in `connToCfg`; `saveHistory` likewise uses `database` for `target_db`
  - `canRun` for sync: removed `tgtDb` guard, now `tgtConn && conn.db_type === tgtConn.db_type`
  - `ConnectionsPanel` `onTgtChange` simplified to just `setTgtConnId(id)`
  - Files: `src/pages/export-import.tsx`
  - Status: done

- **revision** — Sync: cross-DB alert, dual DB/Schema panels, per-table progress bar
  - **Cross-DB alert dialog** (`CrossDbAlertModal`): fires via `useEffect` + ref when source and target connection DB types differ (MySQL↔PostgreSQL); modal shows both types with arrow, explains to use Migration module; dismissed with "OK, understood"; `canRun` is also blocked at the Sync button level (`conn.db_type === tgtConn.db_type`)
  - **Dual DB & Schema panels for sync**: `DatabasePanel` extended with optional `tgtConn/tgtValue/onTgtChange` props; renders "Source DB" (purple) + "Target DB" (violet) sections when in sync mode; each section loads its own database list independently via `fetchDbs()`; similarly `SchemaPanel` extended with `tgtConn/tgtDatabase/tgtValue/onTgtChange`; renders "Src Schema" (teal) + "Tgt Schema" (violet) split; PG-only restriction applies per-section; "All schemas" option present in both; new state added: `tgtSchema`
  - **Sync progress bar**: `syncProgress` state `{ current, total, label }`; `handleSync` rewritten to iterate per-table (one API call per table), updating progress before/after each; progress bar (0–100%) appears on the selected target database row in the DB panel (violet bar below the db button); percentage shown as text; bar animates with `transition-all duration-300`; `setSyncProgress(null)` on completion
  - **Removed**: `DatabaseSyncSelect` component (replaced by DatabasePanel dual mode); "Target Database" section from Panel 4 (was redundant); `typeMismatch` derived variable (replaced by ref-based useEffect)
  - Files: `src/pages/export-import.tsx`
  - Status: done

- **revision** — Export & Import: extend resizable to panel 4 + dual-connection panel for sync
  - **Panels 2–3–4 resizable**: merged the fixed `w-80` PanelGroup wrapper into a single `flex-1` `PanelGroup` covering Panel 2 (DB), Panel 3 (Schema), and Panel 4 (Tables+Workspace); added a second `PanelResizeHandle` between panels 3 and 4; default sizes: DB=24%, Schema=18%, Tables=58%; removed `border-r` from SchemaPanel (replaced by handle); Panel 4 div gets `border-l` for visual separation
  - **Sync dual-connection panel**: `ConnectionsPanel` now accepts optional `tgtValue` + `onTgtChange` props; when provided (Sync tab only), renders two sections — Source (blue highlight) and Target (violet highlight) — each with the full connection list; target connection select removed from Panel 4's sync section; Panel 4 now only shows "Target Database" selector (`DatabaseSyncSelect`) + type-mismatch warning
  - Files: `src/pages/export-import.tsx`
  - Status: done

- **revision** — Export & Import: 5 UX improvements — toolbar tooltips, tab underline style, resizable panels 2–3, scrollbar on hover, Export outline button
  - **Toolbar button tooltips** (`BtnTip` component): hover tooltip with full name + purpose on S+D ("Schema + Data — DDL and all rows"), Schema ("Schema only — DDL, no row data"), Data ("Data only — INSERT statements, no DDL"), Filter ("WHERE filter — applies a WHERE clause to all data SELECT queries"); tooltips appear below the button; Sync tab's Include buttons share same tooltips
  - **Active tab style**: Export/Import/Sync tab buttons changed from `border-emerald-400 bg-emerald-50` (green border box) to `border-b-2 border-blue-500 text-blue-600` underline style, matching schema-explorer's tab bar convention; `self-stretch` ensures underline aligns with the toolbar bottom border
  - **Resizable panels 2–3**: installed `react-resizable-panels` v4; Panels 2 (Database) and 3 (Schema) are now inside a `<PanelGroup orientation="horizontal">` with a 1px `<Separator>` resize handle that turns blue on hover; wrapped in a `w-80 shrink-0 h-full` container; DatabasePanel and SchemaPanel changed from fixed `w-44`/`w-36` to `w-full h-full`; border-r responsibility moved from DatabasePanel to the PanelGroup wrapper
  - **Scrollbar on hover**: `sidebar-scroll` class was already applied to all panel scroll areas (ConnectionsPanel, DatabasePanel, SchemaPanel, SavedJobsPanel, table list in Panel 4) — confirmed present, no changes needed
  - **Export button outline**: Export run button changed from `bg-blue-600 hover:bg-blue-700 text-white` (solid fill) to `border border-blue-500 text-blue-600 bg-transparent hover:bg-blue-50` (outline); Import and Sync buttons remain solid (emerald/violet)
  - Files: `src/pages/export-import.tsx`, `package.json`
  - Status: done

- **implement** — Normalizer: Guide popover
  - Added `GuidePopover` component in `src/pages/normalizer.tsx` — custom popover (no Radix Popover dependency), click-outside + Escape key to close
  - `? Guide` button placed in the navbar right side (before breadcrumb separator); highlights blue when open
  - 5 sections: How it works, When to apply, Profile step, Schema step, Saved Jobs
  - Content explains the 4-step flow, FK candidate heuristic, lookup table structure, schema panel layout, and localStorage job persistence
  - Popover: `w-[420px]`, `max-h-[70vh]` scrollable, `shadow-xl`, positioned `right-0 top-full` relative to the button
  - Status: done

- **revision** — Normalizer: 3-panel layout with saved jobs + schema split + header actions
  - **Right collapsible panel**: saved jobs panel (`w-60` / `w-8` toggle with CSS `transition-[width]`); shows vertical "SAVED JOBS" label when collapsed; "Save current session" button at top; job list (name, date, step) with Load/Delete per entry; persistence via `localStorage` key `normalizer_jobs` (max 10 jobs, full session data incl. `allRows`)
  - **Left panel min width**: `minSize={18}` on both Profile and Schema left panels to prevent over-collapse
  - **"Build Schema" moved to sub-header**: outline button (`border-blue-300 text-blue-600`) visible only when step=2 and data is loaded; calls existing `handleConfirmSchema()`
  - **"Save & Export" in sub-header**: outline button (`border-green-400 text-green-600`) visible only when step=3; saves session to localStorage then advances to step 4
  - **Schema step layout**: left panel shows lookup tables list; center panel shows main table; `SchemaPreview` component renders below both panels (outside `PanelGroup`) spanning full width of left+center area — `max-h-52` scrollable
  - **New session types**: `NormalizerJob` interface; `handleSaveJob`, `handleLoadJob`, `handleDeleteJob` functions; `savedJobs` + `savedJobsOpen` + `saveError` state
  - Step components split into focused sub-components: `ProfileLeftPanel`, `ProfileRightPanel`, `SchemaLeftPanel`, `SchemaMainPanel`, `SchemaPreview`, `SavedJobsPanel`
  - `tsc --noEmit` clean; file: `src/pages/normalizer.tsx`
  - Status: done

- **revision** — Normalizer: full-width panel layout, no cards
  - Removed `max-w-6xl mx-auto` container constraint — page now fills full viewport width like other modules
  - Page root changed to `flex flex-col h-screen overflow-hidden`; main area is `flex-1 min-h-0 overflow-hidden`
  - ProfileStep replaced with `PanelGroup orientation="horizontal"` (left panel 24% | resize handle | right panel); uses `panel-scroll` for scrollable areas
  - All `bg-white border border-gray-200 rounded-xl` card wrappers removed; sections use flat separator-style headers (`border-b border-gray-200 bg-gray-50`)
  - SchemaStep: flat full-width scrollable layout; lookup table blocks retain border (no rounded/shadow)
  - UploadStep / ExportStep: centered scroll with `flex items-start justify-center py-10`; info block is flat list without card wrapper
  - `tsc --noEmit` clean; file: `src/pages/normalizer.tsx`
  - Status: done

- **revision** — Normalizer: ProfileStep two-panel layout + duplicate row detection
  - Restructured `ProfileStep` from single-column layout to a two-column flex layout
  - **Left panel** (`w-72 shrink-0`): sheet selector (stacked buttons when multiple sheets), Summary card (Rows, Columns, FK Candidates, Duplicate Rows), FK/Lookup suggestions as vertical toggle list, Build Schema button (full width, blue)
  - **Right panel** (`flex-1`): Column Profile table (Column, Type, Nulls, Distinct, Top Values, FK? columns); FK? cell changed to a clickable toggle button
  - **Duplicate row detection**: inline IIFE using `JSON.stringify` on `sheet.allRows`, counts duplicates via `Set`; stat shows rose coloring if >0, green if 0
  - Summary card uses a consistent key/value row pattern with muted label + bold value
  - FK suggestions moved from main content area into left panel vertical list; each suggestion has a toggle button to include/exclude
  - Files: `src/pages/normalizer.tsx`; `tsc --noEmit` clean
  - Status: done

- **revision** — Export & Import: full layout redesign — 5-panel flow, tab header options, Saved Jobs
  - **Layout**: replaced 2-column card layout with a full-screen 5-panel horizontal flow matching schema designer/explorer style; sticky header + toolbar row + panels fill remaining height
  - **Panel 1 (Connection, w-52)**: clickable list of all saved connections with DB type badge (PG/MySQL), host, port; click to select/deselect
  - **Panel 2 (Database, w-44)**: clickable list of databases for selected connection; auto-loads on connection pick; refresh button; `+ New Database…` inline create shown for Import tab only
  - **Panel 3 (Schema, w-36)**: PostgreSQL-only schema list fetched from `/api/schema-explorer/schemas`; "All schemas" default; filters table list in Panel 4; greyed out with "PostgreSQL only" for MySQL; hidden for Import tab
  - **Panel 4 (Tables + workspace, flex-1)**: Export/Sync — scrollable table list with All/Custom checkbox toggle, row counts, >50k amber warning; Import — SQL/Excel input area; SQL result (Export) and execution log (Import/Sync) shown below as collapsible sections; Sync shows inline target connection/database pickers at top of panel
  - **Panel 5 (Saved Jobs, collapsible)**: renamed from History; notch on left edge collapses to w-6 strip; shows tab-filtered history entries with status badge, time, source/target db, table count, format, conflict; delete button per entry; auto-refreshes after each operation via `refreshKey`
  - **Toolbar**: tab buttons (Export/Import/Sync) + tab-specific options inline + run button + Guide popover; Export: Include (S+D/Schema/Data) + Format (SQL/CSV) + Filter toggle; Import: Input mode (SQL/Excel) + Preview button; Sync: Include + Conflict strategy (Insert/Truncate/Upsert); WHERE filter appears as an amber row below toolbar when toggled
  - **GuidePopover**: 5-section guide (Navigation, Export, Import, Sync, Saved Jobs); same style as schema designer guide
  - **State lifted to main page**: all connection, db, schema, table, option state lives in `ExportImportPage`; tab switch resets log/result/error only; connection/db/schema/table selection persists
  - **Table data source**: switched from `/api/export-import/tables` to `/api/schema-explorer/tables` which returns `{ schema, name, rowCount }`; schema filter passed as `schemas[]` param
  - Files: `src/pages/export-import.tsx` (full rewrite)
  - Status: done

- **implement** — Schema Designer: 3 UX enhancements — DDL scrollbar, column header tooltips, ERD Preview
  - **DDL Generator scrollbar**: applied `sidebar-scroll` class to the DDL strip scroll area — scrollbar now only appears on mouseover, matching left panel behaviour
  - **Column header tooltips** (`ColHeaderTip` component): hover tooltip with description + code example on Type, PK, NN, UQ, AI, FK Reference headers; tooltip appears above the sticky thead (z-[200]); FK Reference aligns right, Type aligns left, others centre
  - **ERD Preview modal** (`ErdPreviewModal` / `ErdPreviewInner`): full-screen ReactFlow canvas rendered from current `tables[]` state; uses crow's foot edges (`DesignerErdCrowsFoot`) and hierarchical auto-layout (`computeDesignerErdLayout`); `DesignerErdTableNode` shows column name, type, PK/FK badge; "Back to Designer" button closes modal and returns to full designer state; button added to toolbar between Save and Execute (blue outline); no state is lost when closing
  - Resolved `Node` type conflict between `@xyflow/react` and DOM `Node` — changed `as Node` to `as HTMLElement` in GuidePopover click-outside handler
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: GuidePopover rewritten to reflect current feature set
  - Replaced outdated 7-section guide (Workflow / Navbar / Designer Tab / Column Properties / FK Picker / Import Tab / Execute Tab) with accurate 6-section guide (Workflow / Layout / Left Panel / Column Editor / FK Picker / Save & Execute)
  - Removed Navbar section (connection-free designer has no connection/DB dropdowns in header)
  - Workflow updated: connection-free design-first flow; Execute opens modal to pick connection + DB
  - New Layout section: describes 3-panel layout (left tree, middle DDL strip + column editor, right Saved Jobs with collapsible notch)
  - Left Panel section: Create mode (+ Schema / + Table) and Import SQL mode (source tabs in middle strip → parsed list → Merge)
  - Column Editor section: merged old Designer Tab + Column Properties; includes `+ Add Column` at bottom-right, FK section below; removed MySQL references (AI now PG SERIAL-only)
  - Save & Execute section: Save button dirty tracking, Save Revision label, Schema Assign modal, Execute modal with connection picker, Saved Jobs Load button and chevron log expand
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Explorer: Styled XLSX export + UI polish
  - Refactored XLSX export (`src/pages/api/schema-explorer/export.ts`) with styled workbook: title row, generated timestamp, blue column headers, per-table group rows, alternating data row fill, and outer/inner borders via helper functions (`makeCell`, `setRange`, `THIN`, `MEDIUM`)
  - Column queries batched per connection (single query for all selected tables) instead of one query per table — improves perf on large selections; both PG and MySQL paths updated
  - UI updates in `src/pages/schema-explorer.tsx` and `src/styles/globals.css` to align with new export flow
  - Status: done

## 2026-05-22
- **revision** — Normalizer: duplicate rows preview + smart duplicate detection
  - **Smart duplicate detection**: added `DUP_SKIP_TYPES = new Set(['TIMESTAMP', 'DATE', 'UUID'])` at module level; `defaultColsForDupe(sheet)` helper auto-excludes datetime-type columns and 100%-unique columns (distinctCount ≥ total - nullCount) from duplicate key computation
  - **"Dup" checkbox column in Column Profile table**: each column has a checkbox letting users manually include/exclude it from duplicate comparison; `colsForDupe: Set<number>` state lifted to `NormalizerPage`; `handleToggleColForDupe` toggles individual columns; state resets (via `defaultColsForDupe`) on parse, sheet change, job load, and reset
  - **Duplicate count "Preview" button** in Analysis Summary: clicking it switches the center panel to Duplicate Rows view (`setShowDupes(true)`)
  - **Duplicate rows preview tab in `ProfileRightPanel`**: tab header with "Column Profile" | "Duplicate Rows" tabs; `showDupes` state controls which view renders; duplicate groups computed with `Map<key, string[][]>`, sorted by group size descending; group headers show "× N copies" in rose; excluded columns dimmed with "excl" label
  - `showDupes` state (`useState(false)`) added to `NormalizerPage`; reset to `false` in `handleParsed`, `handleSheetChange`, and `reset`
  - Props wired: `onShowDupes={() => setShowDupes(true)}` into `ProfileLeftPanel`; `showDupes` + `onSetShowDupes={setShowDupes}` into `ProfileRightPanel`
  - `tsc --noEmit` clean; file: `src/pages/normalizer.tsx`
  - Status: done

## 2026-05-21
- **revision** — Schema Designer: Fix Load job restore + remove duplicate Load buttons
  - `handleLoadJob` was silently skipping `setTables` if `parseSqlToTables` returned empty (two nested guards). Removed both guards — now always calls `setTables`, `setDesignerSchemas`, `setSelectedTableId`. Also clears `importParsed`/`selectedParsedId` and switches `designerMode` to `'create'` so loaded tables appear in the tree immediately
  - `JobRunCard`: removed Load button and row-level `onClick={() => onLoad(job)}` — historical run rows now only have the chevron to expand the execution log. Removed `onLoad` prop entirely
  - `JobGroupCard` call site updated: `<JobRunCard>` no longer passes `onLoad`. Top-level Load button on the group card remains as the single load entry point
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: Remove Execute tab, fix Save button visibility, fix Add Column/FK position
  - Removed Execute tab button and `ExecutePanel` render block; removed `activeTab` state, `ActiveTab` type, and `setActiveTab` calls — Execute function is fully handled by the header Execute button + modal
  - Toolbar bar replaces tab bar: shows "Designer" label with table count badge; Save/Execute buttons remain in header right
  - Save button condition widened: now shows when `tables.length > 0 || importParsed.length > 0` (was only `tables.length > 0`, missed import mode before merge)
  - Add Column button and FK Relationships section moved inside the `overflow-auto` scroll container, directly after `</table>` — they now sit immediately below the last column row instead of being fixed to the bottom of the panel
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: ColumnEditorPanel layout — Add Column moved to bottom-right, FK below
  - Removed `+ Add Column` button from the table header row (was between column count label and delete button)
  - Added `+ Add Column` as a right-aligned styled button (`flex justify-end`) in its own footer row, above FK Relationships section
  - Reordered bottom section: Add Column footer → border separator → FK Relationships (was FK → Add Column)
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: DDL Generator shows selected table's DDL; SQL import strip only when no table selected
  - Added `activeParsedTable`, `activeEditTable`, `activeEditTableDdl`, `tableDdlCopied` computed state to `SchemaDesignerInner`
  - Middle panel DDL strip: now shows `activeEditTable`'s DDL whenever any table (tree or parsed list) is selected — works in both create and import mode
  - SQL import strip: only rendered when `!activeEditTable && designerMode === 'import'`
  - Column editor replaced IIFE with direct `activeEditTable` reference; `onUpdate` and `onDeleteTable` route to parsed or main tables depending on `activeParsedTable`
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: Save/Execute in tab header, dirty tracking, schema assign modal, import strip light mode fix, job card cleanup
  - **Import strip dark bg fix**: changed content area from `bg-slate-950` to `bg-gray-50 dark:bg-slate-950`; all text/border/input colors updated to light/dark variants
  - **Save moved to tab header**: removed Save button from Saved Jobs panel; tab header now shows Save + Execute buttons when tables exist. Save turns amber (`border-amber-400 bg-amber-50`) when `loadedJob` is set and current DDL differs from saved state (`isDirty` via `useEffect`)
  - **Execute button**: appears in tab header after job is loaded (`loadedJob !== null`); opens `ExecuteJobModal` with the loaded job
  - **Dirty tracking**: `useEffect` compares `generateDDL(tables)` against `loadedJob.schema_sql`; `handleSaveJob` updates `loadedJob.schema_sql` to reset dirty flag
  - **Schema assign modal** (`SchemaAssignModal`): shown before `SaveJobModal` in import mode when any tables have `schema='public'`; user picks existing schema or enters new one; "Keep public" skips assignment
  - **Job cards**: `JobRunCard` and `JobGroupCard` — removed Run (Play) button; replaced group-level action with Load (FolderOpen); `onExecute` prop removed from both components and all call sites
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: parsed table list UX — no fixed height, clickable, column editor wired
  - Removed `maxHeight: 140` from parsed list; uses `sidebar-scroll overflow-y-auto` with natural flex height (no hard pixel cap)
  - Parsed table rows are now clickable — selected row highlights in emerald; sets `selectedParsedId` state
  - Column editor (below import strip in middle panel) renders the selected parsed table via `ColumnEditorPanel`, with full add/remove/edit column support before merging; updates go back to `importParsed` state via `handleUpdateParsedTable`; delete removes from `importParsed` and clears selection
  - Switching to Create mode or merging clears `selectedParsedId`
  - Empty state hint updates contextually for import mode (no tables vs tables present vs table selected)
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **remove** — Schema Designer: Import tab removed; function consolidated into Designer tab
  - Removed "Import" tab from tab bar (`ActiveTab` now `'designer' | 'execute'`) and removed `ImportPanel` render block
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: left panel mode toggle (Create / Import SQL), multi-source import in middle panel
  - Removed TABLES label from left panel header entirely; replaced with a segmented toggle: "Create" (manual schema → tables) vs "Import SQL"
  - Create mode: shows `+ Schema` and `+ Table` action buttons below toggle; `+ Table` disabled until a schema exists; DDL preview strip hidden — column editor full height
  - Import mode: 200px strip in middle panel shows source tabs (Paste SQL | .sql | CSV | XLSX) + context-sensitive upload/parse button. Content area changes per source: paste textarea, .sql upload dropzone, CSV upload + table name input, XLSX upload dropzone. All sources populate `importParsed` state
  - After parsing/uploading, parsed tables appear in left panel below a dashed "Parsed · N" separator with a Merge button. Merge calls `mergeTables()`, auto-registers schemas, clears state
  - Hover `+` on schema headers conditionally hidden in Import mode via `allowAddTable` prop
  - Fixed TypeScript errors: removed no-longer-valid `onAdd`/`onAddSchema` props from `TableTreePanel` call
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

## 2026-05-20
- **implement** — Schema Designer: 3-panel layout, disabled Add Table until schema exists, DDL in middle panel
  - Designer tab reestructured as 3 panels: Left (schema/table tree, w-56), Middle (DDL preview strip 188px + column editor flex-1), Right (Saved Jobs, collapsible with notch, w-72)
  - Right panel notch: 24px strip on left edge of panel, always visible, click to collapse/expand with ChevronRight/ChevronLeft icon and smooth width transition (`transition-all duration-200`)
  - DDL preview strip in middle panel: always-visible generated SQL (postgresql), auto-updates as tables change (`useMemo`), Copy + Download buttons; lifted state (`ddlText`, `ddlCopied`, `downloadDdl`, `copyDdl`, `groupedJobs`) into SchemaDesignerInner
  - Middle panel empty state: removed "Add a table to get started" + "Add Table" button. Shows contextual hint: create schema first → add table → select table
  - Left panel: `designerSchemas` initial state changed `['public']` → `[]`; "+ Table" button disabled with tooltip "Create a schema first (PostgreSQL standard)" when `schemas.length === 0`
  - Added `ChevronLeft` to lucide imports
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **fix** — Schema Explorer: Print/PNG from Export tab not working, ? Guide position + rewrite
  - Root cause: ERD canvas unmounts when switching tabs, so `captureRef.current` was null on Export tab. Fix: ERD section now always mounted — uses `absolute inset-0 invisible pointer-events-none` when not active tab (preserves DOM dimensions for html-to-image), vs `h-full flex flex-col` when active
  - ? Guide button moved from just-after-tabs to far right of tab bar using `ml-auto` wrapper that also holds the columns context; popover flipped to `right-0` since button is now at edge
  - Guide rewritten in English only; removed Malay text; Export tab entry updated to mention PNG and Print
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: XLSX styling, move Print/PNG to Export tab, fix PNG quality
  - XLSX export kini ada border (thin gray), title row (merged, blue bg, white bold 14pt), generated timestamp row, per-table group header (light blue bg), column header row (blue bg, white bold), alternating row fill, freeze panes — ditulis dengan `cellStyles: true`
  - Print & PNG dipindah dari canvas Export dropdown ke Export tab — Export tab kini ada section "Canvas Image" dengan paper size picker, orientation toggle, Print + Export PNG buttons
  - Canvas Export button dibuang sepenuhnya dari ERD Panel — Panel kini hanya ada Hand/Select toggle, Layout dropdown, dan Zoom pill
  - State `paperSize`, `orientation`, `capturing` dilift ke parent `SchemaExplorer`; ERDInner expose `triggerPng` dan `triggerPrint` via `captureRef` prop (mutable ref pattern — updated setiap render)
  - PNG quality fix: tambah `pixelRatio: 3` dalam `toPng()` call — hasilkan gambar 3× resolution, kandungan node tidak lagi kabur bila zoom in
  - Files: `src/pages/schema-explorer.tsx`, `src/pages/api/schema-explorer/export.ts`
  - Status: done

- **implement** — Schema Explorer: collapsible schema groups, hover scrollbar, search sticky, ? guide
  - Schema groups kini collapsible — chevron toggle (▶/▼) pada setiap schema header; checkbox kekal berfungsi (stopPropagation dari collapse toggle)
  - Search field pindah masuk ke dalam scroll area sebagai sticky header (`top-0 z-20`), schema header sticky pada `top-[38px]` supaya tidak overlap
  - Scrollbar left panel: hidden by default, muncul bila hover menggunakan `.sidebar-scroll` CSS class (`globals.css`)
  - Tab bar kini flush kiri (buang `px-4` outer div), columns context button tambah `pr-4` untuk spacing
  - Tambah `?` (HelpCircle) button sebelah tab buttons — buka popover guide penerangan cara guna Schema Explorer (5 section: Left Panel, Columns, ERD, Select-to-zoom, Export)
  - Buang `React.FC<any>` → `React.FC<{size:number}>` untuk type safety
  - Files: `src/pages/schema-explorer.tsx`, `src/styles/globals.css`
  - Status: done

- **fix** — Schema Explorer: XLSX single-sheet, combined export, auto-zoom bug fix
  - XLSX export diubah: satu query batch untuk semua tables → satu sheet "Schema Overview" (Schema|Table|Column|Type|Nullable|Default|PK|FK|Comment). Sebelum ni N queries + N sheets = lambat untuk schema besar
  - Canvas Export dropdown dikembangkan: kini ada dua section — "Canvas image" (Print/PNG, paper size, orientation) dan "Schema data" (SQL/XLSX toggle + Download button). ERDInner kini terima `exportFormat`, `setExportFormat`, `onExportData`, `exportingData` sebagai props
  - Export tab description dikemaskini: XLSX kini labelled "Schema Overview XLSX — Single sheet, all tables × columns"
  - Auto-zoom bug fix: `onSelectionChange` kini gunakan delay 80ms sebelum `fitView` + 400ms sebelum reset `selectMode` supaya XYFlow sempat compute selection bounds
  - Files: `src/pages/schema-explorer.tsx`, `src/pages/api/schema-explorer/export.ts`
  - Status: done

- **revision** — Schema Explorer: buang ERD header bar, pindah Panel ke top-left
  - Buang schema filter bar (Schema dropdown, "X visible", "Uncheck all") dari ERD tab
  - `visibleKeys` kini guna semua `erdTables` tanpa filter — buang state `erdSchemaFilter`/`setErdSchemaFilter`
  - Panel tukar dari `top-right` ke `top-left`, `items-end` → `items-start`
  - Export dropdown flip dari `right-0` ke `left-0` supaya tak tersembunyi diluar skrin
  - File: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: hover highlight merah, direction icons fix, zoom pill, select-to-zoom
  - Tukar warna highlight dari biru ke merah: border, ring, header TableNode, handle, edge line semua jadi merah masa hover
  - Direction icons diswap supaya match user expectation: ↓=LR (horizontal), ↑=RL, →=TB (menegak), ←=BT
  - Fit + Zoom digabung jadi satu pill: [−] [⊡ Fit] [+]
  - Toggle Hand/Select button sebelah Layout: `Hand` icon = pan mode, `MousePointer2` icon (biru) = select mode; dalam select mode, drag area pilih nodes → auto `fitView` ke nodes terpilih then balik ke pan mode
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **implement** — Schema Explorer: Layout dropdown enhanced + edge toggle + edge hover highlight
  - Layout button tukar jadi dropdown dengan 4 section: Algorithm (Hierarchical/Grid), Direction (LR/TB/RL/BT), Spacing (Compact/Normal/Loose), Sort (Default/Name/Columns/Connections)
  - Edge style toggle dalam Layout dropdown: Crow's foot ↔ Simple arrow — sync via `useEffect` pada `edgeStyle` state
  - Edge hover: `onEdgeMouseEnter`/`onEdgeMouseLeave` pada ReactFlow → `highlightedNodes` set via `HighlightCtx` context
  - `TableNode` baca `HighlightCtx` — border biru + ring glow bila edge hover
  - Floating tooltip muncul di cursor bila hover edge — tunjuk `sourceTable.fromCol → targetTable.toCol`
  - `computeHierarchicalLayout` diupdate: terima `dir`, `spacing`, `sort` params; support LR/TB/RL/BT; flip axis untuk RL/BT
  - Tambah `computeGridLayout` — square-root grid arrangement, sortable
  - `applyLayout` pass semua params secara langsung — button dalam dropdown trigger layout terus tanpa tutup menu
  - File: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: pindah zoom controls (+/-) ke bawah Fit button di top-right
  - Keluarkan `<Controls />` component (bottom-left) — gantikan dengan zoom buttons dalam Panel
  - Panel top-right kini `flex-col items-end`: row atas (Layout, Export, Fit), row bawah (ZoomIn | ZoomOut)
  - Tambah `zoomIn`, `zoomOut` dari `useReactFlow()` hook; tambah `ZoomIn`, `ZoomOut` icons dari lucide-react
  - File: `src/pages/schema-explorer.tsx`
  - Status: done

- **fix** — Schema Explorer: ReactFlow Controls dan MiniMap putih dalam dark mode
  - XYFlow Controls button guna `background: white` dari CSS mereka sendiri — tak ikut Tailwind dark mode
  - Tambah CSS override dalam `src/styles/globals.css` untuk `.react-flow__controls-button`, `.react-flow__controls`, `.react-flow__minimap`, `.react-flow__minimap-mask` bawah `html.dark`
  - Buang `!bg-white dark:!bg-slate-800` dari `<MiniMap>` — kini dikontrol sepenuhnya oleh CSS global
  - Files: `src/styles/globals.css`, `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Designer overhaul: connection-free design, PostgreSQL-only, execute via modal
  - Removed connection selector from page header — designer now works fully locally without any DB connection
  - PostgreSQL-only: removed all MySQL branching from `TableTreePanel`, `ColumnEditorPanel`, `NewTableDialog`, DDL generation
  - Schema/table creation always available — no longer gated behind a connected DB
  - `ExecutePanel` stripped of all connection UI; job history now shows a Play button per group/run
  - `JobRunCard` + `JobGroupCard` — added `onExecute` prop + Play icon button
  - Added `ExecuteJobModal` component — connection + database picker, DDL re-generation, execution log, saves a new run record on completion
  - `ImportPanel` — self-contained connection/db picker for "From DB" section
  - Removed dead code: `SchemaAnalysis` interface, `SchemaAnalysisBadge` component, `NewDbDialog` component, `analyzeSchemaSql` function, `MYSQL_TYPES` constant, `useRouter` import, `Terminal` + `AlertCircle` icons
  - Removed state: `selectedConnId`, `databases`, `selectedDb`, `loadingDbs`, `dbError`, `showNewDb`, `creatingDb`, `newDbError`, `executing`, `execLog`, `lastRunStatus`
  - File: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: load-and-resave flow
  - `handleLoadJob` now sets `loadedJob` state when a saved job is loaded into the designer
  - `SaveJobModal` accepts `defaultName` + `defaultDesc` props — pre-fills job name/description when a job is loaded, so user can save a revision under the same name without retyping
  - Modal shows an info banner when editing a loaded job; Save button label changes to "Save Revision" when the name matches the loaded job
  - File: `src/pages/schema-designer.tsx`
  - Status: done

## 2026-05-19
- **implement** — Migration module v2: full replacement for old multi-page migration flow
  - New lib layer `src/lib/migv2/`: `types.ts`, `type-map.ts`, `job-store.ts`, `run-store.ts`, `runner.ts`
  - Cross-DB support: MySQL ↔ PostgreSQL in both directions (source and target are independently configurable)
  - Serial → UUID conversion: deterministic UUID derived from `sha256(tableNamespace||sourceId)` — no pre-pass needed; FK columns resolved on-the-fly using `fkRef` config
  - Job management: save/load named jobs (JSON in `data/migv2/jobs/`); jobs store connection meta (no passwords) + full table map
  - Chunked streaming execution via advance loop (8s per advance, 500 rows/chunk); run state persisted to `data/migv2/runs/`
  - Rollback: DELETE by stored inserted PKs (up to 5K/table) or TRUNCATE fallback when overflow
  - Export to `migration.md`: full run report with table mapping, column details, rollback SQL
  - API routes under `src/pages/api/migv2/`: `tables.ts`, `columns.ts`, `jobs/index.ts`, `jobs/[id].ts`, `run/start.ts`, `run/advance.ts`, `run/status.ts`, `run/rollback.ts`, `export-md.ts`
  - Page `src/pages/migration.tsx` complete rewrite — connection panel (source + target), source table tree with schema grouping, column mapping editor (per-column type/conversion/FK-ref), Jobs tab, Execute tab with per-table progress bars + live log stream
  - `src/pages/mapping.tsx` and `src/pages/migrate.tsx` → redirect to `/migration`
  - `src/pages/index.tsx` nav card description updated
  - Status: done

- **implement** — Schema Explorer: full replacement for Schema Config module
  - New page `src/pages/schema-explorer.tsx` — connect to any PostgreSQL or MySQL DB; 3-panel layout (connection bar, schema/table tree, tabbed right panel)
  - Left panel: schema tree with table count, row count badges, per-table ERD toggle (Network icon), per-schema "add all to ERD" action, live search filter
  - Columns tab: full column table with type, nullable, default, PK/FK/UNI badges, FK reference, comment
  - ERD tab: `@xyflow/react` canvas with custom `TableNode` nodes (columns listed inline), animated FK edges, Controls + MiniMap + fit-view
  - Export tab: pick SQL (CREATE TABLE migration) or XLSX (data model, one sheet per table + summary); downloads via blob
  - API routes under `src/pages/api/schema-explorer/`: `schemas.ts`, `tables.ts`, `columns.ts`, `export.ts`
  - Shared connection helper `src/lib/explorer-db.ts` — `withPg` / `withMysql` wrappers for ad-hoc connections
  - `src/pages/schema-config.tsx` replaced with redirect to `/schema-explorer`
  - `src/pages/index.tsx` nav card updated (Schema Explorer, Network icon, new href)
  - Dependency added: `@xyflow/react`
  - Status: done

- **revision** — Schema Explorer ERD: solid crow's foot edges + hierarchical auto-layout
  - Replaced animated dashed edges with solid `CrowsFootEdge` (custom `BaseEdge` + inline SVG `<marker>`) using `markerUnits="userSpaceOnUse"` for zoom-stable symbols
  - One-to-many: crow's foot (fan) at source FK handle, single bar at target PK handle; one-to-one when FK column is unique
  - `computeHierarchicalLayout`: BFS reverse-FK traversal assigns depth levels (pure parents left, FK-holding children right); vertical spacing estimated from column count
  - Status: done

- **fix** — Schema Explorer ERD capture: export full canvas, exclude dialog overlay
  - `prepareCapture()` closes print dialog then calls `fitView({ duration: 0 })` before capture so the full schema fits in frame
  - `toPng` `filter` excludes `.react-flow__panel` elements; captures `.react-flow` container directly
  - Status: done

- **implement** — Schema Designer: new standalone page (replaces Schema Generator)
  - Page `src/pages/schema-designer.tsx` — full visual schema design tool supporting PostgreSQL & MySQL
  - Connection bar: select saved connection, pick or create a database (with "+ New DB" dialog)
  - **Designer tab**: left table tree (grouped by schema for PG, flat for MySQL) + right inline column editor table. Columns: Name, Type, Length, PK, NN, UQ, AI, Default, FK Reference, Comment. PK rows amber-tinted. Add/delete columns inline.
  - **Import tab** — four import methods:
    - From Database: load live schema via schema-explorer APIs, checkbox-select tables, import column definitions
    - From SQL: paste or upload `.sql`, client-side CREATE TABLE parser, table preview, merge into designer
    - From XLSX/Excel: file upload via existing `excel-parser`, sheet→table mapping, type inference
    - From CSV: file upload, table name input, header+type inference from sample rows
  - **Execute tab** (Schema Generator feature parity):
    - Top: DDL preview (dark terminal) with copy + download buttons
    - Bottom: Seed SQL textarea (dark terminal) — INSERT statements run after DDL; `SeedAnalysisBadge` popover shows rows/table + ID strategy
    - Right panel: connection info, Execute button (runs DDL + seed statements in order), execution log
    - Post-run status banner with "Save Job" shortcut → `SaveJobModal` (job name + description)
    - Job History section: grouped by job name (`JobGroupCard` → `JobRunCard`), expand/collapse, Load button restores tables + seed SQL + clears log, Retry for failed runs
  - SQL analysis badges: `SchemaAnalysisBadge` + `SeedAnalysisBadge` — click-to-open popover with full breakdown
  - Job persistence: reuses `dbt_schema_jobs` table + `/api/schema-generator/jobs` POST/GET endpoints
  - `SchemaJob` interface updated to include `schema_sql`/`seed_sql` fields; GET query expanded to return them
  - All imports use merge strategy: skip tables with duplicate schema.name, append new ones
  - DDL generator: full round-trip support — PG SERIAL types, MySQL AUTO_INCREMENT, FOREIGN KEY constraints, column comments, `CREATE SCHEMA IF NOT EXISTS` for non-public PG schemas
  - Client-side SQL parser: handles `CREATE TABLE [IF NOT EXISTS] [schema.]table (...)`, inline PK/UNIQUE/FK, table-level constraints, type aliases normalisation
  - API routes under `src/pages/api/schema-designer/`: `databases.ts`, `create-db.ts`, `execute.ts`
  - `src/pages/index.tsx` — Schema Designer card added (Columns icon)
  - `src/pages/db-setup.tsx` — replaced with redirect to `/schema-designer`
  - Status: done

- **remove** — Schema Generator tab removed from Schema Explorer
  - Removed `ActiveTab` value `'schema-gen'`; type is now `'columns' | 'erd' | 'export'`
  - Removed all Sg* component definitions, helper types/functions, schema-gen state block, tab button, tab JSX content, and schema-gen modals from `src/pages/schema-explorer.tsx`
  - Schema Generator will be implemented as a standalone page
  - Status: done

## 2026-05-20
- **implement** — Schema Designer: pgAdmin-like UX overhaul — hierarchical tree, FK picker, guide popover
  - **Navbar UX**: New Connection option inside connection dropdown (navigates to `/connections` via `useRouter`); "+ New Database…" option inside DB dropdown; PostgreSQL badge shown only for PG connections
  - **`TableTreePanel`**: hierarchical schema → table grouping for PG (schema headers with expand/collapse, per-schema hover "+" to add table); flat list for MySQL; FK/referenced icons on table rows; "New Schema" button (PG only) + "New Table" button in panel header
  - **`NewSchemaDialog`**: PG-only dialog, sanitizes name to lowercase alphanumeric; adds schema to `designerSchemas` state; DDL generator emits `CREATE SCHEMA IF NOT EXISTS` for non-public schemas at execute time
  - **`NewTableDialog`**: accepts `defaultSchema?` prop so per-schema "+" pre-fills the schema field
  - **`FkPickerModal`**: two-panel visual FK picker — left: table list, right: columns with PK/UQ icons; click column → sets FK as `table.column` and closes modal
  - **`ColumnEditorPanel`**: FK cell shows blue badge (click to reopen picker) + × to clear; "Set FK" button opens picker; relationship summary below column table (Outgoing FKs + Referenced by)
  - **`GuidePopover`**: self-contained English-language guide popover (click-outside closes, 430 px wide, scrollable, 7 sections: Workflow, Navbar, Designer Tab, Column Properties, FK Picker, Import, Execute); replaces old full-screen Malay modal
  - Removed `showGuide` state, old tab bar button, old `GuideModal`/`_GuideModal_UNUSED` function
  - Files affected: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Migration module: navbar redesign + saved-connection pickers for source/target
  - Removed manual `ConnForm` (host/port/user/pass inputs) and `EMPTY_CONN` constant; removed `Eye`, `EyeOff`, `Plug`, `Unplug` icon imports
  - Header redesigned to match other modules: sticky, `backdrop-blur`, title + subtitle left, breadcrumb + action buttons right
  - New connections bar: Source and Target each have a saved-connection dropdown (grouped by PG/MySQL) + a database dropdown; "+ New Connection →" option navigates to `/connections`
  - When a connection is selected → databases auto-loaded via `/api/schema-designer/databases`; when a database is selected → auto-connects (source: fetches tables; target: validates connection)
  - `connRowToMigConn(row, db): MigConn` helper builds the connection object from `ConnectionRow`; `srcConn`/`tgtConn` state updated automatically so start/advance/rollback functions are unchanged
  - `handleLoadJob` now restores `srcConnId`/`srcDb` and `tgtConnId`/`tgtDb` by matching job metadata against saved connections (host + username + type)
  - Files affected: `src/pages/migration.tsx`
  - Status: done

- **fix** — Migration: target schema/table pickers for MySQL→PG mapping
  - Added `tgtSchemas: string[]` and `tgtDefaultSchema: string` state
  - When target PG DB connects, `/api/migv2/tables` response is used to extract distinct schema names; defaults to `public` if present
  - Connections bar: PG-only schema `<select>` (styled blue) appears after the database dropdown once connected; selects the default schema for new table mappings
  - Per-table mapping editor: target schema field is a `<select>` dropdown (populated from `tgtSchemas`) when connected to PG; falls back to free-text `<input>` for MySQL or if schemas not loaded
  - `toggleTable`: target schema now defaults to `tgtDefaultSchema` (for PG targets) instead of copying the MySQL source schema/db name
  - Added `tgtTables: MigTableInfo[]` state; target table field uses `<input>` + `<datalist>` that lists existing tables in the selected target schema — filters dynamically as schema changes; allows typing a new table name
  - Files affected: `src/pages/migration.tsx`
  - Status: done

---

## 2026-04-10
- **implement** — Initial commit: MySQL to PostgreSQL migration tool
  - Base Next.js project scaffold
  - MySQL inspector (`src/lib/mysql-inspector.ts`) — list databases, inspect tables/columns/indexes/FKs
  - PostgreSQL migrator (`src/lib/postgres-migrator.ts`)
  - Migration executor & orchestrator (`src/lib/migration-executor.ts`, `src/lib/migration-orchestrator.ts`)
  - Status: done

---

## 2026-04-12
- **implement** — Complete migration workflow with template, logs, and phase orchestration
  - Migration phases: dry run → mapping → execute
  - Template save/load for migration configs
  - Phase log output per table
  - Status: done

- **fix** — Next.js route types import path
  - Updated `next-env.d.ts` route type references
  - Status: done

- **fix** — Restore file selection handling in footer bar
  - Refined file picker state for config/template restore
  - Status: done

- **implement** — Remove UUID default PK flow from phase 1/2; add remove-table dialog
  - Phase 1 & 2 no longer auto-assign UUID PKs
  - Added dialog to remove tables from migration scope
  - Status: done

- **implement** — `.gitignore` — ignore migration run snapshots and `tsbuildinfo`
  - Status: done

---

## 2026-04-14
- **implement** — Phase 4: allow rerun for selected completed tables
  - User can re-select and re-execute specific completed tables without full restart
  - Status: done

---

## 2026-04-17
- **implement** — Schema Config: UUID PK/FK generate flow with manual parent-child mappings
  - UI to configure which columns become UUIDs
  - Manual mapping editor for parent → child FK relationships
  - Status: done

---

## 2026-04-27
- **update** — General update commit (miscellaneous fixes)
  - Status: done

---

## 2026-05-18
- **implement** — Repository restructured to standard Next.js `src/` layout
  - `pages/` → `src/pages/`, `components/` → `src/components/`, `lib/` → `src/lib/`, `styles/` → `src/styles/`
  - `tsconfig.json` path alias updated: `"@/*": ["./src/*"]`
  - `tailwind.config.js` content paths updated
  - Status: done

- **implement** — JWT authentication (replaces DB-backed opaque sessions)
  - `src/lib/auth-store.ts` — `createAccessToken`, `verifyAccessToken`, `createTokens`, `refreshAccessToken`
  - Access token: short-lived JWT signed with `JWT_SECRET_KEY`, expiry from `JWT_EXPIRATION_TIME` (default 3600s)
  - Refresh token: opaque 64-char hex stored in `dbt_sessions`, expiry from `REFRESH_TOKEN_EXPIRATION_TIME` (default 86400s)
  - `src/lib/auth-context.tsx` — `AuthProvider` with auto-refresh scheduled 60s before expiry, client-side JWT decode
  - New API routes: `POST /api/auth/refresh`, `GET /api/auth/profile`
  - Updated: login, verify-otp, verify, logout, update-account APIs
  - Status: done

- **implement** — Settings page — Email Config + Audit Logs tabs
  - Email Config: SMTP form (host, port, username, password, from_email, from_name), SSL toggle, 2FA toggle, test connection
  - Audit Logs: file list with inline log viewer (Time, Level, Module, Action, Details columns)
  - Status: done

- **implement** — Login dialog — 2FA OTP step
  - 6-digit input with auto-advance, `Mail` icon header, back link
  - Triggered when login response returns `twoFactorRequired: true`
  - Status: done

- **implement** — Footer cleanup
  - Removed: Restore Config, Restore Template, Logs buttons
  - Kept: theme toggle, clock, copyright
  - Status: done

- **update** — Home screen module order & rename
  - Order: Schema Generator → Export & Import → Data Normalization → Schema Config → Migration
  - "DB Setup" renamed to "Schema Generator"
  - Status: done

- **implement** — Settings Account tab — email field
  - Display current email, allow update via `POST /api/auth/update-account`
  - Status: done

- **implement** — README.md created
  - Getting started, JWT secret generation, app structure tree with `src/` layout
  - Status: done

- **implement** — Schema Generator module (`/db-setup`)
  - Pick saved PostgreSQL connection (card picker)
  - Create new DB or select existing from dropdown
  - Upload/paste schema SQL and seed SQL with drag-and-drop
  - Files stored at `UPLOAD_DIR/schema-generator/{username}/{YYYY-MM-DD}/{hex}_{filename}`
  - Execute: schema first, then seed; combined log output
  - Schema SQL analysis badge — tables, indexes, FKs, extensions, enums, triggers (popover)
  - Seed SQL analysis badge — rows per table, ID strategy (uuid/sequential/mixed/none), public schema flag (popover)
  - After execution → SaveJobModal (job name required, description optional)
  - Job history per user in right panel, grouped by job name as sub-list (alter/patch runs)
  - Failed job click → reload full config (connection, target DB, schema SQL, seed SQL) for retry
  - Status: done

- **implement** — Schema Generator API + DB migration
  - `POST /api/pg-create-db` — create new PostgreSQL database via `Client` (outside transaction)
  - `POST /api/schema-generator/upload` — file storage endpoint
  - `GET/POST /api/schema-generator/jobs` — list & create job records
  - `GET /api/schema-generator/jobs/[id]` — fetch single job for config reload
  - `db/migrations/004_schema_jobs.sql` — `dbt_schema_jobs` table
  - Status: done

- **implement** — SQL execute with per-step rollback (`/api/sql-execute`)
  - Each SQL block wrapped in `BEGIN/COMMIT`; error triggers `ROLLBACK`
  - `CONCURRENTLY` keyword detected — runs outside transaction with `[NOTE]` warning
  - Response includes `rolledBack` flag and expanded log lines (`[FAIL]`, `[ROLLBACK]`, `[ERROR]`)
  - Log renderer: green=success, amber=rollback/note, red=error
  - Status: done

---

## 2026-05-20
- **revision** — Schema Explorer ERD: crow's foot edges, hierarchical auto-layout
  - Replaced animated dashed edges with solid crow's foot edges (`CrowsFootEdge` custom component)
  - Crow's foot notation: source (FK table) = bar + three diverging lines (many); target (referenced table) = single bar (one); one-to-one when FK column has `isUnique = true`
  - Uses `getSmoothStepPath` with `borderRadius: 12` for clean right-angle routing; `BaseEdge` + inline SVG `<defs>` markers with `markerUnits="userSpaceOnUse"` for consistent sizing at all zoom levels
  - `computeHierarchicalLayout()` pure function: BFS reverse-FK traversal — "pure parent" tables (only referenced, no FKs) placed leftmost; FK-holder tables placed right based on depth; vertical spacing estimated from column count
  - ERD canvas now auto-layouts on every connect (initial load via `useEffect`)
  - "Layout" button in ERD Panel re-runs the hierarchical layout on demand; `minZoom` lowered to 0.05 to allow full-schema view
  - `edgeTypes = { crowsFoot: CrowsFootEdge }` registered on `<ReactFlow>`
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **fix** — Schema Explorer ERD export: full canvas capture (no dialog overlay, fit all nodes)
  - `handlePng` / `handlePrint` now call `prepareCapture()` before capturing: closes dropdown, calls `fitView({ duration: 0, padding: 0.06 })`, waits 180ms for layout to settle
  - `capture()` passes `filter` to `toPng` to exclude `.react-flow__panel` elements (dialog, Controls, MiniMap) from the image
  - Previously the Export dropdown was still visible in the screenshot and off-screen nodes were not included
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **implement** — Schema Explorer: integrate Schema Generator as new tab
  - New `schema-gen` tab added to Schema Explorer tab bar (FileCode2 icon)
  - Shows PostgreSQL-only notice when connected to MySQL; connect-first prompt when disconnected
  - Context banner in tab shows active connection label + target database
  - All Schema Generator sub-components ported into `schema-explorer.tsx`: `SgPopover`, `SchemaAnalysisBadge`, `SeedAnalysisBadge`, `SgDragDropField`, `SgExcelImportCard`, `SgExcelPreviewModal`, `SgSaveJobModal`, `SgJobRunCard`, `SgJobGroupCard`
  - Helper functions added: `timeAgo`, `analyzeSchemaSql`, `analyzeSeedSql`, `groupJobs`
  - Schema Gen state: `sgSchemaSql`, `sgSeedSql`, `sgSchemaFile`, `sgSeedFile`, `sgRunning`, `sgLog`, `sgLastStatus`, `sgShowSaveModal`, `sgJobs`, `sgExcelTables`, `sgShowExcelPreview`
  - `handleSgRun`: executes Schema + optional Seed SQL via `/api/sql-execute` using the currently connected PG DB; builds per-line log
  - `handleSgSaveJob` / `handleSgLoadJob`: POST/GET `/api/schema-generator/jobs`; loading a job restores SQL fields
  - `loadSgJobs`: GET `/api/schema-generator/jobs` on mount + after save
  - Two-column layout: left = Excel import + Schema SQL + Seed SQL + Execute + log; right = Job History grouped by job name
  - Excel import → `SgExcelPreviewModal` → applies generated schema + seed SQL into text fields
  - Fixed `Node` type collision (ReactFlow's `Node` vs DOM `Node`) by using `HTMLElement` in `SgPopover` click-outside handler
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

---
## 2026-05-20
- **implement** — Schema Explorer: flat grouped table panel, ERD node navigate, print/PNG
  - Left panel rewrite: flat list grouped by schema (no collapsible); schema header has indeterminate "check all" checkbox; `loadSchemas` auto-loads all schemas on connect
  - `toggleSchemaErd`: check/uncheck all tables in a schema at once; individual table checkboxes still work
  - `filteredSchemas` now also matches on table names within schema (not just schema name)
  - ERD `TableNode` header: `ExternalLink` icon button calls `onTableClick` via `onMouseDown` to avoid drag interference
  - ERD node click + `ExternalLink` button both navigate to Columns tab for that table
  - Tab bar Columns context: "ERD" button switches back to ERD tab; table name shown as mono label
  - Print/PNG panel in ERD canvas (top-right): paper size (A4/A3/Letter/Legal), orientation (portrait/landscape), Print opens popup window with `@page` CSS and auto-prints; PNG downloads via `html-to-image`
  - Installed: `html-to-image`
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **implement** — Schema Explorer: Records panel + ERD node → Columns navigation
  - New API `POST /api/schema-explorer/records` — fetches rows with COUNT, LIMIT/OFFSET (max 200), sanitized identifiers; supports PG + MySQL
  - Records panel renders below Foreign Keys in Columns tab — auto-loads on table select, 50 rows/page with Prev/Next pagination, Reload button
  - `null` values rendered as italic `null`; all values coerced to string for display
  - ERD node click (`onNodeClick`) → calls `selectTable(node.id)` → switches to Columns tab and loads columns + records for that table
  - Files: `src/pages/api/schema-explorer/records.ts` (new), `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: minimalist connected indicator
  - Removed "✓ Connected" text label
  - DB type badge changes to green border + small check icon when connected; reverts to blue when disconnected
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: add database picker in header
  - After picking a connection, loads database list via `/api/pg-databases` (PG) or `/api/list-databases` (MySQL)
  - Auto-selects `database_name` from the saved connection if present in list, else first in list
  - `connPayload` now uses the selected database instead of the hardcoded `database_name`
  - Connect button disabled until both connection and database are chosen
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: new navbar UI (matches Schema Generator & Export/Import)
  - Header: sticky, backdrop-blur, `bg-white/95`, icon + title + subtitle on left, breadcrumb nav (Home › Schema Explorer) on right
  - Connection controls (saved connection picker, DB type badge, Connect/Disconnect/Refresh) remain inline between title and breadcrumb
  - Removed `ArrowLeft` back-button pattern
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done

- **revision** — Schema Explorer: replace manual connection form with saved connection picker
  - Removed: DB type toggle, host/port/database/username/password inputs, show-password button
  - Added: `<select>` grouped by PostgreSQL/MySQL listing all `dbt_connections` records (label + database_name)
  - `connToPayload()` helper maps `ConnectionRow` → `ConnPayload` (including `db_type: 'postgres'` → `'postgresql'`)
  - All API calls guard against null `connPayload` (no connection selected)
  - Cleaned unused imports: `ConnForm`, `DbType`, `FkInfo`, `Eye`, `EyeOff`, `useRef`
  - Files: `src/pages/schema-explorer.tsx`
  - Status: done



- **fix** — Import tab: add "Create new DB" to Target database selector
  - New `/api/create-database.ts` — unified PG + MySQL create DB endpoint (auth-protected)
  - `DbSelector` in `export-import.tsx` — added `allowCreate` prop; shows Existing/New toggle; calls new API
  - Only Import tab passes `allowCreate` — Export and Sync tabs unaffected
  - Files: `src/pages/api/create-database.ts` (new), `src/pages/export-import.tsx`
  - Status: done

- **implement** — Export & Import: 8 enhancements
  - **Shared lib** — `src/lib/excel-parser.ts` extracted from db-setup; reused by both Schema Generator and Export & Import
  - **Table row counts** — `listTablesWithCounts()` in `sql-exporter.ts`; `TableSelector` shows row counts + >50k warning badge
  - **Excel import (Import tab)** — SQL/Excel toggle; drag-drop `.xlsx`/`.xls`; `ExcelImportModal` with column type editor → generates INSERT SQL
  - **Dry-run preview** — "Preview" button before import shows statement breakdown (CREATE/INSERT/DROP/TRUNCATE) + destructive warning
  - **WHERE filter (Export)** — Optional per-export filter applied to all SELECT queries; toggled via "Add WHERE filter"
  - **CSV export** — Format picker (SQL/CSV); CSV path zipped client-side via JSZip with one file per table
  - **Conflict strategy (Sync)** — `ConflictPicker`: INSERT only / TRUNCATE+INSERT / Upsert (ON CONFLICT DO NOTHING / INSERT IGNORE)
  - **Operation history** — `dbt_export_history` table; right-side `HistoryPanel` per tab; delete entries; persists across sessions
  - **Large dataset warning** — Tables >50k rows flagged amber in TableSelector
  - Files: `src/lib/excel-parser.ts` (new), `src/lib/sql-exporter.ts`, `src/pages/export-import.tsx`, `src/pages/api/export-import/tables.ts`, `src/pages/api/export-import/export.ts`, `src/pages/api/export-import/sync.ts`, `src/pages/api/export-import/history.ts` (new), `db/migrations/005_export_history.sql` (new)
  - Installed: `jszip`
  - Status: done

## 2026-05-20
- **implement** — Schema Designer: Guide modal
  - `GuideModal` component — scrollable modal dengan 7 sections: Overview, Navbar, Designer Tab, Column Properties (table), FK Relationship Picker, Import Tab, Execute Tab, Tips
  - `HelpCircle` + `BookOpen` icons dari lucide-react
  - Button `Guide` dalam tab bar (kanan, `ml-auto`) — `HelpCircle` icon + label, hover style biru; click buka modal
  - `showGuide` state dalam `SchemaDesignerInner`
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **revision** — Schema Designer: FK/PK relationship picker + schema tree + navbar UX
  - `FkPickerModal` — visual two-panel modal (tables left, columns right); PK/UQ badges on columns; click to set FK; "Remove FK" button; replaces free-text `table.col` input
  - `ColumnEditorPanel` — FK Reference cell changed from text input to button-badge (shows `table.col` as blue badge, click to re-pick, × to clear); relationship summary section below column table showing outgoing FKs and incoming references (tables that point to this table)
  - `TableTreePanel` — hierarchical schema tree for PostgreSQL (schema → tables); per-schema hover "+ Add Table" button; FK indicator icon on tables with outgoing FKs; referenced-by indicator on tables pointed to by others; header split into two rows: title + labeled "New Schema" / "New Table" buttons (PG-only schema button)
  - `NewSchemaDialog` — new dialog for adding a schema node to designer (sanitises name to lowercase alphanumeric); schema tracked in `designerSchemas` state; `CREATE SCHEMA IF NOT EXISTS` generated at DDL time
  - `NewTableDialog` — added `defaultSchema` prop; clicking "Add Table" under a schema pre-fills schema field
  - Navbar: connection dropdown has `+ New Connection →` option (navigates to `/connections`); DB dropdown has `+ New Database…` option (opens NewDbDialog inline, replaces standalone "New DB" button); PostgreSQL badge only appears for PG connections (MySQL connection shows no badge)
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

## 2026-05-19
- **implement** — Export & Import module (`/export-import`)
  - 3 tabs: Export, Import, Sync
  - **Export**: pick connection (MySQL or PG), select database, select tables (all or custom checkbox list), include schema/data/both → SQL dump with copy + download
  - **Import**: pick target connection + database, paste or drag-drop `.sql` file → execute with rollback on failure
  - **Sync**: source connection + database → target connection + database, same DB type only; cross-type (MySQL↔PG) shows warning to use Migration module instead
  - Per-step rollback on import and sync target
  - Status: done

- **implement** — Export & Import API routes
  - `POST /api/export-import/tables` — list tables for any connection (MySQL or PG)
  - `POST /api/export-import/export` — pure-SQL dump generator (PG: `information_schema` + `pg_indexes`; MySQL: `SHOW CREATE TABLE` + `SELECT *`)
  - `POST /api/export-import/import` — execute SQL on target with `BEGIN/COMMIT/ROLLBACK` (PG) or `beginTransaction/commit/rollback` (MySQL)
  - `POST /api/export-import/sync` — export from source then import into target in one call
  - Status: done

- **implement** — `src/lib/sql-exporter.ts` — shared export engine
  - `listTables(cfg)` — unified table listing for both DB types
  - `exportDatabase(cfg, tables, include)` — generates header + per-table DDL + INSERT blocks
  - PG value escaping: NULL, boolean, number, Date, Buffer, object (JSON), string
  - MySQL value escaping: NULL, boolean, number, Date, Buffer, object (JSON), string with backslash handling
  - Status: done

- **implement** — Home screen: Export & Import link activated
  - `href: '/export-import'`, `available: true`
  - Status: done

- **implement** — Schema Generator: Excel import (`/db-setup`)
  - New `ExcelImportCard` — drag-drop / browse `.xlsx`/`.xls`, shown between Step 2 and Step 3
  - New `ExcelPreviewModal` — sheet list sidebar, per-column type editor (10 PG types), nullable toggle, sample data toggle
  - Helper functions: `parseExcelFile` (SheetJS dynamic import), `inferPgType`, `sanitizePgName`, `generateSchemaSqlFromTables`, `generateSeedSqlFromTables`
  - On apply: auto-populates Schema SQL (Step 3) + Seed SQL (Step 4), clears any previous file badges
  - Installed: `xlsx` (SheetJS)
  - Files: `src/pages/db-setup.tsx`, `package.json`
  - Status: done

- **implement** — DEVLOG.md created; CLAUDE.md instruction added
  - All past implementation history recorded by date

## 2026-06-02

- **fix** — Migration: saved jobs now support tables from multiple source databases (follow-up: saving no longer replaces other-DB tables)
  - Root cause: `TableMap.source` only stored `{ schema, table }` with no database context; the runner used a single global `source.database` for all tables; saved jobs stored one `sourceMeta.database`, losing per-table DB provenance on load
  - Added `sourceDatabase?: string` to `TableMap` (also `MigJobTableSummary`) — stamped with the active `srcDb` whenever a table is checked into the mapping
  - Runner (`src/lib/migv2/runner.ts`): `advanceRun` now builds a per-table `tableSource` conn by overriding `database` from `tableMap.sourceDatabase` when it differs from the global source conn; applies to `countRows`, `readChunk`, and `getMaxValue` calls
  - UI (`src/pages/migration.tsx`): `doSaveJob` derives `sourceMeta.database` from the first included table's `sourceDatabase` instead of `srcConn.database`; `toggleTable` stamps `sourceDatabase: srcDb` on new map entries
  - DB badge shown in column mapping header and saved-job table list so the source DB is visible at a glance
  - `src/lib/migv2/job-store.ts`: `listJobs` includes `sourceDatabase` in the summary projection
  - Follow-up fix: removed `setTableMaps([])` and `setColsCache({})` from the `srcDb` change effect — switching DB within the same connection no longer wipes existing table mappings (other-DB tables are preserved); these resets now only happen on `srcConnId` change (different server)
  - Added `srcConnForMap` helper: preview fetches use per-map source DB, not the global `srcConn.database`
  - Follow-up fix: Pending Save list now excludes tables already present in any saved job — `savedJobSourceKeys` memo built from `jobs[].tables[].source`, filtered out of `completedMigratedStates` alongside `savedMigratedSources`
  - Follow-up fix: `doSaveJob` now merges instead of replacing — when updating an existing job, existing tables added via pending-save (different session IDs) are preserved; session `tableMaps` entries replace only their matching IDs; prevents "Save Job" from wiping pending-save tables
  - Follow-up fix: `doSaveJob` now clears pending-save entries after saving — computes `savedSourceKeys` from merged tables and adds matching `accumulatedTableStates` to `savedMigratedSources` (with localStorage sync), so the pending list clears immediately
  - Follow-up fix: `handleSaveMigratedTables` syncs `tableMaps` when saving to the active job — new pending-save tables are merged into the session's `tableMaps` so subsequent "Save Job" clicks see the full table list and won't overwrite them
  - Status: done

- **implement** — Schema Studio: full module revision of Schema Designer
  - Route renamed `/schema-designer` → `/schema-studio`; old route redirects; navbar, index, db-setup, schema-explorer updated; page title updated
  - **PostgreSQL only**: `DbType` reduced to `'postgresql'`; `connToPayload` hardcoded; MySQL DDL branches (`AUTO_INCREMENT`, `ENGINE=InnoDB`, `CHANGE`, `MODIFY COLUMN`, `RENAME TABLE`) removed from `generateDDL` and `generateAlterDDL`; connection pickers filter to `db_type === 'postgres'`
  - **ERD hover highlight**: `DesignerErdCrowsFoot` turns amber + thicker stroke on hover; `DesignerErdTableNode` header turns amber and border glows; `ErdPreviewInner` handles `onEdgeMouseEnter/Leave` by setting `highlighted` on matching edges + nodes via `setEdges`/`setNodes`
  - **Interactive FK creation**: per-column source handles added to `DesignerErdTableNode` (appear on column row hover); `ErdPreviewInner` `onConnect` fires `onFkCreate(sourceTable, colId, targetTable)`; main component `handleFkCreate` updates `tableMaps` — sets `fkRef = targetTable.targetPk` on the dragged column
  - **Scan + Suggest**: new API `src/pages/api/schema-studio/analyze.ts` — scans schema and returns `SchemaSuggestion[]` for missing PK, potential FK by naming convention (`*_id` → target table), nullable PK, `VARCHAR` → `TEXT`, `TIMESTAMP` → `TIMESTAMPTZ`; suggestions panel in right panel with dismiss-per-suggestion; "Scan Suggestions" button appears after schema is loaded
  - **Right panel tabs** (Refactor mode): Jobs / Suggest / ALTER — tab bar replaces single panel; badge counts per tab
  - **Global saved jobs**: `loadJobs` now fetches both schema-generator jobs and migration jobs in parallel; migration jobs shown as read-only reference section in saved jobs panel
  - Files: `src/pages/schema-studio.tsx` (new), `src/pages/schema-designer.tsx` (redirect), `src/pages/api/schema-studio/analyze.ts` (new), navbar, index, db-setup, schema-explorer updated
  - Status: done

- **revision** — Schema Designer: saved jobs panel redesigned to match Migration module style
  - `JobGroupCard` rewritten: compact card (border-highlight for active job), inline rename input, status badge on name row, runs count + timeAgo + target_db meta, expand-to-show-runs, action row with Load / Rename / Delete buttons and `active` pill
  - `isActive` prop added to `JobGroupCard` — highlighted when `loadedJob.job_name === group.job_name`
  - Right panel changed from notch-strip layout to migration-style full-row header with icon, title, count badge, and collapse button; width `w-64` / `w-9`
  - Header adapts to refactor mode (amber Pencil icon, "ALTER SQL" title, statement count)
  - `ExecutePanel` job list updated to same compact card style
  - Files: `src/pages/schema-designer.tsx`
  - Status: done

- **implement** — Schema Designer: Refactor mode (ALTER TABLE diff against live DB)
  - New third mode "Refactor" added alongside Create and Import in `src/pages/schema-designer.tsx`
  - `DesignerColumn` gains `_originalName`, `_fkConstraintName`, `_uniqueConstraintName`; `DesignerTable` gains `_originalName` — all stamped when loading from live DB, never changed, used by diff
  - New `generateAlterDDL(original, current, dbType)` pure function: compares original snapshot vs current state and emits `ALTER TABLE` statements for table rename, column rename, type change, NOT NULL toggle, default change, add/drop UNIQUE, add/drop FK, add/drop column, drop/create table
  - New API `src/pages/api/schema-designer/constraints.ts`: fetches FK and UNIQUE constraint names (PG + MySQL) needed for `DROP CONSTRAINT` statements
  - `loadRefactorSchema()`: loads tables + columns + constraints from live DB, builds `DesignerTable[]` with all `_original*` fields, deep-clones into `originalTables` (immutable) + `tables` (editable)
  - `applyAlterDDL()`: sends `alterStmts` to existing `/api/schema-designer/execute`, shows inline apply log, reloads schema on success to refresh snapshot
  - Right panel in Refactor mode shows ALTER SQL diff, copy button, Apply button, and apply log; falls back to "No changes" badge when schema matches snapshot
  - Left panel in Refactor mode shows connection + DB + schema picker with amber styling; status shows table count after load
  - CLAUDE.md updated with commands section and full module map
  - Status: done

- **revision** — Schema Studio: UX overhaul — remove Create/Import modes, bottom exec console, table list in saved jobs
  - Removed Create / Import mode toggle from left panel; module now only shows the refactor connection picker (Load PG Schema)
  - `activeParsedTable` locked to `null`; `ColumnEditorPanel` always uses live `tables` state and `handleUpdateTable`
  - Empty state message updated to guide user to load a PG schema
  - Toolbar: removed Execute modal button; added inline "Apply Changes" button (amber) that only appears when `refactorLoaded && alterStmts.length > 0`; table count + change count badges added
  - Bottom execution console: `execConsoleLog`, `execConsoleOpen`, `execLogEndRef` state; `applyAlterDDL()` now writes to bottom console and auto-opens it; console shows ok/fail per statement with auto-scroll, close button
  - `extractTablesFromSql()` helper: regex-extracts table names from ALTER/CREATE SQL; used in `JobGroupCard` expanded section to show table list before run history
  - `handleSaveJob`: refactor mode saves `alterText` (ALTER SQL) as `schema_sql` + `target_database` / `connection_label` from refactor connection; non-refactor saves generated DDL
  - `handleLoadJob`: detects ALTER SQL by checking if sql starts with ALTER — skips `parseSqlToTables` in that case
  - `handleSaveClick`: removed import-mode schema-assign check
  - Files: `src/pages/schema-studio.tsx`
  - Status: done
