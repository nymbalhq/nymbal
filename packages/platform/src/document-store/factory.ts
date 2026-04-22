import type { NymbalConfig } from '@nymbal/config'
import { ConfigError } from '@nymbal/types'
import type { DocumentStoreAdapter } from '@nymbal/types'
import { InMemoryDocumentStore } from './in-memory.js'

export function createDocumentStore(config: NymbalConfig): DocumentStoreAdapter {
  switch (config.infrastructure.documentStore) {
    case 'in-memory':
      return new InMemoryDocumentStore()
    case 'dynamodb':
    case 'firestore':
    case 'cosmosdb':
    case 'postgres-jsonb':
      throw new ConfigError(
        `documentStore=${config.infrastructure.documentStore} is planned for v1.0 and not yet implemented.`,
        { context: { documentStore: config.infrastructure.documentStore } },
      )
    default: {
      const exhaustive: never = config.infrastructure.documentStore
      throw new ConfigError(`Unknown documentStore: ${String(exhaustive)}`)
    }
  }
}
