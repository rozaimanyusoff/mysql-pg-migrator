export type OrmDbType = 'postgresql' | 'mysql';
export type OrmTarget = 'drizzle' | 'prisma' | 'typeorm';

export interface OrmColDef {
  name: string;
  rawType: string;          // udt_name (PG) or DATA_TYPE (MySQL) or lowercase designer type
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  fullType: string;         // original type string with length/precision
  nullable: boolean;
  defaultValue: string | null;
  isPk: boolean;
  isUnique: boolean;
  isAutoIncrement: boolean;
  comment: string | null;
  fkToTable: string | null;
  fkToCol: string | null;
}

export interface OrmTableDef {
  schema: string;
  table: string;
  columns: OrmColDef[];
}

// ─── String helpers ───────────────────────────────────────────────────────────

function toCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

function toPascal(s: string): string {
  const c = toCamel(s);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function toSingular(name: string): string {
  if (name.endsWith('ies')) return name.slice(0, -3) + 'y';
  if (/(?:ses|xes|zes|shes|ches)$/.test(name)) return name.slice(0, -2);
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1);
  return name;
}

// ─── DRIZZLE ─────────────────────────────────────────────────────────────────

function pgDrizzleFn(col: OrmColDef): { call: string; imports: string[] } {
  const dt = col.rawType.toLowerCase();
  const n = col.name;
  const len = col.maxLength;
  const p = col.numericPrecision;
  const s = col.numericScale;

  if (dt === 'varchar' || dt === 'character varying') {
    return { call: len ? `varchar('${n}', { length: ${len} })` : `varchar('${n}')`, imports: ['varchar'] };
  }
  if (dt === 'bpchar' || dt === 'char' || dt === 'character') {
    return { call: len ? `char('${n}', { length: ${len} })` : `char('${n}')`, imports: ['char'] };
  }
  if (dt === 'numeric' || dt === 'decimal') {
    return { call: p ? `numeric('${n}', { precision: ${p}, scale: ${s ?? 0} })` : `numeric('${n}')`, imports: ['numeric'] };
  }
  if (dt === 'bigint' || dt === 'int8') {
    return { call: `bigint('${n}', { mode: 'number' })`, imports: ['bigint'] };
  }
  if (dt === 'bigserial') {
    return { call: `bigserial('${n}', { mode: 'number' })`, imports: ['bigserial'] };
  }
  if (dt === 'timestamptz' || dt === 'timestamp with time zone') {
    return { call: `timestamp('${n}', { withTimezone: true })`, imports: ['timestamp'] };
  }
  if (dt === 'bytea') {
    return { call: `customType<{ data: Buffer }>({ dataType: () => 'bytea' })('${n}')`, imports: ['customType'] };
  }

  const simple: Record<string, [string, string]> = {
    int4: ['integer', 'integer'], integer: ['integer', 'integer'],
    int2: ['smallint', 'smallint'], smallint: ['smallint', 'smallint'],
    serial: ['serial', 'serial'],
    smallserial: ['smallserial', 'smallserial'],
    text: ['text', 'text'],
    bool: ['boolean', 'boolean'], boolean: ['boolean', 'boolean'],
    date: ['date', 'date'],
    uuid: ['uuid', 'uuid'],
    jsonb: ['jsonb', 'jsonb'],
    json: ['json', 'json'],
    float4: ['real', 'real'], real: ['real', 'real'],
    float8: ['doublePrecision', 'doublePrecision'],
    'double precision': ['doublePrecision', 'doublePrecision'],
    timestamp: ['timestamp', 'timestamp'],
    time: ['time', 'time'], timetz: ['time', 'time'],
    interval: ['interval', 'interval'],
  };

  const [fn, imp] = simple[dt] ?? ['text', 'text'];
  const suffix = dt in simple ? '' : ` /* ${dt} */`;
  return { call: `${fn}('${n}')${suffix}`, imports: [imp] };
}

