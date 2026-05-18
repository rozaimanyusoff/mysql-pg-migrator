import React, { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import axios from 'axios';
import { toast } from 'sonner';
import { InspectionResult, MigrationConfig, PgConnectionConfig } from '../lib/types';
import { initializeMigrationConfig, mergePhase1Mappings } from '../lib/mapping-utils';
import { LoadingSpinner } from '../components/StateComponents';
import PgHelpPopover from '../components/PgHelpPopover';
import { Database, ChevronRight, Plug, PlugZap, RotateCcw, ServerCrash, HelpCircle, X, Trash2, PlusCircle, BadgeCheck } from 'lucide-react';

interface ConnForm {
  host: string; port: string; user: string; password: string; database: string;
}

const DEFAULT_FORM: ConnForm = {
  host: process.env.NEXT_PUBLIC_MYSQL_HOST || 'localhost',
  port: '3306',
  user: '',
  password: '',
  database: '',
};

const CREDS_KEY = 'mysql_connection_creds';
const CONN_STATE_KEY = 'mysql_connection_state';
const INSPECT_RESULT_KEY = 'inspection_result';
const TABLE_STATUS_KEY = 'mysql_table_status';
const PG_CONN_KEY = 'pg_connection';
const PHASE2_REVIEWED_KEY = 'phase2_schema_reviewed';
const PHASE2_REVIEWED_STATE_KEY = 'phase2_schema_reviewed_state';
const PHASE3_TEMPLATE_READY_KEY = 'phase3_template_ready';
const HIDDEN_DBS_KEY = 'phase1_hidden_databases';

const DEFAULT_PG: PgConnectionConfig = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '',
  database: '',
  ssl: false,
};

