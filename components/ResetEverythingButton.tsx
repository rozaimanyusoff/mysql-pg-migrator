import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { Trash2 } from 'lucide-react';

const CREDS_KEY = 'mysql_connection_creds';
const CONN_STATE_KEY = 'mysql_connection_state';
const INSPECT_RESULT_KEY = 'inspection_result';
const TABLE_STATUS_KEY = 'mysql_table_status';
const PG_CONN_KEY = 'pg_connection';
const PHASE2_REVIEWED_KEY = 'phase2_schema_reviewed';
const PHASE2_REVIEWED_STATE_KEY = 'phase2_schema_reviewed_state';

export default function ResetEverythingButton() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const rawStatus = localStorage.getItem(TABLE_STATUS_KEY);
      const status = rawStatus ? (JSON.parse(rawStatus) as { done?: string[] }) : null;
      const hasDone = (status?.done?.length ?? 0) > 0;
      const hasData = Boolean(
        localStorage.getItem(INSPECT_RESULT_KEY) ||
        localStorage.getItem('migration_config') ||
        localStorage.getItem(PHASE2_REVIEWED_KEY)
      );
      setVisible(hasDone || hasData);
    } catch {
      setVisible(false);
    }
  }, []);

  if (!visible) return null;

  const handleResetEverything = () => {
    const ok = window.confirm('Reset everything? This will clear inspected tables, mappings, docs config, and connection settings.');
    if (!ok) return;

    Object.keys(localStorage)
      .filter((k) => k.startsWith('table_mappings_'))
      .forEach((k) => localStorage.removeItem(k));

      [CREDS_KEY, CONN_STATE_KEY, INSPECT_RESULT_KEY, TABLE_STATUS_KEY, PG_CONN_KEY,
      'migration_config', PHASE2_REVIEWED_KEY, PHASE2_REVIEWED_STATE_KEY].forEach((k) => localStorage.removeItem(k));

    fetch('/api/module-config-reset', { method: 'POST' }).finally(() => {
      router.push('/');
    });
  };

  return (
    <button
      type="button"
      onClick={handleResetEverything}
      title="Reset everything"
      className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
    >
      <Trash2 size={15} />
    </button>
  );
}
