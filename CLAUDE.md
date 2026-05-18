# CLAUDE.md — DB Maintenance Tools

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

## Project overview

**DB Maintenance Tools** — Next.js 16 Pages Router, TypeScript, Tailwind CSS (dark mode: `class`), PostgreSQL (`pg`), MySQL (`mysql2`).

### Directory layout

```
src/
  pages/          # Next.js pages + API routes
    api/
      auth/       # login, logout, verify, refresh, profile, update-account, verify-otp
      connections/# CRUD for saved DB connections
      export-import/ # tables, export, import, sync
      schema-generator/ # upload, jobs, jobs/[id]
  components/     # Shared React components
  lib/            # Server + shared utilities
    auth-store.ts     # JWT access token + opaque refresh token
    auth-context.tsx  # React AuthProvider with auto-refresh
    sql-exporter.ts   # Pure-SQL export engine (PG + MySQL)
    db.ts             # Singleton pg Pool
    paths.ts          # UPLOAD_DIR, LOGS_DIR
  styles/
db/
  migrations/     # SQL migration files (run via npm run db:push)
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
