import React from 'react';
import { MySQLTable } from '../lib/types';
import { Key, Link, ArrowRight } from 'lucide-react';

interface Props {
  table: MySQLTable;
}

export default function TableDetail({ table }: Props) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-800">{table.name}</h2>
          {table.comment && <p className="text-sm text-gray-500 mt-0.5">{table.comment}</p>}
        </div>
        <div className="text-right text-xs text-gray-400 space-y-0.5">
          <div>{table.rowCount.toLocaleString()} rows</div>
          <div>{table.sizeMB} MB</div>
          <div>{table.engine}</div>
        </div>
      </div>

      {/* Columns */}
      <div className="px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-600 mb-3">Columns</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Type</th>
                <th className="pb-2 font-medium">Null</th>
                <th className="pb-2 font-medium">Default</th>
                <th className="pb-2 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {table.columns.map((col) => (
                <tr key={col.name} className="hover:bg-gray-50">
                  <td className="py-2 pr-4 font-mono text-gray-800 flex items-center gap-1">
                    {col.isPrimaryKey && <Key size={12} className="text-yellow-500" />}
                    {col.name}
                  </td>
                  <td className="py-2 pr-4 font-mono text-blue-600">{col.type}</td>
                  <td className="py-2 pr-4 text-gray-500">{col.nullable ? 'YES' : 'NO'}</td>
                  <td className="py-2 pr-4 font-mono text-gray-400 text-xs">
                    {col.defaultValue ?? '—'}
                  </td>
                  <td className="py-2 flex flex-wrap gap-1">
                    {col.autoIncrement && (
                      <span className="bg-purple-100 text-purple-700 text-xs px-1.5 py-0.5 rounded">AUTO</span>
                    )}
                    {col.isPrimaryKey && (
                      <span className="bg-yellow-100 text-yellow-700 text-xs px-1.5 py-0.5 rounded">PK</span>
                    )}
                    {col.isUnique && (
                      <span className="bg-blue-100 text-blue-700 text-xs px-1.5 py-0.5 rounded">UNIQUE</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Indexes */}
      {table.indexes.length > 0 && (
        <div className="px-6 py-4 border-t border-gray-100">
          <h3 className="text-sm font-semibold text-gray-600 mb-3">Indexes</h3>
          <div className="space-y-1">
            {table.indexes.map((idx) => (
              <div key={idx.name} className="flex items-center gap-2 text-sm">
                <span className={`text-xs px-1.5 py-0.5 rounded ${idx.unique ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                  {idx.unique ? 'UNIQUE' : 'INDEX'}
                </span>
                <span className="font-mono text-gray-700">{idx.name}</span>
                <ArrowRight size={12} className="text-gray-400" />
                <span className="font-mono text-gray-500">{idx.columns.join(', ')}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Foreign Keys */}
      {table.foreignKeys.length > 0 && (
        <div className="px-6 py-4 border-t border-gray-100">
          <h3 className="text-sm font-semibold text-gray-600 mb-3">Foreign Keys</h3>
          <div className="space-y-1">
            {table.foreignKeys.map((fk) => (
              <div key={fk.name} className="flex items-center gap-2 text-sm">
                <Link size={12} className="text-indigo-400" />
                <span className="font-mono text-gray-700">{fk.column}</span>
                <ArrowRight size={12} className="text-gray-400" />
                <span className="font-mono text-blue-600">
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
