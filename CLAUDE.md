# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## After every work session

After completing any implementation, revision, fix, update, removal, or plan — **always update `DEVLOG.md`**.

### DEVLOG entry format

```
## YYYY-MM-DD
- **<type>** — <short title>
  - <describe what was done, files affected, decisions made>
  - Status: done | in-progress | planned
```

Types: `implement`, `revision`, `fix`, `remove`, `update`, `plan`

Rules:
- One date heading per calendar day. Append to an existing date block if one already exists for today.
- Each bullet is one logical unit of work (a feature, a fix, a refactor). Do not merge unrelated changes into one bullet.
- Mention key files or API routes changed so the log is navigable without reading the diff.
- If a task is left incomplete, mark `Status: in-progress` and note what remains.

---

## Commands

```bash
npm run dev          # start dev server
npm run build        # production build (run before commit to verify types)
npm run lint         # ESLint via next lint
npm run db:push      # run SQL migration files in db/migrations/ against PG
npm run db:seed      # seed initial data
```

No test runner is configured. Type-check is run as part of `npm run build`.

---

## Project overview

**DB Maintenance Tools** — Next.js 16 Pages Router, TypeScript, Tailwind CSS (dark mode: `class`), PostgreSQL (`pg`), MySQL (`mysql2`).

### Module map

| Route | Purpose |
|---|---|
| `/migration` | Map & migrate tables between any two DBs (MySQL ↔ PG); column mapping, UUID PK conversion, incremental sync, rollback |
| `/schema-designer` | Design schemas visually or from SQL/XLSX/CSV; generates `CREATE TABLE` DDL and executes against live DB |
| `/schema-explorer` | Browse live DB tables/columns/FKs; FK advisor suggests missing constraints; ERD view |
| `/export-import` | Export data to SQL dump; import/sync between environments; dry-run preview |
| `/flow-designer` | Design DB schema from business-process flows (BPMN-style); generates entities, ERD, PG DDL |
| `/normalizer` | Transform raw CSV/XLSX into schema-ready datasets |
| `/audit` | View audit logs of all cross-module operations |
| `/settings` | DB connections, email config, module visibility |

Legacy redirect pages: `db-setup` → `schema-designer`, `migrate`/`mapping` → `migration`, `schema-config` → `schema-explorer`.

### Directory layout

```
src/
  pages/           # Next.js pages + API routes
    api/
      connections/ # CRUD for saved DB connections (ConnectionRow type lives here)
      export-import/
      migv2/       # Migration v2 API: tables, columns, jobs, run/*, jobs/export-sql
      schema-designer/  # databases, execute
      schema-explorer/  # schemas, tables, columns, records, export
      flow-designer/
      schema-generator/ # upload, jobs, jobs/[id]
  components/      # Shared React components (Tooltip, AlertDialog, Navbar, FooterBar, …)
  lib/
    migv2/         # Migration v2 engine: types.ts, runner.ts, job-store.ts, run-store.ts, type-map.ts
    explorer-db.ts # withPg / withMysql helpers used by schema-explorer API routes
    db.ts          # Singleton pg Pool (app's own PG database)
    paths.ts       # UPLOAD_DIR, LOGS_DIR constants
    alert-context.tsx   # showError / showWarning / showConfirm React context
    sql-exporter.ts     # Pure-SQL export engine (PG + MySQL)
  hooks/
    useUnsavedGuard.ts  # blocks navigation when dirty=true (browser unload + Next.js router)
  styles/
data/
  migv2/jobs/      # Saved migration jobs as JSON files (job-store.ts reads/writes here)
  migv2/runs/      # Migration run snapshots (run-store.ts)
  migration/       # Legacy migration run data
db/
  migrations/      # SQL files executed by npm run db:push
```

### Auth

- Access token: short-lived JWT (`JWT_SECRET_KEY`, `JWT_EXPIRATION_TIME=3600`)
- Refresh token: opaque hex stored in `dbt_sessions` (`REFRESH_TOKEN_EXPIRATION_TIME=86400`)
- All protected API routes: verify via `verifyAccessToken(token)` from `auth-store.ts`
- Client: `localStorage` keys `auth_token` + `auth_refresh_token`

### Key conventions

- PostgreSQL DDL/DML inside API routes: wrap in `BEGIN/COMMIT/ROLLBACK` for atomicity.
- `CREATE DATABASE` must use `Client` (not `Pool`) — cannot run inside a transaction.
- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction — detect and skip transaction wrapper.
- MySQL connections: use `mysql2/promise`, `multipleStatements: false` unless importing a dump.
- Saved connections are in `dbt_connections` table, typed as `ConnectionRow` from `src/pages/api/connections/index.ts`.
- `explorer-db.ts` exports `withPg`/`withMysql` helpers for one-shot connections (schema-explorer, migv2). The singleton `db.ts` Pool is only for the app's own PG database.
- File-based stores (`job-store.ts`, `run-store.ts`) use `data/migv2/` directories created at runtime via `fs.mkdirSync(..., { recursive: true })`. Do not import these on the client.
- Alert/confirm dialogs: use `useAlert()` hook (`showError`, `showWarning`, `showConfirm`) — never use `window.alert` or `window.confirm`.
- Unsaved-changes guard: pass `dirty` boolean to `useUnsavedGuard(dirty, message)` in any page that has editable state.

### Migration v2 architecture (`src/lib/migv2/`)

The migv2 system is the most complex part of the codebase. Key concepts:

- **`TableMap`** — per-table mapping config (source schema/table, target schema/table, column mappings, `sourceDatabase` for multi-DB jobs). Stamped with `sourceDatabase` when added so the runner can use the right DB per table.
- **`MigJob`** — persisted to `data/migv2/jobs/<id>.json` via `job-store.ts`. Saving a job **merges** the current session's `tableMaps` with any tables previously added via the pending-save flow (different IDs are kept, same IDs are replaced).
- **`MigRun`** — in-memory run snapshot persisted to `data/migv2/runs/`. The runner advances in chunks of 500 rows per `advanceRun` call (called from `/api/migv2/run/advance` on a 1 s polling loop).
- **`runner.ts`** — builds a per-table `tableSource` conn overriding `database` from `tableMap.sourceDatabase`. Reads source, transforms rows (UUID conversion, type coercions), writes to target. Supports full and incremental (high-water mark) sync.
- **Pending Save** — after a run, completed tables appear in the sidebar. `completedMigratedStates` filters by both `savedMigratedSources` (session Set) and `savedJobSourceKeys` (memo from loaded jobs) so tables already in a job are never re-listed.
