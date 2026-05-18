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

# File storage — audit logs and config snapshots are saved here
UPLOAD_DIR=./public/uploads
UPLOAD_PUBLIC_URL=/uploads
```

**Generating a secure `JWT_SECRET_KEY`:**

Pick any one of these — all produce a cryptographically random 64-character hex string:

```bash
# Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# OpenSSL
openssl rand -hex 32

# Python
python3 -c "import secrets; print(secrets.token_hex(32))"
```

Paste the output as the value of `JWT_SECRET_KEY` in your `.env`.

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

---

## App Structure

```
mysql-pg-migrator/
├── src/                             # All application source code
│   ├── pages/                       # Next.js pages (file-based routing)
│   │   ├── _app.tsx                 # App wrapper — AuthProvider, global styles
│   │   ├── _document.tsx            # Custom HTML document
│   │   ├── index.tsx                # Home — module grid + login dialog
│   │   ├── settings.tsx             # Global settings (connections, email, account, audit logs)
│   │   ├── db-setup.tsx             # Schema Generator module
│   │   ├── schema-config.tsx        # Schema Config module
│   │   ├── schema-generate.tsx      # Schema generation sub-page
│   │   ├── migration.tsx            # Migration module (phases 1–2)
│   │   ├── mapping.tsx              # Column mapping sub-page
│   │   ├── migrate.tsx              # Migration execution (phases 3–4)
│   │   ├── docs.tsx                 # Generated docs viewer
│   │   ├── audit.tsx                # Audit log viewer page
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
│   │       ├── audit-files.ts       # GET — list daily audit log files
│   │       ├── audit-read.ts        # GET — read entries from a log file or date range
│   │       ├── audit-event.ts       # POST — write a client-side audit event
│   │       ├── pg-test.ts           # POST — test PostgreSQL connection
│   │       ├── inspect.ts           # POST — inspect MySQL databases/tables
│   │       ├── list-databases.ts    # POST — list MySQL databases
│   │       ├── dry-run.ts           # POST — dry-run migration plan
│   │       ├── migrate.ts           # POST — execute migration
│   │       └── sql-execute.ts       # POST — execute raw SQL (DB Setup)
│   │
│   ├── components/
│   │   ├── FooterBar.tsx            # Fixed bottom bar — theme toggle + clock
│   │   ├── ColumnMappingEditor.tsx
│   │   ├── ColumnMappingTable.tsx
│   │   ├── ConnectionBadges.tsx
│   │   ├── DocumentationViewer.tsx
│   │   ├── TableDetail.tsx
│   │   ├── TableList.tsx
│   │   └── TableMappingEditor.tsx
│   │
│   ├── lib/                         # Shared server + client utilities
│   │   ├── auth-store.ts            # JWT creation/verification, refresh token DB store
│   │   ├── auth-context.tsx         # React Context — global auth state + auto-refresh
│   │   ├── db.ts                    # Singleton PostgreSQL pool (hot-reload safe)
│   │   ├── mailer.ts                # Nodemailer wrapper — SMTP config, OTP generation
│   │   ├── audit-logger.ts          # Daily rotating JSON log files
│   │   ├── audit-api.ts             # Helper to log API activity
│   │   ├── paths.ts                 # Resolved UPLOAD_DIR, LOGS_DIR, CONFIG_DIR paths
│   │   ├── mapping-utils.ts         # Column mapping helpers for migration
│   │   └── types.ts                 # Shared TypeScript types
│   │
│   └── styles/
│       └── globals.css              # Global Tailwind CSS
│
├── db/
│   ├── migrations/                  # Sequential SQL migrations (run via npm run db:push)
│   │   ├── 001_init.sql             # dbt_users, dbt_connections, dbt_migrations
│   │   ├── 002_sessions.sql         # dbt_sessions (refresh token store)
│   │   └── 003_email_otp.sql        # dbt_email_config, dbt_otp_codes, email col on users
│   └── seeds/
│       └── 001_seed.sql             # Default admin user
│
├── scripts/
│   ├── db-push.js                   # Reads DATABASE_URL, executes all migrations in order
│   └── db-seed.js                   # Reads DATABASE_URL, executes seed files
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

| Table | Purpose |
|-------|---------|
| `dbt_users` | App users — username, password hash, email |
| `dbt_sessions` | Refresh token store — opaque hex + TTL |
| `dbt_connections` | Saved DB connections (MySQL/PostgreSQL) — one active per type |
| `dbt_email_config` | SMTP settings + 2FA toggle |
| `dbt_otp_codes` | One-time codes for 2FA (6-digit, 5 min TTL) |
| `dbt_migrations` | Migration tracking (records which SQL files have been applied) |

---

## npm Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Next.js dev server |
| `npm run build` | Production build |
| `npm start` | Start production server |
| `npm run db:push` | Run all pending schema migrations |
| `npm run db:seed` | Insert seed data (idempotent) |
