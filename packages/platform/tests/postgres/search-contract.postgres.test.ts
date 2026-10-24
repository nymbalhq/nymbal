import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll } from 'vitest'
import { runSearchContract } from '../../../contract-tests/src/index.js'
import {
  createNativeSearchAdapter,
  encodeSearchCursor,
} from '../../src/adapters/search/native-adapter.js'
import { createCommandStore, rawClients, type CommandStore } from '../../src/db/command-store.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createLogger } from '../../src/logger.js'
import { createDatabase, postgresServerUrl, type TestDatabase } from '../support/postgres.js'

// P2-07 AC-1 to AC-4 on the native search adapter's Postgres dialect (decision 1: a tsvector column with a GIN index,
// language 'simple'), on a database of this file's own migrated with the platform's migrations (0007 creates the
// search table). The cases share the index across cases and runs, as decision 10 says they may; the SQLite dialect
// and the `custom` fixture run the same cases in contracts-native (tests/contracts). P2-13 decision 2: the P2-07 cases
// moved into runSearchContract in the package, under the same options.

const serverUrl = postgresServerUrl()
const MIGRATIONS = fileURLToPath(new URL('../../migrations', import.meta.url))
const logger = createLogger({ pretty: false, level: 'error' })

let db: TestDatabase | undefined
let store: CommandStore | undefined

beforeAll(async () => {
  db = await createDatabase(serverUrl, 'search_contract')
  store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'postgres' }, store: { name: 'test', currency: 'GBP' } },
    { postgresUrl: db.url },
  )
  await runMigrations(store, { migrationsRoot: MIGRATIONS })
}, 60_000)

afterAll(async () => {
  await store?.close()
  await db?.drop()
}, 60_000)

function build() {
  if (store === undefined) throw new Error('the Postgres command store was not opened')
  return createNativeSearchAdapter({ sql: rawClients(store), logger })
}

runSearchContract('native-postgres', build, {
  ranking: true,
  facets: true,
  cursorAt: encodeSearchCursor,
})
