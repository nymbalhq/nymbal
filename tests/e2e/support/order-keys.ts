import { existsSync, readFileSync } from 'node:fs'
import { createCommandStore, rawClients } from '@nymbalhq/platform'

// The store has no clock a test can move, so a journey that needs an order's keys past their lifetime backdates them:
// every key row of the order gets an `expires_at` a minute ago, written in the command store of the running API (its
// own connection: a SQLite file in WAL mode, or the run's Postgres database). What the shopper then sees is the store's
// own answer to an expired key.

const UPDATE_SQLITE =
  'UPDATE order_access_keys SET expires_at = ? WHERE order_id = (SELECT id FROM orders WHERE order_number = ?)'
const UPDATE_POSTGRES =
  'UPDATE order_access_keys SET expires_at = $1 WHERE order_id = (SELECT id FROM orders WHERE order_number = $2)'

/**
 * The store variables the native API was started with, as scripts/e2e-server.mjs recorded them: on a Postgres store
 * set its DATABASE_URL names a database of the run's own, which only the API's record knows.
 */
function apiStoreEnv(): Record<string, string> {
  const file = process.env.NYMBAL_E2E_STORE_ENV_FILE
  if (file === undefined || file === '') {
    throw new Error(
      'expireOrderKeys: NYMBAL_E2E_STORE_ENV_FILE is not set: playwright.config.ts sets it',
    )
  }
  if (!existsSync(file)) {
    throw new Error(`expireOrderKeys: ${file} does not exist: scripts/e2e-server.mjs writes it`)
  }
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>
}

type StoreConfig = Parameters<typeof createCommandStore>[0]
const configFor = (commandStore: 'sqlite' | 'postgres'): StoreConfig =>
  ({ infrastructure: { commandStore } }) as unknown as StoreConfig

/** Expires every key of the order; answers how many there were, and fails when the order has none. */
export async function expireOrderKeys(orderNumber: string): Promise<number> {
  const env = apiStoreEnv()
  const expired = new Date(Date.now() - 60_000)
  let changes: number
  let where: string
  if (env.NYMBAL_COMMAND_STORE === 'postgres') {
    const postgresUrl = env.DATABASE_URL
    if (postgresUrl === undefined || postgresUrl === '') {
      throw new Error('expireOrderKeys: the API runs on Postgres but recorded no DATABASE_URL')
    }
    where = new URL(postgresUrl).pathname
    const store = createCommandStore(configFor('postgres'), { postgresUrl })
    try {
      const clients = rawClients(store)
      if (clients.kind !== 'postgres') throw new Error('expireOrderKeys: the store is not Postgres')
      const result = await clients.pool.query(UPDATE_POSTGRES, [expired, orderNumber])
      changes = result.rowCount ?? 0
    } finally {
      await store.close()
    }
  } else {
    const sqlitePath = env.NYMBAL_SQLITE_PATH
    if (sqlitePath === undefined || sqlitePath === '') {
      throw new Error('expireOrderKeys: the API recorded no NYMBAL_SQLITE_PATH')
    }
    where = sqlitePath
    const store = createCommandStore(configFor('sqlite'), { sqlitePath })
    try {
      const clients = rawClients(store)
      if (clients.kind !== 'sqlite') throw new Error('expireOrderKeys: the store is not SQLite')
      changes = clients.raw.prepare(UPDATE_SQLITE).run(expired.toISOString(), orderNumber).changes
    } finally {
      await store.close()
    }
  }
  if (changes === 0) throw new Error(`expireOrderKeys: ${orderNumber} has no key rows in ${where}`)
  return changes
}
