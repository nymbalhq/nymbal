import { ConfigError } from '@nymbal/types';
import { InMemoryDocumentStore } from './in-memory.js';
export function createDocumentStore(config) {
    switch (config.infrastructure.documentStore) {
        case 'in-memory':
            return new InMemoryDocumentStore();
        case 'dynamodb':
        case 'firestore':
        case 'cosmosdb':
        case 'postgres-jsonb':
            throw new ConfigError(`documentStore=${config.infrastructure.documentStore} is planned for v1.0 and not yet implemented.`, { context: { documentStore: config.infrastructure.documentStore } });
        default: {
            const exhaustive = config.infrastructure.documentStore;
            throw new ConfigError(`Unknown documentStore: ${String(exhaustive)}`);
        }
    }
}
//# sourceMappingURL=factory.js.map