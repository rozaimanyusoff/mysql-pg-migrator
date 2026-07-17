#!/usr/bin/env node
/**
 * CLI runner for scheduled migration jobs.
 *
 * Usage:
 *   node scripts/run-job.js --schedule-id <id> [--base-url http://localhost:3000]
 *
 * Environment variables:
 *   APP_URL                                Base URL (default: http://localhost:3000)
 *   SCHEDULE_TRIGGER_RETRY_SECONDS          Trigger retry window (default: 900)
 *   SCHEDULE_TRIGGER_RETRY_INTERVAL_SECONDS Delay between retries (default: 15)
 *   SCHEDULE_TRIGGER_REQUEST_TIMEOUT_SECONDS Per-request timeout (default: 15)
 *
 * Exit codes:
 *   0  Migration completed successfully
 *   1  Migration failed or could not start
 */

const http = require('http');
const https = require('https');

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const scheduleId = getArg('--schedule-id');
const baseUrl = getArg('--base-url') || process.env.APP_URL || 'http://localhost:3000';
const timeoutSeconds = Number(process.env.RUN_TIMEOUT_SECONDS || 86400);
const triggerRetrySeconds = Number(process.env.SCHEDULE_TRIGGER_RETRY_SECONDS || 900);
const triggerRetryIntervalSeconds = Number(process.env.SCHEDULE_TRIGGER_RETRY_INTERVAL_SECONDS || 15);
const triggerRequestTimeoutSeconds = Number(process.env.SCHEDULE_TRIGGER_REQUEST_TIMEOUT_SECONDS || 15);
const autoResumeAttempts = Number(process.env.SCHEDULE_AUTO_RESUME_ATTEMPTS || 3);
const schedulerToken = process.env.SCHEDULER_API_TOKEN || '';

