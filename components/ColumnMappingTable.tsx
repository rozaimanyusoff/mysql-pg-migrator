import React, { useState, useEffect } from 'react';
import { MySQLTable, ColumnMapping, PkHandling } from '../lib/types';
import { mapMySQLTypeToPg, tableStorageKey } from '../lib/mapping-utils';
import { Key, CheckCircle, Plus, PlusCircle, BadgeCheck, XCircle, RotateCcw, Trash2 } from 'lucide-react';

const PG_TYPES = [
   'SMALLINT', 'INTEGER', 'BIGINT', 'SERIAL', 'BIGSERIAL',
   'REAL', 'DOUBLE PRECISION', 'NUMERIC',
   'BOOLEAN', 'CHAR', 'VARCHAR', 'TEXT', 'BYTEA',
   'DATE', 'TIME WITHOUT TIME ZONE', 'TIMESTAMP WITHOUT TIME ZONE', 'TIMESTAMPTZ',
   'JSONB', 'JSON', 'UUID', 'BIT',
];

interface Phase1TableStorage {
   pgName: string;
   columns: ColumnMapping[];
   tableDescription?: string;
}

function withAutoRemarks(columns: ColumnMapping[]): ColumnMapping[] {
   return columns.map((c) => {
      if (c.isTargetOnly) return c;
      const current = (c.description || '').trim();
      if (current) return c;
      return { ...c, description: `formerly ${c.mysqlName}` };
   });
}

function initMappings(table: MySQLTable): ColumnMapping[] {
   return withAutoRemarks(table.columns.map((c): ColumnMapping => ({
      mysqlName: c.name,
      pgName: c.name,
      mysqlType: c.type,
      pgType: mapMySQLTypeToPg(c.type),
      nullable: c.nullable,
      defaultValue: c.defaultValue,
      isPrimaryKey: c.isPrimaryKey,
      isUnique: c.isUnique,
      indexStrategy: c.isPrimaryKey ? 'sequential' : 'none',
      description: c.comment || '',
      include: c.isPrimaryKey ? false : true, // PK excluded by default when using migrate_to_id
      pkHandling: c.isPrimaryKey ? 'migrate_to_id' : undefined,
      isTargetOnly: false,
   })));
}

interface Props {
   table: MySQLTable;
   database: string;
   isDone?: boolean;
   isExcluded?: boolean;
   onDone?: () => void;
   onExcludeTable?: () => void;
   onUndoStatus?: () => void;
}

