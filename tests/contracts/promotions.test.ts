import { afterAll, beforeAll } from 'vitest'
import type { PromotionsAdapter } from '@nymbalhq/types'
import { runPromotionsContract } from '../../packages/contract-tests/src/index.js'
import { createNativePromotionsAdapter } from '../../packages/platform/src/adapters/promotions/native-adapter.js'
import {
  createCommandStore,
  type CommandStore,
} from '../../packages/platform/src/db/command-store.js'
import { runMigrations } from '../../packages/platform/src/db/migrate.js'
import { InMemoryDocumentStore } from '../../packages/platform/src/document-store/in-memory.js'
import { createLogger } from '../../packages/platform/src/logger.js'
import { buildRepositories } from '../../packages/platform/src/repositories/index.js'

// AC-8: the published promotions suite runs on the native engine over a migrated SQLite command store. The half that
// says the suite can fail is in contract-breakers.test.ts (promotions-*).

const logger = createLogger({ pretty: false, level: 'error' })
let store: CommandStore | undefined

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../packages/platform/migrations', import.meta.url).pathname,
  })
})

afterAll(async () => {
  await store?.close()
})

function build(): PromotionsAdapter {
  if (store === undefined) throw new Error('the SQLite command store was not opened')
  return createNativePromotionsAdapter({
    repos: buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 })),
    logger,
  })
}

runPromotionsContract('native', build)
