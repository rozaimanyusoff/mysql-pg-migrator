import React from 'react';
import { X } from 'lucide-react';

interface Props {
   top: number;
   left: number;
   onClose: () => void;
}

export default function PgHelpPopover({ top, left, onClose }: Props) {
   return (
      <div
         className="fixed z-[500] w-96 bg-white border border-gray-200 rounded-xl shadow-2xl p-4 overflow-y-auto"
         style={{ top, left, maxHeight: '80vh' }}
      >
         <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">PostgreSQL Quick Reference</p>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={13} /></button>
         </div>
         <div className="space-y-4 text-xs">

            <div>
               <p className="font-semibold text-blue-600 mb-1.5">① Access psql</p>
               <pre className="bg-gray-50 border border-gray-100 rounded px-2 py-1.5 font-mono text-gray-700 whitespace-pre-wrap">{`# Standard login
psql -h localhost -p 5432 -U postgres -d mydb

# Via connection string
psql "postgresql://user:password@host:5432/mydb"

# As system postgres user (Linux/macOS)
sudo -u postgres psql`}</pre>
            </div>

            <div>
               <p className="font-semibold text-blue-600 mb-1.5">② Useful psql commands</p>
               <pre className="bg-gray-50 border border-gray-100 rounded px-2 py-1.5 font-mono text-gray-700 whitespace-pre-wrap">{`\\l           -- list databases
\\c mydb      -- connect to database
\\dn          -- list schemas
\\dt          -- list tables
\\du          -- list roles/users
\\q           -- quit psql`}</pre>
            </div>

            <div>
               <p className="font-semibold text-blue-600 mb-1.5">③ Create Database</p>
               <pre className="bg-gray-50 border border-gray-100 rounded px-2 py-1.5 font-mono text-gray-700 whitespace-pre-wrap">{`CREATE DATABASE mydb;`}</pre>
            </div>

            <div>
               <p className="font-semibold text-blue-600 mb-1.5">④ Create Schema</p>
               <pre className="bg-gray-50 border border-gray-100 rounded px-2 py-1.5 font-mono text-gray-700 whitespace-pre-wrap">{`CREATE SCHEMA myschema;`}</pre>
            </div>

            <div>
               <p className="font-semibold text-blue-600 mb-1.5">⑤ Create Role & Grant Access</p>
               <pre className="bg-gray-50 border border-gray-100 rounded px-2 py-1.5 font-mono text-gray-700 whitespace-pre-wrap">{`CREATE ROLE myrole WITH LOGIN PASSWORD 'secret';
GRANT ALL ON DATABASE mydb TO myrole;
GRANT ALL ON SCHEMA myschema TO myrole;
GRANT ALL ON ALL TABLES IN SCHEMA myschema TO myrole;`}</pre>
            </div>

            <div>
               <p className="font-semibold text-blue-600 mb-1.5">⑥ Enable UUID extension</p>
               <pre className="bg-gray-50 border border-gray-100 rounded px-2 py-1.5 font-mono text-gray-700 whitespace-pre-wrap">{`CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- then use: gen_random_uuid()`}</pre>
            </div>

         </div>
      </div>
   );
}
