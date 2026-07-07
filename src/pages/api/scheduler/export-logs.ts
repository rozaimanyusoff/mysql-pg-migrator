import type { NextApiRequest, NextApiResponse } from 'next';
import ExcelJS from 'exceljs';
import { loadJob } from '../../../lib/migv2/job-store';
import { listRunsForJob } from '../../../lib/migv2/run-store';

const HEADER_FILL = '312E81';
const TITLE_FILL = '0F172A';
const BORDER_COLOR = 'CBD5E1';

function safeFilename(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'migration-job';
}

function excelText(value: string, limit = 32_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n… truncated`;
}

function durationSeconds(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  return Math.max(0, Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000));
}

function setupSheet(ws: ExcelJS.Worksheet, title: string, subtitle: string, columns: Partial<ExcelJS.Column>[]) {
  ws.mergeCells(1, 1, 1, columns.length);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${TITLE_FILL}` } };
  titleCell.alignment = { vertical: 'middle' };
  ws.getRow(1).height = 28;

  ws.mergeCells(2, 1, 2, columns.length);
  ws.getCell(2, 1).value = subtitle;
  ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF64748B' } };
  ws.getRow(2).height = 22;

  ws.columns = columns;
  const header = ws.getRow(4);
  header.values = columns.map(column => column.header as string);
  header.height = 24;
  header.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${HEADER_FILL}` } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: `FF${BORDER_COLOR}` } } };
  });
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: columns.length } };
}

function finishSheet(ws: ExcelJS.Worksheet) {
  for (let rowNo = 5; rowNo <= ws.rowCount; rowNo++) {
    const row = ws.getRow(rowNo);
    if (rowNo % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    row.alignment = { vertical: 'top', wrapText: true };
    row.eachCell(cell => {
      cell.border = { bottom: { style: 'hair', color: { argb: `FF${BORDER_COLOR}` } } };
    });
  }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).end();
  const { jobId } = req.query as { jobId?: string };
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const job = loadJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const runs = listRunsForJob(jobId);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'DB Maintenance Tools';
  workbook.created = new Date();
  workbook.properties.date1904 = false;

  const generated = new Date().toISOString();
  const summary = workbook.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF4F46E5' } } });
  setupSheet(summary, `${job.name} — Scheduler Run Logs`, `Generated ${generated} · ${runs.length} run(s)`, [
    { header: 'Run ID', key: 'runId', width: 38 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Created At', key: 'createdAt', width: 22 },
    { header: 'Started At', key: 'startedAt', width: 22 },
    { header: 'Completed At', key: 'completedAt', width: 22 },
    { header: 'Duration (s)', key: 'duration', width: 14 },
    { header: 'Tables', key: 'tables', width: 10 },
    { header: 'Completed Tables', key: 'completedTables', width: 17 },
    { header: 'Failed Tables', key: 'failedTables', width: 14 },
    { header: 'Source Rows', key: 'sourceRows', width: 14 },
    { header: 'Migrated Rows', key: 'migratedRows', width: 15 },
    { header: 'Skipped Rows', key: 'skippedRows', width: 14 },
    { header: 'Errors', key: 'errors', width: 10 },
    { header: 'Run Errors', key: 'runErrors', width: 50 },
    { header: 'Run Log', key: 'runLog', width: 80 },
  ]);

  for (const run of runs) {
    summary.addRow({
      runId: run.id,
      status: run.status,
      createdAt: run.createdAt,
      startedAt: run.startedAt ?? '',
      completedAt: run.completedAt ?? '',
      duration: durationSeconds(run.startedAt, run.completedAt),
      tables: run.tableStates.length,
      completedTables: run.tableStates.filter(t => t.status === 'completed').length,
      failedTables: run.tableStates.filter(t => t.status === 'failed').length,
      sourceRows: run.tableStates.reduce((sum, t) => sum + t.rowsSource, 0),
      migratedRows: run.tableStates.reduce((sum, t) => sum + t.rowsMigrated, 0),
      skippedRows: run.tableStates.reduce((sum, t) => sum + t.rowsSkipped, 0),
      errors: run.tableStates.reduce((sum, t) => sum + t.rowsErrored, 0),
      runErrors: excelText(run.errors.join('\n')),
      runLog: excelText(run.logs.join('\n')),
    });
  }
  finishSheet(summary);

  const tables = workbook.addWorksheet('Tables', { properties: { tabColor: { argb: 'FF0EA5E9' } } });
  setupSheet(tables, `${job.name} — Table Results`, `One row per table per run · Generated ${generated}`, [
    { header: 'Run ID', key: 'runId', width: 38 },
    { header: 'Run Created At', key: 'runCreatedAt', width: 22 },
    { header: 'Run Status', key: 'runStatus', width: 14 },
    { header: 'Source Table', key: 'sourceTable', width: 32 },
    { header: 'Target Table', key: 'targetTable', width: 32 },
    { header: 'Table Status', key: 'tableStatus', width: 14 },
    { header: 'Source Rows', key: 'sourceRows', width: 14 },
    { header: 'Migrated Rows', key: 'migratedRows', width: 15 },
    { header: 'Skipped Rows', key: 'skippedRows', width: 14 },
    { header: 'Error Rows', key: 'errorRows', width: 12 },
    { header: 'Progress %', key: 'progress', width: 12 },
    { header: 'Offset', key: 'offset', width: 12 },
    { header: 'Error Detail', key: 'errorDetail', width: 60 },
    { header: 'Table Log', key: 'tableLog', width: 80 },
  ]);

  for (const run of runs) {
    for (const table of run.tableStates) {
      const processed = Math.max(table.offset, table.rowsMigrated + table.rowsSkipped + table.rowsErrored);
      const progress = table.rowsSource > 0 ? Math.min(100, Math.round(processed / table.rowsSource * 100)) : table.status === 'completed' ? 100 : 0;
      const tableLogs = run.logs.filter(line => line.includes(`[${table.sourceKey}]`) || line.includes(`[${table.targetKey}]`));
      const relatedErrors = run.errors.filter(error => error.includes(table.sourceKey) || error.includes(table.targetKey));
      tables.addRow({
        runId: run.id,
        runCreatedAt: run.createdAt,
        runStatus: run.status,
        sourceTable: table.sourceKey,
        targetTable: table.targetKey,
        tableStatus: table.status,
        sourceRows: table.rowsSource,
        migratedRows: table.rowsMigrated,
        skippedRows: table.rowsSkipped,
        errorRows: table.rowsErrored,
        progress,
        offset: table.offset,
        errorDetail: excelText([table.error, ...relatedErrors].filter(Boolean).join('\n')),
        tableLog: excelText(tableLogs.join('\n')),
      });
    }
  }
  tables.getColumn('progress').numFmt = '0"%"';
  finishSheet(tables);

  const buffer = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(job.name)}-scheduler-logs.xlsx"`);
  return res.status(200).send(Buffer.from(buffer));
}
