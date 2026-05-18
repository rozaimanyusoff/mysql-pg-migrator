export interface SchemaTableConfig {
  tableKey: string;
  selectedPkColumn: string;
  generateUuidPk: boolean;
  uuidPkColumn: string;
  reassignPrimaryKey: boolean;
  relationRole?: 'auto' | 'parent' | 'child';
}

export interface SchemaChildFkConfig {
  relationshipKey: string;
  childTableKey: string;
  childColumn: string;
  parentTableKey: string;
  parentColumn?: string;
  parentUuidColumn: string;
  generateChildUuidFk: boolean;
}

export interface SchemaConfigRuntimePayload {
  selectedDb: string;
  selectedTableKeys: string[];
  tableConfigs: Record<string, SchemaTableConfig>;
  childFkConfigs: Record<string, SchemaChildFkConfig>;
  generatedAt?: string;
}

export interface SchemaPlanTableSummary {
  tableKey: string;
  uuidColumn: string;
  selectedPkColumn: string;
  generateUuidPk: boolean;
  reassignPrimaryKey: boolean;
}

export interface SchemaPlanRelationshipSummary {
  relationshipKey: string;
  childTableKey: string;
  childColumn: string;
  childUuidColumn: string;
  parentTableKey: string;
  parentOldColumn: string;
  parentUuidColumn: string;
  generateChildUuidFk: boolean;
}

export interface SchemaGenerationPlan {
  summary: {
    database: string;
    selectedTables: number;
    selectedRelationships: number;
    operations: number;
  };
  tables: SchemaPlanTableSummary[];
  relationships: SchemaPlanRelationshipSummary[];
  applySql: string[];
  rollbackSql: string[];
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function splitTableKey(tableKey: string): { schema: string; table: string } {
  const idx = tableKey.indexOf('.');
  if (idx <= 0 || idx === tableKey.length - 1) {
    return { schema: 'public', table: tableKey };
  }
  return { schema: tableKey.slice(0, idx), table: tableKey.slice(idx + 1) };
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40);
}

function parseParentOldColumn(relationshipKey: string): string {
  const arrowIdx = relationshipKey.indexOf('->');
  if (arrowIdx < 0) return 'id';
  const right = relationshipKey.slice(arrowIdx + 2);
  const colonIdx = right.lastIndexOf(':');
  if (colonIdx < 0) return 'id';
  return right.slice(colonIdx + 1) || 'id';
}

