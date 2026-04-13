import type { NextApiRequest, NextApiResponse } from 'next';
import { initializeMigrationRun, advanceMigrationRun } from '../../lib/migration-orchestrator';
import { loadTemplate } from '../../lib/migration-template-store';
import { listRuns, loadRun } from '../../lib/migration-run-store';
import { MigrationConfig, MigrationRunOptions, PgConnectionConfig, SourceConnectionConfig } from '../../lib/types';
import { logApiActivity } from '../../lib/audit-api';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    await logApiActivity(req, 'api_migration_run_start_method_not_allowed', 'warn');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { templateId, config, source, target, options, forceFreshKeys } = req.body as {
    templateId?: string;
    config?: MigrationConfig;
    source?: SourceConnectionConfig;
    target?: PgConnectionConfig;
    options?: Partial<MigrationRunOptions>;
    forceFreshKeys?: string[];
  };

  if (!source || !target) {
    await logApiActivity(req, 'api_migration_run_start_bad_request', 'warn');
    return res.status(400).json({ error: 'source and target are required' });
  }

  try {
    let runConfig: MigrationConfig | null = config ?? null;
    let templateVersion: number | null = null;

    if (templateId) {
      const template = await loadTemplate(templateId);
      if (!template) {
        await logApiActivity(req, 'api_migration_run_start_template_not_found', 'warn', { templateId });
        return res.status(404).json({ error: 'Template not found' });
      }
      runConfig = template.config;
      templateVersion = template.version;
    }

    if (!runConfig) {
      await logApiActivity(req, 'api_migration_run_start_missing_config', 'warn');
      return res.status(400).json({ error: 'Provide templateId or config' });
    }

    const includedKeySet = new Set(
      runConfig.tables
        .filter((t) => t.include)
        .map((t) => `${t.sourceDatabase || 'default'}::${t.mysqlName}`)
    );

    const completedSnapshotByKey: Record<string, { rowsCopied?: number; rowsSource?: number | null; finishedAt?: string }> = {};
    const forceFreshKeySet = new Set((forceFreshKeys ?? []).map((k) => String(k)));
    let resumeFromRunId: string | null = null;
    try {
      const runs = await listRuns(50);
      for (const item of runs) {
        const prev = await loadRun(item.id);
        if (!prev) continue;
        if (templateId && prev.templateId && prev.templateId !== templateId) continue;
        if (templateId && !prev.templateId) continue;
        if (!templateId && prev.templateId) continue;

        const completed = prev.tables.filter((t) =>
          t.status === 'completed' &&
          includedKeySet.has(t.key) &&
          !forceFreshKeySet.has(t.key)
        );
        if (completed.length === 0) continue;

        for (const t of completed) {
          completedSnapshotByKey[t.key] = {
            rowsCopied: t.rowsCopied,
            rowsSource: t.rowsSource,
            finishedAt: t.finishedAt,
          };
        }
        resumeFromRunId = prev.id;
        break;
      }
    } catch {
      // non-blocking fallback: start fresh run
    }

    const run = await initializeMigrationRun({
      config: runConfig,
      source,
      target,
      templateId: templateId ?? null,
      templateVersion,
      options,
      completedSnapshotByKey,
    });

    const advanced = await advanceMigrationRun(run.id);
    await logApiActivity(req, 'api_migration_run_start_success', 'info', {
      runId: advanced.id,
      status: advanced.status,
      tables: advanced.tables.length,
      resumedFromRunId: resumeFromRunId,
      skippedCompleted: Object.keys(completedSnapshotByKey).length,
      forcedFresh: forceFreshKeySet.size,
    });

    return res.status(200).json({
      success: true,
      run: advanced,
      resumedFromRunId: resumeFromRunId,
      skippedCompleted: Object.keys(completedSnapshotByKey).length,
      forcedFresh: forceFreshKeySet.size,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await logApiActivity(req, 'api_migration_run_start_error', 'error', { message });
    return res.status(500).json({ success: false, error: message });
  }
}