export default function ColumnMappingTable({ table, database, isDone, isExcluded, onDone, onExcludeTable, onUndoStatus }: Props) {
   const [mappings, setMappings] = useState<ColumnMapping[]>([]);
   const [pgTableName, setPgTableName] = useState(table.name);
   const [tableDescription, setTableDescription] = useState('');
   const [saved, setSaved] = useState(false);

   const hasPk = table.columns.some((c) => c.isPrimaryKey);

   // Load saved mappings from localStorage on mount or table change
   useEffect(() => {
      const key = tableStorageKey(database, table.name);
      const raw = localStorage.getItem(key);
      if (raw) {
         try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
               // Backward compat: old format was ColumnMapping[]
               setMappings(withAutoRemarks(parsed as ColumnMapping[]));
               setPgTableName(table.name);
            } else {
               const stored = parsed as Phase1TableStorage;
               setMappings(withAutoRemarks(stored.columns));
               setPgTableName(stored.pgName || table.name);
               setTableDescription(stored.tableDescription || '');
            }
            return;
         } catch { /* fall through */ }
      }
      setMappings(initMappings(table));
      setPgTableName(table.name);
      setTableDescription('');
   }, [database, table.name]);

   // Auto-save to localStorage whenever mappings or pgTableName change
   useEffect(() => {
      if (mappings.length === 0) return;
      const key = tableStorageKey(database, table.name);
      const data: Phase1TableStorage = { pgName: pgTableName, columns: mappings, tableDescription };
      localStorage.setItem(key, JSON.stringify(data));
   }, [mappings, pgTableName, tableDescription, database, table.name]);

   const updateMapping = (idx: number, partial: Partial<ColumnMapping>) => {
      setMappings((prev) => {
         const next = [...prev];
         next[idx] = { ...next[idx], ...partial };
         return next;
      });
      triggerSaved();
   };

   const addTargetColumn = () => {
      const id = Date.now();
      const newCol: ColumnMapping = {
         mysqlName: `__target_only_${id}`,
         sourceMysqlName: '',
         pgName: `new_column_${mappings.length + 1}`,
         mysqlType: '(target-only)',
         pgType: 'TEXT',
         nullable: true,
         defaultValue: null,
         isPrimaryKey: false,
         isUnique: false,
         indexStrategy: 'none',
         description: '',
         include: true,
         isTargetOnly: true,
      };
      setMappings((prev) => [...prev, newCol]);
      triggerSaved();
   };

   const removeTargetColumn = (idx: number) => {
      setMappings((prev) => prev.filter((_, i) => i !== idx));
      triggerSaved();
   };

   const triggerSaved = () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
   };

   const includedCount = mappings.filter((m) => m.include).length;
   const excludedCount = mappings.length - includedCount;

   return (
      <div className="space-y-3">
         {/* Summary bar */}
         <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-gray-400 dark:text-slate-500 font-mono">
               <span className="text-gray-500 dark:text-slate-300 font-medium">{table.name}</span>
            </span>
            <button
               type="button"
               onClick={addTargetColumn}
               className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/30 hover:bg-blue-100 dark:hover:bg-blue-900/40"
            >
               <PlusCircle size={12} /> Add PG Column
            </button>
            <div className="flex gap-3 text-xs text-gray-500 dark:text-slate-400 ml-auto flex-shrink-0">
               <span><strong className="text-gray-700 dark:text-slate-200">{includedCount}</strong> included</span>
               {excludedCount > 0 && <span><strong className="text-red-500 dark:text-rose-400">{excludedCount}</strong> excluded</span>}
               {saved && (
                  <span className="flex items-center gap-1 text-green-600 dark:text-emerald-400">
                     <CheckCircle size={12} /> Saved
                  </span>
               )}
            </div>
         </div>
         {/* Table description */}
         <textarea
            rows={2}
            className="w-full text-xs border border-gray-200 dark:border-slate-700 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-500 resize-none text-gray-700 dark:text-slate-200 placeholder-gray-400 dark:placeholder-slate-500 bg-white dark:bg-slate-800"
            value={tableDescription}
            onChange={(e) => { setTableDescription(e.target.value); triggerSaved(); }}
            placeholder="Table description (required) — e.g. what this table stores, relationships, business context…"
         />

         {/* Mapping table */}
         <div className="border border-gray-200 dark:border-slate-700 rounded-xl overflow-hidden">
            {/* Column headers */}
            <div className="grid grid-cols-2 text-xs font-semibold text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
               <div className="px-4 py-2.5 bg-gray-100 dark:bg-slate-800">MySQL (Source)</div>
               <div className="px-4 py-2.5 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-700">PostgreSQL (Target)</div>
            </div>

            {/* Virtual UUID id row — always shown when table has a PK */}
            {hasPk && (
               <div className="grid grid-cols-2 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-100 dark:border-emerald-900">
                  <div className="px-4 py-3 text-xs text-emerald-600 dark:text-emerald-300 italic flex items-center gap-2">
                     <Plus size={12} className="flex-shrink-0" />
                     <span>New column — no MySQL equivalent</span>
                  </div>
                  <div className="px-4 py-3 border-l border-emerald-100 dark:border-emerald-900 flex items-center gap-2 flex-wrap">
                     <span className="font-mono text-sm font-semibold text-emerald-800 dark:text-emerald-200">id</span>
                     <span className="text-xs bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded font-mono">UUID</span>
                     <span className="text-xs bg-yellow-100 dark:bg-amber-900/40 text-yellow-700 dark:text-amber-300 px-1.5 py-0.5 rounded font-medium">PRIMARY KEY</span>
                     <span className="text-xs text-emerald-500 dark:text-emerald-300 font-mono">DEFAULT gen_random_uuid()</span>
                  </div>
               </div>
            )}

            {/* Column rows */}
            <div className="divide-y divide-gray-100 dark:divide-slate-700">
               {mappings.map((m, idx) => {
                  const srcCol = m.isTargetOnly
                     ? null
                     : table.columns.find((col) => col.name === m.mysqlName) ?? null;

                  if (m.isPrimaryKey) {
                     return (
                        <div key={m.mysqlName} className="grid grid-cols-2">
                           {/* LEFT: MySQL PK */}
                           <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800 text-sm">
                              <div className="flex items-center gap-1.5 font-mono font-medium text-gray-800 dark:text-slate-100">
                                 <Key size={11} className="text-yellow-500 dark:text-amber-400 flex-shrink-0" />
                                 <span>{m.mysqlName}</span>
                              </div>
                              <div className="mt-0.5 text-xs text-blue-600 dark:text-blue-300 font-mono">{m.mysqlType}</div>
                              <div className="mt-1 flex gap-1 flex-wrap">
                                 <span className="bg-yellow-100 dark:bg-amber-900/40 text-yellow-700 dark:text-amber-300 text-xs px-1 rounded">PK</span>
                                 {srcCol?.autoIncrement && (
                                    <span className="bg-purple-100 dark:bg-violet-900/40 text-purple-700 dark:text-violet-300 text-xs px-1 rounded">AUTO_INCREMENT</span>
                                 )}
                              </div>
                              {srcCol?.comment && (
                                 <p className="mt-1 text-xs text-amber-600 dark:text-amber-300 italic leading-snug">{srcCol.comment}</p>
                              )}
                           </div>

                           {/* RIGHT: PK handling options */}
                           <div className="px-4 py-3 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-700 space-y-2.5">
                              <p className="text-xs font-semibold text-gray-600 dark:text-slate-300">Original PK strategy:</p>
                              <div className="space-y-2">
                                 <label className="flex items-start gap-2 text-xs cursor-pointer group">
                                    <input
                                       type="radio"
                                       name={`pk_${table.name}_${m.mysqlName}`}
                                       value="migrate_to_id"
                                       checked={(m.pkHandling ?? 'migrate_to_id') === 'migrate_to_id'}
                                       onChange={() => updateMapping(idx, { pkHandling: 'migrate_to_id', include: false })}
                                       className="w-3 h-3 mt-0.5 flex-shrink-0"
                                    />
                                    <span className="leading-snug">
                                       Migrate PK to <code className="bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-1 rounded">id</code>
                                       <span className="block text-gray-400 dark:text-slate-500 mt-0.5">Exclude this column — use new UUID id as PK</span>
                                    </span>
                                 </label>
                                 <label className="flex items-start gap-2 text-xs cursor-pointer group">
                                    <input
                                       type="radio"
                                       name={`pk_${table.name}_${m.mysqlName}`}
                                       value="keep"
                                       checked={m.pkHandling === 'keep'}
                                       onChange={() => updateMapping(idx, { pkHandling: 'keep', include: true })}
                                       className="w-3 h-3 mt-0.5 flex-shrink-0"
                                    />
                                    <span className="leading-snug">
                                       Keep this column (maintain value)
                                       <span className="block text-gray-400 dark:text-slate-500 mt-0.5">Include alongside new UUID id column</span>
                                    </span>
                                 </label>
                              </div>

                              {/* If 'keep' — show rename + type editors */}
                              {m.pkHandling === 'keep' && (
                                 <div className="pt-1 space-y-1.5 border-t border-gray-100 dark:border-slate-700">
                                    <input
                                       type="text"
                                       className="w-full text-sm font-mono border border-gray-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100"
                                       value={m.pgName}
                                       onChange={(e) => updateMapping(idx, { pgName: e.target.value })}
                                       placeholder="Column name"
                                    />
                                    <select
                                       className="w-full text-xs border border-gray-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-500"
                                       value={m.pgType}
                                       onChange={(e) => updateMapping(idx, { pgType: e.target.value })}
                                    >
                                       {PG_TYPES.map((t) => (
                                          <option key={t} value={t}>{t}</option>
                                       ))}
                                       {!PG_TYPES.includes(m.pgType) && (
                                          <option value={m.pgType}>{m.pgType}</option>
                                       )}
                                    </select>
                                 </div>
                              )}
                           </div>
                        </div>
                     );
                  }

                  // Normal non-PK row
                  return (
                     <div
                        key={m.mysqlName}
                        className={`grid grid-cols-2 transition-opacity ${!m.include ? 'opacity-40' : ''}`}
                     >
                        {/* LEFT: MySQL source (read-only) */}
                        <div className="px-4 py-3 bg-gray-50 dark:bg-slate-800 text-sm">
                           {m.isTargetOnly ? (
                              <>
                                 <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300 italic">
                                    <Plus size={12} />
                                    <span>New column - no MySQL equivalent</span>
                                 </div>
                                 <div className="mt-0.5 text-xs text-gray-400 dark:text-slate-500 font-mono">(target-only)</div>
                              </>
                           ) : (
                              <>
                                 <div className="flex items-center gap-1.5 font-mono font-medium text-gray-800 dark:text-slate-100 truncate">
                                    <span className="truncate">{m.mysqlName}</span>
                                 </div>
                                 <div className="mt-0.5 text-xs text-blue-600 dark:text-blue-300 font-mono truncate">{m.mysqlType}</div>
                                 {srcCol && (
                                    <div className="mt-1 flex gap-1 flex-wrap">
                                       <span className="text-xs text-gray-400 dark:text-slate-500">
                                          {srcCol.nullable ? 'nullable' : 'not null'}
                                       </span>
                                       {srcCol.isUnique && (
                                          <span className="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs px-1 rounded">UNIQUE</span>
                                       )}
                                    </div>
                                 )}
                                 {srcCol?.comment && (
                                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-300 italic leading-snug">{srcCol.comment}</p>
                                 )}
                              </>
                           )}
                        </div>

                        {/* RIGHT: PG target (editable) */}
                        <div className="px-4 py-3 bg-white dark:bg-slate-900 border-l border-gray-200 dark:border-slate-700 space-y-2">
                           <input
                              type="text"
                              className="w-full text-sm font-mono border border-gray-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100 disabled:bg-gray-50 dark:disabled:bg-slate-800/60 disabled:text-gray-400 dark:disabled:text-slate-500"
                              value={m.pgName}
                              onChange={(e) => updateMapping(idx, { pgName: e.target.value })}
                              disabled={!m.include}
                              placeholder="Column name"
                           />
                           <select
                              className="w-full text-xs border border-gray-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-500 disabled:bg-gray-50 dark:disabled:bg-slate-800/60 disabled:text-gray-400 dark:disabled:text-slate-500 bg-white dark:bg-slate-800 text-gray-900 dark:text-slate-100"
                              value={m.pgType}
                              onChange={(e) => updateMapping(idx, { pgType: e.target.value })}
                              disabled={!m.include}
                           >
                              {PG_TYPES.map((t) => (
                                 <option key={t} value={t}>{t}</option>
                              ))}
                              {!PG_TYPES.includes(m.pgType) && (
                                 <option value={m.pgType}>{m.pgType}</option>
                              )}
                           </select>
                           <div className="flex items-center gap-4 flex-wrap">
                              <label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-slate-400 cursor-pointer select-none">
                                 <input
                                    type="checkbox"
                                    checked={m.nullable}
                                    onChange={(e) => updateMapping(idx, { nullable: e.target.checked })}
                                    disabled={!m.include}
                                    className="w-3 h-3"
                                 />
                                 Nullable
                              </label>
                              <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
                                 <input
                                    type="checkbox"
                                    checked={!m.include}
                                    onChange={(e) => updateMapping(idx, { include: !e.target.checked })}
                                    className="w-3 h-3 accent-red-500"
                                 />
                                 <span className={!m.include ? 'text-red-500 dark:text-rose-400 font-medium' : 'text-gray-500 dark:text-slate-500'}>
                                    Exclude
                                 </span>
                              </label>
                              {m.isTargetOnly && (
                                 <button
                                    type="button"
                                    onClick={() => removeTargetColumn(idx)}
                                    className="inline-flex items-center gap-1 text-xs text-red-500 dark:text-rose-400 hover:text-red-600 dark:hover:text-rose-300"
                                 >
                                    <Trash2 size={12} /> Remove
                                 </button>
                              )}
                           </div>
                           <input
                              type="text"
                              className="w-full text-xs border border-gray-100 dark:border-slate-700 rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-blue-300 dark:focus:ring-blue-500 text-gray-600 dark:text-slate-300 placeholder-gray-300 dark:placeholder-slate-500 bg-gray-50 dark:bg-slate-800"
                              value={m.description}
                              onChange={(e) => updateMapping(idx, { description: e.target.value })}
                              disabled={!m.include}
                              placeholder="Remark / column note…"
                           />
                        </div>
                     </div>
                  );
               })}
            </div>
         </div>


      </div>
   );
}
