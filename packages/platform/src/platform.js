import { createCommandStore } from './db/command-store.js';
import { createDocumentStore } from './document-store/factory.js';
import { createEventBus } from './event-bus/factory.js';
import { createLogger } from './logger.js';
export function createPlatform(config, options = {}) {
    const logger = options.logger ??
        createLogger({
            base: { store: config.store.name },
        });
    const commandStore = createCommandStore(config, {
        ...(options.sqlitePath !== undefined && { sqlitePath: options.sqlitePath }),
        ...(options.postgresUrl !== undefined && { postgresUrl: options.postgresUrl }),
    });
    const documentStore = createDocumentStore(config);
    const eventBus = createEventBus(config, logger);
    return {
        config,
        commandStore,
        documentStore,
        eventBus,
        logger,
        async close() {
            await commandStore.close();
            await documentStore.close();
            await eventBus.close();
        },
    };
}
//# sourceMappingURL=platform.js.map