if (!scheduleId) {
  console.error('[run-job] Error: --schedule-id is required');
  console.error('  Usage: node scripts/run-job.js --schedule-id <id>');
  process.exit(1);
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(schedulerToken ? { Authorization: `Bearer ${schedulerToken}` } : {}),
      },
    };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(Math.max(1, triggerRequestTimeoutSeconds) * 1000, () => {
      req.destroy(new Error(`Request timed out after ${triggerRequestTimeoutSeconds}s`));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function statusIcon(status) {
  switch (status) {
    case 'completed': return '✓';
    case 'failed': return '✗';
    case 'interrupted': return '⚠';
    case 'running': return '▶';
    case 'pending': return '…';
    case 'aborted': return '■';
    default: return '?';
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  console.log(`[run-job] ${startedAt} — schedule: ${scheduleId}`);
  console.log(`[run-job] App URL: ${baseUrl}`);

  // Retry temporary app/network failures. If the first request was accepted but
  // its response was lost, the API returns activeRunId and this process safely
  // reattaches instead of starting a duplicate run.
  const triggerDeadline = Date.now() + Math.max(0, triggerRetrySeconds) * 1000;
  let runId = null;
  let triggerAttempt = 0;
  while (!runId) {
    triggerAttempt += 1;
    let triggerRes;
    try {
      triggerRes = await request('POST', `${baseUrl}/api/scheduler/${scheduleId}/run`, {});
    } catch (err) {
      if (Date.now() >= triggerDeadline) {
        console.error(`[run-job] Failed to reach app after ${triggerAttempt} attempt(s): ${err.message}`);
        process.exit(1);
      }
      console.error(`[run-job] Trigger attempt ${triggerAttempt} could not reach app: ${err.message}. Retrying in ${triggerRetryIntervalSeconds}s.`);
      await sleep(Math.max(1, triggerRetryIntervalSeconds) * 1000);
      continue;
    }

    if (triggerRes.status === 200 && triggerRes.body?.runId) {
      runId = triggerRes.body.runId;
      break;
    }
    if (triggerRes.status === 409 && triggerRes.body?.activeRunId) {
      runId = triggerRes.body.activeRunId;
      console.log(`[run-job] Trigger was already accepted; reattaching to run ${runId}`);
      break;
    }

    const retryable = triggerRes.status === 429 || triggerRes.status >= 500;
    if (!retryable || Date.now() >= triggerDeadline) {
      console.error(`[run-job] Trigger failed (HTTP ${triggerRes.status}):`, triggerRes.body?.error || triggerRes.body);
      process.exit(1);
    }
    console.error(`[run-job] Trigger attempt ${triggerAttempt} returned HTTP ${triggerRes.status}. Retrying in ${triggerRetryIntervalSeconds}s.`);
    await sleep(Math.max(1, triggerRetryIntervalSeconds) * 1000);
  }

  console.log(`[run-job] Run started: ${runId}`);

  // Poll for completion
  const TERMINAL = new Set(['completed', 'completed_with_issues', 'failed', 'aborted', 'rolled_back']);
  let lastStatus = null;
  let lastTableSummary = '';
  let recoveryAttempts = 0;

  const maxAttempts = Math.max(1, Math.ceil(timeoutSeconds / 5));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(5000);

    let statusRes;
    try {
      statusRes = await request('GET', `${baseUrl}/api/migv2/run/status?id=${encodeURIComponent(runId)}&compact=1`, null);
    } catch {
      process.stdout.write('.');
      continue;
    }

    if (statusRes.status !== 200) continue;

    const run = statusRes.body?.run;
    if (!run) continue;

    if ((run.status === 'interrupted' || run.status === 'failed') && run.interrupted && recoveryAttempts < Math.max(0, autoResumeAttempts)) {
      recoveryAttempts += 1;
      console.error(`[run-job] Server interruption detected; resuming run ${runId} from its saved checkpoint (${recoveryAttempts}/${autoResumeAttempts}).`);
      try {
        const recoveryRes = await request('POST', `${baseUrl}/api/migv2/run/resume`, { runId });
        if (recoveryRes.status === 200 || (recoveryRes.status === 409 && recoveryRes.body?.activeRunId === runId)) {
          lastStatus = null;
          continue;
        }
        console.error(`[run-job] Recovery request failed (HTTP ${recoveryRes.status}):`, recoveryRes.body?.error || recoveryRes.body);
      } catch (err) {
        console.error(`[run-job] Recovery request could not reach app: ${err.message}`);
      }
      continue;
    }

    if (run.status !== lastStatus) {
      lastStatus = run.status;
      console.log(`[run-job] Status: ${run.status}`);
    }

    const tableSummary = run.tableStates
      .map(ts => `  ${statusIcon(ts.status)} ${ts.sourceKey} → ${ts.targetKey} (${ts.rowsMigrated}w/${ts.rowsSource}r)`)
      .join('\n');

    if (tableSummary !== lastTableSummary) {
      lastTableSummary = tableSummary;
      console.log(tableSummary);
    }

    if (TERMINAL.has(run.status)) {
      const elapsed = ((Date.now() - new Date(startedAt).getTime()) / 1000).toFixed(1);
      if (run.status === 'completed') {
        console.log(`[run-job] ✓ Completed in ${elapsed}s — ${run.migratedRows} rows migrated`);
        process.exit(0);
      } else if (run.status === 'completed_with_issues') {
        console.error(`[run-job] ⚠ Completed with issues in ${elapsed}s — review rejected/error rows in Scheduler`);
        process.exit(2);
      } else {
        console.error(`[run-job] ✗ Run ${run.status} after ${elapsed}s`);
        if (run.errors?.length) {
          run.errors.forEach(e => console.error(`  ${e}`));
        }
        process.exit(1);
      }
    }
  }

  console.error(`[run-job] Timed out after ${timeoutSeconds}s waiting for run to complete`);
  process.exit(1);
}

main().catch(err => {
  console.error('[run-job] Unexpected error:', err);
  process.exit(1);
});