function mysqlDrizzleFn(col: OrmColDef): { call: string; imports: string[] } {
  const dt = col.rawType.toLowerCase();
  const n = col.name;
  const len = col.maxLength;
  const decMatch = col.fullType.match(/\((\d+)(?:,\s*(\d+))?\)/);

  if (dt === 'varchar') {
    return { call: `varchar('${n}', { length: ${len ?? 255} })`, imports: ['varchar'] };
  }
  if (dt === 'char') {
    return { call: `char('${n}', { length: ${len ?? 1} })`, imports: ['char'] };
  }
  if (dt === 'tinyint' && col.fullType.toLowerCase().includes('(1)')) {
    return { call: `boolean('${n}')`, imports: ['boolean'] };
  }
  if (dt === 'decimal' || dt === 'numeric') {
    const pr = decMatch ? decMatch[1] : '10';
    const sc = decMatch ? (decMatch[2] ?? '0') : '2';
    return { call: `decimal('${n}', { precision: ${pr}, scale: ${sc} })`, imports: ['decimal'] };
  }
  if (dt === 'bigint') {
    return { call: `bigint('${n}', { mode: 'number' })`, imports: ['bigint'] };
  }
  if (dt === 'datetime') {
    return { call: `datetime('${n}', { mode: 'date' })`, imports: ['datetime'] };
  }

  const simple: Record<string, [string, string]> = {
    int: ['int', 'int'], integer: ['int', 'int'],
    smallint: ['smallint', 'smallint'],
    mediumint: ['mediumint', 'mediumint'],
    tinyint: ['tinyint', 'tinyint'],
    text: ['text', 'text'], mediumtext: ['text', 'text'],
    longtext: ['text', 'text'], tinytext: ['text', 'text'],
    boolean: ['boolean', 'boolean'], bool: ['boolean', 'boolean'],
    float: ['float', 'float'],
    double: ['double', 'double'],
    timestamp: ['timestamp', 'timestamp'],
    date: ['date', 'date'],
    time: ['time', 'time'],
    year: ['year', 'year'],
    json: ['json', 'json'],
  };

  const [fn, imp] = simple[dt] ?? ['text', 'text'];
  const suffix = dt in simple ? '' : ` /* ${dt} */`;
  return { call: `${fn}('${n}')${suffix}`, imports: [imp] };
}

function drizzleDefault(col: OrmColDef): string {
  const dv = col.defaultValue;
  if (!dv) return '';
  const dvLow = dv.toLowerCase();
  if (dvLow.includes('now()') || dvLow.includes('current_timestamp')) return 'defaultNow()';
  if (dvLow === 'true') return 'default(true)';
  if (dvLow === 'false') return 'default(false)';
  if (!isNaN(Number(dv))) return `default(${dv})`;
  if (/^'[^']*'$/.test(dv)) return `default(${dv})`;
  const castMatch = dv.match(/^'([^']*)'::.*$/);
  if (castMatch) return `default('${castMatch[1]}')`;
  return '';
}

function generateDrizzle(tables: OrmTableDef[], dbType: OrmDbType): string {
  const isPg = dbType === 'postgresql';
  const tableFunc = isPg ? 'pgTable' : 'mysqlTable';
  const coreModule = isPg ? 'drizzle-orm/pg-core' : 'drizzle-orm/mysql-core';

  const usedImports = new Set<string>([tableFunc]);
  const tableVarMap = new Map(tables.map(t => [t.table, toCamel(t.table)]));

  // Collect non-public schemas to emit pgSchema() declarations
  const nonPublicSchemas = isPg
    ? [...new Set(tables.map(t => t.schema).filter((s): s is string => !!s && s !== 'public'))]
    : [];

  if (nonPublicSchemas.length > 0) usedImports.add('pgSchema');

  const schemaDefs = nonPublicSchemas.map(s => `export const ${toCamel(s)}Schema = pgSchema('${s}');`);
  const tableDefs: string[] = [];

  for (const t of tables) {
    const varName = toCamel(t.table);
    const colLines: string[] = [];

    for (const col of t.columns) {
      const { call, imports } = isPg ? pgDrizzleFn(col) : mysqlDrizzleFn(col);
      imports.forEach(i => usedImports.add(i));

      const chain: string[] = [call];

      if (col.isPk) chain.push('primaryKey()');
      if (col.isAutoIncrement && !isPg) chain.push('autoincrement()');
      if (!col.nullable && !col.isPk) chain.push('notNull()');
      if (col.isUnique && !col.isPk) chain.push('unique()');

      const def = drizzleDefault(col);
      if (def) chain.push(def);

      if (col.fkToTable && col.fkToCol) {
        const refVar = tableVarMap.get(col.fkToTable) ?? toCamel(col.fkToTable);
        chain.push(`references(() => ${refVar}.${toCamel(col.fkToCol)})`);
      }

      colLines.push(`  ${toCamel(col.name)}: ${chain.join('.')},`);
    }

    const schemaName = t.schema || 'public';
    if (isPg && schemaName !== 'public') {
      const schemaVar = `${toCamel(schemaName)}Schema`;
      tableDefs.push(`export const ${varName} = ${schemaVar}.table('${t.table}', {\n${colLines.join('\n')}\n});`);
    } else {
      tableDefs.push(`export const ${varName} = ${tableFunc}('${t.table}', {\n${colLines.join('\n')}\n});`);
    }
  }

  const importLine = `import { ${[...usedImports].sort().join(', ')} } from '${coreModule}';`;
  const parts: string[] = [
    `// Generated by DB Maintenance Tools — ${new Date().toISOString().slice(0, 10)}`,
    importLine,
  ];
  if (schemaDefs.length) parts.push('', schemaDefs.join('\n'));
  parts.push('', tableDefs.join('\n\n'));
  return parts.join('\n');
}

