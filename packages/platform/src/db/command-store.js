import { envOptional } from '@nymbal/config';
import { ConfigError } from '@nymbal/types';
import BetterSqlite3 from 'better-sqlite3';
import pg from 'pg';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import * as sqliteSchema from './schema/sqlite.js';
import * as postgresSchema from './schema/postgres.js';
export function createCommandStore(config, options = {}) {
    if (config.infrastructure.commandStore === 'sqlite') {
        const path = options.sqlitePath ?? envOptional('NYMBAL_SQLITE_PATH') ?? './nymbal.db';
        const raw = new BetterSqlite3(path);
        raw.pragma('journal_mode = WAL');
        raw.pragma('foreign_keys = ON');
        const db = drizzleSqlite(raw, { schema: sqliteSchema });
        return {
            kind: 'sqlite',
            db,
            raw,
            async close() {
                raw.close();
            },
            async transaction(fn) {
                return db.transaction(async (tx) => fn(tx));
            },
        };
    }
    if (config.infrastructure.commandStore === 'postgres') {
        const connectionString = options.postgresUrl ?? envOptional('DATABASE_URL');
        if (!connectionString) {
            throw new ConfigError('commandStore=postgres requires DATABASE_URL to be set (or pass postgresUrl option).', { context: { commandStore: 'postgres' } });
        }
        const pool = new pg.Pool({ connectionString });
        const db = drizzlePg(pool, { schema: postgresSchema });
        return {
            kind: 'postgres',
            db,
            pool,
            async close() {
                await pool.end();
            },
            async transaction(fn) {
                return db.transaction(async (tx) => fn(tx));
            },
        };
    }
    throw new ConfigError(`Unsupported commandStore: ${String(config.infrastructure.commandStore)}`, { context: { commandStore: config.infrastructure.commandStore } });
}
//# sourceMappingURL=command-store.js.map