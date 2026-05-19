import { Client } from 'pg';
import mysql from 'mysql2/promise';

export type DbType = 'postgresql' | 'mysql';

export interface ExplorerConn {
  type: DbType;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
}

export async function withPg<T>(conn: ExplorerConn, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    database: conn.database || 'postgres',
    user: conn.username,
    password: conn.password,
    connectionTimeoutMillis: 8000,
    ssl: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function withMysql<T>(conn: ExplorerConn, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
  const c = await mysql.createConnection({
    host: conn.host,
    port: conn.port,
    database: conn.database || undefined,
    user: conn.username,
    password: conn.password,
    connectTimeout: 8000,
    multipleStatements: false,
  });
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