// ─── PRISMA ──────────────────────────────────────────────────────────────────

interface PrismaFieldType { prismaType: string; attr: string }

function pgPrismaType(col: OrmColDef): PrismaFieldType {
  const dt = col.rawType.toLowerCase();
  const len = col.maxLength;
  const p = col.numericPrecision;
  const s = col.numericScale;

  if (dt === 'varchar' || dt === 'character varying') {
    return { prismaType: 'String', attr: len ? `@db.VarChar(${len})` : '' };
  }
  if (dt === 'bpchar' || dt === 'char' || dt === 'character') {
    return { prismaType: 'String', attr: len ? `@db.Char(${len})` : '' };
  }
  if (dt === 'numeric' || dt === 'decimal') {
    return { prismaType: 'Decimal', attr: p ? `@db.Decimal(${p}, ${s ?? 0})` : '' };
  }

  const map: Record<string, PrismaFieldType> = {
    int4: { prismaType: 'Int', attr: '' }, integer: { prismaType: 'Int', attr: '' },
    int2: { prismaType: 'Int', attr: '@db.SmallInt' }, smallint: { prismaType: 'Int', attr: '@db.SmallInt' },
    int8: { prismaType: 'BigInt', attr: '' }, bigint: { prismaType: 'BigInt', attr: '' },
    serial: { prismaType: 'Int', attr: '' },
    bigserial: { prismaType: 'BigInt', attr: '' },
    smallserial: { prismaType: 'Int', attr: '@db.SmallInt' },
    text: { prismaType: 'String', attr: '' },
    bool: { prismaType: 'Boolean', attr: '' }, boolean: { prismaType: 'Boolean', attr: '' },
    date: { prismaType: 'DateTime', attr: '@db.Date' },
    uuid: { prismaType: 'String', attr: '@db.Uuid' },
    jsonb: { prismaType: 'Json', attr: '' }, json: { prismaType: 'Json', attr: '' },
    float4: { prismaType: 'Float', attr: '@db.Real' }, real: { prismaType: 'Float', attr: '@db.Real' },
    float8: { prismaType: 'Float', attr: '' }, 'double precision': { prismaType: 'Float', attr: '' },
    timestamp: { prismaType: 'DateTime', attr: '' },
    timestamptz: { prismaType: 'DateTime', attr: '@db.Timestamptz(6)' },
    'timestamp with time zone': { prismaType: 'DateTime', attr: '@db.Timestamptz(6)' },
    bytea: { prismaType: 'Bytes', attr: '' },
    time: { prismaType: 'String', attr: '@db.Time' }, timetz: { prismaType: 'String', attr: '@db.Time' },
    interval: { prismaType: 'String', attr: '' },
  };
  return map[dt] ?? { prismaType: 'String', attr: `// unknown: ${dt}` };
}

