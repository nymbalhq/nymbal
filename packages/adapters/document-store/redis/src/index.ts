import { ConfigError, type AdapterContext, type DocumentStoreAdapter } from '@nymbalhq/types'
import {
  createRedisDocumentStore,
  RedisDocumentStore,
  type RedisDocumentStoreOptions,
} from './redis-document-store.js'

export { createRedisDocumentStore, RedisDocumentStore, type RedisDocumentStoreOptions }

/** The kernel's entry: `infrastructure.documentStore: 'redis'`, with `{ url, prefix }` from the `redis` block. */
export async function createAdapter(ctx: AdapterContext): Promise<DocumentStoreAdapter> {
  if (ctx.slot !== 'documentStore') {
    throw new ConfigError(`@nymbalhq/document-store-redis serves documentStore, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  const { url, prefix } = ctx.config
  if (typeof url !== 'string' || url === '' || typeof prefix !== 'string' || prefix === '') {
    throw new ConfigError('@nymbalhq/document-store-redis needs a Redis url and a key prefix', {
      code: 'config.invalid',
      context: { slot: ctx.slot },
    })
  }
  return createRedisDocumentStore({ url, prefix, logger: ctx.logger })
}
