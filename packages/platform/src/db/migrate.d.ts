import type { CommandStore } from './command-store.js';
export interface MigrateOptions {
    migrationsRoot?: string;
}
export declare function runMigrations(store: CommandStore, options?: MigrateOptions): Promise<void>;
//# sourceMappingURL=migrate.d.ts.map