function mysqlPrismaType(col: OrmColDef): PrismaFieldType {
  const dt = col.rawType.toLowerCase();
  const len = col.maxLength;
  const decMatch = col.fullType.match(/\((\d+)(?:,\s*(\d+))?\)/);

  if (dt === 'varchar') return { prismaType: 'String', attr: len ? `@db.VarChar(${len})` : '' };
  if (dt === 'char') return { prismaType: 'String', attr: len ? `@db.Char(${len})` : '' };
  if (dt === 'tinyint' && col.fullType.toLowerCase().includes('(1)')) return { prismaType: 'Boolean', attr: '' };
  if (dt === 'decimal' || dt === 'numeric') {
    const pr = decMatch ? decMatch[1] : '10';
    const sc = decMatch ? (decMatch[2] ?? '0') : '2';
    return { prismaType: 'Decimal', attr: `@db.Decimal(${pr}, ${sc})` };
  }

  const map: Record<string, PrismaFieldType> = {
    int: { prismaType: 'Int', attr: '' }, integer: { prismaType: 'Int', attr: '' },
    bigint: { prismaType: 'BigInt', attr: '' },
    smallint: { prismaType: 'Int', attr: '@db.SmallInt' },
    mediumint: { prismaType: 'Int', attr: '@db.MediumInt' },
    tinyint: { prismaType: 'Int', attr: '@db.TinyInt' },
    text: { prismaType: 'String', attr: '@db.Text' },
    mediumtext: { prismaType: 'String', attr: '@db.MediumText' },
    longtext: { prismaType: 'String', attr: '@db.LongText' },
    tinytext: { prismaType: 'String', attr: '@db.TinyText' },
    boolean: { prismaType: 'Boolean', attr: '' }, bool: { prismaType: 'Boolean', attr: '' },
    float: { prismaType: 'Float', attr: '' },
    double: { prismaType: 'Float', attr: '@db.Double' },
    datetime: { prismaType: 'DateTime', attr: '@db.DateTime(0)' },
    timestamp: { prismaType: 'DateTime', attr: '@db.Timestamp(0)' },
    date: { prismaType: 'DateTime', attr: '@db.Date' },
    time: { prismaType: 'String', attr: '@db.Time(0)' },
    year: { prismaType: 'Int', attr: '@db.Year' },
    json: { prismaType: 'Json', attr: '' },
    enum: { prismaType: 'String', attr: '' },
  };
  return map[dt] ?? { prismaType: 'String', attr: `// unknown: ${dt}` };
}

function prismaPkDefault(col: OrmColDef): string {
  if (!col.isPk) return '';
  if (col.isAutoIncrement || ['serial', 'bigserial', 'smallserial'].includes(col.rawType.toLowerCase())) {
    return '@default(autoincrement())';
  }
  if (col.rawType.toLowerCase() === 'uuid') return '@default(uuid())';
  return '';
}

function prismaValueDefault(col: OrmColDef): string {
  if (col.isPk || !col.defaultValue) return '';
  const dv = col.defaultValue;
  const dvLow = dv.toLowerCase();
  if (dvLow.includes('now()') || dvLow.includes('current_timestamp')) return '@default(now())';
  if (dvLow === 'true') return '@default(true)';
  if (dvLow === 'false') return '@default(false)';
  if (!isNaN(Number(dv))) return `@default(${dv})`;
  return '';
}

