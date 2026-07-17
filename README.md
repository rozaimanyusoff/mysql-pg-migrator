# DB Maintenance Tools

A Next.js web application for database maintenance, migration, and schema management — primarily targeting MySQL-to-PostgreSQL workflows.

---

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL database (for the app's own metadata tables)
- MySQL source database (for migration modules)

### 1. Clone and install

```bash
git clone <repo-url>
cd mysql-pg-migrator
npm install
```

### 2. Configure environment

Create a `.env` file in the project root:

```env
# PostgreSQL connection for the app's own metadata (sessions, users, connections, etc.)
DATABASE_URL=postgresql://user:password@localhost:5432/db_maintenance

# JWT authentication
JWT_SECRET_KEY=your-secret-key-min-32-chars
JWT_EXPIRATION_TIME=3600            # Access token TTL in seconds (default: 1 hour)
REFRESH_TOKEN_EXPIRATION_TIME=86400 # Refresh token TTL in seconds (default: 24 hours)

# Internal Scheduler starts with the persistent Next.js Node server.
SCHEDULER_TIMEZONE=Asia/Kuala_Lumpur
SCHEDULER_POLL_INTERVAL_MS=15000
DISABLE_INTERNAL_SCHEDULER=false # true only when an external scheduler owns triggering
ENABLE_INTERNAL_SCHEDULER_IN_DEV=false # prevents local dev from consuming production-like schedules

# Required only by optional external cron/scheduler calls. Browser UI uses same-origin protection.
SCHEDULER_API_TOKEN=replace-with-a-random-64-character-secret
RUN_TIMEOUT_SECONDS=86400          # Scheduled-run polling timeout (default: 24 hours)
SCHEDULE_TRIGGER_RETRY_SECONDS=900 # Retry temporary app outages for 15 minutes
SCHEDULE_TRIGGER_RETRY_INTERVAL_SECONDS=15
SCHEDULE_TRIGGER_REQUEST_TIMEOUT_SECONDS=15
SCHEDULE_AUTO_RESUME_ATTEMPTS=3  # Resume interrupted scheduled runs from checkpoints

# File storage — audit logs and config snapshots are saved here
UPLOAD_DIR=./public/uploads
UPLOAD_PUBLIC_URL=/uploads
```

**Generating a secure `JWT_SECRET_KEY`:**

Pick any one of these — all produce a cryptographically random 64-character hex string:

```bash
# Node.js (works on macOS, Linux, Windows CMD/PowerShell)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# OpenSSL (macOS / Linux / Git Bash on Windows)
openssl rand -hex 32

# Python — macOS / Linux
python3 -c "import secrets; print(secrets.token_hex(32))"

# Python — Windows (uses 'python' instead of 'python3')
python -c "import secrets; print(secrets.token_hex(32))"
```

Paste the output as the value of `JWT_SECRET_KEY` in your `.env`.

> **Windows users:** All `npm run *` commands work in CMD and PowerShell as-is.
> If you prefer a Unix shell, use [Git Bash](https://git-scm.com/downloads) or
> [WSL](https://learn.microsoft.com/en-us/windows/wsl/install) — both support
> the `openssl` and `python3` alternatives above.

### 3. Bootstrap the database

Create the PostgreSQL database first, then run migrations and seed data:

```bash
# Run all schema migrations
npm run db:push

# Seed default admin user (username: admin / password: admin)
npm run db:seed
```

### 4. Start the app

```bash
npm run dev      # Development
npm run build && npm start  # Production
```

Open [http://localhost:3000](http://localhost:3000). Sign in with `admin` / `admin` and change the password immediately in **Settings → Account**.

### Production Scheduler

Run production as a persistent Node process (`npm start`, normally supervised by systemd, PM2, Docker, or an equivalent service manager). The internal Scheduler starts with that process, so run-once and recurring jobs do not require an open browser or a logged-in user. It checks schedules every 15 seconds by default and catches up an overdue run-once trigger after an application/server restart.

Persist and back up `data/migv2`; it contains schedules, job definitions, run state, and recovery checkpoints. Every app instance that may execute migrations must see the same storage. For horizontally scaled hosts without shared storage, run a single Scheduler-enabled instance and set `DISABLE_INTERNAL_SCHEDULER=true` on the others.

---

## App Structure

```
mysql-pg-migrator/
├── src/                             # All application source code
│   ├── pages/                       # Next.js pages (file-based routing)
│   │   ├── _app.tsx                 # App wrapper — AuthProvider, global styles
│   │   ├── _document.tsx            # Custom HTML document
│   │   ├── index.tsx                # Home — module grid + login dialog
│   │   ├── settings.tsx             # Global settings (connections, email, account)
│   │   ├── audit.tsx                # Audit log viewer
│   │   ├── schema-designer.tsx      # Schema Designer — visual table editor, XLSX/CSV/SQL import
│   │   ├── schema-explorer.tsx      # Schema Explorer — browse DB, ERD, export SQL/XLSX
│   │   ├── schema-config.tsx        # Schema Config — table role & FK mapping
│   │   ├── schema-generate.tsx      # Schema generation — pre-flight + execute DDL
│   │   ├── migration.tsx            # Migration — job setup, table mapping (phases 1–2)
│   │   ├── mapping.tsx              # Column mapping sub-page
│   │   ├── migrate.tsx              # Migration execution (phases 3–4)
│   │   ├── export-import.tsx        # Export & Import — SQL dump, XLSX seed, table sync
│   │   ├── normalizer.tsx           # Data Normalizer — upload CSV/XLSX/JSON, profile, export
│   │   ├── db-setup.tsx             # DB Setup (legacy schema generator entry)
│   │   └── api/                     # API routes (Next.js serverless handlers)
│   │       ├── auth/
│   │       │   ├── login.ts         # POST — validate credentials, issue JWT + refresh token
│   │       │   ├── verify.ts        # POST — verify JWT access token
│   │       │   ├── refresh.ts       # POST — issue new access token from refresh token
│   │       │   ├── logout.ts        # POST — revoke refresh token
│   │       │   ├── verify-otp.ts    # POST — verify 2FA OTP code
│   │       │   ├── update-account.ts # POST — update username / password / email
│   │       │   └── profile.ts       # GET  — current user profile
│   │       ├── connections/
│   │       │   ├── index.ts         # GET list, POST create
│   │       │   └── [id].ts          # PUT update, DELETE, PATCH activate
│   │       ├── email-config/
│   │       │   ├── index.ts         # GET config, POST save
│   │       │   └── test.ts          # POST test SMTP connection
│   │       ├── schema-explorer/     # Schema Explorer API
│   │       │   ├── schemas.ts       # GET schemas for a connection
│   │       │   ├── tables.ts        # GET tables in a schema
│   │       │   ├── columns.ts       # GET columns for a table
│   │       │   ├── records.ts       # GET sample rows
│   │       │   └── export.ts        # POST export SQL or styled XLSX
│   │       ├── schema-designer/     # Schema Designer API
│   │       ├── schema-generator/    # Schema Generator jobs API
│   │       ├── export-import/       # Export / Import / Sync API
│   │       ├── normalizer/          # Data Normalizer API
│   │       │   ├── parse.ts         # POST — parse XLSX/CSV/JSON, return column profile
│   │       │   └── export.ts        # POST — generate SQL/CSV/JSON output
│   │       └── ...                  # Other single-file API routes
│   │
│   ├── components/                  # Shared React components
│   │   ├── FooterBar.tsx            # Fixed bottom bar — theme toggle + clock
│   │   ├── ConnectionBadges.tsx     # Active connection indicator
│   │   └── ...
│   │
│   └── lib/                         # Shared server + client utilities
│       ├── auth-store.ts            # JWT creation/verification, refresh token DB store
│       ├── auth-context.tsx         # React Context — global auth state + auto-refresh
│       ├── db.ts                    # Singleton PostgreSQL pool (hot-reload safe)
│       ├── explorer-db.ts           # withPg / withMysql helpers for Schema Explorer
│       ├── sql-exporter.ts          # Pure-SQL export engine (PG + MySQL)
│       ├── excel-parser.ts          # Browser-side XLSX/CSV parser (exceljs dynamic import)
│       ├── mailer.ts                # Nodemailer wrapper — SMTP config, OTP generation
│       ├── audit-logger.ts          # Daily rotating JSON log files
│       ├── audit-api.ts             # Helper to log API activity
│       ├── paths.ts                 # Resolved UPLOAD_DIR, LOGS_DIR, CONFIG_DIR paths
│       └── normalizer/              # Data Normalizer utilities
│           ├── csv-parser.ts        # RFC-4180 CSV parser
│           └── profiler.ts          # Column profiling + FK suggestion engine
│
├── db/
│   ├── migrations/                  # Sequential SQL migrations (run via npm run db:push)
│   │   ├── 001_init.sql             # dbt_users, dbt_connections, dbt_migrations
│   │   ├── 002_sessions.sql         # dbt_sessions (refresh token store)
│   │   ├── 003_email_otp.sql        # dbt_email_config, dbt_otp_codes, email col on users
│   │   ├── 004_schema_jobs.sql      # dbt_schema_jobs (Schema Generator job history)
│   │   └── 005_export_history.sql   # dbt_export_history (Export/Import/Sync log)
│   └── seeds/
│       └── 001_seed.sql             # Default admin user (admin / admin)
│
├── scripts/
│   ├── db-push.js                   # Apply pending migrations — skips already-applied via dbt_migrations
│   └── db-seed.js                   # Apply seed files (idempotent)
│
├── public/uploads/                  # Runtime file storage (set via UPLOAD_DIR)
│   ├── logs/                        # Daily audit logs (audit-YYYY-MM-DD.jsonl)
│   └── schema/                      # Config/template snapshots saved by modules
│
├── next.config.js
├── tailwind.config.js
├── tsconfig.json
└── .env                             # Environment variables (never commit)
```

---

## Authentication

| Flow | Description |
|------|-------------|
| Login | `POST /api/auth/login` → returns `accessToken` (JWT, 1 hr) + `refreshToken` (opaque hex, 24 hr) |
| 2FA | If enabled in Email Config, login returns `twoFactorRequired: true`; OTP is sent to user's email and verified at `POST /api/auth/verify-otp` |
| Auto-refresh | Client-side `AuthProvider` schedules a token refresh 60 s before access token expiry |
| Logout | Deletes refresh token from `dbt_sessions`; access token expires naturally |

The default account is **admin / admin** (created by `db:seed`). Set an email address in Settings → Account to use 2FA.

---

## Core Database Tables

| Table | Migration | Purpose |
|-------|-----------|---------|
| `dbt_users` | 001_init | App users — username, bcrypt password hash, email |
| `dbt_connections` | 001_init | Saved DB connections (MySQL/PostgreSQL) |
| `dbt_migrations` | 001_init | Tracks which migration files have been applied |
| `dbt_sessions` | 002_sessions | Refresh token store — opaque hex + TTL |
| `dbt_email_config` | 003_email_otp | SMTP settings + 2FA toggle |
| `dbt_otp_codes` | 003_email_otp | One-time codes for 2FA (6-digit, 5 min TTL) |
| `dbt_schema_jobs` | 004_schema_jobs | Schema Generator job history and SQL output |
| `dbt_export_history` | 005_export_history | Export / Import / Sync operation log |

---

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run db:push` | Run all pending schema migrations |
| `npm run db:seed` | Insert seed data (idempotent) |
