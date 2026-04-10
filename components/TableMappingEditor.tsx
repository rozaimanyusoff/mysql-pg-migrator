import React from 'react';
import { TableMapping } from '../lib/types';

interface Props {
  table: TableMapping;
  onChange: (updated: TableMapping) => void;
}

const PG_SCHEMAS = ['public', 'app', 'auth', 'audit', 'content', 'data', 'legacy'];

export default function TableMappingEditor({ table, onChange }: Props) {
  const update = (partial: Partial<TableMapping>) => onChange({ ...table, ...partial });

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
      {/* Include toggle */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-gray-800">{table.mysqlName}</h3>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={table.include}
            onChange={(e) => update({ include: e.target.checked })}
            className="w-4 h-4 rounded"
          />
          Include in migration
        </label>
      </div>

      {table.include && (
        <>
          <div className="grid grid-cols-2 gap-4">
            {/* PG Table Name */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">PostgreSQL Table Name</label>
              <input
                type="text"
                value={table.pgName}
                onChange={(e) => update({ pgName: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
            {/* PG Schema */}
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">PostgreSQL Schema</label>
              <select
                value={table.pgSchema}
                onChange={(e) => update({ pgSchema: e.target.value })}
                className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
              >
                {PG_SCHEMAS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
            <input
              type="text"
              value={table.description}
              onChange={(e) => update({ description: e.target.value })}
              placeholder="Optional table description"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
            />
          </div>
        </>
      )}
    </div>
  );
}