export function buildSchemaGenerationPlan(runtime: SchemaConfigRuntimePayload): SchemaGenerationPlan {
  const selectedKeys = new Set(runtime.selectedTableKeys);
  const tables: SchemaPlanTableSummary[] = [];
  const rels: SchemaPlanRelationshipSummary[] = [];
  const applySql: string[] = [];
  const rollbackSql: string[] = [];

  applySql.push('CREATE EXTENSION IF NOT EXISTS pgcrypto;');

  for (const tableKey of runtime.selectedTableKeys) {
    const cfg = runtime.tableConfigs[tableKey];
    if (!cfg) continue;
    const { schema, table } = splitTableKey(tableKey);
    const qTable = `${quoteIdent(schema)}.${quoteIdent(table)}`;
    const defaultUuidCol = cfg.reassignPrimaryKey ? 'id' : 'uuid';
    const uuidCol = (cfg.uuidPkColumn || defaultUuidCol).trim() || defaultUuidCol;
    const selectedPk = (cfg.selectedPkColumn || 'id').trim() || 'id';
    const qUuidCol = quoteIdent(uuidCol);

    tables.push({
      tableKey,
      uuidColumn: uuidCol,
      selectedPkColumn: selectedPk,
      generateUuidPk: Boolean(cfg.generateUuidPk),
      reassignPrimaryKey: Boolean(cfg.reassignPrimaryKey),
    });

    if (cfg.generateUuidPk && !cfg.reassignPrimaryKey) {
      const idxName = safeName(`uidx_${table}_${uuidCol}`);
      applySql.push(`ALTER TABLE ${qTable} ADD COLUMN IF NOT EXISTS ${qUuidCol} UUID;`);
      applySql.push(`UPDATE ${qTable} SET ${qUuidCol} = gen_random_uuid() WHERE ${qUuidCol} IS NULL;`);
      applySql.push(`ALTER TABLE ${qTable} ALTER COLUMN ${qUuidCol} SET NOT NULL;`);
      applySql.push(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${qTable} (${qUuidCol});`);

      rollbackSql.push(`-- rollback: remove uuid artifacts on ${tableKey}`);
      rollbackSql.push(`DROP INDEX IF EXISTS ${quoteIdent(idxName)};`);
      rollbackSql.push(`ALTER TABLE ${qTable} DROP COLUMN IF EXISTS ${qUuidCol};`);
    }

    if (cfg.reassignPrimaryKey) {
      const nextPkName = safeName(`pk_${table}_uuid`);
      const legacyUniqueName = safeName(`uq_${table}_${selectedPk}`);
      const oldPkRenamed = safeName(`old_${selectedPk}`);
      applySql.push(
        `DO $$ 
DECLARE 
  v_pk_name text;
  v_fk record;
  v_fk_count integer := 0;
  v_fk_restore_sql text[] := ARRAY[]::text[];
  v_sql text;
  v_old_pk_exists boolean;
  v_old_pk_renamed_exists boolean;
  v_work_pk_col text := '${uuidCol.replace(/'/g, "''")}';
BEGIN
  IF lower('${selectedPk.replace(/'/g, "''")}') = lower('${uuidCol.replace(/'/g, "''")}') THEN
    v_work_pk_col := '__tmp_uuid_pk__';
  END IF;

  -- Ensure new UUID PK column exists and is populated.
  EXECUTE format('ALTER TABLE %I.%I ADD COLUMN IF NOT EXISTS %I UUID', '${schema.replace(/'/g, "''")}', '${table.replace(/'/g, "''")}', v_work_pk_col);
  EXECUTE format('UPDATE %I.%I SET %I = gen_random_uuid() WHERE %I IS NULL', '${schema.replace(/'/g, "''")}', '${table.replace(/'/g, "''")}', v_work_pk_col, v_work_pk_col);
  EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I SET NOT NULL', '${schema.replace(/'/g, "''")}', '${table.replace(/'/g, "''")}', v_work_pk_col);

  -- Temporarily drop dependent FKs (only those referencing old PK column), then restore.
  FOR v_fk IN
    SELECT
      child_ns.nspname AS child_schema,
      child_rel.relname AS child_table,
      con.conname AS fk_name,
      pg_get_constraintdef(con.oid, true) AS fk_def
    FROM pg_constraint con
    JOIN pg_class child_rel ON child_rel.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child_rel.relnamespace
    JOIN unnest(con.confkey) AS confk(attnum) ON true
    JOIN pg_attribute parent_att ON parent_att.attrelid = con.confrelid AND parent_att.attnum = confk.attnum
    WHERE con.contype='f'
      AND con.confrelid = format('%I.%I', '${schema.replace(/'/g, "''")}', '${table.replace(/'/g, "''")}')::regclass
      AND parent_att.attname='${selectedPk.replace(/'/g, "''")}'
  LOOP
    v_fk_restore_sql := array_append(
      v_fk_restore_sql,
      format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I %s',
        v_fk.child_schema,
        v_fk.child_table,
        v_fk.fk_name,
        v_fk.fk_def
      )
    );
    v_fk_count := v_fk_count + 1;
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', v_fk.child_schema, v_fk.child_table, v_fk.fk_name);
  END LOOP;

  -- Keep old PK column unique so existing legacy FKs can be restored.
  IF v_fk_count > 0 THEN
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I UNIQUE (%I)',
        '${schema.replace(/'/g, "''")}',
        '${table.replace(/'/g, "''")}',
        '${legacyUniqueName}',
        '${selectedPk.replace(/'/g, "''")}'
      );
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END IF;

  SELECT con.conname INTO v_pk_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE con.contype='p' AND nsp.nspname='${schema.replace(/'/g, "''")}' AND rel.relname='${table.replace(/'/g, "''")}';
  IF v_pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', '${schema.replace(/'/g, "''")}', '${table.replace(/'/g, "''")}', v_pk_name);
  END IF;
  BEGIN
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I PRIMARY KEY (%I)', '${schema.replace(/'/g, "''")}', '${table.replace(/'/g, "''")}', '${nextPkName}', v_work_pk_col);
  EXCEPTION WHEN duplicate_object THEN
    NULL;
  END;

  FOREACH v_sql IN ARRAY v_fk_restore_sql LOOP
    EXECUTE v_sql;
  END LOOP;

  -- Rename old PK column to old_* (if still exists), then rename new UUID PK column to target name.
  SELECT EXISTS(
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='${schema.replace(/'/g, "''")}'
      AND table_name='${table.replace(/'/g, "''")}'
      AND column_name='${selectedPk.replace(/'/g, "''")}'
  ) INTO v_old_pk_exists;
  SELECT EXISTS(
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='${schema.replace(/'/g, "''")}'
      AND table_name='${table.replace(/'/g, "''")}'
      AND column_name='${oldPkRenamed.replace(/'/g, "''")}'
  ) INTO v_old_pk_renamed_exists;

  IF v_old_pk_exists AND NOT v_old_pk_renamed_exists THEN
    EXECUTE format(
      'ALTER TABLE %I.%I RENAME COLUMN %I TO %I',
      '${schema.replace(/'/g, "''")}',
      '${table.replace(/'/g, "''")}',
      '${selectedPk.replace(/'/g, "''")}',
      '${oldPkRenamed.replace(/'/g, "''")}'
    );
  END IF;

  IF lower(v_work_pk_col) <> lower('${uuidCol.replace(/'/g, "''")}') THEN
    EXECUTE format(
      'ALTER TABLE %I.%I RENAME COLUMN %I TO %I',
      '${schema.replace(/'/g, "''")}',
      '${table.replace(/'/g, "''")}',
      v_work_pk_col,
      '${uuidCol.replace(/'/g, "''")}'
    );
  END IF;
