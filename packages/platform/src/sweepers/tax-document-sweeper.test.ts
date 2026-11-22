import { v7 as uuidv7 } from 'uuid'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommandStore, rawClients, type CommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createLogger } from '../logger.js'
import { buildRepositories } from '../repositories/index.js'
import { startTaxDocumentSweeper } from './index.js'

// The sweep that retries what is owed to the tax provider: which records a tick takes (the current provider's, due for
// at least the minimum age, the least recently tried first, at most 50), that rows it always fails cannot starve the
// rest, that one order whose filing rejects does not stop it, and that a tick asked for during a tick waits for it. The
// store and its records are real (SQLite `:memory:`); `file` is the test's, so what it is asked is what the sweep chose,
// and it writes back what a filing would (a failure moves `updated_at`, a filing clears the row).

const PROVIDER = 'filing-tax'
const MINUTE = 60_000
const MIN_AGE_MS = MINUTE

interface Env {
  store: CommandStore
  lines: string[]
  /** Every order `file` was asked for, in order. */
  asked: string[]
  /** What `file` does for an order: files it (the default), fails it (still due), or rejects. */
  outcome: Map<string, 'filed' | 'due' | 'rejects'>
  /** When set, every `file` call waits on it. */
  hold: Promise<void> | null
  sweeper(): ReturnType<typeof startTaxDocumentSweeper>
}

const opened: Array<{ store: CommandStore; stop: () => void }> = []
afterEach(async () => {
  for (const o of opened.splice(0)) {
    o.stop()
    await o.store.close()
  }
})

function sqlite(store: CommandStore) {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error('this file runs on SQLite')
  return clients.raw
}

const iso = (at: number): string => new Date(at).toISOString()

async function open(): Promise<Env> {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const handles: Array<{ stop: () => void }> = []
  opened.push({ store, stop: () => handles.forEach((h) => h.stop()) })
  const env: Env = {
    store,
    lines: [],
    asked: [],
    outcome: new Map(),
    hold: null,
    sweeper() {
      const handle = startTaxDocumentSweeper({
        store,
        repo: repos.orderTaxDocument,
        documents: { file },
        providerName: PROVIDER,
        logger: createLogger({
          pretty: false,
          level: 'warn',
          destination: { write: (line: string) => void env.lines.push(line) },
        }),
        intervalMs: 3_600_000,
        minAgeMs: MIN_AGE_MS,
      })
      handles.push(handle)
      return handle
    },
  }
  async function file(orderId: string): Promise<'none' | 'filed' | 'due'> {
    env.asked.push(orderId)
    if (env.hold !== null) await env.hold
    const outcome = env.outcome.get(orderId) ?? 'filed'
    if (outcome === 'rejects') throw new Error(`store hiccup filing ${orderId}`)
    const now = iso(Date.now())
    if (outcome === 'due') {
      sqlite(store)
        .prepare(
          'UPDATE order_tax_documents SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE order_id = ?',
        )
        .run('provider refused', now, orderId)
      return 'due'
    }
    sqlite(store)
      .prepare(
        'UPDATE order_tax_documents SET attempts = 0, last_error = NULL, due_since = NULL, updated_at = ? WHERE order_id = ?',
      )
      .run(now, orderId)
    return 'filed'
  }
  return env
}

/** A filing record owed since `dueAgo` ms before now (never owed when null), last written `touchedAgo` ms before now. */
function seed(
  env: Env,
  row: { provider?: string; dueAgo: number | null; touchedAgo: number },
): string {
  const orderId = uuidv7()
  const now = Date.now()
  sqlite(env.store)
    .prepare(
      'INSERT INTO order_tax_documents (order_id, provider, status, attempts, due_since, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      orderId,
      row.provider ?? PROVIDER,
      'pending',
      0,
      row.dueAgo === null ? null : iso(now - row.dueAgo),
      iso(now - 3 * 60 * MINUTE),
      iso(now - row.touchedAgo),
    )
  return orderId
}

/** A sweeper whose own start-up pass (if it runs one) has finished, so a tick after this is the test's own. */
async function started(env: Env) {
  const sweeper = env.sweeper()
  await sweeper.tick()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await sweeper.tick()
  env.asked.length = 0
  return sweeper
}