export default function Phase1() {
  const router = useRouter();
  const [form, setForm] = useState<ConnForm>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InspectionResult[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null); // "database::tableName"
  const [databases, setDatabases] = useState<string[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [doneTables, setDoneTables] = useState<Set<string>>(new Set());
  const [excludedTables, setExcludedTables] = useState<Set<string>>(new Set());
  const [phase2Reviewed, setPhase2Reviewed] = useState<Set<string>>(new Set());
  const [phase2ReviewedState, setPhase2ReviewedState] = useState<Record<string, string>>({});
  const [phase3TemplateReady, setPhase3TemplateReady] = useState<{ ready?: boolean; readyAt?: string; confirmedCount?: number; assignedKeys?: string[] } | null>(null);
  const [migrateCompletedKeys, setMigrateCompletedKeys] = useState<Set<string>>(new Set());
  const [mappingConfig, setMappingConfig] = useState<MigrationConfig | null>(null);
  const [hiddenDatabases, setHiddenDatabases] = useState<Set<string>>(new Set());
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  // PostgreSQL connection
  const [pgForm, setPgForm] = useState<PgConnectionConfig>(DEFAULT_PG);
  const [pgConnected, setPgConnected] = useState(false);
  const [pgSchemas, setPgSchemas] = useState<string[]>([]);
  const [pgConnecting, setPgConnecting] = useState(false);
  const [pgConnError, setPgConnError] = useState<string | null>(null);

  // PG help popover
  const [showPgHelp, setShowPgHelp] = useState(false);
  const [pgHelpPos, setPgHelpPos] = useState({ top: 0, left: 0 });
  const pgHelpBtnRef = useRef<HTMLButtonElement>(null);

  // Connection panel (badge click)
  const [showConnPanel, setShowConnPanel] = useState<'mysql' | 'pg' | null>(null);
  const connPanelRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const mysqlBadgeRef = useRef<HTMLButtonElement>(null);
  const pgBadgeRef = useRef<HTMLButtonElement>(null);
  const [connPanelPos, setConnPanelPos] = useState({ left: 0, top: 0 });

  // Reset confirmation dialog
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [connConfigFiles, setConnConfigFiles] = useState<string[]>([]);
  const [selectedConnConfigFile, setSelectedConnConfigFile] = useState('');
  const [connConfigName, setConnConfigName] = useState('default');
  const [connConfigLoading, setConnConfigLoading] = useState(false);
  const [connConfigMessage, setConnConfigMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!error) return;
    window.alert(error);
    setError(null);
  }, [error]);

  useEffect(() => {
    if (!dbError) return;
    window.alert(dbError);
    setDbError(null);
  }, [dbError]);

  useEffect(() => {
    if (!pgConnError) return;
    window.alert(pgConnError);
    setPgConnError(null);
  }, [pgConnError]);

  useEffect(() => {
    if (!connConfigMessage) return;
    if (connConfigMessage.startsWith('Saved:') || connConfigMessage.startsWith('Loaded:')) {
      toast.success(connConfigMessage);
    } else {
      window.alert(connConfigMessage);
    }
    setConnConfigMessage(null);
  }, [connConfigMessage]);

  const syncModuleConfig = async (
    mysqlOverride?: {
      host: string;
      port: string;
      user: string;
      password: string;
      database: string;
      connected: boolean;
      databases: string[];
    },
    pgOverride?: {
      form: PgConnectionConfig;
      connected: boolean;
      schemas: string[];
    }
  ) => {
    try {
      await axios.post('/api/module-config?module=migration', {
        module: 'migration',
        mysql: mysqlOverride ?? {
          host: form.host,
          port: form.port,
          user: form.user,
          password: form.password,
          database: form.database,
          connected,
          databases,
        },
        pg: pgOverride ?? {
          form: pgForm,
          connected: pgConnected,
          schemas: pgSchemas,
        },
      });
    } catch {
      // non-blocking
    }
  };

  const loadConnectionConfigFiles = async () => {
    try {
      const { data } = await axios.get('/api/connection-config-list', { params: { module: 'migration' } });
      const files = (data.files ?? []) as string[];
      setConnConfigFiles(files);
      if (!selectedConnConfigFile && files.length > 0) setSelectedConnConfigFile(files[0]);
    } catch {
      // ignore
    }
  };

  const handleSaveConnectionConfig = async () => {
    setConnConfigLoading(true);
    setConnConfigMessage(null);
    try {
      const { data } = await axios.post('/api/connection-config-save', {
        module: 'migration',
        name: connConfigName,
        mysql: {
          host: form.host,
          port: form.port,
          user: form.user,
          password: form.password,
          database: form.database,
          connected,
          databases,
        },
        pg: {
          form: pgForm,
          connected: pgConnected,
          schemas: pgSchemas,
        },
      });
      setConnConfigMessage(`Saved: ${data.fileName}`);
      await loadConnectionConfigFiles();
    } catch (err: unknown) {
      setConnConfigMessage(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setConnConfigLoading(false);
    }
  };

  const handleLoadConnectionConfig = async () => {
    if (!selectedConnConfigFile) return;
    setConnConfigLoading(true);
    setConnConfigMessage(null);
    try {
      const { data } = await axios.get('/api/connection-config-load', { params: { file: selectedConnConfigFile } });
      const cfg = data.config as {
        mysql?: { host?: string; port?: string; user?: string; password?: string; database?: string; connected?: boolean; databases?: string[] };
        pg?: { form?: PgConnectionConfig; connected?: boolean; schemas?: string[] };
      };

      if (cfg.mysql) {
        const mysqlForm = {
          host: cfg.mysql.host ?? DEFAULT_FORM.host,
          port: cfg.mysql.port ?? DEFAULT_FORM.port,
          user: cfg.mysql.user ?? '',
          password: cfg.mysql.password ?? '',
          database: cfg.mysql.database ?? '',
        };
        setForm(mysqlForm);
        setConnected(Boolean(cfg.mysql.connected));
        setDatabases(cfg.mysql.databases ?? []);
        localStorage.setItem(CREDS_KEY, JSON.stringify({
          host: mysqlForm.host,
          port: mysqlForm.port,
          user: mysqlForm.user,
          password: mysqlForm.password,
        }));
        localStorage.setItem(CONN_STATE_KEY, JSON.stringify({
          databases: cfg.mysql.databases ?? [],
          database: mysqlForm.database,
        }));
      }
      if (cfg.pg?.form) {
        setPgForm(cfg.pg.form);
        setPgConnected(Boolean(cfg.pg.connected));
        setPgSchemas(cfg.pg.schemas ?? []);
        localStorage.setItem(PG_CONN_KEY, JSON.stringify({
          form: cfg.pg.form,
          connected: Boolean(cfg.pg.connected),
          schemas: cfg.pg.schemas ?? [],
        }));
      }
      setConnConfigMessage(`Loaded: ${selectedConnConfigFile}`);
      void syncModuleConfig(
        {
          host: cfg.mysql?.host ?? form.host,
          port: cfg.mysql?.port ?? form.port,
          user: cfg.mysql?.user ?? form.user,
          password: cfg.mysql?.password ?? form.password,
          database: cfg.mysql?.database ?? form.database,
          connected: Boolean(cfg.mysql?.connected ?? connected),
          databases: cfg.mysql?.databases ?? databases,
        },
        {
          form: cfg.pg?.form ?? pgForm,
          connected: Boolean(cfg.pg?.connected ?? pgConnected),
          schemas: cfg.pg?.schemas ?? pgSchemas,
        }
      );
    } catch (err: unknown) {
      setConnConfigMessage(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setConnConfigLoading(false);
    }
  };

  // Restore saved credentials + connection state on mount
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (connPanelRef.current && !connPanelRef.current.contains(e.target as Node)) {
        setShowConnPanel(null);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const positionConnPanel = (panel: 'mysql' | 'pg') => {
    const headerEl = headerRef.current;
    const badgeEl = panel === 'mysql' ? mysqlBadgeRef.current : pgBadgeRef.current;
    if (!headerEl || !badgeEl) return;

    const headerRect = headerEl.getBoundingClientRect();
    const badgeRect = badgeEl.getBoundingClientRect();
    const panelWidth = Math.min(window.innerWidth * 0.92, 560);
    const margin = 8;
    const top = badgeRect.bottom - headerRect.top + 8;
    const preferredLeft =
      panel === 'mysql'
        ? badgeRect.left - headerRect.left
        : badgeRect.right - headerRect.left - panelWidth;
    const left = Math.max(margin, Math.min(preferredLeft, headerRect.width - panelWidth - margin));

    setConnPanelPos({ left, top });
  };

  const toggleConnPanel = (panel: 'mysql' | 'pg') => {
    setShowConnPanel((current) => {
      if (current === panel) return null;
      positionConnPanel(panel);
      return panel;
    });
  };

  useEffect(() => {
    if (!showConnPanel) return;
    const onResize = () => positionConnPanel(showConnPanel);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [showConnPanel]);

  useEffect(() => {
    if (!router.isReady) return;
    const openConn = router.query.openConn;
    if (openConn !== 'mysql' && openConn !== 'pg') return;

    requestAnimationFrame(() => {
      positionConnPanel(openConn);
      setShowConnPanel(openConn);
    });

    router.replace('/migration', undefined, { shallow: true });
  }, [router.isReady, router.query.openConn]);

  useEffect(() => {
    const restore = async () => {
      try {
        const rawCreds = localStorage.getItem(CREDS_KEY);
        if (rawCreds) {
          const saved = JSON.parse(rawCreds) as Partial<ConnForm>;
          setForm((f) => ({ ...f, ...saved }));
        }

        const rawState = localStorage.getItem(CONN_STATE_KEY);
        if (rawState) {
          const state = JSON.parse(rawState) as { databases: string[]; database: string };
          setDatabases(state.databases ?? []);
          setConnected(state.databases?.length > 0);
          setForm((f) => ({ ...f, database: state.database ?? '' }));
        }

        const rawResult = localStorage.getItem(INSPECT_RESULT_KEY);
        if (rawResult) {
          const parsed = JSON.parse(rawResult);
          // Support both old single-result format and new array format
          const loaded: InspectionResult[] = Array.isArray(parsed) ? parsed : [parsed];
          setResults(loaded);
          if (loaded[0]?.tables.length > 0) {
            setSelectedTable(`${loaded[0].database}::${loaded[0].tables[0].name}`);
          }
        }

        const rawHiddenDbs = localStorage.getItem(HIDDEN_DBS_KEY);
        if (rawHiddenDbs) {
          try {
            setHiddenDatabases(new Set(JSON.parse(rawHiddenDbs) as string[]));
          } catch {
            setHiddenDatabases(new Set());
          }
        }

        const rawStatus = localStorage.getItem(TABLE_STATUS_KEY);
        if (rawStatus) {
          const status = JSON.parse(rawStatus) as { done: string[]; excluded: string[] };
          setDoneTables(new Set(status.done ?? []));
          setExcludedTables(new Set(status.excluded ?? []));
        }

        const rawReviewed = localStorage.getItem(PHASE2_REVIEWED_KEY);
        if (rawReviewed) {
          try {
            const reviewed = JSON.parse(rawReviewed) as string[];
            setPhase2Reviewed(new Set(reviewed));
          } catch {
            setPhase2Reviewed(new Set());
          }
        }
        const rawReviewedState = localStorage.getItem(PHASE2_REVIEWED_STATE_KEY);
        if (rawReviewedState) {
          try {
            setPhase2ReviewedState(JSON.parse(rawReviewedState) as Record<string, string>);
          } catch {
            setPhase2ReviewedState({});
          }
        }
        const rawTemplateReady = localStorage.getItem(PHASE3_TEMPLATE_READY_KEY);
        if (rawTemplateReady) {
          try {
            setPhase3TemplateReady(JSON.parse(rawTemplateReady) as { ready?: boolean; readyAt?: string; confirmedCount?: number; assignedKeys?: string[] });
          } catch {
            setPhase3TemplateReady(null);
          }
        }

        const rawConfig = localStorage.getItem('migration_config');
        if (rawConfig) {
          try {
            setMappingConfig(JSON.parse(rawConfig) as MigrationConfig);
          } catch {
            setMappingConfig(null);
          }
        }

        const rawPg = localStorage.getItem(PG_CONN_KEY);
        if (rawPg) {
          const saved = JSON.parse(rawPg) as { form: PgConnectionConfig; connected: boolean; schemas?: string[] };
          setPgForm(saved.form);
          if (saved.connected) {
            setPgConnected(true);
            setPgSchemas(saved.schemas ?? []);
          }
        }
      } catch { /* ignore */ }

      // Restore from persisted module config file (server-side) if exists
      try {
        const { data } = await axios.get('/api/module-config?module=migration');
        const cfg = data?.config as {
          mysql: { host: string; port: string; user: string; password: string; database: string; connected: boolean; databases: string[] };
          pg: { form: PgConnectionConfig; connected: boolean; schemas: string[] };
        };
        if (!cfg) return;

        setForm({
          host: cfg.mysql.host || DEFAULT_FORM.host,
          port: cfg.mysql.port || DEFAULT_FORM.port,
          user: cfg.mysql.user || '',
          password: cfg.mysql.password || '',
          database: cfg.mysql.database || '',
        });
        setConnected(Boolean(cfg.mysql.connected));
        setDatabases(cfg.mysql.databases ?? []);

        const rawPgLocal = localStorage.getItem(PG_CONN_KEY);
        let localPgSchemas: string[] = [];
        if (rawPgLocal) {
          try {
            const localPg = JSON.parse(rawPgLocal) as { schemas?: string[] };
            localPgSchemas = localPg.schemas ?? [];
          } catch {
            localPgSchemas = [];
          }
        }
        const rawConfig = localStorage.getItem('migration_config');
        let configSchemas: string[] = [];
        if (rawConfig) {
          try {
            const parsed = JSON.parse(rawConfig) as MigrationConfig;
            configSchemas = parsed.tables.map((t) => t.pgSchema).filter(Boolean);
          } catch {
            configSchemas = [];
          }
        }
        const mergedSchemas = [...new Set([...(cfg.pg?.schemas ?? []), ...localPgSchemas, ...configSchemas])];
        const nextPgForm = cfg.pg?.form ?? DEFAULT_PG;
        const nextPgConnected = Boolean(cfg.pg?.connected);
        setPgForm(nextPgForm);
        setPgConnected(nextPgConnected);
        setPgSchemas(mergedSchemas);

        localStorage.setItem(
          CREDS_KEY,
          JSON.stringify({
            host: cfg.mysql.host || DEFAULT_FORM.host,
            port: cfg.mysql.port || DEFAULT_FORM.port,
            user: cfg.mysql.user || '',
            password: cfg.mysql.password || '',
          })
        );
        localStorage.setItem(
          CONN_STATE_KEY,
          JSON.stringify({
            databases: cfg.mysql.databases ?? [],
            database: cfg.mysql.database || '',
          })
        );
        localStorage.setItem(
          PG_CONN_KEY,
          JSON.stringify({
            form: nextPgForm,
            connected: nextPgConnected,
            schemas: mergedSchemas,
          })
        );
      } catch {
        // no persisted config file yet
      }
    };

    void restore();
    void loadConnectionConfigFiles();
    void loadLatestRunStatus();
  }, []);

  const loadLatestRunStatus = async () => {
    try {
      const { data } = await axios.get('/api/migration-run-status');
      const runs = (data?.runs ?? []) as Array<{ id: string }>;
      if (!runs.length) {
        setMigrateCompletedKeys(new Set());
        return;
      }
      const { data: runData } = await axios.get('/api/migration-run-status', { params: { id: runs[0].id } });
      const run = runData?.run as { tables?: Array<{ key: string; status: 'pending' | 'running' | 'completed' | 'failed' }> } | undefined;
      const next = new Set<string>();
      for (const t of run?.tables ?? []) {
        if (t.status === 'completed') next.add(t.key);
      }
      setMigrateCompletedKeys(next);
    } catch {
      // non-blocking
    }
  };

  const handleConnect = async () => {
    if (!form.host || !form.user) return;
    setDbLoading(true);
    setDbError(null);
    setDatabases([]);
    setForm((f) => ({ ...f, database: '' }));
    try {
      const { data } = await axios.post('/api/list-databases', {
        host: form.host,
        port: Number(form.port),
        user: form.user,
        password: form.password,
      });
      const dbs = data.databases ?? [];
      setDatabases(dbs);
      setConnected(true);
      // Persist credentials + connection state
      localStorage.setItem(
        CREDS_KEY,
        JSON.stringify({ host: form.host, port: form.port, user: form.user, password: form.password })
      );
      localStorage.setItem(
        CONN_STATE_KEY,
        JSON.stringify({ databases: dbs, database: '' })
      );
      void syncModuleConfig(
        {
          host: form.host,
          port: form.port,
          user: form.user,
          password: form.password,
          database: '',
          connected: true,
          databases: dbs,
        },
        undefined
      );
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? err.message)
        : String(err);
      setDbError(msg);
    } finally {
      setDbLoading(false);
    }
  };

  const handleDisconnect = () => {
    setConnected(false);
    setDatabases([]);
    setResults([]);
    setSelectedTable(null);
    setForm((f) => ({ ...f, database: '' }));
    setDbError(null);
    localStorage.removeItem(CREDS_KEY);
    localStorage.removeItem(CONN_STATE_KEY);
    localStorage.removeItem(INSPECT_RESULT_KEY);
    localStorage.removeItem(TABLE_STATUS_KEY);
    localStorage.removeItem('migration_config');
    setDoneTables(new Set());
    setExcludedTables(new Set());
    void syncModuleConfig(
      {
        host: form.host,
        port: form.port,
        user: form.user,
        password: form.password,
        database: '',
        connected: false,
        databases: [],
      },
      undefined
    );
  };

  const handleInspect = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.post('/api/inspect', {
        host: form.host,
        port: Number(form.port),
        user: form.user,
        password: form.password,
        database: form.database,
      });
      const newResult = data.result as InspectionResult;
      // Upsert: replace existing result for same database, add new otherwise
      setResults((prev) => {
        const filtered = prev.filter((r) => r.database !== newResult.database);
        const updated = [...filtered, newResult];
        localStorage.setItem(INSPECT_RESULT_KEY, JSON.stringify(updated));
        return updated;
      });
      // Auto-select first table of the newly inspected database
      if (newResult.tables.length > 0) {
        setSelectedTable(`${newResult.database}::${newResult.tables[0].name}`);
      }
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err)
        ? (err.response?.data?.error ?? err.message)
        : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const saveTableStatus = (done: Set<string>, excluded: Set<string>) => {
    localStorage.setItem(
      TABLE_STATUS_KEY,
      JSON.stringify({ done: [...done], excluded: [...excluded] })
    );
  };

  const handleAddToSelection = (compositeKey: string) => {
    setDoneTables((prev) => {
      const next = new Set(prev);
      next.add(compositeKey);
      const excl = new Set(excludedTables);
      excl.delete(compositeKey);
      setExcludedTables(excl);
      saveTableStatus(next, excl);
      return next;
    });
  };

  const handleRemoveFromSelection = (compositeKey: string) => {
    setDoneTables((prev) => {
      const next = new Set(prev);
      next.delete(compositeKey);
      const excl = new Set(excludedTables);
      excl.delete(compositeKey);
      setExcludedTables(excl);
      saveTableStatus(next, excl);
      return next;
    });
  };

  const handleRemoveDatabase = (database: string) => {
    const updatedResults = results.filter((r) => r.database !== database);
    localStorage.setItem(INSPECT_RESULT_KEY, JSON.stringify(updatedResults));
    setResults(updatedResults);
    // Keep done/excluded/reviewed status in storage.
    // Removing a DB from current Phase 1 view should not erase prior mapping progress.
    const prefix = `${database}::`;
    // Move selection away if it was in the removed database
    if (selectedTable?.startsWith(prefix)) {
      const first = updatedResults[0];
      setSelectedTable(first?.tables[0] ? `${first.database}::${first.tables[0].name}` : null);
    }
    setHiddenDatabases((prev) => {
      if (!prev.has(database)) return prev;
      const next = new Set(prev);
      next.delete(database);
      localStorage.setItem(HIDDEN_DBS_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const handleToggleDatabaseVisibility = (database: string) => {
    setHiddenDatabases((prev) => {
      const next = new Set(prev);
      const isHidden = next.has(database);

      if (isHidden) {
        next.delete(database);
      } else {
        const currentlyVisible = results.filter((r) => !prev.has(r.database)).length;
        // Keep at least one DB visible so table panel never becomes empty by accident.
        if (currentlyVisible <= 1) return prev;
        next.add(database);
      }

      localStorage.setItem(HIDDEN_DBS_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const handleConnectPG = async () => {
    setPgConnecting(true);
    setPgConnError(null);
    try {
      const { data } = await axios.post<{ schemas: string[] }>('/api/pg-schemas', pgForm);
      setPgSchemas(data.schemas);
      setPgConnected(true);
      localStorage.setItem(PG_CONN_KEY, JSON.stringify({ form: pgForm, connected: true, schemas: data.schemas }));
      void syncModuleConfig(undefined, { form: pgForm, connected: true, schemas: data.schemas });
    } catch (err: unknown) {
      const msg = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      setPgConnError(msg);
      setPgConnected(false);
    } finally {
      setPgConnecting(false);
    }
  };

  const handleDisconnectPG = () => {
    setPgConnected(false);
    setPgSchemas([]);
    setPgConnError(null);
    localStorage.removeItem(PG_CONN_KEY);
    void syncModuleConfig(undefined, { form: pgForm, connected: false, schemas: [] });
  };

  const handleReset = () => {
    // Clear all table_mappings_* keys
    Object.keys(localStorage)
      .filter((k) => k.startsWith('table_mappings_'))
      .forEach((k) => localStorage.removeItem(k));
    // Clear all known keys
    [CREDS_KEY, CONN_STATE_KEY, INSPECT_RESULT_KEY, TABLE_STATUS_KEY, PG_CONN_KEY,
      'migration_config', 'phase2_schema_reviewed', 'phase2_schema_reviewed_state'].forEach((k) => localStorage.removeItem(k));
    // Reset all state
    setForm(DEFAULT_FORM);
    setConnected(false);
    setDatabases([]);
    setResults([]);
    setSelectedTable(null);
    setError(null);
    setDbError(null);
    setDoneTables(new Set());
    setExcludedTables(new Set());
    setPgForm(DEFAULT_PG);
    setPgConnected(false);
    setPgSchemas([]);
    setPgConnError(null);
    setShowResetDialog(false);
    setShowConnPanel(null);
    fetch('/api/module-config-reset', { method: 'POST' }).catch(() => undefined);
  };

  const handleProceedToPhase2 = () => {
    if (results.length === 0) return;
    const fresh = mergePhase1Mappings(initializeMigrationConfig(results));
    const statusRaw = localStorage.getItem(TABLE_STATUS_KEY);
    const status = statusRaw ? (JSON.parse(statusRaw) as { done?: string[]; excluded?: string[] }) : null;
    const done = new Set(status?.done ?? []);
    const excluded = new Set(status?.excluded ?? []);

    const existingRaw = localStorage.getItem('migration_config');
    let existing: MigrationConfig | null = null;
    if (existingRaw) {
      try {
        existing = JSON.parse(existingRaw) as MigrationConfig;
      } catch {
        existing = null;
      }
    }
    const keyOf = (t: { sourceDatabase?: string; mysqlName: string }) =>
      t.sourceDatabase ? `${t.sourceDatabase}::${t.mysqlName}` : t.mysqlName;
    const oldByKey = new Map<string, MigrationConfig['tables'][number]>();
    if (existing) {
      for (const t of existing.tables) {
        oldByKey.set(keyOf(t), t);
      }
    }
    const mergedTables = fresh.tables.map((t) => {
      const key = keyOf(t);
      const old = oldByKey.get(key) ?? (existing?.tables.find((x) => x.mysqlName === t.mysqlName));
      const include = (done.has(key) || done.has(t.mysqlName)) && !(excluded.has(key) || excluded.has(t.mysqlName));
      if (!old) return { ...t, include };
      return {
        ...t,
        ...old,
        mysqlName: t.mysqlName,
        sourceDatabase: t.sourceDatabase,
        include,
      };
    });

    const config: MigrationConfig = {
      ...(existing ?? fresh),
      ...fresh,
      id: existing?.id ?? fresh.id,
      name: existing?.name ?? fresh.name,
      sourceDatabase: existing?.sourceDatabase ?? fresh.sourceDatabase,
      targetDatabase: existing?.targetDatabase ?? fresh.targetDatabase,
      status: existing?.status ?? fresh.status,
      createdAt: existing?.createdAt ?? fresh.createdAt,
      updatedAt: new Date().toISOString(),
      tables: mergedTables,
    };

    const pgRaw = localStorage.getItem(PG_CONN_KEY);
    if (pgRaw) {
      try {
        const pg = JSON.parse(pgRaw) as { form?: PgConnectionConfig; connected?: boolean; schemas?: string[] };
        const schemas = [...new Set([...(pg.schemas ?? []), ...config.tables.map((t) => t.pgSchema).filter(Boolean)])];
        localStorage.setItem(PG_CONN_KEY, JSON.stringify({ ...pg, schemas }));
      } catch {
        // non-blocking
      }
    }

    localStorage.setItem('migration_config', JSON.stringify(config));
    setMappingConfig(config);
    localStorage.setItem('inspection_result', JSON.stringify(results));
    window.location.href = '/mapping';
  };

  const visibleResults = results.filter((r) => !hiddenDatabases.has(r.database));
  const configureTotal = results.reduce((sum, r) => sum + r.tables.length, 0);
  const allKeys = new Set<string>();
  const allMysqlNames = new Set<string>();
  for (const r of results) {
    for (const t of r.tables) {
      allKeys.add(`${r.database}::${t.name}`);
      allMysqlNames.add(t.name);
    }
  }
  const validDoneKeys = [...doneTables].filter((k) => {
    const mysqlName = k.includes('::') ? k.split('::')[1] : k;
    return allKeys.has(k) || allMysqlNames.has(mysqlName);
  });
  const resolvedSelectedKeys = [...new Set(validDoneKeys.map((k) => {
    if (k.includes('::')) return k;
    for (const r of results) {
      const found = r.tables.find((t) => t.name === k);
      if (found) return `${r.database}::${found.name}`;
    }
    return null;
  }).filter((k): k is string => Boolean(k)))];
  const configureDone = validDoneKeys.length;
  const assignTotal = configureDone;
  const assignDone = validDoneKeys.filter((k) => {
    const mysqlName = k.includes('::') ? k.split('::')[1] : k;
    return phase2Reviewed.has(k) || phase2Reviewed.has(mysqlName);
  }).length;
  const resolvedAssignKeys = [...new Set(
    validDoneKeys
      .filter((k) => {
        const mysqlName = k.includes('::') ? k.split('::')[1] : k;
        return phase2Reviewed.has(k) || phase2Reviewed.has(mysqlName);
      })
      .map((k) => {
        if (k.includes('::')) return k;
        for (const r of results) {
          const found = r.tables.find((t) => t.name === k);
          if (found) return `${r.database}::${found.name}`;
        }
        return null;
      })
      .filter((k): k is string => Boolean(k))
  )];
  const assignedTemplateKeySet = new Set(phase3TemplateReady?.assignedKeys ?? []);
  const templateAssigned = phase3TemplateReady?.ready
    ? (assignedTemplateKeySet.size > 0
      ? resolvedAssignKeys.filter((k) => assignedTemplateKeySet.has(k)).length
      : Math.min(phase3TemplateReady.confirmedCount ?? assignDone, assignDone))
    : 0;
  const templateScopeKeysForMigrate = phase3TemplateReady?.ready
    ? (assignedTemplateKeySet.size > 0 ? resolvedAssignKeys.filter((k) => assignedTemplateKeySet.has(k)) : resolvedAssignKeys)
    : [];
  const migrateTotal = templateAssigned;
  const migrateSuccess = Math.min(
    templateScopeKeysForMigrate.filter((k) => migrateCompletedKeys.has(k)).length,
    migrateTotal
  );
  const mappingKey = (t: { sourceDatabase?: string; mysqlName: string }) =>
    t.sourceDatabase ? `${t.sourceDatabase}::${t.mysqlName}` : t.mysqlName;
  const mappingTableFor = (database: string, mysqlName: string) =>
    mappingConfig?.tables.find((t) => mappingKey(t) === `${database}::${mysqlName}` || t.mysqlName === mysqlName);
  const mappingSignature = (t: NonNullable<MigrationConfig['tables'][number]>) =>
    JSON.stringify({
      pgSchema: t.pgSchema,
      pgName: t.pgName,
      columns: t.columns.map((c) => ({
        mysqlName: c.mysqlName,
        pgName: c.pgName,
        pgType: c.pgType,
        include: c.include,
        nullable: c.nullable,
        isTargetOnly: c.isTargetOnly ?? false,
        pkHandling: c.pkHandling ?? '',
        description: c.description ?? '',
      })),
    });
  const isPhase2Confirmed = (database: string, mysqlName: string) => {
    const key = `${database}::${mysqlName}`;
    const reviewed = phase2Reviewed.has(key) || phase2Reviewed.has(mysqlName);
    if (!reviewed) return false;
    const table = mappingTableFor(database, mysqlName);
    if (!table) return reviewed;
    const baseline = phase2ReviewedState[key] ?? phase2ReviewedState[mysqlName];
    if (!baseline) return reviewed;
    return baseline === mappingSignature(table);
  };
  const mappingDescription = (database: string, mysqlName: string) =>
    mappingTableFor(database, mysqlName)?.description?.trim() || '';
  const handleHomeNavigate = () => {
    const ok = window.confirm('Return to module home and clear all local session data?');
    if (!ok) return;
    localStorage.clear();
    window.location.href = '/';
  };
  const selectedKeySet = new Set(resolvedSelectedKeys);
  const sourceGroups = visibleResults.map((r) => ({
    database: r.database,
    tables: r.tables.filter((t) => !selectedKeySet.has(`${r.database}::${t.name}`)),
  })).filter((g) => g.tables.length > 0);
  const selectedGroups = results.map((r) => ({
    database: r.database,
    tables: r.tables.filter((t) => selectedKeySet.has(`${r.database}::${t.name}`)),
  })).filter((g) => g.tables.length > 0);

  useEffect(() => {
    if (results.length === 0) return;

    // Prune hidden dbs that no longer exist in current session.
    const existing = new Set(results.map((r) => r.database));
    const pruned = [...hiddenDatabases].filter((db) => existing.has(db));
    if (pruned.length !== hiddenDatabases.size) {
      const next = new Set(pruned);
      setHiddenDatabases(next);
      localStorage.setItem(HIDDEN_DBS_KEY, JSON.stringify([...next]));
      return;
    }

    // Ensure at least one DB remains visible.
    if (visibleResults.length === 0) {
      setHiddenDatabases(new Set());
      localStorage.setItem(HIDDEN_DBS_KEY, JSON.stringify([]));
      return;
    }

    // Keep selected table visible; if hidden, auto-select first visible table.
    if (selectedTable) {
      const [db] = selectedTable.split('::');
      if (hiddenDatabases.has(db)) {
        const firstVisible = visibleResults[0]?.tables[0];
        setSelectedTable(firstVisible ? `${visibleResults[0].database}::${firstVisible.name}` : null);
      }
    } else {
      const firstVisible = visibleResults[0]?.tables[0];
      if (firstVisible) setSelectedTable(`${visibleResults[0].database}::${firstVisible.name}`);
    }
  }, [results, hiddenDatabases, selectedTable, visibleResults]);

  return (
    <>
      <Head>
        <title>Configure Mapping — Phase 1</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        {/* Header */}
        <header ref={headerRef} className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between relative">
          <div>
            <h1 className="font-bold text-gray-900 dark:text-slate-100">Migration: Configure Mapping</h1>
            <p className="text-xs text-gray-500 dark:text-slate-400">Phase 1: connect databases, inspect source, and select tables to include.</p>
          </div>
          {/* Connection badges */}
          <div className="flex items-center gap-2" ref={connPanelRef}>
            <button
              ref={mysqlBadgeRef}
              type="button"
              onClick={() => toggleConnPanel('mysql')}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium border transition-colors cursor-pointer ${connected
                ? 'bg-green-50 dark:bg-emerald-950/30 text-green-700 dark:text-emerald-300 border-green-200 dark:border-emerald-800 hover:bg-green-100 dark:hover:bg-emerald-900/40'
                : 'bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-400 border-gray-200 dark:border-slate-700 hover:bg-gray-200 dark:hover:bg-slate-700'
                } ${showConnPanel === 'mysql' ? 'ring-2 ring-blue-300 dark:ring-blue-500' : ''}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${connected ? 'bg-green-500 dark:bg-emerald-400' : 'bg-gray-300 dark:bg-slate-500'}`} />
              MySQL{connected && form.database ? `: ${form.database}` : ''}
            </button>
            <button
              ref={pgBadgeRef}
              type="button"
              onClick={() => toggleConnPanel('pg')}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium border transition-colors cursor-pointer ${pgConnected
                ? 'bg-green-50 dark:bg-emerald-950/30 text-green-700 dark:text-emerald-300 border-green-200 dark:border-emerald-800 hover:bg-green-100 dark:hover:bg-emerald-900/40'
                : 'bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-400 border-gray-200 dark:border-slate-700 hover:bg-gray-200 dark:hover:bg-slate-700'
                } ${showConnPanel === 'pg' ? 'ring-2 ring-blue-300 dark:ring-blue-500' : ''}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${pgConnected ? 'bg-green-500 dark:bg-emerald-400' : 'bg-gray-300 dark:bg-slate-500'}`} />
              PostgreSQL{pgConnected && pgForm.database ? `: ${pgForm.database}` : ''}
            </button>

            {/* Connection dropdown panel */}
            {showConnPanel && (
              <div
                className="absolute z-50 w-[min(92vw,560px)] max-w-[560px] bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-700 shadow-xl p-5"
                style={{ left: connPanelPos.left, top: connPanelPos.top }}
              >
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-semibold text-gray-800 dark:text-slate-100">
                    {showConnPanel === 'mysql' ? 'MySQL Connection' : (
                      <span className="flex items-center gap-1.5">
                        PostgreSQL Connection
                        <button
                          ref={pgHelpBtnRef}
                          type="button"
                          onClick={() => {
                            if (pgHelpBtnRef.current) {
                              const r = pgHelpBtnRef.current.getBoundingClientRect();
                              setPgHelpPos({ top: r.bottom + 6, left: r.left });
                            }
                            setShowPgHelp((v) => !v);
                          }}
                          className="text-gray-300 dark:text-slate-500 hover:text-blue-400 dark:hover:text-blue-300 transition-colors"
                          title="PostgreSQL quick reference"
                        >
                          <HelpCircle size={14} />
                        </button>
                      </span>
                    )}
                  </h2>
                  <button
                    type="button"
                    onClick={() => setShowConnPanel(null)}
                    className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300 transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>

                <div className="mb-4 p-3 border border-gray-200 dark:border-slate-700 rounded-lg bg-gray-50 dark:bg-slate-800 space-y-2">
                  <p className="text-xs font-semibold text-gray-600 dark:text-slate-300">DB Connection Config</p>
                  <div className="flex items-center gap-2 min-w-0">
                    <input
                      type="text"
                      value={connConfigName}
                      onChange={(e) => setConnConfigName(e.target.value)}
                      placeholder="config name"
                      className="flex-1 min-w-0 border border-gray-200 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100"
                    />
                    <button
                      type="button"
                      onClick={handleSaveConnectionConfig}
                      disabled={connConfigLoading}
                      className="shrink-0 text-xs px-2.5 py-1.5 rounded-md bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                  <div className="flex items-center gap-2 min-w-0">
                    <select
                      value={selectedConnConfigFile}
                      onChange={(e) => setSelectedConnConfigFile(e.target.value)}
                      className="flex-1 min-w-0 border border-gray-200 dark:border-slate-700 rounded-md px-2.5 py-1.5 text-xs bg-white dark:bg-slate-900 text-gray-900 dark:text-slate-100"
                      title={selectedConnConfigFile}
                    >
                      <option value="">Select saved connection</option>
                      {connConfigFiles.map((f) => (
                        <option key={f} value={f}>{f}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void loadConnectionConfigFiles()}
                      className="shrink-0 text-xs px-2 py-1.5 rounded-md bg-gray-100 dark:bg-slate-700 hover:bg-gray-200 dark:hover:bg-slate-600 text-gray-700 dark:text-slate-200"
                    >
                      Refresh
                    </button>
                    <button
                      type="button"
                      onClick={handleLoadConnectionConfig}
                      disabled={!selectedConnConfigFile || connConfigLoading}
                      className="shrink-0 text-xs px-2.5 py-1.5 rounded-md bg-green-50 hover:bg-green-100 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 text-green-700 dark:text-emerald-300 disabled:opacity-50"
                    >
                      Load
                    </button>
                  </div>
                </div>

                {showConnPanel === 'mysql' && (
                  <form onSubmit={handleInspect} className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Host</label>
                      <input
                        className="input"
                        value={form.host}
                        onChange={(e) => setForm({ ...form, host: e.target.value })}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
                      <input
                        className="input"
                        type="number"
                        value={form.port}
                        onChange={(e) => setForm({ ...form, port: e.target.value })}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">User</label>
                      <input
                        className="input"
                        value={form.user}
                        onChange={(e) => {
                          setForm({ ...form, user: e.target.value, database: '' });
                          setDatabases([]);
                          setConnected(false);
                        }}
                        disabled={connected}
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
                      <div className="flex gap-2">
                        <input
                          className="input flex-1"
                          type="password"
                          value={form.password}
                          onChange={(e) => {
                            setForm({ ...form, password: e.target.value, database: '' });
                            setDatabases([]);
                            setConnected(false);
                          }}
                          disabled={connected}
                        />
                        {connected ? (
                          <button
                            type="button"
                            onClick={handleDisconnect}
                            title="Disconnect MySQL"
                            className="px-2.5 py-2 bg-red-50 hover:bg-red-100 dark:bg-rose-950/30 dark:hover:bg-rose-900/40 text-red-500 dark:text-rose-300 rounded-xl border border-red-200 dark:border-rose-800 transition-colors"
                          >
                            <PlugZap size={16} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={handleConnect}
                            disabled={dbLoading || !form.host || !form.user}
                            title="Connect MySQL"
                            className="px-2.5 py-2 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 disabled:opacity-50 text-gray-600 dark:text-slate-300 rounded-xl border border-gray-300 dark:border-slate-600 transition-colors"
                          >
                            {dbLoading ? <RotateCcw size={16} className="animate-spin" /> : <Plug size={16} />}
                          </button>
                        )}
                      </div>
                    </div>
                    {dbError && (
                      <div className="col-span-2 text-red-600 text-xs">{dbError}</div>
                    )}
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Database</label>
                      {databases.length > 0 ? (
                        <select
                          className="input"
                          value={form.database}
                          onChange={(e) => {
                            const database = e.target.value;
                            setForm({ ...form, database });
                            try {
                              const raw = localStorage.getItem(CONN_STATE_KEY);
                              const state = raw ? JSON.parse(raw) : {};
                              localStorage.setItem(CONN_STATE_KEY, JSON.stringify({ ...state, database }));
                            } catch { /* ignore */ }
                            void syncModuleConfig(
                              {
                                host: form.host,
                                port: form.port,
                                user: form.user,
                                password: form.password,
                                database,
                                connected,
                                databases,
                              },
                              undefined
                            );
                          }}
                          required
                        >
                          <option value="">— select a database —</option>
                          {databases.map((db) => (
                            <option key={db} value={db}>{db}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="input"
                          value={form.database}
                          onChange={(e) => {
                            const database = e.target.value;
                            setForm({ ...form, database });
                            void syncModuleConfig(
                              {
                                host: form.host,
                                port: form.port,
                                user: form.user,
                                password: form.password,
                                database,
                                connected,
                                databases,
                              },
                              undefined
                            );
                          }}
                          placeholder={connected ? 'No databases found' : 'Click Connect to list databases'}
                          required
                        />
                      )}
                    </div>
                    <div className="col-span-2">
                      <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold py-2.5 rounded-xl transition-colors"
                      >
                        {loading ? 'Inspecting…' : 'Inspect Database'}
                      </button>
                    </div>
                  </form>
                )}

                {showConnPanel === 'pg' && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Host</label>
                      <input
                        className="input"
                        value={pgForm.host}
                        onChange={(e) => setPgForm({ ...pgForm, host: e.target.value })}
                        disabled={pgConnected}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Port</label>
                      <input
                        className="input"
                        type="number"
                        value={pgForm.port}
                        onChange={(e) => setPgForm({ ...pgForm, port: Number(e.target.value) })}
                        disabled={pgConnected}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">User</label>
                      <input
                        className="input"
                        value={pgForm.user}
                        onChange={(e) => setPgForm({ ...pgForm, user: e.target.value })}
                        disabled={pgConnected}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
                      <div className="flex gap-2">
                        <input
                          className="input flex-1"
                          type="password"
                          value={pgForm.password}
                          onChange={(e) => setPgForm({ ...pgForm, password: e.target.value })}
                          disabled={pgConnected}
                        />
                        {pgConnected ? (
                          <button
                            type="button"
                            onClick={handleDisconnectPG}
                            title="Disconnect PostgreSQL"
                            className="px-2.5 py-2 bg-red-50 hover:bg-red-100 dark:bg-rose-950/30 dark:hover:bg-rose-900/40 text-red-500 dark:text-rose-300 rounded-xl border border-red-200 dark:border-rose-800 transition-colors"
                          >
                            <PlugZap size={16} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={handleConnectPG}
                            disabled={pgConnecting || !pgForm.host || !pgForm.database}
                            title="Connect PostgreSQL"
                            className="px-2.5 py-2 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 disabled:opacity-50 text-gray-600 dark:text-slate-300 rounded-xl border border-gray-300 dark:border-slate-600 transition-colors"
                          >
                            {pgConnecting ? <RotateCcw size={16} className="animate-spin" /> : <Plug size={16} />}
                          </button>
                        )}
                      </div>
                    </div>
                    {pgConnError && (
                      <div className="col-span-2 text-red-600 text-xs flex items-center gap-1">
                        <ServerCrash size={12} /> {pgConnError}
                      </div>
                    )}
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-gray-600 mb-1">Database</label>
                      <input
                        className="input"
                        value={pgForm.database}
                        onChange={(e) => setPgForm({ ...pgForm, database: e.target.value })}
                        disabled={pgConnected}
                        placeholder="postgres"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={pgForm.ssl}
                          onChange={(e) => setPgForm({ ...pgForm, ssl: e.target.checked })}
                          disabled={pgConnected}
                          className="w-3.5 h-3.5"
                        />
                        Use SSL
                      </label>
                    </div>
                    {pgConnected && pgSchemas.length > 0 && (
                      <div className="col-span-2 text-xs text-green-600 dark:text-emerald-300 bg-green-50 dark:bg-emerald-950/30 border border-green-200 dark:border-emerald-800 rounded-lg px-3 py-2">
                        ✓ Connected · {pgSchemas.length} schemas: {pgSchemas.slice(0, 5).join(', ')}{pgSchemas.length > 5 ? `, +${pgSchemas.length - 5} more` : ''}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Phase nav */}
          <nav className="flex items-center gap-1 text-sm">
            {[
              { label: 'Home', href: '/' },
              { label: 'Source Selection', href: '/migration', active: true },
              { label: 'Mapping Config', href: '/mapping' },
              { label: 'Schema Template', href: '/docs' },
              { label: 'Migrate', href: '/migrate' },
            ].map((item, i) => (
              <React.Fragment key={item.href}>
                {i > 0 && <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />}
                {item.href === '/' ? (
                  <button
                    type="button"
                    onClick={handleHomeNavigate}
                    className={`px-3 py-1 rounded-lg ${item.active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}
                  >
                    {item.label}
                  </button>
                ) : (
                  <Link
                    href={item.href}
                    className={`px-3 py-1 rounded-lg ${item.active ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold' : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'}`}
                  >
                    {item.label}
                    {item.href === '/migration' && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-200/70 dark:bg-blue-800/70 text-blue-800 dark:text-blue-200 font-semibold">
                        {configureDone}/{configureTotal}
                      </span>
                    )}
                    {item.href === '/mapping' && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-200/70 dark:bg-emerald-800/70 text-emerald-800 dark:text-emerald-200 font-semibold">
                        {assignDone}/{assignTotal}
                      </span>
                    )}
                    {item.href === '/docs' && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-200/70 dark:bg-amber-800/70 text-amber-800 dark:text-amber-200 font-semibold">
                        {templateAssigned}/{assignDone}
                      </span>
                    )}
                    {item.href === '/migrate' && (
                      <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-cyan-200/70 dark:bg-cyan-800/70 text-cyan-800 dark:text-cyan-200 font-semibold">
                        {migrateSuccess}/{migrateTotal}
                      </span>
                    )}
                  </Link>
                )}
              </React.Fragment>
            ))}
            <span className="w-px h-5 bg-gray-200 dark:bg-slate-700 mx-1" />
            <button
              type="button"
              onClick={() => setShowResetDialog(true)}
              title="Reset everything"
              className="p-1.5 text-gray-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-rose-400 hover:bg-red-50 dark:hover:bg-rose-950/30 rounded-lg transition-colors"
            >
              <Trash2 size={15} />
            </button>
          </nav>
        </header>

        <main className="max-w-6xl mx-auto px-6 py-8 space-y-6">
          {loading && <LoadingSpinner message="Connecting to MySQL and reading schema…" />}
          {results.length === 0 && (
              <div className="min-h-[46vh] flex items-center justify-center">
              <div className="max-w-xl text-center bg-white dark:bg-slate-900 border border-gray-200 dark:border-slate-700 rounded-2xl px-6 py-7">
                <h2 className="font-semibold text-gray-900 dark:text-slate-100">How To Select Source Tables</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400 mt-2">
                  Open MySQL connection badge and connect to source DB, choose database, then click <strong>Inspect Database</strong>.
                  Then move tables to selection (drag or Add). Final mapping configuration is done in Phase 2.
                </p>
              </div>
            </div>
          )}

          {results.length > 0 && (
            <>
              {/* Summary bar */}
              <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-xl px-6 py-4 flex items-center justify-between flex-wrap gap-3">
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-blue-800 dark:text-blue-200">
                    <strong>{results.reduce((s, r) => s + r.tables.length, 0)}</strong> tables across{' '}
                    <strong>{results.length}</strong> database{results.length !== 1 ? 's' : ''}
                  </span>
                  {results.map((r) => {
                    const isHidden = hiddenDatabases.has(r.database);
                    return (
                    <span
                      key={r.database}
                      onClick={() => handleToggleDatabaseVisibility(r.database)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleToggleDatabaseVisibility(r.database);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border transition-colors ${
                        isHidden
                          ? 'bg-gray-100 dark:bg-slate-800 text-gray-500 dark:text-slate-400 border-gray-200 dark:border-slate-700'
                          : 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800'
                      }`}
                      title={isHidden ? `Show tables for ${r.database}` : `Hide tables for ${r.database}`}
                    >
                      <Database size={10} />
                      {r.database}
                      <span className={isHidden ? 'text-gray-400 dark:text-slate-500' : 'text-blue-400 dark:text-blue-400/80'}>({r.tables.length})</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveDatabase(r.database);
                        }}
                        className="ml-0.5 hover:text-red-500 dark:hover:text-rose-400 transition-colors"
                        title={`Remove ${r.database}`}
                      >
                        <X size={10} />
                      </button>
                    </span>
                  )})}
                </div>
                <button
                  onClick={handleProceedToPhase2}
                  className="bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600 dark:border dark:border-blue-500/60 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors flex items-center gap-1"
                >
                  Configure Mappings
                  <ChevronRight size={16} />
                </button>
              </div>

              {/* Source selection browser */}
              <div className="grid grid-cols-2 gap-6">
                <div className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 dark:border-slate-700 bg-gray-50 dark:bg-slate-800 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-gray-600 dark:text-slate-300 uppercase tracking-wide">
                      Source Tables
                    </h2>
                    <span className="text-xs text-gray-500 dark:text-slate-400">
                      {sourceGroups.reduce((sum, g) => sum + g.tables.length, 0)} available
                    </span>
                  </div>
                  <div className="max-h-[70vh] overflow-y-auto divide-y divide-gray-100 dark:divide-slate-700">
                    {sourceGroups.map((group) => (
                      <div key={group.database}>
                        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-50 dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700">
                          <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-slate-300">
                            <Database size={11} className="text-blue-400 dark:text-blue-300" />
                            {group.database}
                            <span className="text-gray-400 dark:text-slate-500 font-normal">({group.tables.length})</span>
                          </span>
                        </div>
                        <ul className="divide-y divide-gray-100 dark:divide-slate-700">
                          {group.tables.map((t) => {
                            const key = `${group.database}::${t.name}`;
                            return (
                              <li key={key}>
                                <div
                                  draggable
                                  onDragStart={() => setDraggingKey(key)}
                                  className={`w-full px-4 py-2.5 text-left hover:bg-blue-50 dark:hover:bg-slate-800 transition-colors ${selectedTable === key ? 'bg-blue-50 dark:bg-blue-950/40 border-l-2 border-blue-500 dark:border-blue-400' : ''}`}
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setSelectedTable(key)}
                                      className="min-w-0 text-left"
                                    >
                                      <p className="text-sm font-medium truncate text-gray-800 dark:text-slate-100">{t.name}</p>
                                      <p className="text-xs text-gray-400 dark:text-slate-500">{t.columns.length} cols · {t.rowCount.toLocaleString()} rows</p>
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleAddToSelection(key)}
                                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100"
                                    >
                                      <PlusCircle size={12} />
                                      Add
                                    </button>
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                    {sourceGroups.length === 0 && (
                      <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-slate-500">
                        No source tables available.
                      </div>
                    )}
                  </div>
                </div>

                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (!draggingKey) return;
                    handleAddToSelection(draggingKey);
                    setDraggingKey(null);
                  }}
                  className="bg-white dark:bg-slate-900 rounded-xl border border-gray-200 dark:border-slate-700 overflow-hidden"
                >
                  <div className="px-4 py-3 border-b border-gray-100 dark:border-slate-700 bg-emerald-50/80 dark:bg-emerald-950/20 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-emerald-700 dark:text-emerald-300 uppercase tracking-wide">
                      Selected Tables
                    </h2>
                    <span className="text-xs text-emerald-600 dark:text-emerald-300">
                      {resolvedSelectedKeys.length} selected
                    </span>
                  </div>
                  <div className="px-4 py-2 border-b border-gray-100 dark:border-slate-700 text-xs text-amber-700 dark:text-amber-300 bg-amber-50/80 dark:bg-amber-950/20">
                    Drag from Source Tables into this pane, or click Add. Final mapping configuration is done in Phase 2.
                  </div>
                  <div className="max-h-[70vh] overflow-y-auto divide-y divide-gray-100 dark:divide-slate-700">
                    {selectedGroups.map((group) => (
                      <div key={group.database}>
                        <div className="px-3 py-1.5 bg-gray-50 dark:bg-slate-800 border-b border-gray-100 dark:border-slate-700">
                          <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 dark:text-slate-300">
                            <Database size={11} className="text-emerald-500 dark:text-emerald-300" />
                            {group.database}
                            <span className="text-gray-400 dark:text-slate-500 font-normal">({group.tables.length})</span>
                          </span>
                        </div>
                        <ul className="divide-y divide-gray-100 dark:divide-slate-700">
                          {group.tables.map((t) => {
                            const key = `${group.database}::${t.name}`;
                            const isConfirmed = isPhase2Confirmed(group.database, t.name);
                            const description = mappingDescription(group.database, t.name);
                            const mapped = mappingTableFor(group.database, t.name);
                            return (
                              <li key={key}>
                                <div className={`w-full px-4 py-2.5 text-left transition-colors ${
                                  isConfirmed
                                    ? 'bg-emerald-50/80 dark:bg-emerald-950/35 border-l-2 border-emerald-500 dark:border-emerald-400'
                                    : 'hover:bg-emerald-50/60 dark:hover:bg-emerald-950/20'
                                } ${selectedTable === key ? 'ring-1 ring-blue-300 dark:ring-blue-700' : ''}`}>
                                  <div className="flex items-center justify-between gap-2">
                                    <button
                                      type="button"
                                      onClick={() => setSelectedTable(key)}
                                      className="min-w-0 text-left"
                                    >
                                      <p className="text-sm font-medium truncate text-gray-800 dark:text-slate-100 flex items-center gap-1.5">
                                        {t.name}
                                        {isConfirmed && <BadgeCheck size={13} className="text-emerald-600 dark:text-emerald-300 shrink-0" />}
                                      </p>
                                      <p className="text-xs text-gray-400 dark:text-slate-500">{t.columns.length} cols · {t.rowCount.toLocaleString()} rows</p>
                                      {isConfirmed && mapped && (
                                        <p className="text-xs text-emerald-700 dark:text-emerald-300 truncate mt-0.5 font-mono">
                                          → {mapped.pgSchema}.{mapped.pgName}
                                        </p>
                                      )}
                                      {description && (
                                        <p className="text-xs italic text-gray-500 dark:text-slate-400 truncate mt-0.5">{description}</p>
                                      )}
                                    </button>
                                    {isConfirmed ? (
                                      <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-emerald-200 text-emerald-700 bg-emerald-50">
                                        <BadgeCheck size={12} />
                                        Configured
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => handleRemoveFromSelection(key)}
                                        className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-red-200 text-red-600 bg-red-50 hover:bg-red-100"
                                      >
                                        <X size={12} />
                                        Remove
                                      </button>
                                    )}
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                    {selectedGroups.length === 0 && (
                      <div className="px-4 py-8 text-center text-sm text-gray-400 dark:text-slate-500">
                        No selected tables yet.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      <style jsx global>{`
        .input {
          width: 100%;
          border: 1px solid #e5e7eb;
          border-radius: 0.5rem;
          padding: 0.5rem 0.75rem;
          font-size: 0.875rem;
          outline: none;
          transition: box-shadow 0.15s;
        }
        .input:focus {
          box-shadow: 0 0 0 2px #3b82f6;
        }
      `}</style>

      {showPgHelp && (
        <PgHelpPopover
          top={pgHelpPos.top}
          left={pgHelpPos.left}
          onClose={() => setShowPgHelp(false)}
        />
      )}

      {/* Reset Confirmation Dialog */}
      {showResetDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-slate-700 w-full max-w-md mx-4 p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 dark:bg-rose-950/40 flex items-center justify-center">
                <Trash2 size={18} className="text-red-600 dark:text-rose-300" />
              </div>
              <div>
                <h2 className="font-semibold text-gray-900 dark:text-slate-100 text-base">Reset Everything?</h2>
                <p className="text-sm text-gray-500 dark:text-slate-400 mt-1">
                  This will permanently clear all saved data including connection settings, inspection results, table mappings, and migration configuration.
                </p>
              </div>
            </div>
            <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2 text-xs text-amber-700 dark:text-amber-300 mb-5">
              This action cannot be undone. You will need to reconnect and re-inspect your database.
            </div>
            <div className="flex gap-3 justify-end">
              <button
                type="button"
                onClick={() => setShowResetDialog(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-slate-200 bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors flex items-center gap-1.5"
              >
                <Trash2 size={14} />
                Reset Everything
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
