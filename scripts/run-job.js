#!/usr/bin/env node
/**
 * CLI runner for scheduled migration jobs.
 *
 * Usage:
 *   node scripts/run-job.js --schedule-id <id> [--base-url http://localhost:3000]
 *
 * Environment variables:
 *   APP_URL   Base URL of the running Next.js app (default: http://localhost:3000)
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
      headers: { 'Content-Type': 'application/json' },
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function statusIcon(status) {
  switch (status) {
    case 'completed': return '✓';
    case 'failed': return '✗';
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

  // Trigger the run
  let triggerRes;
  try {
    triggerRes = await request('POST', `${baseUrl}/api/scheduler/${scheduleId}/run`, {});
  } catch (err) {
    console.error(`[run-job] Failed to reach app: ${err.message}`);
    console.error(`[run-job] Is the server running at ${baseUrl}?`);
    process.exit(1);
  }

  if (triggerRes.status !== 200) {
    console.error(`[run-job] Trigger failed (HTTP ${triggerRes.status}):`, triggerRes.body?.error || triggerRes.body);
    process.exit(1);
  }

  const { runId } = triggerRes.body;
  console.log(`[run-job] Run started: ${runId}`);

  // Poll for completion
  const TERMINAL = new Set(['completed', 'failed', 'aborted', 'rolled_back']);
  let lastStatus = null;
  let lastTableSummary = '';

  for (let attempt = 0; attempt < 720; attempt++) { // max 1 hour at 5s intervals
    await sleep(5000);

    let statusRes;
    try {
      statusRes = await request('GET', `${baseUrl}/api/migv2/run/status`, null);
    } catch {
      process.stdout.write('.');
      continue;
    }

    if (statusRes.status !== 200) continue;

    const runs = statusRes.body?.runs ?? [];
    const run = runs.find(r => r.id === runId);
    if (!run) continue;

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
      } else {
        console.error(`[run-job] ✗ Run ${run.status} after ${elapsed}s`);
        if (run.errors?.length) {
          run.errors.forEach(e => console.error(`  ${e}`));
        }
        process.exit(1);
      }
    }
  }

  console.error('[run-job] Timed out waiting for run to complete');
  process.exit(1);
}

main().catch(err => {
  console.error('[run-job] Unexpected error:', err);
  process.exit(1);
});
