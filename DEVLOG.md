# DEVLOG — DB Maintenance Tools

---

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
  - Status: done
