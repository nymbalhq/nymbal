import { defineCommand } from 'citty';
import { loadConfig } from '@nymbal/config';
import { createCommandStore, runMigrations } from '@nymbal/platform';
import { resolve } from 'node:path';
export const migrateCommand = defineCommand({
    meta: { name: 'migrate', description: 'Run database migrations (Drizzle)' },
    async run() {
        const { config, projectRoot } = await loadConfig();
        const store = createCommandStore(config);
        try {
            // Migrations live inside @nymbal/platform once published; during workspace dev they're under packages/platform/migrations.
            const migrationsRoot = resolveMigrations(projectRoot);
            await runMigrations(store, { migrationsRoot });
            // eslint-disable-next-line no-console
            console.log(`✓ migrations applied (${store.kind})`);
        }
        finally {
            await store.close();
        }
    },
});
function resolveMigrations(projectRoot) {
    // Prefer a project-local migrations/ override, else the platform package's shipped migrations.
    const local = resolve(projectRoot, 'migrations');
    return local;
}
//# sourceMappingURL=migrate.js.map