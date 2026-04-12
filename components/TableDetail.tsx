import React from 'react';
import { MySQLTable } from '../lib/types';
import { Link, ArrowRight, BadgeCheck, XCircle, RotateCcw, CheckCircle } from 'lucide-react';
import ColumnMappingTable from './ColumnMappingTable';

interface Props {
  table: MySQLTable;
  database: string;
  isDone?: boolean;
  isExcluded?: boolean;
  onDone?: () => void;
  onExcludeTable?: () => void;
  onUndoStatus?: () => void;
}

export default function TableDetail({ table, database, isDone, isExcluded, onDone, onExcludeTable, onUndoStatus }: Props) {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-800 dark:text-slate-100">{table.name}</h2>
          {table.comment && <p className="text-sm text-gray-500 dark:text-slate-400 mt-0.5">{table.comment}</p>}
        </div>
        <div className="text-right text-xs text-gray-400 dark:text-slate-500 space-y-0.5">
          <div>{table.rowCount.toLocaleString()} rows</div>
          <div>{table.sizeMB} MB</div>
          <div>{table.engine}</div>
        </div>
      </div>

      {/* Column Mapping Editor */}
      <div className="px-6 py-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-slate-300">Column Mapping</h3>
          <div className="flex items-center gap-2">
            {!isExcluded && !isDone && (
              <>
                <button
                  type="button"
                  onClick={onDone}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-green-600 hover:bg-green-700 dark:bg-emerald-700 dark:hover:bg-emerald-600 dark:border dark:border-emerald-500/60 text-white rounded-lg transition-colors"
                >
                  <BadgeCheck size={13} /> Mark as Done
                </button>
                <button
                  type="button"
                  onClick={onExcludeTable}
                  className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-red-50 hover:bg-red-100 dark:bg-rose-950/30 dark:hover:bg-rose-900/40 text-red-600 dark:text-rose-300 border border-red-200 dark:border-rose-800 rounded-lg transition-colors"
                >
                  <XCircle size={13} /> Exclude Table
                </button>
              </>
            )}
            {(isDone || isExcluded) && (
              <button
                type="button"
                onClick={onUndoStatus}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-gray-100 hover:bg-gray-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-gray-600 dark:text-slate-300 border border-gray-300 dark:border-slate-600 rounded-lg transition-colors"
              >
                <RotateCcw size={13} />
                {isExcluded ? 'Re-include Table' : 'Unmark Done'}
              </button>
            )}
            {isDone && (
              <span className="flex items-center gap-1 text-xs text-green-700 dark:text-emerald-300 font-medium">
                <CheckCircle size={13} /> Mapping configured
              </span>
            )}
            {isExcluded && (
              <span className="flex items-center gap-1 text-xs text-red-500 dark:text-rose-400 font-medium">
                <XCircle size={13} /> Table excluded
              </span>
            )}
          </div>
        </div>
        <ColumnMappingTable
          table={table}
          database={database}
        />
      </div>

      {/* Indexes */}
      {table.indexes.length > 0 && (
        <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-slate-300 mb-3">Indexes</h3>
          <div className="space-y-1">
            {table.indexes.map((idx) => (
              <div key={idx.name} className="flex items-center gap-2 text-sm">
                <span className={`text-xs px-1.5 py-0.5 rounded ${idx.unique ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300' : 'bg-gray-100 dark:bg-slate-800 text-gray-600 dark:text-slate-300'}`}>
                  {idx.unique ? 'UNIQUE' : 'INDEX'}
                </span>
                <span className="font-mono text-gray-700 dark:text-slate-200">{idx.name}</span>
                <ArrowRight size={12} className="text-gray-400 dark:text-slate-500" />
                <span className="font-mono text-gray-500 dark:text-slate-400">{idx.columns.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Foreign Keys */}
      {table.foreignKeys.length > 0 && (
        <div className="px-6 py-4 border-t border-gray-100 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-600 dark:text-slate-300 mb-3">Foreign Keys</h3>
          <div className="space-y-1">
            {table.foreignKeys.map((fk) => (
              <div key={fk.name} className="flex items-center gap-2 text-sm">
                <Link size={12} className="text-indigo-400 dark:text-indigo-300" />
                <span className="font-mono text-gray-700 dark:text-slate-200">{fk.column}</span>
                <ArrowRight size={12} className="text-gray-400 dark:text-slate-500" />
                <span className="font-mono text-blue-600 dark:text-blue-300">
                  {fk.referencedTable}.{fk.referencedColumn}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
