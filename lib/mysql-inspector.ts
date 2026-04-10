import mysql from 'mysql2/promise';
import { InspectionResult, MySQLTable, MySQLColumn, MySQLIndex, MySQLForeignKey } from './types';

export async function inspectMySQL(
  host: string,
  port: number,
  user: string,
  password: string,
  database: string
): Promise<InspectionResult> {
  const conn = await mysql.createConnection({ host, port, user, password, database, multipleStatements: false });

  try {
    const tables = await getTables(conn, database);
    return { database, tables, inspectedAt: new Date().toISOString() };
  } finally {
    await conn.end();
  }
}

async function getTables(conn: mysql.Connection, database: string): Promise<MySQLTable[]> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME, TABLE_ROWS, ROUND(((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024), 2) AS SIZE_MB,
            ENGINE, TABLE_COLLATION, TABLE_COMMENT
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
     ORDER BY TABLE_NAME`,
    [database]
  );

  const tables: MySQLTable[] = [];
  for (const row of rows) {
    const name = row.TABLE_NAME as string;
    const [columns, indexes, foreignKeys] = await Promise.all([
      getColumns(conn, database, name),
      getIndexes(conn, database, name),
      getForeignKeys(conn, database, name),
    ]);
    tables.push({
      name,
      columns,
      indexes,
      foreignKeys,
      rowCount: Number(row.TABLE_ROWS) || 0,
      sizeMB: Number(row.SIZE_MB) || 0,
      engine: row.ENGINE || 'InnoDB',
      collation: row.TABLE_COLLATION || '',
      comment: row.TABLE_COMMENT || '',
    });
  }
  return tables;
}

async function getColumns(conn: mysql.Connection, database: string, table: string): Promise<MySQLColumn[]> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA,
            COLUMN_KEY, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_COMMENT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [database, table]
  );

  return rows.map((r) => ({
    name: r.COLUMN_NAME,
    type: r.COLUMN_TYPE,
    nullable: r.IS_NULLABLE === 'YES',
    defaultValue: r.COLUMN_DEFAULT ?? null,
    autoIncrement: (r.EXTRA as string)?.includes('auto_increment') ?? false,
    isPrimaryKey: r.COLUMN_KEY === 'PRI',
    isUnique: r.COLUMN_KEY === 'UNI',
    comment: r.COLUMN_COMMENT || '',
    characterSet: r.CHARACTER_SET_NAME || null,
    collation: r.COLLATION_NAME || null,
  }));
}

async function getIndexes(conn: mysql.Connection, database: string, table: string): Promise<MySQLIndex[]> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, INDEX_TYPE
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [database, table]
  );

  const map = new Map<string, MySQLIndex>();
  for (const r of rows) {
    const name = r.INDEX_NAME as string;
    if (!map.has(name)) {
      map.set(name, { name, columns: [], unique: r.NON_UNIQUE === 0, type: r.INDEX_TYPE });
    }
    map.get(name)!.columns.push(r.COLUMN_NAME as string);
  }
  return Array.from(map.values());
}

async function getForeignKeys(conn: mysql.Connection, database: string, table: string): Promise<MySQLForeignKey[]> {
  const [rows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT kcu.CONSTRAINT_NAME, kcu.COLUMN_NAME, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME,
            rc.UPDATE_RULE, rc.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE kcu
     JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
       ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND kcu.TABLE_SCHEMA = rc.CONSTRAINT_SCHEMA
     WHERE kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ? AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
    [database, table]
  );

  return rows.map((r) => ({
    name: r.CONSTRAINT_NAME,
    column: r.COLUMN_NAME,
    referencedTable: r.REFERENCED_TABLE_NAME,
    referencedColumn: r.REFERENCED_COLUMN_NAME,
    onUpdate: r.UPDATE_RULE || 'RESTRICT',
    onDelete: r.DELETE_RULE || 'RESTRICT',
  }));
}