describe('AC-6: the tax document sweep', () => {
  // Kills: an outage never retried; a just-failed row hammered; a switched provider's rows retried against the wrong
  // provider; rows taken oldest-owed first, so the rows that always fail come back first.
  it('AC-6: a tick files every current-provider record due for at least the minimum age, the least recently tried first, and leaves records due more recently, not due, or of another provider', async () => {
    const env = await open()
    const sweeper = await started(env)
    // Owed longest but tried most recently, so taken last.
    const c = seed(env, { dueAgo: 50 * MINUTE, touchedAgo: 2 * MINUTE })
    const a = seed(env, { dueAgo: 5 * MINUTE, touchedAgo: 30 * MINUTE })
    const b = seed(env, { dueAgo: 20 * MINUTE, touchedAgo: 10 * MINUTE })
    const recent = seed(env, { dueAgo: 10_000, touchedAgo: 10_000 })
    const notDue = seed(env, { dueAgo: null, touchedAgo: 40 * MINUTE })
    const other = seed(env, { provider: 'old-tax', dueAgo: 60 * MINUTE, touchedAgo: 60 * MINUTE })

    await sweeper.tick()

    expect(env.asked).toEqual([a, b, c])
    expect(env.asked.filter((id) => [recent, notDue, other].includes(id))).toEqual([])
  })

  // Kills: a batch with no limit, or one ordered by due_since, where 50 rows the provider always refuses hold back
  // every other filing for ever.
  it('AC-6: with 51 due records whose 50 least recently tried always fail, a tick asks for exactly those 50 and the second tick files the 51st first', async () => {
    const env = await open()
    const sweeper = await started(env)
    const failing = Array.from({ length: 50 }, (_, i) =>
      seed(env, { dueAgo: 120 * MINUTE, touchedAgo: (100 - i) * MINUTE }),
    )
    for (const id of failing) env.outcome.set(id, 'due')
    const last = seed(env, { dueAgo: 30 * MINUTE, touchedAgo: 5 * MINUTE })

    await sweeper.tick()
    const firstTick = [...env.asked]
    env.asked.length = 0
    await sweeper.tick()
    const secondTick = [...env.asked]

    expect(firstTick).toHaveLength(50)
    expect([...firstTick].sort()).toEqual([...failing].sort())
    expect(secondTick[0]).toBe(last)
    const row = sqlite(env.store)
      .prepare('SELECT due_since FROM order_tax_documents WHERE order_id = ?')
      .get(last) as { due_since: string | null }
    expect(row.due_since).toBeNull()
  })

  // Kills: one bad order stopping the sweep, so nothing after it is ever filed.
  it('AC-6: an order whose file rejects is logged and the next is still filed', async () => {
    const env = await open()
    const sweeper = await started(env)
    const bad = seed(env, { dueAgo: 30 * MINUTE, touchedAgo: 30 * MINUTE })
    const good = seed(env, { dueAgo: 30 * MINUTE, touchedAgo: 20 * MINUTE })
    env.outcome.set(bad, 'rejects')

    await sweeper.tick()

    expect(env.asked).toEqual([bad, good])
    const row = sqlite(env.store)
      .prepare('SELECT due_since FROM order_tax_documents WHERE order_id = ?')
      .get(good) as { due_since: string | null }
    expect(row.due_since).toBeNull()
    const logged = env.lines.filter(
      (line) => (JSON.parse(line) as { level: number }).level >= 40 && line.includes(bad),
    )
    expect(logged).toHaveLength(1)
  })

  // Kills: overlapping ticks (the interval firing during a slow tick) filing each order twice at once.
  it('AC-6: a tick asked for during a tick waits for it and starts no second pass', async () => {
    const env = await open()
    const sweeper = await started(env)
    const rows = [
      seed(env, { dueAgo: 30 * MINUTE, touchedAgo: 30 * MINUTE }),
      seed(env, { dueAgo: 30 * MINUTE, touchedAgo: 20 * MINUTE }),
    ]
    // Left owed, so a second pass would ask for both again.
    for (const id of rows) env.outcome.set(id, 'due')
    let release!: () => void
    env.hold = new Promise<void>((resolve) => (release = resolve))
    const order: string[] = []

    const first = sweeper.tick().then(() => order.push('first'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const second = sweeper.tick().then(() => order.push('second'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const beforeRelease = order.length
    order.push('released')
    release()
    await Promise.all([first, second])

    expect(beforeRelease).toBe(0)
    expect(order.indexOf('second')).toBeGreaterThan(order.indexOf('released'))
    expect(env.asked).toEqual(rows)
  })
})
