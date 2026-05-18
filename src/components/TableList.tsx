import React from 'react';
import { MySQLTable } from '../lib/types';
import { ChevronRight, Table2, CheckCircle, XCircle, Database, X } from 'lucide-react';

export interface TableGroup {
  database: string;
  tables: MySQLTable[];
  onRemove?: () => void;
}

interface Props {
  groups: TableGroup[];
  selectedTable: string | null; // "database::tableName"
  onSelect: (key: string) => void;
  doneSet?: Set<string>;   // keys are "database::tableName"
  excludedSet?: Set<string>;
}

export default function TableList({ groups, selectedTable, onSelect, doneSet, excludedSet }: Props) {
  const totalTables = groups.reduce((sum, g) => sum + g.tables.length, 0);
  const totalDone = doneSet?.size ?? 0;
  const totalExcluded = excludedSet?.size ?? 0;

  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-600 dark:text-slate-300 uppercase tracking-wide">
          Tables ({totalTables})
        </h2>
        <div className="flex gap-2 text-xs text-gray-400 dark:text-slate-500">
          {totalDone > 0 && <span className="text-green-600 dark:text-emerald-400">{totalDone} done</span>}
          {totalExcluded > 0 && <span className="text-red-500 dark:text-rose-400">{totalExcluded} excluded</span>}
        </div>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-slate-700">
        {groups.map((group) => (
          <div key={group.database}>
            {/* Database group header */}
            <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-slate-300">
                <Database size={11} className="text-blue-400 dark:text-blue-300" />
                {group.database}
                <span className="text-gray-400 dark:text-slate-500 font-normal">({group.tables.length})</span>
              </span>
              {group.onRemove && (
                <button
                  type="button"
                  onClick={group.onRemove}
                  title={`Remove ${group.database} from session`}
                  className="text-gray-300 dark:text-slate-500 hover:text-red-400 dark:hover:text-rose-400 transition-colors p-0.5 rounded"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {/* Tables in this database */}
            <ul className="divide-y divide-gray-100 dark:divide-slate-700">
              {group.tables.map((t) => {
                const key = `${group.database}::${t.name}`;
                const isDone = doneSet?.has(key);
                const isExcluded = excludedSet?.has(key);
                const isSelected = selectedTable === key;

                let rowClass = 'w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors ';
                if (isSelected) rowClass += 'bg-blue-50 dark:bg-blue-950/40 border-l-2 border-blue-500 dark:border-blue-400 ';
                else if (isExcluded) rowClass += 'bg-red-50 dark:bg-rose-950/30 border-l-2 border-red-400 dark:border-rose-400 ';
                else if (isDone) rowClass += 'bg-green-50 dark:bg-emerald-950/30 border-l-2 border-green-500 dark:border-emerald-400 ';

                return (
                  <li key={key}>
                    <button onClick={() => onSelect(key)} className={rowClass}>
                      <div className="flex items-center gap-2 min-w-0">
                        {isExcluded ? (
                          <XCircle size={14} className="text-red-400 dark:text-rose-400 shrink-0" />
                        ) : isDone ? (
                          <CheckCircle size={14} className="text-green-500 dark:text-emerald-400 shrink-0" />
                        ) : (
                          <Table2 size={14} className="text-gray-400 dark:text-slate-500 shrink-0" />
                        )}
                        <span className={`text-sm font-medium truncate ${isExcluded ? 'text-red-500 dark:text-rose-400 line-through' : isDone ? 'text-green-700 dark:text-emerald-300' : 'text-gray-800 dark:text-slate-100'}`}>
                          {t.name}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-400 dark:text-slate-500 shrink-0 ml-2">
                        <span>{t.columns.length} cols</span>
                        {t.rowCount > 0 && (
                          <span className="text-gray-300 dark:text-slate-600">·</span>
                        )}
                        {t.rowCount > 0 && (
                          <span>{t.rowCount.toLocaleString()} rows</span>
                        )}
                        <ChevronRight size={14} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
        {groups.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-slate-500">
            No databases inspected yet
          </div>
        )}
      </div>
    </div>
  );
}