function generatePrisma(tables: OrmTableDef[], dbType: OrmDbType): string {
  const provider = dbType === 'postgresql' ? 'postgresql' : 'mysql';

  const header = `// Generated by DB Maintenance Tools — ${new Date().toISOString().slice(0, 10)}

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "${provider}"
  url      = env("DATABASE_URL")
}
`;

  // Build back-ref map: target table → list of {fromTable, fromPkCol}
  const backRefMap = new Map<string, Array<{ fromTable: string }> >();
  for (const t of tables) {
    for (const col of t.columns) {
      if (col.fkToTable) {
        if (!backRefMap.has(col.fkToTable)) backRefMap.set(col.fkToTable, []);
        backRefMap.get(col.fkToTable)!.push({ fromTable: t.table });
      }
    }
  }

  const models: string[] = [];

  for (const t of tables) {
    const modelName = toPascal(toSingular(t.table));
    const lines: string[] = [];

    for (const col of t.columns) {
      const { prismaType, attr } = dbType === 'postgresql' ? pgPrismaType(col) : mysqlPrismaType(col);
      const nullable = col.nullable && !col.isPk ? '?' : '';
      const pkAttr = col.isPk ? '@id' : '';
      const defAttr = prismaPkDefault(col);
      const dvAttr = prismaValueDefault(col);
      const uniqueAttr = col.isUnique && !col.isPk ? '@unique' : '';
      const allAttrs = [pkAttr, defAttr, uniqueAttr, dvAttr, attr].filter(Boolean).join(' ');

      lines.push(`  ${toCamel(col.name)}  ${prismaType}${nullable}${allAttrs ? `  ${allAttrs}` : ''}`);

      if (col.fkToTable && col.fkToCol) {
        const relModel = toPascal(toSingular(col.fkToTable));
        const relProp = toCamel(toSingular(col.fkToTable));
        lines.push(`  ${relProp}  ${relModel}${nullable}  @relation(fields: [${toCamel(col.name)}], references: [${toCamel(col.fkToCol)}])`);
      }
    }

    // Back-references (one-to-many)
    const backRefs = backRefMap.get(t.table) ?? [];
    const seenFromTables = new Set<string>();
    for (const ref of backRefs) {
      if (seenFromTables.has(ref.fromTable)) continue;
      seenFromTables.add(ref.fromTable);
      const refModel = toPascal(toSingular(ref.fromTable));
      const refProp = toCamel(ref.fromTable);
      lines.push(`  ${refProp}  ${refModel}[]`);
    }

    lines.push('');
    if (t.table !== modelName.toLowerCase()) lines.push(`  @@map("${t.table}")`);

    models.push(`model ${modelName} {\n${lines.join('\n')}\n}`);
  }

  return header + models.join('\n\n');
}

// ─── TYPEORM ─────────────────────────────────────────────────────────────────

interface TypeOrmColType { tsType: string; columnOptions: string }

function pgTypeOrmType(col: OrmColDef): TypeOrmColType {
  const dt = col.rawType.toLowerCase();
  const len = col.maxLength;
  const p = col.numericPrecision;
  const s = col.numericScale;

  if (dt === 'varchar' || dt === 'character varying') {
    return { tsType: 'string', columnOptions: `type: 'varchar'${len ? `, length: ${len}` : ''}` };
  }
  if (dt === 'bpchar' || dt === 'char' || dt === 'character') {
    return { tsType: 'string', columnOptions: `type: 'char'${len ? `, length: ${len}` : ''}` };
  }
  if (dt === 'numeric' || dt === 'decimal') {
    return { tsType: 'string', columnOptions: `type: 'decimal'${p ? `, precision: ${p}, scale: ${s ?? 0}` : ''}` };
  }

  const map: Record<string, TypeOrmColType> = {
    int4: { tsType: 'number', columnOptions: "type: 'integer'" },
    integer: { tsType: 'number', columnOptions: "type: 'integer'" },
    int2: { tsType: 'number', columnOptions: "type: 'smallint'" },
    smallint: { tsType: 'number', columnOptions: "type: 'smallint'" },
    int8: { tsType: 'string', columnOptions: "type: 'bigint'" },
    bigint: { tsType: 'string', columnOptions: "type: 'bigint'" },
    serial: { tsType: 'number', columnOptions: "type: 'integer'" },
    bigserial: { tsType: 'number', columnOptions: "type: 'bigint'" },
    smallserial: { tsType: 'number', columnOptions: "type: 'smallint'" },
    text: { tsType: 'string', columnOptions: "type: 'text'" },
    bool: { tsType: 'boolean', columnOptions: "type: 'boolean'" },
    boolean: { tsType: 'boolean', columnOptions: "type: 'boolean'" },
    date: { tsType: 'Date', columnOptions: "type: 'date'" },
    uuid: { tsType: 'string', columnOptions: "type: 'uuid'" },
    jsonb: { tsType: 'object', columnOptions: "type: 'jsonb'" },
    json: { tsType: 'object', columnOptions: "type: 'json'" },
    float4: { tsType: 'number', columnOptions: "type: 'real'" },
    real: { tsType: 'number', columnOptions: "type: 'real'" },
    float8: { tsType: 'number', columnOptions: "type: 'double precision'" },
    'double precision': { tsType: 'number', columnOptions: "type: 'double precision'" },
    timestamp: { tsType: 'Date', columnOptions: "type: 'timestamp'" },
    timestamptz: { tsType: 'Date', columnOptions: "type: 'timestamp with time zone'" },
    'timestamp with time zone': { tsType: 'Date', columnOptions: "type: 'timestamp with time zone'" },
    bytea: { tsType: 'Buffer', columnOptions: "type: 'bytea'" },
    time: { tsType: 'string', columnOptions: "type: 'time'" },
    timetz: { tsType: 'string', columnOptions: "type: 'time with time zone'" },
    interval: { tsType: 'string', columnOptions: "type: 'interval'" },
  };
  return map[dt] ?? { tsType: 'unknown', columnOptions: `type: '${dt}'` };
}

