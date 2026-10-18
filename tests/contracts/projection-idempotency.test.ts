import { afterAll } from 'vitest'
import { runProjectionContract } from '@nymbalhq/contract-tests'
import {
  InMemoryDocumentStore,
  buildRepositories,
  createCommandStore,
  createLogger,
  runMigrations,
  withIdempotency,
  type CommandStore,
} from '@nymbalhq/platform'

// The processed-event repository is command-store backed since P1-03 (the document-store one is gone), so the
// contract runs on a SQLite :memory: store per build.

const logger = createLogger({ pretty: false, level: 'error' })
const stores: CommandStore[] = []

afterAll(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()))
})

runProjectionContract({
  build: async () => {
    const store = createCommandStore(
      // @ts-expect-error minimal config
      { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
      { sqlitePath: ':memory:' },
    )
    stores.push(store)
    await runMigrations(store, {
      migrationsRoot: new URL('../../packages/platform/migrations', import.meta.url).pathname,
    })
    const repo = buildRepositories(
      store,
      new InMemoryDocumentStore({ sweepIntervalMs: 0 }),
    ).processedEvent
    let count = 0
    const wrapped = withIdempotency(
      'test-projection',
      async (_event) => {
        count++
      },
      { repo, logger },
    )
    return {
      handle: async (event) => {
        await wrapped(event)
      },
      applicationCount: async () => count,
    }
  },
})
