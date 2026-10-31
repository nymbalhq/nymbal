import { ConfigError, type AdapterContext } from '@nymbalhq/types'
import {
  createPostgresJsonbDocumentStore,
  PostgresJsonbDocumentStore,
  type PostgresJsonbDocumentStoreOptions,
} from './postgres-jsonb-document-store.js'

/** What this package serves: the kernel refuses it on any other slot or provider. */
export const slot = 'documentStore'
export const provider = 'postgres-jsonb'

export {
  createPostgresJsonbDocumentStore,
  PostgresJsonbDocumentStore,
  type PostgresJsonbDocumentStoreOptions,
}

/**
 * The kernel's entry: `infrastructure.documentStore: { provider: 'postgres-jsonb' }`, on the command store's connection
 * (`config.postgresUrl`, then `DATABASE_URL`). The kernel calls `initialize()` before it uses the store.
 */
export function createAdapter(ctx: AdapterContext): PostgresJsonbDocumentStore {
  if (ctx.slot !== 'documentStore') {
    throw new ConfigError(
      `@nymbalhq/document-store-postgres-jsonb serves documentStore, not ${ctx.slot}`,
      { code: 'adapter.wrong_slot', context: { slot: ctx.slot } },
    )
  }
  const configured = ctx.config['postgresUrl']
  const postgresUrl =
    typeof configured === 'string' && configured !== '' ? configured : ctx.env['DATABASE_URL']
  const prefix = ctx.config['prefix']
  if (postgresUrl === undefined || postgresUrl === '') {
    throw new ConfigError(
      '@nymbalhq/document-store-postgres-jsonb needs the Postgres connection: set DATABASE_URL',
      { code: 'config.postgres_url_missing', context: { slot: ctx.slot } },
    )
  }
  if (typeof prefix !== 'string' || prefix === '') {
    throw new ConfigError('@nymbalhq/document-store-postgres-jsonb needs a prefix', {
      code: 'config.invalid',
      context: { slot: ctx.slot },
    })
  }
  return createPostgresJsonbDocumentStore({ postgresUrl, prefix, logger: ctx.logger })
}
