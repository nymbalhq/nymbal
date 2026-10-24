import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { runSearchContract } from '@nymbalhq/contract-tests'
import {
  createCommandStore,
  createLogger,
  createNativeSearchAdapter,
  encodeSearchCursor,
  rawClients,
  runMigrations,
  type CommandStore,
} from '@nymbalhq/platform'

// P2-07 AC-1 to AC-4 on the native search adapter's SQLite dialect (decision 1: FTS5 in the command store's own
// database), on a temp file migrated with the platform's migrations (0007 creates the search tables). One database
// for the file: the cases share the index, as decision 10 says they may. Postgres runs the same cases in
// integration-postgres (packages/platform/tests/postgres/search-contract.postgres.test.ts). P2-13 decision 2: the
// P2-07 cases moved into runSearchContract, under the same options.

const MIGRATIONS = fileURLToPath(new URL('../../packages/platform/migrations', import.meta.url))
const config = {
  infrastructure: { commandStore: 'sqlite' },
  store: { name: 'contract', currency: 'GBP' },
} as unknown as NymbalConfig
const logger = createLogger({ pretty: false, level: 'error' })

let dir: string | undefined
let store: CommandStore | undefined

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'p2-07-search-'))
  store = createCommandStore(config, { sqlitePath: join(dir, 'search.sqlite') })
  await runMigrations(store, { migrationsRoot: MIGRATIONS })
})

afterAll(async () => {
  await store?.close()
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
})

function build() {
  if (store === undefined) throw new Error('the SQLite command store was not opened')
  return createNativeSearchAdapter({ sql: rawClients(store), logger })
}

runSearchContract('native-sqlite', build, {
  ranking: true,
  facets: true,
  cursorAt: encodeSearchCursor,
})
