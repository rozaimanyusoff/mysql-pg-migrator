import Head from 'next/head';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { toast } from 'sonner';
import ResetEverythingButton from '../components/ResetEverythingButton';
import { ArrowLeft, ArrowRight, ChevronRight, Link2, Plug, PlugZap, RotateCcw, X, Plus, Trash2 } from 'lucide-react';

interface PgConnectForm {
  host: string;
  port: number;
  user: string;
  password: string;
  ssl: boolean;
  maintenanceDb: string;
}

interface PgTableMeta {
  schema: string;
  name: string;
  columns: string[];
  primaryKeys: string[];
}

interface PgSchemaMeta {
  name: string;
  tableCount: number;
  tables: PgTableMeta[];
}

interface PgRelationship {
  child_schema: string;
  child_table: string;
  child_column: string;
  parent_schema: string;
  parent_table: string;
  parent_column: string;
  constraint_name: string;
}

type TableRelationRole = 'auto' | 'parent' | 'child';

interface TableConfig {
  tableKey: string;
  schema: string;
  table: string;
  relationRole: TableRelationRole;
  selectedPkColumn: string;
  generateUuidPk: boolean;
  uuidPkColumn: string;
  reassignPrimaryKey: boolean;
}

interface ChildFkConfig {
  relationshipKey: string;
  childTableKey: string;
  childColumn: string;
  parentTableKey: string;
  parentColumn: string;
  parentUuidColumn: string;
  generateChildUuidFk: boolean;
}

interface SnapshotMeta {
  module: string;
  savedAt?: string;
  version: string;
}

interface SchemaConfigSnapshot {
  meta: SnapshotMeta;
  postgres: {
    connection: Omit<PgConnectForm, 'password'> & { passwordMask: string };
    selectedDatabase: string;
  };
  selection: {
    selectedSchemas: string[];
    selectedTables: string[];
  };
  tableConfigs: TableConfig[];
  childFkConfigs: ChildFkConfig[];
}

const MODULE_KEY = 'schema-config';
const PG_CONN_KEY = 'pg_connection';
const DEFAULT_FORM: PgConnectForm = {
  host: 'localhost',
  port: 5432,
  user: 'postgres',
  password: '',
  ssl: false,
  maintenanceDb: 'postgres',
};

const EMPTY_MYSQL_PLACEHOLDER = {
  host: '',
  port: '',
  user: '',
  password: '',
  database: '',
  connected: false,
  databases: [],
};

const tableKey = (schema: string, table: string) => `${schema}.${table}`;
const buildRelationshipKey = (childTableKey: string, childColumn: string, parentTableKey: string, parentColumn: string) =>
  `${childTableKey}:${childColumn}->${parentTableKey}:${parentColumn}`;

const getPkCandidates = (table: PgTableMeta): string[] => {
  if (table.primaryKeys.length > 0) return table.primaryKeys;
  const idLike = table.columns.find((c) => c.toLowerCase() === 'id');
  if (idLike) return [idLike];
  return table.columns.length > 0 ? [table.columns[0]] : ['id'];
};

