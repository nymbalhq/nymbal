import { defineCommand } from 'citty';
import { loadConfig } from '@nymbal/config';
import { createPlatform, runSeed } from '@nymbal/platform';
import { getCliVersion } from '../utils/version.js';
export const seedCommand = defineCommand({
    meta: { name: 'seed', description: 'Re-seed demo content (products, categories)' },
    async run() {
        const { config } = await loadConfig();
        const platform = createPlatform(config);
        try {
            const result = await runSeed({
                config,
                commandStore: platform.commandStore,
                documentStore: platform.documentStore,
                eventBus: platform.eventBus,
                logger: platform.logger,
                version: getCliVersion(),
            });
            // eslint-disable-next-line no-console
            console.log(`✓ seeded ${result.products} products across ${result.categories} categories`);
        }
        finally {
            await platform.close();
        }
    },
});
//# sourceMappingURL=seed.js.map