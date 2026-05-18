import React, { useEffect, useState } from 'react';
import { Plug, PlugZap } from 'lucide-react';
import { useRouter } from 'next/router';

interface BadgeState {
   label: string;
   detail: string;
   connected: boolean;
}

const CONN_STATE_KEY = 'mysql_connection_state';
const PG_CONN_KEY = 'pg_connection';

export default function ConnectionBadges() {
   const router = useRouter();
   const [mysql, setMysql] = useState<BadgeState | null>(null);
   const [pg, setPg] = useState<BadgeState | null>(null);

   useEffect(() => {
      try {
         const rawMysql = localStorage.getItem(CONN_STATE_KEY);
         if (rawMysql) {
            const s = JSON.parse(rawMysql) as { databases: string[]; database: string };
            const connected = (s.databases?.length ?? 0) > 0;
            setMysql({ label: 'MySQL', detail: s.database || '', connected });
         } else {
            setMysql({ label: 'MySQL', detail: '', connected: false });
         }
      } catch {
         setMysql({ label: 'MySQL', detail: '', connected: false });
      }

      try {
         const rawPg = localStorage.getItem(PG_CONN_KEY);
         if (rawPg) {
            const s = JSON.parse(rawPg) as { form: { host: string; database: string }; connected: boolean };
            setPg({ label: 'PostgreSQL', detail: s.connected ? s.form.database : '', connected: s.connected });
         } else {
            setPg({ label: 'PostgreSQL', detail: '', connected: false });
         }
      } catch {
         setPg({ label: 'PostgreSQL', detail: '', connected: false });
      }

   }, []);

   if (!mysql && !pg) return null;

   const isSchemaConfigPage = router.pathname === '/schema-config' || router.pathname === '/schema-generate';
   const badges = isSchemaConfigPage ? [pg] : [mysql, pg];

   const goToConnectionPanel = (panel: 'mysql' | 'pg') => {
      const pathname = isSchemaConfigPage ? '/schema-config' : '/migration';
      router.push({ pathname, query: { openConn: panel } });
   };

   return (
      <div className="flex items-center gap-2">
         {badges.map(
            (b) =>
               b && (
                  <button
                     type="button"
                     onClick={() => goToConnectionPanel(b.label === 'MySQL' ? 'mysql' : 'pg')}
                     key={b.label}
                     className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium border ${b.connected
                        ? 'bg-green-50 dark:bg-emerald-950/30 text-green-700 dark:text-emerald-300 border-green-200 dark:border-emerald-800'
                        : 'bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-400 border-gray-200 dark:border-slate-700'
                        } hover:opacity-90 transition-opacity`}
                  >
                     {b.connected
                        ? <Plug size={11} className="text-green-500 dark:text-emerald-400" />
                        : <PlugZap size={11} className="text-gray-300 dark:text-slate-500" />
                     }
                     {b.label}
                     {b.connected && b.detail ? `: ${b.detail}` : ''}
                  </button>
               )
         )}
      </div>
   );
}