export default function SchemaConfigPage() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2>(1);
  const [form, setForm] = useState<PgConnectForm>(DEFAULT_FORM);
  const [showConnPanel, setShowConnPanel] = useState(false);
  const [pgConnected, setPgConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loadingMeta, setLoadingMeta] = useState(false);
  const [databases, setDatabases] = useState<string[]>([]);
  const [selectedDb, setSelectedDb] = useState('');
  const [schemas, setSchemas] = useState<PgSchemaMeta[]>([]);
  const [relationships, setRelationships] = useState<PgRelationship[]>([]);
  const [activeSchema, setActiveSchema] = useState('');
  const [selectedTableKeys, setSelectedTableKeys] = useState<Set<string>>(new Set());
  const [tableConfigs, setTableConfigs] = useState<Record<string, TableConfig>>({});
  const [childFkConfigs, setChildFkConfigs] = useState<Record<string, ChildFkConfig>>({});
  const [mappingDraft, setMappingDraft] = useState({
    childTableKey: '',
    childColumn: '',
    parentTableKey: '',
    parentColumn: '',
  });
  const [connConfigFiles, setConnConfigFiles] = useState<string[]>([]);
  const [selectedConnConfigFile, setSelectedConnConfigFile] = useState('');
  const [connConfigName, setConnConfigName] = useState('default');
  const [connConfigLoading, setConnConfigLoading] = useState(false);
  const [connConfigMessage, setConnConfigMessage] = useState<string | null>(null);
  const headerRef = useRef<HTMLElement>(null);
  const pgBadgeRef = useRef<HTMLButtonElement>(null);
  const connPanelRef = useRef<HTMLDivElement>(null);
  const [connPanelPos, setConnPanelPos] = useState({ left: 0, top: 0 });

  const tableByKey = useMemo(() => {
    const map = new Map<string, PgTableMeta>();
    for (const schema of schemas) {
      for (const table of schema.tables) {
        map.set(tableKey(schema.name, table.name), table);
      }
    }
    return map;
  }, [schemas]);

  const selectedTables = useMemo(() => {
    const tables: PgTableMeta[] = [];
    for (const key of selectedTableKeys) {
      const table = tableByKey.get(key);
      if (table) tables.push(table);
    }
    return tables.sort((a, b) =>
      `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`)
    );
  }, [selectedTableKeys, tableByKey]);

  const selectedSchemaSet = useMemo(() => {
    const names = new Set<string>();
    for (const key of selectedTableKeys) {
      names.add(key.split('.')[0] || '');
    }
    names.delete('');
    return names;
  }, [selectedTableKeys]);

  const visibleTables = useMemo(() => {
    if (!activeSchema) return [];
    const schema = schemas.find((s) => s.name === activeSchema);
    return schema?.tables ?? [];
  }, [schemas, activeSchema]);

  const selectedRelationshipRows = useMemo(() => {
    return relationships.filter((rel) => {
      const childKey = tableKey(rel.child_schema, rel.child_table);
      const parentKey = tableKey(rel.parent_schema, rel.parent_table);
      if (!selectedTableKeys.has(childKey) || !selectedTableKeys.has(parentKey)) return false;

      const childRole = tableConfigs[childKey]?.relationRole ?? 'auto';
      const parentRole = tableConfigs[parentKey]?.relationRole ?? 'auto';

      if (childRole === 'parent') return false;
      if (parentRole === 'child') return false;
      return true;
    });
  }, [relationships, selectedTableKeys, tableConfigs]);

  const selectedTableKeyList = useMemo(() => {
    return [...selectedTableKeys].sort((a, b) => a.localeCompare(b));
  }, [selectedTableKeys]);

  const visibleChildFkConfigs = useMemo(() => {
    return Object.values(childFkConfigs)
      .filter((cfg) => selectedTableKeys.has(cfg.childTableKey) && selectedTableKeys.has(cfg.parentTableKey))
      .filter((cfg) => {
        const childRole = tableConfigs[cfg.childTableKey]?.relationRole ?? 'auto';
        const parentRole = tableConfigs[cfg.parentTableKey]?.relationRole ?? 'auto';
        if (childRole === 'parent') return false;
        if (parentRole === 'child') return false;
        return true;
      })
      .sort((a, b) => a.relationshipKey.localeCompare(b.relationshipKey));
  }, [childFkConfigs, selectedTableKeys, tableConfigs]);

  const applySchemaConfigSnapshot = (snapshot: SchemaConfigSnapshot) => {
    const conn = snapshot.postgres?.connection;
    if (conn) {
      setForm((prev) => ({
        ...prev,
        host: conn.host || prev.host,
        port: Number(conn.port) || prev.port,
        user: conn.user || prev.user,
        ssl: Boolean(conn.ssl),
        maintenanceDb: conn.maintenanceDb || prev.maintenanceDb,
      }));
    }
    setSelectedDb(snapshot.postgres?.selectedDatabase || '');
    setStep(1);
    toast.success('Schema config restored.');
  };

  useEffect(() => {
    if (!connConfigMessage) return;
    if (connConfigMessage.startsWith('Saved:') || connConfigMessage.startsWith('Loaded:')) {
      toast.success(connConfigMessage);
    } else {
      window.alert(connConfigMessage);
    }
    setConnConfigMessage(null);
  }, [connConfigMessage]);

  useEffect(() => {
    const raw = router.query.openConn;
    const openConn = Array.isArray(raw) ? raw[0] : raw;
    if (!router.isReady) return;
    if (openConn !== 'pg') return;
    requestAnimationFrame(() => {
      positionConnPanel();
      setShowConnPanel(true);
    });
    const { openConn: _openConn, ...rest } = router.query;
    void router.replace({ pathname: '/schema-config', query: rest }, undefined, { shallow: true });
  }, [router.isReady, router.query.openConn]);

  useEffect(() => {
    const raw = router.query.restoreFile;
    const restoreFile = Array.isArray(raw) ? raw[0] : raw;
    if (!restoreFile) return;

    const loadFromRestoreFile = async () => {
      try {
        const { data } = await axios.get('/api/schema-config-load', { params: { file: restoreFile } });
        const snapshot = data.snapshot as SchemaConfigSnapshot;
        applySchemaConfigSnapshot(snapshot);
        await router.replace('/schema-config', undefined, { shallow: true });
      } catch (err: unknown) {
        const message = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
        window.alert(message);
      }
    };
    void loadFromRestoreFile();
  }, [router]);

  const loadConnectionConfigFiles = async () => {
    try {
      const { data } = await axios.get('/api/connection-config-list', { params: { module: MODULE_KEY } });
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
        module: MODULE_KEY,
        name: connConfigName,
        mysql: EMPTY_MYSQL_PLACEHOLDER,
        pg: {
          form: {
            host: form.host,
            port: form.port,
            user: form.user,
            password: form.password,
            database: form.maintenanceDb,
            ssl: form.ssl,
          },
          connected: pgConnected,
          schemas: schemas.map((s) => s.name),
          databases,
          selectedDb,
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
        pg?: {
          form?: { host?: string; port?: number; user?: string; password?: string; database?: string; ssl?: boolean };
          connected?: boolean;
          schemas?: string[];
          databases?: string[];
          selectedDb?: string;
        };
      };

      const pg = cfg.pg;
      if (pg?.form) {
        setForm((prev) => ({
          ...prev,
          host: pg.form?.host ?? prev.host,
          port: Number(pg.form?.port) || prev.port,
          user: pg.form?.user ?? prev.user,
          password: pg.form?.password ?? '',
          maintenanceDb: pg.form?.database ?? prev.maintenanceDb,
          ssl: Boolean(pg.form?.ssl),
        }));
      }
      setPgConnected(Boolean(pg?.connected));
      setDatabases(pg?.databases ?? []);
      setSelectedDb(pg?.selectedDb ?? '');
      localStorage.setItem(
        PG_CONN_KEY,
        JSON.stringify({
          form: {
            host: pg?.form?.host ?? form.host,
            port: Number(pg?.form?.port) || form.port,
            user: pg?.form?.user ?? form.user,
            password: pg?.form?.password ?? '',
            database: pg?.form?.database ?? '',
            ssl: Boolean(pg?.form?.ssl),
          },
          connected: Boolean(pg?.connected),
          schemas: pg?.schemas ?? [],
        })
      );
      setSchemas([]);
      setRelationships([]);
      setActiveSchema('');
      resetSelection();
      setConnConfigMessage(`Loaded: ${selectedConnConfigFile}`);
    } catch (err: unknown) {
      setConnConfigMessage(axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err));
    } finally {
      setConnConfigLoading(false);
    }
  };

  useEffect(() => {
    const restoreModuleConnection = async () => {
      try {
        const { data } = await axios.get('/api/module-config?module=schema-config');
        const cfg = data?.config as {
          pg?: {
            form?: { host?: string; port?: number; user?: string; password?: string; database?: string; ssl?: boolean };
            connected?: boolean;
            schemas?: string[];
            databases?: string[];
            selectedDb?: string;
          };
        };
        const pg = cfg?.pg;
        if (!pg) return;
        if (pg.form) {
          setForm((prev) => ({
            ...prev,
            host: pg.form?.host ?? prev.host,
            port: Number(pg.form?.port) || prev.port,
            user: pg.form?.user ?? prev.user,
            password: pg.form?.password ?? prev.password,
            maintenanceDb: pg.form?.database ?? prev.maintenanceDb,
            ssl: Boolean(pg.form?.ssl),
          }));
        }
        setPgConnected(Boolean(pg.connected));
        setDatabases(pg.databases ?? []);
        setSelectedDb(pg.selectedDb ?? (pg.form?.database ?? ''));
        localStorage.setItem(
          PG_CONN_KEY,
          JSON.stringify({
            form: {
              host: pg.form?.host ?? DEFAULT_FORM.host,
              port: Number(pg.form?.port) || DEFAULT_FORM.port,
              user: pg.form?.user ?? DEFAULT_FORM.user,
              password: pg.form?.password ?? '',
              database: pg.form?.database ?? '',
              ssl: Boolean(pg.form?.ssl),
            },
            connected: Boolean(pg.connected),
            schemas: pg.schemas ?? [],
          })
        );
      } catch {
        // ignore if missing
      }
    };
    void restoreModuleConnection();
    void loadConnectionConfigFiles();
  }, []);

  const positionConnPanel = () => {
    const headerEl = headerRef.current;
    const badgeEl = pgBadgeRef.current;
    if (!headerEl || !badgeEl) return;

    const headerRect = headerEl.getBoundingClientRect();
    const badgeRect = badgeEl.getBoundingClientRect();
    const panelWidth = Math.min(window.innerWidth * 0.92, 560);
    const margin = 8;
    const top = badgeRect.bottom - headerRect.top + 8;
    const preferredLeft = badgeRect.right - headerRect.left - panelWidth;
    const left = Math.max(margin, Math.min(preferredLeft, headerRect.width - panelWidth - margin));
    setConnPanelPos({ left, top });
  };

  const toggleConnPanel = () => {
    setShowConnPanel((current) => {
      if (current) return false;
      positionConnPanel();
      return true;
    });
  };

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (connPanelRef.current && !connPanelRef.current.contains(e.target as Node)) {
        setShowConnPanel(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!showConnPanel) return;
    const onResize = () => positionConnPanel();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [showConnPanel]);

  const resetSelection = () => {
    setSelectedTableKeys(new Set());
    setTableConfigs({});
    setChildFkConfigs({});
    setStep(1);
    setMappingDraft({ childTableKey: '', childColumn: '', parentTableKey: '', parentColumn: '' });
  };

  const ensureTableConfig = (table: PgTableMeta): TableConfig => {
    const key = tableKey(table.schema, table.name);
    const pkCandidates = getPkCandidates(table);
    const existing = tableConfigs[key];
    if (existing) {
      if (pkCandidates.includes(existing.selectedPkColumn)) return existing;
      return { ...existing, selectedPkColumn: pkCandidates[0] || 'id' };
    }
    const selectedPkColumn = pkCandidates[0] || 'id';
    return {
      tableKey: key,
      schema: table.schema,
      table: table.name,
      relationRole: 'auto',
      selectedPkColumn,
      generateUuidPk: true,
      uuidPkColumn: 'id',
      reassignPrimaryKey: true,
    };
  };

  const hydrateConfigForSelectedTables = (keys: Set<string>) => {
    const nextTableConfigs: Record<string, TableConfig> = {};
    for (const key of keys) {
      const table = tableByKey.get(key);
      if (!table) continue;
      nextTableConfigs[key] = ensureTableConfig(table);
    }
    setTableConfigs(nextTableConfigs);

    const nextChildConfigs: Record<string, ChildFkConfig> = {};
    for (const cfg of Object.values(childFkConfigs)) {
      if (!keys.has(cfg.childTableKey) || !keys.has(cfg.parentTableKey)) continue;
      nextChildConfigs[cfg.relationshipKey] = cfg;
    }
    for (const rel of relationships) {
      const childKey = tableKey(rel.child_schema, rel.child_table);
      const parentKey = tableKey(rel.parent_schema, rel.parent_table);
      if (!keys.has(childKey) || !keys.has(parentKey)) continue;
      const relKey = buildRelationshipKey(childKey, rel.child_column, parentKey, rel.parent_column);
      const parentCfg = nextTableConfigs[parentKey];
      nextChildConfigs[relKey] = nextChildConfigs[relKey] || {
        relationshipKey: relKey,
        childTableKey: childKey,
        childColumn: rel.child_column,
        parentTableKey: parentKey,
        parentColumn: rel.parent_column,
        parentUuidColumn: parentCfg?.uuidPkColumn || 'id',
        generateChildUuidFk: true,
      };
    }
    setChildFkConfigs(nextChildConfigs);
  };

  const addManualMapping = () => {
    const childTableKey = mappingDraft.childTableKey;
    const childColumn = mappingDraft.childColumn;
    const parentTableKey = mappingDraft.parentTableKey;
    const parentColumn = mappingDraft.parentColumn;
    if (!childTableKey || !childColumn || !parentTableKey || !parentColumn) {
      window.alert('Choose child table/column and parent table/column first.');
      return;
    }
    if (childTableKey === parentTableKey && childColumn === parentColumn) {
      window.alert('Child and parent mapping cannot be the same column.');
      return;
    }
    const parentCfg = tableConfigs[parentTableKey];
    const relKey = buildRelationshipKey(childTableKey, childColumn, parentTableKey, parentColumn);
    setChildFkConfigs((prev) => ({
      ...prev,
      [relKey]: {
        relationshipKey: relKey,
        childTableKey,
        childColumn,
        parentTableKey,
        parentColumn,
        parentUuidColumn: parentCfg?.uuidPkColumn || 'id',
        generateChildUuidFk: true,
      },
    }));
  };

  const removeMapping = (relationshipKey: string) => {
    setChildFkConfigs((prev) => {
      const next = { ...prev };
      delete next[relationshipKey];
      return next;
    });
  };

  useEffect(() => {
    if (selectedTableKeyList.length === 0) {
      setMappingDraft({ childTableKey: '', childColumn: '', parentTableKey: '', parentColumn: '' });
      return;
    }
    setMappingDraft((prev) => {
      const childTableKey = selectedTableKeyList.includes(prev.childTableKey) ? prev.childTableKey : selectedTableKeyList[0];
      const parentTableKey = selectedTableKeyList.includes(prev.parentTableKey) ? prev.parentTableKey : selectedTableKeyList[0];
      const childCols = tableByKey.get(childTableKey)?.columns ?? [];
      const parentCols = tableByKey.get(parentTableKey)?.columns ?? [];
      const childColumn = childCols.includes(prev.childColumn) ? prev.childColumn : (childCols[0] || '');
      const parentColumn = parentCols.includes(prev.parentColumn) ? prev.parentColumn : (parentCols[0] || '');
      return { childTableKey, childColumn, parentTableKey, parentColumn };
    });
  }, [selectedTableKeyList, tableByKey]);

  const connectAndLoadDatabases = async () => {
    setConnecting(true);
    try {
      const { data } = await axios.post('/api/pg-databases', {
        host: form.host,
        port: form.port,
        user: form.user,
        password: form.password,
        ssl: form.ssl,
        maintenanceDb: form.maintenanceDb,
      });
      const dbs = (data.databases ?? []) as string[];
      setPgConnected(true);
      setDatabases(dbs);
      if (!selectedDb && dbs.length > 0) setSelectedDb(dbs[0]);
      localStorage.setItem(
        PG_CONN_KEY,
        JSON.stringify({
          form: {
            host: form.host,
            port: form.port,
            user: form.user,
            password: form.password,
            database: form.maintenanceDb,
            ssl: form.ssl,
          },
          connected: true,
          schemas: [],
        })
      );
      try {
        await axios.post('/api/module-config?module=schema-config', {
          module: 'schema-config',
          mysql: EMPTY_MYSQL_PLACEHOLDER,
          pg: {
            form: {
              host: form.host,
              port: form.port,
              user: form.user,
              password: form.password,
              database: form.maintenanceDb,
              ssl: form.ssl,
            },
            connected: true,
            schemas: [],
            databases: dbs,
            selectedDb: dbs[0] ?? '',
          },
        });
      } catch {
        // non-blocking
      }
      toast.success(`Connected. ${dbs.length} database(s) found.`);
    } catch (err: unknown) {
      setPgConnected(false);
      const message = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      window.alert(message);
    } finally {
      setConnecting(false);
    }
  };

  const disconnectDb = async () => {
    setPgConnected(false);
    setDatabases([]);
    setSelectedDb('');
    setSchemas([]);
    setRelationships([]);
    setActiveSchema('');
    resetSelection();
    setForm((prev) => ({ ...prev, password: '' }));
    setShowConnPanel(false);
    localStorage.setItem(
      PG_CONN_KEY,
      JSON.stringify({
        form: {
          host: form.host,
          port: form.port,
          user: form.user,
          password: '',
          database: '',
          ssl: form.ssl,
        },
        connected: false,
        schemas: [],
      })
    );

    try {
      await axios.post('/api/module-config?module=schema-config', {
        module: 'schema-config',
        mysql: EMPTY_MYSQL_PLACEHOLDER,
        pg: {
          form: {
            host: form.host,
            port: form.port,
            user: form.user,
            password: '',
            database: '',
            ssl: form.ssl,
          },
          connected: false,
          schemas: [],
          databases: [],
          selectedDb: '',
        },
      });
    } catch {
      // non-blocking
    }
    toast.success('Disconnected. You can test new credentials now.');
  };

  const loadSchemasAndTables = async (databaseName = selectedDb): Promise<boolean> => {
    if (!databaseName) {
      window.alert('Select a database first.');
      return false;
    }
    setLoadingMeta(true);
    try {
      const { data } = await axios.post('/api/pg-schema-tables', {
        host: form.host,
        port: form.port,
        user: form.user,
        password: form.password,
        ssl: form.ssl,
        database: databaseName,
      });
      const schemaRows = (data.schemas ?? []) as PgSchemaMeta[];
      const relRows = (data.relationships ?? []) as PgRelationship[];
      setSchemas(schemaRows);
      setRelationships(relRows);
      setActiveSchema(schemaRows[0]?.name || '');
      resetSelection();
      toast.success(`Loaded ${schemaRows.length} schema(s).`);
      return true;
    } catch (err: unknown) {
      const message = axios.isAxiosError(err) ? (err.response?.data?.error ?? err.message) : String(err);
      window.alert(message);
      return false;
    } finally {
      setLoadingMeta(false);
    }
  };

  const handleSelectDatabaseAndLoad = async (databaseName: string) => {
    setSelectedDb(databaseName);
    if (!databaseName) return;
    const ok = await loadSchemasAndTables(databaseName);
    if (ok) setShowConnPanel(false);
  };

  const toggleTableSelection = (schemaName: string, tableName: string) => {
    const key = tableKey(schemaName, tableName);
    const next = new Set(selectedTableKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedTableKeys(next);
    hydrateConfigForSelectedTables(next);
  };

  const goToStep2 = () => {
    if (selectedTableKeys.size === 0) {
      window.alert('Select at least one table to continue.');
      return;
    }
    setStep(2);
  };

  const handleGenerate = async () => {
    if (!selectedDb || selectedTableKeys.size === 0) {
      window.alert('Select database and tables before generate.');
      return;
    }
    const payload = {
      selectedDb,
      selectedTableKeys: [...selectedTableKeys],
      tableConfigs,
      childFkConfigs,
      generatedAt: new Date().toISOString(),
    };
    localStorage.setItem('schema_config_runtime', JSON.stringify(payload));
    await router.push('/schema-generate');
  };

  const updateTableConfig = (key: string, patch: Partial<TableConfig>) => {
    setTableConfigs((prev) => {
      const current = prev[key];
      if (!current) return prev;
      const next = { ...current, ...patch };
      if (patch.reassignPrimaryKey === true && (!next.uuidPkColumn || next.uuidPkColumn === 'uuid')) {
        next.uuidPkColumn = 'id';
      }
      if (patch.reassignPrimaryKey === false && (!next.uuidPkColumn || next.uuidPkColumn === 'id')) {
        next.uuidPkColumn = 'uuid';
      }
      return { ...prev, [key]: next };
    });
  };

  const handleHomeNavigate = () => {
    const ok = window.confirm('Return to module home and clear all local session data?');
    if (!ok) return;
    localStorage.clear();
    window.location.href = '/';
  };

  return (
    <>
      <Head>
        <title>Schema Config</title>
      </Head>
      <div className="min-h-screen bg-gray-50 dark:bg-slate-900">
        <header
          ref={headerRef}
          className="sticky top-0 z-50 bg-white/95 dark:bg-slate-900/95 backdrop-blur border-b border-gray-200 dark:border-slate-700 px-6 py-4 flex items-center justify-between relative"
        >
          <div>
            <h1 className="font-bold text-gray-900 dark:text-slate-100">Schema Config</h1>
            <p className="text-xs text-gray-500 dark:text-slate-400">
              Configure PostgreSQL schema, table, PK/FK reassignment, and UUID generation.
            </p>
          </div>
          <button
            ref={pgBadgeRef}
            type="button"
            onClick={toggleConnPanel}
            className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium border transition-colors ${
              pgConnected
                ? 'bg-green-50 dark:bg-emerald-950/30 text-green-700 dark:text-emerald-300 border-green-200 dark:border-emerald-800 hover:bg-green-100 dark:hover:bg-emerald-900/40'
                : 'bg-gray-100 dark:bg-slate-800 text-gray-400 dark:text-slate-400 border-gray-200 dark:border-slate-700 hover:bg-gray-200 dark:hover:bg-slate-700'
            } ${showConnPanel ? 'ring-2 ring-blue-300 dark:ring-blue-500' : ''}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full inline-block ${pgConnected ? 'bg-green-500 dark:bg-emerald-400' : 'bg-gray-300 dark:bg-slate-500'}`} />
            PostgreSQL{pgConnected && selectedDb ? `: ${selectedDb}` : ''}
          </button>
          <nav className="flex items-center gap-1 text-sm">
            <button
              type="button"
              onClick={handleHomeNavigate}
              className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200"
            >
              Home
            </button>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <button
              type="button"
              onClick={() => setStep(1)}
              className={`px-3 py-1 rounded-lg ${
                step === 1
                  ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                  : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'
              }`}
            >
              Schema Selection
            </button>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <button
              type="button"
              onClick={() => {
                if (selectedTableKeys.size > 0) setStep(2);
              }}
              className={`px-3 py-1 rounded-lg ${
                step === 2
                  ? 'bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-semibold'
                  : 'text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200'
              }`}
            >
              Schema Config
            </button>
            <ChevronRight size={14} className="text-gray-300 dark:text-slate-600" />
            <Link
              href="/schema-generate"
              className="px-3 py-1 rounded-lg text-gray-500 dark:text-slate-400 hover:text-gray-800 dark:hover:text-slate-200"
            >
              Generate
            </Link>
            <span className="w-px h-5 bg-gray-200 dark:bg-slate-700 mx-1" />
            <ResetEverythingButton />
          </nav>
        </header>

        <main className="max-w-7xl mx-auto px-6 py-8">

          {step === 1 && (
            <div className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="font-semibold text-gray-900">Schema & Table Selection</h2>
                  <p className="text-xs text-gray-500 mt-1">
                    Connection via PostgreSQL badge. {pgConnected ? `Connected${selectedDb ? ` · DB: ${selectedDb}` : ''}` : 'Not connected'}.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={goToStep2}
                  disabled={selectedTableKeys.size === 0}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded bg-blue-600 text-white text-sm font-medium disabled:opacity-60"
                >
                  Schema Config
                  <ArrowRight size={15} />
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-3">
                <div className="border border-gray-200 rounded-lg p-2 max-h-[520px] overflow-auto">
                  <p className="text-xs text-gray-500 px-1 mb-2">Schemas</p>
                  {schemas.map((schema) => (
                    <button
                      key={schema.name}
                      type="button"
                      onClick={() => setActiveSchema(schema.name)}
                      className={`w-full text-left px-2 py-2 rounded text-sm mb-1 ${
                        activeSchema === schema.name
                          ? 'bg-blue-50 text-blue-700 border border-blue-200'
                          : 'hover:bg-gray-50 border border-transparent'
                      }`}
                    >
                      <div className="font-medium">{schema.name}</div>
                      <div className="text-xs text-gray-500">{schema.tableCount} table(s)</div>
                    </button>
                  ))}
                  {schemas.length === 0 && (
                    <p className="text-sm text-gray-400 px-1 py-3">No schema loaded yet.</p>
                  )}
                </div>
                <div className="border border-gray-200 rounded-lg p-3 max-h-[520px] overflow-auto">
                  <p className="text-xs text-gray-500 mb-2">
                    Tables in <span className="font-semibold text-gray-700">{activeSchema || '-'}</span>
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {visibleTables.map((table) => {
                      const key = tableKey(table.schema, table.name);
                      const selected = selectedTableKeys.has(key);
                      return (
                        <label
                          key={key}
                          className={`border rounded p-2 text-sm cursor-pointer ${
                            selected ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleTableSelection(table.schema, table.name)}
                              className="mt-0.5"
                            />
                            <div>
                              <p className="font-medium text-gray-800">{table.name}</p>
                              <p className="text-xs text-gray-500">
                                cols: {table.columns.length} | PK: {table.primaryKeys.join(', ') || '-'}
                              </p>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                  {activeSchema && visibleTables.length === 0 && (
                    <p className="text-sm text-gray-400 py-4">No table found in this schema.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              <div className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4 flex items-center justify-between">
                <div>
                  <h2 className="font-semibold text-gray-900">PK/FK + UUID Configuration</h2>
                  <p className="text-sm text-gray-500">
                    Selected {selectedTables.length} table(s), {Object.keys(childFkConfigs).length} parent-child relation(s).
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(1)}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded border border-gray-300 text-sm font-medium"
                  >
                    <ArrowLeft size={14} />
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleGenerate()}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded bg-blue-600 text-white text-sm font-medium"
                  >
                    Generate
                    <ArrowRight size={14} />
                  </button>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 mb-3">Table Configuration</h3>
                <div className="space-y-2">
                  {selectedTables.map((table) => {
                    const key = tableKey(table.schema, table.name);
                    const cfg = tableConfigs[key] || ensureTableConfig(table);
                    return (
                      <div key={key} className="border border-gray-200 rounded-lg p-3">
                        <div className="flex items-center justify-between gap-3 mb-2">
                          <p className="font-medium text-gray-800">{key}</p>
                          <div className="flex items-center gap-3">
                            <label className="text-xs text-gray-600">
                              Table Role
                              <select
                                className="ml-2 border border-gray-300 rounded px-2 py-1 text-sm"
                                value={cfg.relationRole || 'auto'}
                                onChange={(e) =>
                                  updateTableConfig(key, {
                                    relationRole: e.target.value as TableRelationRole,
                                  })
                                }
                              >
                                <option value="auto">Auto</option>
                                <option value="parent">Parent</option>
                                <option value="child">Child</option>
                              </select>
                            </label>
                            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                              <input
                                type="checkbox"
                                checked={cfg.reassignPrimaryKey}
                                onChange={(e) =>
                                  updateTableConfig(key, { reassignPrimaryKey: e.target.checked })
                                }
                              />
                              Reassign PK to UUID
                            </label>
                          </div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                          <label className="text-xs text-gray-600">
                            Existing PK Column
                            <select
                              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                              value={cfg.selectedPkColumn}
                              onChange={(e) => updateTableConfig(key, { selectedPkColumn: e.target.value })}
                            >
                              {getPkCandidates(table).map((col) => (
                                <option key={col} value={col}>
                                  {col}
                                </option>
                              ))}
                            </select>
                            <p className="mt-1 text-[11px] text-gray-500">
                              Use table&apos;s own PK only (not parent FK like <code>brand_id</code>/<code>category_id</code>).
                            </p>
                          </label>
                          <label className="text-xs text-gray-600">
                            UUID PK Column
                            <input
                              className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                              value={cfg.uuidPkColumn}
                              onChange={(e) => updateTableConfig(key, { uuidPkColumn: e.target.value })}
                            />
                          </label>
                          <label className="inline-flex items-center gap-2 mt-5 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              checked={cfg.generateUuidPk}
                              onChange={(e) => updateTableConfig(key, { generateUuidPk: e.target.checked })}
                            />
                            Generate UUID column
                          </label>
                        </div>
                      </div>
                    );
                  })}
                  {selectedTables.length === 0 && (
                    <p className="text-sm text-gray-400">No tables selected.</p>
                  )}
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900/70 border border-gray-200 dark:border-slate-700 rounded-xl p-4">
                <h3 className="font-semibold text-gray-900 mb-3">Child FK Mapping to Parent UUID</h3>
                <div className="space-y-3">
                  <div className="border border-gray-200 rounded-lg p-3 bg-gray-50/60 dark:bg-slate-900/30">
                    <p className="text-xs font-semibold text-gray-600 mb-2">Add Child → Parent Mapping</p>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
                      <label className="text-xs text-gray-600">
                        Child Table
                        <select
                          className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                          value={mappingDraft.childTableKey}
                          onChange={(e) =>
                            setMappingDraft((prev) => {
                              const nextChild = e.target.value;
                              const nextCols = tableByKey.get(nextChild)?.columns ?? [];
                              return {
                                ...prev,
                                childTableKey: nextChild,
                                childColumn: nextCols.includes(prev.childColumn) ? prev.childColumn : (nextCols[0] || ''),
                              };
                            })
                          }
                        >
                          {selectedTableKeyList.map((k) => <option key={k} value={k}>{k}</option>)}
                        </select>
                      </label>
                      <label className="text-xs text-gray-600">
                        Child Column (legacy)
                        <select
                          className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                          value={mappingDraft.childColumn}
                          onChange={(e) => setMappingDraft((prev) => ({ ...prev, childColumn: e.target.value }))}
                        >
                          {(tableByKey.get(mappingDraft.childTableKey)?.columns ?? []).map((col) => (
                            <option key={col} value={col}>{col}</option>
                          ))}
                        </select>
                      </label>
                      <label className="text-xs text-gray-600">
                        Parent Table
                        <select
                          className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                          value={mappingDraft.parentTableKey}
                          onChange={(e) =>
                            setMappingDraft((prev) => {
                              const nextParent = e.target.value;
                              const nextCols = tableByKey.get(nextParent)?.columns ?? [];
                              return {
                                ...prev,
                                parentTableKey: nextParent,
                                parentColumn: nextCols.includes(prev.parentColumn) ? prev.parentColumn : (nextCols[0] || ''),
                              };
                            })
                          }
                        >
                          {selectedTableKeyList.map((k) => <option key={k} value={k}>{k}</option>)}
                        </select>
                      </label>
                      <label className="text-xs text-gray-600">
                        Parent Column (legacy)
                        <select
                          className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                          value={mappingDraft.parentColumn}
                          onChange={(e) => setMappingDraft((prev) => ({ ...prev, parentColumn: e.target.value }))}
                        >
                          {(tableByKey.get(mappingDraft.parentTableKey)?.columns ?? []).map((col) => (
                            <option key={col} value={col}>{col}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={addManualMapping}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-gray-300 text-xs font-medium"
                      >
                        <Plus size={13} />
                        Add Mapping
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    {visibleChildFkConfigs.map((cfg) => {
                      const parentCfg = tableConfigs[cfg.parentTableKey];
                      return (
                        <div key={cfg.relationshipKey} className="border border-gray-200 rounded-lg p-3">
                          <div className="text-sm text-gray-800 flex items-center justify-between gap-2 mb-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Link2 size={14} className="text-blue-600 shrink-0" />
                              <span className="font-medium truncate">{cfg.childTableKey}.{cfg.childColumn}</span>
                              <span className="text-gray-400">→</span>
                              <span className="font-medium truncate">{cfg.parentTableKey}.{cfg.parentColumn}</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeMapping(cfg.relationshipKey)}
                              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                            >
                              <Trash2 size={12} />
                              Remove
                            </button>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                            <label className="text-xs text-gray-600">
                              Parent UUID Column
                              <input
                                className="mt-1 w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                                value={cfg.parentUuidColumn || parentCfg?.uuidPkColumn || 'id'}
                                onChange={(e) =>
                                  setChildFkConfigs((prev) => ({
                                    ...prev,
                                    [cfg.relationshipKey]: {
                                      ...cfg,
                                      parentUuidColumn: e.target.value,
                                    },
                                  }))
                                }
                              />
                            </label>
                            <label className="inline-flex items-center gap-2 mt-5 text-sm text-gray-700">
                              <input
                                type="checkbox"
                                checked={cfg.generateChildUuidFk ?? true}
                                onChange={(e) =>
                                  setChildFkConfigs((prev) => ({
                                    ...prev,
                                    [cfg.relationshipKey]: {
                                      ...cfg,
                                      generateChildUuidFk: e.target.checked,
                                      parentUuidColumn: cfg.parentUuidColumn || parentCfg?.uuidPkColumn || 'id',
                                    },
                                  }))
                                }
                              />
                              Generate child UUID FK
                            </label>
                          </div>
                        </div>
                      );
                    })}
                    {visibleChildFkConfigs.length === 0 && (
                      <p className="text-sm text-gray-400">
                        No mapping yet. Add manual mapping above or select tables with detected FK relations.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>

        {showConnPanel && (
          <div
            ref={connPanelRef}
            className="absolute z-[70] w-[min(92vw,560px)] max-w-[560px] bg-white dark:bg-slate-900 rounded-2xl border border-gray-200 dark:border-slate-700 shadow-xl"
            style={{ left: connPanelPos.left, top: connPanelPos.top }}
          >
            <div className="w-full bg-white dark:bg-slate-900 rounded-2xl">
              <div className="px-5 py-4 border-b border-gray-100 dark:border-slate-700 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900 dark:text-slate-100">Configure PostgreSQL Connection</h2>
                <button
                  type="button"
                  onClick={() => setShowConnPanel(false)}
                  className="text-gray-400 dark:text-slate-500 hover:text-gray-600 dark:hover:text-slate-300"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="p-5 space-y-4">
                <div className="p-3 border border-gray-200 dark:border-slate-700 rounded-lg bg-gray-50 dark:bg-slate-800 space-y-2">
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

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Host</label>
                    <input
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                      value={form.host}
                      onChange={(e) => setForm((prev) => ({ ...prev, host: e.target.value }))}
                      disabled={pgConnected}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Port</label>
                    <input
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                      type="number"
                      value={form.port}
                      onChange={(e) => setForm((prev) => ({ ...prev, port: Number(e.target.value) || 5432 }))}
                      disabled={pgConnected}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">User</label>
                    <input
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                      value={form.user}
                      onChange={(e) => setForm((prev) => ({ ...prev, user: e.target.value }))}
                      disabled={pgConnected}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Password</label>
                    <div className="flex items-center gap-2">
                      <input
                        className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                        type="password"
                        value={form.password}
                        onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                        disabled={pgConnected}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (pgConnected) {
                            void disconnectDb();
                          } else {
                            void connectAndLoadDatabases();
                          }
                        }}
                        disabled={connecting || !form.host || !form.user}
                        title={pgConnected ? 'Disconnect PostgreSQL' : 'Connect PostgreSQL'}
                        className={`px-2.5 py-2 rounded-xl border transition-colors ${
                          pgConnected
                            ? 'bg-red-50 hover:bg-red-100 dark:bg-rose-950/30 dark:hover:bg-rose-900/40 text-red-500 dark:text-rose-300 border-red-200 dark:border-rose-800'
                            : 'bg-gray-100 dark:bg-slate-800 hover:bg-gray-200 dark:hover:bg-slate-700 text-gray-600 dark:text-slate-300 border-gray-300 dark:border-slate-600'
                        } disabled:opacity-50`}
                      >
                        {connecting ? <RotateCcw size={16} className="animate-spin" /> : (pgConnected ? <PlugZap size={16} /> : <Plug size={16} />)}
                      </button>
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1">Database</label>
                    <input
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                      value={form.maintenanceDb}
                      onChange={(e) => setForm((prev) => ({ ...prev, maintenanceDb: e.target.value }))}
                      disabled={pgConnected}
                      placeholder="postgres"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-slate-300">
                      <input
                        type="checkbox"
                        checked={form.ssl}
                        onChange={(e) => setForm((prev) => ({ ...prev, ssl: e.target.checked }))}
                        disabled={pgConnected}
                        className="w-3.5 h-3.5"
                      />
                      Use SSL
                    </label>
                  </div>
                </div>

                {pgConnected && (
                  <div className="space-y-2">
                    <label className="block text-xs font-medium text-gray-600 dark:text-slate-300">Target Database</label>
                    <select
                      value={selectedDb}
                      onChange={(e) => void handleSelectDatabaseAndLoad(e.target.value)}
                      className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
                    >
                      <option value="">Select database...</option>
                      {databases.map((db) => (
                        <option key={db} value={db}>{db}</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500 dark:text-slate-400">
                      Popup will close after database is selected and schemas are loaded.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