END $$;`
      );
      rollbackSql.push(`-- rollback: restore PK manually for ${tableKey} (original PK unknown at generation time)`);
    }
  }

  for (const [relKey, relCfg] of Object.entries(runtime.childFkConfigs)) {
    if (!relCfg.generateChildUuidFk) continue;
    if (!selectedKeys.has(relCfg.childTableKey) || !selectedKeys.has(relCfg.parentTableKey)) continue;

    const child = splitTableKey(relCfg.childTableKey);
    const parent = splitTableKey(relCfg.parentTableKey);
    const parsedChildColumn = relCfg.childColumn;
    const parsedParentOldColumn = (relCfg.parentColumn || parseParentOldColumn(relKey)).trim() || 'id';
    const childCfg = runtime.tableConfigs[relCfg.childTableKey];
    const parentCfg = runtime.tableConfigs[relCfg.parentTableKey];
    const childOldColumn =
      childCfg?.reassignPrimaryKey && childCfg.selectedPkColumn === parsedChildColumn
        ? safeName(`old_${parsedChildColumn}`)
        : parsedChildColumn;
    const parentOldColumn =
      parentCfg?.reassignPrimaryKey && parentCfg.selectedPkColumn === parsedParentOldColumn
        ? safeName(`old_${parsedParentOldColumn}`)
        : parsedParentOldColumn;
    const childUuidColumn = `${relCfg.childColumn}_uuid`;

    const qChildTable = `${quoteIdent(child.schema)}.${quoteIdent(child.table)}`;
    const qParentTable = `${quoteIdent(parent.schema)}.${quoteIdent(parent.table)}`;
    const qChildOld = quoteIdent(childOldColumn);
    const qChildUuid = quoteIdent(childUuidColumn);
    const qParentOld = quoteIdent(parentOldColumn);
    const defaultParentUuidColumn = parentCfg?.reassignPrimaryKey ? 'id' : (parentCfg?.uuidPkColumn || 'uuid');
    const parentUuidColumn = (relCfg.parentUuidColumn || defaultParentUuidColumn).trim() || defaultParentUuidColumn;
    const qParentUuid = quoteIdent(parentUuidColumn);
    const fkName = safeName(`fk_${child.table}_${childUuidColumn}_${parent.table}_${parentUuidColumn}`);
    const idxName = safeName(`idx_${child.table}_${childUuidColumn}`);

    rels.push({
      relationshipKey: relKey,
      childTableKey: relCfg.childTableKey,
      childColumn: childOldColumn,
      childUuidColumn,
      parentTableKey: relCfg.parentTableKey,
      parentOldColumn,
      parentUuidColumn,
      generateChildUuidFk: true,
    });

    applySql.push(`ALTER TABLE ${qChildTable} ADD COLUMN IF NOT EXISTS ${qChildUuid} UUID;`);
    applySql.push(
      `UPDATE ${qChildTable} c
SET ${qChildUuid} = p.${qParentUuid}
FROM ${qParentTable} p
WHERE c.${qChildOld} = p.${qParentOld}
  AND c.${qChildOld} IS NOT NULL
  AND c.${qChildUuid} IS NULL;`
    );
    applySql.push(`CREATE INDEX IF NOT EXISTS ${quoteIdent(idxName)} ON ${qChildTable} (${qChildUuid});`);
    applySql.push(
      `DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='${fkName.replace(/'/g, "''")}'
      AND conrelid='${child.schema.replace(/'/g, "''")}.${child.table.replace(/'/g, "''")}'::regclass
  ) THEN
    ALTER TABLE ${qChildTable}
      ADD CONSTRAINT ${quoteIdent(fkName)}
      FOREIGN KEY (${qChildUuid}) REFERENCES ${qParentTable} (${qParentUuid});
  END IF;
END $$;`
    );

    rollbackSql.push(`ALTER TABLE ${qChildTable} DROP CONSTRAINT IF EXISTS ${quoteIdent(fkName)};`);
    rollbackSql.push(`DROP INDEX IF EXISTS ${quoteIdent(idxName)};`);
    rollbackSql.push(`ALTER TABLE ${qChildTable} DROP COLUMN IF EXISTS ${qChildUuid};`);
  }

  return {
    summary: {
      database: runtime.selectedDb,
      selectedTables: tables.length,
      selectedRelationships: rels.length,
      operations: applySql.length,
    },
    tables,
    relationships: rels,
    applySql,
    rollbackSql,
  };
}
