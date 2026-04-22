import { resolve } from 'node:path';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
export async function runMigrations(store, options = {}) {
    const root = options.migrationsRoot ?? resolve(process.cwd(), 'migrations');
    if (store.kind === 'sqlite') {
        migrateSqlite(store.db, { migrationsFolder: resolve(root, 'sqlite') });
    }
    else {
        await migratePostgres(store.db, { migrationsFolder: resolve(root, 'postgres') });
    }
}
//# sourceMappingURL=migrate.js.map