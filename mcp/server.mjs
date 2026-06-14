#!/usr/bin/env node
/**
 * MCP server for mysql-pg-migrator.
 * Exposes migration jobs, runs, and schedules as Claude-readable tools.
 *
 * Register via .mcp.json at the project root, then restart Claude Code.
 * Claude can then call these tools directly in conversation:
 *   "list all migration jobs" → list_jobs
 *   "show errors for run abc123" → get_run_errors
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, '..', 'data', 'migv2');

// ── helpers ───────────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return null; }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

// ── tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_jobs',
    description: 'List all saved migration jobs with name, table count, filter settings, and last updated time.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_job',
    description: 'Get full details of a migration job including all table and column mappings.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Job ID' } },
      required: ['id'],
    },
  },
  {
    name: 'list_runs',
    description: 'List recent migration runs. Optionally filter by job ID. Shows status, row counts, and error count per run.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Filter by job ID (optional)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_run_status',
    description: 'Get detailed status of a migration run including per-table row counts, offsets, and status.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run ID' } },
      required: ['runId'],
    },
  },
  {
    name: 'get_run_errors',
    description: 'Get all errors from a migration run — both global errors and per-table errors with row counts.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run ID' } },
      required: ['runId'],
    },
  },
  {
    name: 'list_schedules',
    description: 'List all cron schedules with cron expression, enabled state, job name, and last run status.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_schedule',
    description: 'Get full details of a cron schedule including last run info.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Schedule ID' } },
      required: ['id'],
    },
  },
  {
    name: 'get_failed_tables',
    description: 'Get a summary of all failed tables across all runs of a specific job, useful for diagnosing recurring failures.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'Job ID' } },
      required: ['jobId'],
    },
  },
];

// ── handlers ──────────────────────────────────────────────────────────────────

function handle(name, args) {
  switch (name) {

    case 'list_jobs': {
      return listDir(path.join(DATA, 'jobs'))
        .map(f => readJson(f)).filter(Boolean)
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .map(j => ({
          id: j.id,
          name: j.name,
          description: j.description,
          version: j.version,
          tableCount: j.tables?.length ?? 0,
          includedTableCount: j.tables?.filter(t => t.include).length ?? 0,
          createdAt: j.createdAt,
          updatedAt: j.updatedAt,
          filterCol: j.filterCol ?? null,
          filterFrom: j.filterFrom ?? null,
          filterTo: j.filterTo ?? null,
          sourceMeta: j.sourceMeta,
          targetMeta: j.targetMeta,
        }));
    }

    case 'get_job': {
      return readJson(path.join(DATA, 'jobs', `${args.id}.json`));
    }

    case 'list_runs': {
      const limit = args.limit ?? 20;
      const runs = listDir(path.join(DATA, 'runs'))
        .map(f => readJson(f)).filter(Boolean);
      const filtered = args.jobId ? runs.filter(r => r.jobId === args.jobId) : runs;
      return filtered
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit)
        .map(r => ({
          id: r.id,
          jobId: r.jobId,
          jobName: r.jobName,
          status: r.status,
          createdAt: r.createdAt,
          startedAt: r.startedAt,
          completedAt: r.completedAt,
          totalRows: r.totalRows,
          migratedRows: r.migratedRows,
          errorCount: r.errors?.length ?? 0,
          failedTableCount: r.tableStates?.filter(ts => ts.status === 'failed').length ?? 0,
          completedTableCount: r.tableStates?.filter(ts => ts.status === 'completed').length ?? 0,
          totalTableCount: r.tableStates?.length ?? 0,
          filterCol: r.filterCol ?? null,
          filterFrom: r.filterFrom ?? null,
          filterTo: r.filterTo ?? null,
        }));
    }

    case 'get_run_status': {
      const run = readJson(path.join(DATA, 'runs', `${args.runId}.json`));
      if (!run) return { error: 'Run not found' };
      return {
        id: run.id,
        jobId: run.jobId,
        jobName: run.jobName,
        status: run.status,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        totalRows: run.totalRows,
        migratedRows: run.migratedRows,
        errors: run.errors,
        filterCol: run.filterCol ?? null,
        filterFrom: run.filterFrom ?? null,
        filterTo: run.filterTo ?? null,
        tableStates: run.tableStates?.map(ts => ({
          sourceKey: ts.sourceKey,
          targetKey: ts.targetKey,
          status: ts.status,
          rowsSource: ts.rowsSource,
          rowsMigrated: ts.rowsMigrated,
          rowsSkipped: ts.rowsSkipped,
          rowsErrored: ts.rowsErrored,
          offset: ts.offset,
          error: ts.error ?? null,
          newWatermark: ts.newWatermark ?? null,
        })),
      };
    }

    case 'get_run_errors': {
      const run = readJson(path.join(DATA, 'runs', `${args.runId}.json`));
      if (!run) return { error: 'Run not found' };
      return {
        runId: run.id,
        jobName: run.jobName,
        status: run.status,
        globalErrors: run.errors ?? [],
        tableErrors: (run.tableStates ?? [])
          .filter(ts => ts.error || ts.status === 'failed')
          .map(ts => ({
            sourceKey: ts.sourceKey,
            targetKey: ts.targetKey,
            status: ts.status,
            error: ts.error ?? null,
            rowsSource: ts.rowsSource,
            rowsMigrated: ts.rowsMigrated,
            rowsErrored: ts.rowsErrored,
            offset: ts.offset,
          })),
      };
    }

    case 'list_schedules': {
      return listDir(path.join(DATA, 'schedules'))
        .map(f => readJson(f)).filter(Boolean)
        .sort((a, b) => {
          if (!a.lastRunAt && !b.lastRunAt) return 0;
          if (!a.lastRunAt) return 1;
          if (!b.lastRunAt) return -1;
          return new Date(b.lastRunAt) - new Date(a.lastRunAt);
        });
    }

    case 'get_schedule': {
      return readJson(path.join(DATA, 'schedules', `${args.id}.json`));
    }

    case 'get_failed_tables': {
      const runs = listDir(path.join(DATA, 'runs'))
        .map(f => readJson(f)).filter(Boolean)
        .filter(r => r.jobId === args.jobId)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      // Aggregate failures across all runs for this job
      const failMap = new Map();
      for (const run of runs) {
        for (const ts of run.tableStates ?? []) {
          if (ts.status !== 'failed') continue;
          const existing = failMap.get(ts.sourceKey);
          if (!existing) {
            failMap.set(ts.sourceKey, {
              sourceKey: ts.sourceKey,
              targetKey: ts.targetKey,
              failCount: 1,
              lastError: ts.error,
              lastRunId: run.id,
              lastRunAt: run.createdAt,
              rowsSource: ts.rowsSource,
              rowsMigrated: ts.rowsMigrated,
            });
          } else {
            existing.failCount++;
          }
        }
      }

      return {
        jobId: args.jobId,
        runsChecked: runs.length,
        failedTables: Array.from(failMap.values()).sort((a, b) => b.failCount - a.failCount),
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── server setup ──────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mysql-pg-migrator', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async req => {
  const { name, arguments: args } = req.params;
  try {
    const result = handle(name, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
