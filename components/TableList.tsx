import React from 'react';
import { MySQLTable } from '../lib/types';
import { ChevronRight, Table2 } from 'lucide-react';

interface Props {
  tables: MySQLTable[];
  selectedTable: string | null;
  onSelect: (name: string) => void;
}

export default function TableList({ tables, selectedTable, onSelect }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
        <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wide">
          Tables ({tables.length})
        </h2>
      </div>
      <ul className="divide-y divide-gray-100">
        {tables.map((t) => (
          <li key={t.name}>
            <button
              onClick={() => onSelect(t.name)}
              className={`w-full flex items-center justify-between px-4 py-3 text-left hover:bg-blue-50 transition-colors ${
                selectedTable === t.name ? 'bg-blue-50 border-l-2 border-blue-500' : ''
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Table2 size={16} className="text-gray-400 shrink-0" />
                <span className="text-sm font-medium text-gray-800 truncate">{t.name}</span>
              </div>
              <div className="flex items-center gap-2 text-xs text-gray-400 shrink-0 ml-2">
                <span>{t.columns.length} cols</span>
                <span>{t.rowCount.toLocaleString()} rows</span>
                <ChevronRight size={14} />
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
