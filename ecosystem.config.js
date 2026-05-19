module.exports = {
  apps: [
    {
      name: 'db-maintenance-tools',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: __dirname,

      // ── Instances & mode ─────────────────────────────────────────────────
      instances: 1,          // increase to 'max' for cluster mode when ready
      exec_mode: 'fork',     // use 'cluster' if instances > 1

      // ── Environment ──────────────────────────────────────────────────────
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3046,
      },

      // ── Restart policy ───────────────────────────────────────────────────
      autorestart: true,
      watch: false,          // never watch in production — use deploy workflow
      max_restarts: 10,
      restart_delay: 3000,   // ms between automatic restarts
      min_uptime: '10s',     // must stay up at least this long to count as stable

      // ── Memory guard ─────────────────────────────────────────────────────
      max_memory_restart: '512M',

      // ── Logging ──────────────────────────────────────────────────────────
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,

      // ── Startup ──────────────────────────────────────────────────────────
      wait_ready: false,
      listen_timeout: 8000,
      kill_timeout: 5000,
    },
  ],
};