function mysqlTypeOrmType(col: OrmColDef): TypeOrmColType {
  const dt = col.rawType.toLowerCase();
  const len = col.maxLength;
  const decMatch = col.fullType.match(/\((\d+)(?:,\s*(\d+))?\)/);

  if (dt === 'varchar') {
    return { tsType: 'string', columnOptions: `type: 'varchar'${len ? `, length: ${len}` : ''}` };
  }
  if (dt === 'char') {
    return { tsType: 'string', columnOptions: `type: 'char'${len ? `, length: ${len}` : ''}` };
  }
  if (dt === 'tinyint' && col.fullType.toLowerCase().includes('(1)')) {
    return { tsType: 'boolean', columnOptions: "type: 'tinyint', width: 1" };
  }
  if (dt === 'decimal' || dt === 'numeric') {
    const pr = decMatch ? decMatch[1] : '10';
    const sc = decMatch ? (decMatch[2] ?? '0') : '2';
    return { tsType: 'string', columnOptions: `type: 'decimal', precision: ${pr}, scale: ${sc}` };
  }

  const map: Record<string, TypeOrmColType> = {
    int: { tsType: 'number', columnOptions: "type: 'int'" },
    integer: { tsType: 'number', columnOptions: "type: 'int'" },
    bigint: { tsType: 'string', columnOptions: "type: 'bigint'" },
    smallint: { tsType: 'number', columnOptions: "type: 'smallint'" },
    mediumint: { tsType: 'number', columnOptions: "type: 'mediumint'" },
    tinyint: { tsType: 'number', columnOptions: "type: 'tinyint'" },
    text: { tsType: 'string', columnOptions: "type: 'text'" },
    mediumtext: { tsType: 'string', columnOptions: "type: 'mediumtext'" },
    longtext: { tsType: 'string', columnOptions: "type: 'longtext'" },
    tinytext: { tsType: 'string', columnOptions: "type: 'tinytext'" },
    boolean: { tsType: 'boolean', columnOptions: "type: 'boolean'" },
    bool: { tsType: 'boolean', columnOptions: "type: 'boolean'" },
    float: { tsType: 'number', columnOptions: "type: 'float'" },
    double: { tsType: 'number', columnOptions: "type: 'double'" },
    datetime: { tsType: 'Date', columnOptions: "type: 'datetime'" },
    timestamp: { tsType: 'Date', columnOptions: "type: 'timestamp'" },
    date: { tsType: 'Date', columnOptions: "type: 'date'" },
    time: { tsType: 'string', columnOptions: "type: 'time'" },
    year: { tsType: 'number', columnOptions: "type: 'year'" },
    json: { tsType: 'object', columnOptions: "type: 'json'" },
    enum: { tsType: 'string', columnOptions: "type: 'enum'" },
  };
  return map[dt] ?? { tsType: 'unknown', columnOptions: `type: '${dt}'` };
}

function typeormDefault(col: OrmColDef): string {
  const dv = col.defaultValue;
  if (!dv) return '';
  const dvLow = dv.toLowerCase();
  if (dvLow.includes('now()') || dvLow.includes('current_timestamp')) return `default: () => 'CURRENT_TIMESTAMP'`;
  if (!isNaN(Number(dv))) return `default: ${dv}`;
  if (/^'[^']*'$/.test(dv)) return `default: ${dv}`;
  return '';
}

