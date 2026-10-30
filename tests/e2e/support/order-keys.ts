import { createCommandStore, rawClients } from '@nymbalhq/platform'

// The store has no clock a test can move, so a journey that needs an order's keys past their lifetime backdates them:
// every key row of the order gets an `expires_at` a minute ago, written in the fixture store's SQLite file beside the
// running API (its own connection; the file is in WAL mode). What the shopper then sees is the store's own answer to an
// expired key.

/** The native store's file (playwright.config.ts sets it for every run); a custom store's run passes its own. */
const NATIVE_SQLITE = process.env.NYMBAL_E2E_SQLITE_PATH

/** Expires every key of the order; answers how many there were, and fails when the order has none. */
export async function expireOrderKeys(
  orderNumber: string,
  sqlitePath: string | undefined = NATIVE_SQLITE,
): Promise<number> {
  if (sqlitePath === undefined || sqlitePath === '') {
    throw new Error('expireOrderKeys: NYMBAL_E2E_SQLITE_PATH names no store file')
  }
  const store = createCommandStore(
    { infrastructure: { commandStore: 'sqlite' } } as unknown as Parameters<
      typeof createCommandStore
    >[0],
    { sqlitePath },
  )
  try {
    const clients = rawClients(store)
    if (clients.kind !== 'sqlite') throw new Error('expireOrderKeys: the store is not SQLite')
    const expired = new Date(Date.now() - 60_000).toISOString()
    const { changes } = clients.raw
      .prepare(
        'UPDATE order_access_keys SET expires_at = ? WHERE order_id = (SELECT id FROM orders WHERE order_number = ?)',
      )
      .run(expired, orderNumber)
    if (changes === 0)
      throw new Error(`expireOrderKeys: ${orderNumber} has no key rows in ${sqlitePath}`)
    return changes
  } finally {
    await store.close()
  }
}
