import React, { useState } from 'react';
import { ColumnMapping, IndexStrategy } from '../lib/types';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface Props {
  columns: ColumnMapping[];
  onChange: (updated: ColumnMapping[]) => void;
}

const PG_TYPES = [
  'SMALLINT', 'INTEGER', 'BIGINT', 'REAL', 'DOUBLE PRECISION', 'NUMERIC',
  'BOOLEAN', 'CHAR', 'VARCHAR', 'TEXT', 'BYTEA',
  'DATE', 'TIME WITHOUT TIME ZONE', 'TIMESTAMP WITHOUT TIME ZONE', 'TIMESTAMPTZ',
  'JSONB', 'JSON', 'UUID', 'BIT',
];

const INDEX_STRATEGIES: { value: IndexStrategy; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'sequential', label: 'Sequential (IDENTITY)' },
  { value: 'uuid', label: 'UUID' },
];

export default function ColumnMappingEditor({ columns, onChange }: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const updateCol = (idx: number, partial: Partial<ColumnMapping>) => {
    const updated = [...columns];
    updated[idx] = { ...updated[idx], ...partial };
    onChange(updated);
  };

  return (
    <div className="space-y-2">
      {columns.map((col, idx) => (
        <div key={col.mysqlName} className="border border-gray-200 rounded-lg overflow-hidden">
          {/* Row header */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 hover:bg-gray-100 transition-colors">
            <button
              className="flex items-center gap-2 text-sm font-medium text-gray-700 flex-1 text-left"
              onClick={() => setExpanded((p) => ({ ...p, [col.mysqlName]: !p[col.mysqlName] }))}
            >
              {expanded[col.mysqlName] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <span className="font-mono">{col.mysqlName}</span>
              <span className="text-gray-400 font-normal">{col.mysqlType}</span>
              {col.isPrimaryKey && (
                <span className="bg-yellow-100 text-yellow-700 text-xs px-1.5 py-0.5 rounded">PK</span>
              )}
            </button>
            <label className="flex items-center gap-1.5 text-xs ml-2 cursor-pointer">
              <input
                type="checkbox"
                checked={col.include}
                onChange={(e) => updateCol(idx, { include: e.target.checked })}
                className="w-3.5 h-3.5"
              />
              Include
            </label>
          </div>

          {/* Expanded editor */}
          {expanded[col.mysqlName] && col.include && (
            <div className="px-4 py-3 grid grid-cols-2 gap-3 border-t border-gray-100">
              {/* PG column name */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">PG Column Name</label>
                <input
                  type="text"
                  value={col.pgName}
                  onChange={(e) => updateCol(idx, { pgName: e.target.value })}
                  className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              {/* PG type */}
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">PostgreSQL Type</label>
                <select
                  value={col.pgType}
                  onChange={(e) => updateCol(idx, { pgType: e.target.value })}
                  className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                >
                  {PG_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              {/* Index strategy (PK only) */}
              {col.isPrimaryKey && (
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Index Strategy</label>
                  <select
                    value={col.indexStrategy}
                    onChange={(e) => updateCol(idx, { indexStrategy: e.target.value as IndexStrategy })}
                    className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                  >
                    {INDEX_STRATEGIES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Nullable */}
              <div className="flex items-center gap-2 mt-4">
                <input
                  type="checkbox"
                  checked={col.nullable}
                  onChange={(e) => updateCol(idx, { nullable: e.target.checked })}
                  className="w-4 h-4"
                  id={`nullable-${idx}`}
                />
                <label htmlFor={`nullable-${idx}`} className="text-sm text-gray-600 cursor-pointer">
                  Nullable
                </label>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
