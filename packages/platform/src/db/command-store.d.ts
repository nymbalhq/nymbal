import type { NymbalConfig } from '@nymbal/config';
import BetterSqlite3 from 'better-sqlite3';
import pg from 'pg';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as sqliteSchema from './schema/sqlite.js';
import * as postgresSchema from './schema/postgres.js';
export type SqliteClient = BetterSQLite3Database<typeof sqliteSchema>;
export type PostgresClient = NodePgDatabase<typeof postgresSchema>;
export type CommandStore = {
    kind: 'sqlite';
    db: SqliteClient;
    raw: BetterSqlite3.Database;
    close(): Promise<void>;
    transaction<T>(fn: (tx: SqliteClient) => Promise<T> | T): Promise<T>;
} | {
    kind: 'postgres';
    db: PostgresClient;
    pool: pg.Pool;
    close(): Promise<void>;
    transaction<T>(fn: (tx: PostgresClient) => Promise<T> | T): Promise<T>;
};
export interface CommandStoreOptions {
    sqlitePath?: string;
    postgresUrl?: string;
}
export declare function createCommandStore(config: NymbalConfig, options?: CommandStoreOptions): CommandStore;
//# sourceMappingURL=command-store.d.ts.map