function generateTypeorm(tables: OrmTableDef[], dbType: OrmDbType): string {
  const usedDecorators = new Set<string>(['Entity', 'Column']);
  const tableDefs: string[] = [];

  const backRefMap = new Map<string, Array<{ fromTable: string }>>();
  for (const t of tables) {
    for (const col of t.columns) {
      if (col.fkToTable) {
        if (!backRefMap.has(col.fkToTable)) backRefMap.set(col.fkToTable, []);
        backRefMap.get(col.fkToTable)!.push({ fromTable: t.table });
      }
    }
  }

  for (const t of tables) {
    const className = `${toPascal(toSingular(t.table))}Entity`;
    const props: string[] = [];

    for (const col of t.columns) {
      const { tsType, columnOptions } = dbType === 'postgresql' ? pgTypeOrmType(col) : mysqlTypeOrmType(col);
      const propName = toCamel(col.name);
      const nullSuffix = col.nullable && !col.isPk ? ' | null' : '';
      const optMark = col.nullable && !col.isPk ? '?' : '';
      const isSerial = ['serial', 'bigserial', 'smallserial'].includes(col.rawType.toLowerCase());

      if (col.isPk) {
        if (col.isAutoIncrement || isSerial) {
          usedDecorators.add('PrimaryGeneratedColumn');
          props.push(`  @PrimaryGeneratedColumn()\n  ${propName}: ${tsType};`);
        } else if (col.rawType.toLowerCase() === 'uuid') {
          usedDecorators.add('PrimaryGeneratedColumn');
          props.push(`  @PrimaryGeneratedColumn('uuid')\n  ${propName}: ${tsType};`);
        } else {
          usedDecorators.add('PrimaryColumn');
          props.push(`  @PrimaryColumn({ ${columnOptions} })\n  ${propName}: ${tsType};`);
        }
      } else if (col.fkToTable && col.fkToCol) {
        usedDecorators.add('ManyToOne');
        usedDecorators.add('JoinColumn');
        const refClass = `${toPascal(toSingular(col.fkToTable))}Entity`;
        const relProp = toCamel(toSingular(col.fkToTable));
        const colOpts: string[] = [columnOptions];
        if (col.nullable) colOpts.push('nullable: true');
        if (col.isUnique) colOpts.push('unique: true');
        const manyOpts = col.nullable ? ', { nullable: true }' : '';
        props.push(`  @Column({ ${colOpts.join(', ')} })\n  ${propName}: ${tsType}${nullSuffix};`);
        props.push(`\n  @ManyToOne(() => ${refClass}${manyOpts})\n  @JoinColumn({ name: '${col.name}' })\n  ${relProp}${optMark}: ${refClass}${nullSuffix};`);
      } else {
        const opts: string[] = [columnOptions];
        if (col.nullable) opts.push('nullable: true');
        if (col.isUnique) opts.push('unique: true');
        const def = typeormDefault(col);
        if (def) opts.push(def);
        props.push(`  @Column({ ${opts.join(', ')} })\n  ${propName}${optMark}: ${tsType}${nullSuffix};`);
      }
    }

    // Back-references
    const seenFromTables = new Set<string>();
    for (const ref of (backRefMap.get(t.table) ?? [])) {
      if (seenFromTables.has(ref.fromTable)) continue;
      seenFromTables.add(ref.fromTable);
      usedDecorators.add('OneToMany');
      const refClass = `${toPascal(toSingular(ref.fromTable))}Entity`;
      const refProp = toCamel(ref.fromTable);
      const inverseVar = toCamel(toSingular(ref.fromTable));
      const inverseProp = toCamel(toSingular(t.table));
      props.push(`\n  @OneToMany(() => ${refClass}, ${inverseVar} => ${inverseVar}.${inverseProp})\n  ${refProp}: ${refClass}[];`);
    }

    tableDefs.push(`@Entity({ name: '${t.table}' })\nexport class ${className} {\n${props.join('\n\n')}\n}`);
  }

  const importLine = `import { ${[...usedDecorators].sort().join(', ')} } from 'typeorm';`;
  return [
    `// Generated by DB Maintenance Tools — ${new Date().toISOString().slice(0, 10)}`,
    importLine, '',
    tableDefs.join('\n\n'),
  ].join('\n');
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function generateOrm(tables: OrmTableDef[], dbType: OrmDbType, target: OrmTarget): string {
  switch (target) {
    case 'drizzle':  return generateDrizzle(tables, dbType);
    case 'prisma':   return generatePrisma(tables, dbType);
    case 'typeorm':  return generateTypeorm(tables, dbType);
  }
}
