import { AsyncLocalStorage } from 'node:async_hooks'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CART_UPDATED, type EventBusAdapter, type NymbalEvent } from '@nymbalhq/types'
import { currentActor, runAsActor } from '../audit/actor.js'
import { audit, openCommand, runInCommand } from '../audit/audit.js'
import {
  createCommandStore,
  openTransaction,
  rawClients,
  sqliteTurn,
  type CommandStore,
} from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createLogger } from '../logger.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import type { EventLogRepository } from '../repositories/event-log.js'
import { buildRepositories, type Repositories } from '../repositories/index.js'
import { TEST_BUILDER_CONTEXT } from '../tests/publisher.js'
import { createHold, settlesWithin, type Hold } from '../tests/settles-within.js'
import { currentCorrelationId, runWithCorrelation } from './correlation.js'
import { createEventPublisher, type EventPublisher } from './publisher.js'
import { createRelay, deliveringBus, type CreateRelayOptions, type Relay } from './relay.js'

// A committing transaction against the relay, on the in-process bus and a SQLite `:memory:` store: it answers once its
// own events have reached the derived subscriptions, and never waits on a subscription that is not derived (a mail),
// its own or one a pass in flight is delivering for another transaction. That pass still hands every event to every
// subscription once, in seq order, with the relay's failure bookkeeping. The subscriptions are made through
// `deliveringBus`, as the app makes them; the events row is read on the store's own connection.

/** A transaction that waits on a held handler would wait for ever; this is how long the tests give it to answer. */
const ANSWER_BOUND_MS = 2_000

let store: CommandStore
let repos: Repositories
let eventLog: EventLogRepository
const logger = createLogger({ pretty: false, level: 'silent' })

beforeAll(async () => {
  store = createCommandStore(
    // @ts-expect-error a minimal config: only the command store kind is read
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'commits', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  eventLog = repos.eventLog
})

afterAll(async () => {
  await store?.close()
})

// ─── The world one scenario runs in ─────────────────────────────────────────────────────────────────────────────

interface World {
  /** What subscribers subscribe to, as the app hands it to handlers. */
  bus: EventBusAdapter
  relay: Relay
  publisher: EventPublisher
}

/**
 * Set while the bus is publishing (a relay pass hands an event to every subscription that way); a derived handler
 * that runs outside it was run by the commit's own step. A pass runs its handlers concurrently, so the derived one
 * may be handed an event by the pass the commit started before the test looks: only an inline run proves the answer
 * waited for it.
 */
const publishing = new AsyncLocalStorage<true>()
const inPass = (): boolean => publishing.getStore() === true

function world(
  opts: Partial<Pick<CreateRelayOptions, 'maxAttempts' | 'retryDelayMs' | 'now'>> = {},
): World {
  const underneath = new InProcessEventBus({ logger })
  // The one bus the app hands both the relay and the publisher, with its publishes marked.
  const bus: EventBusAdapter = {
    capabilities: () => underneath.capabilities(),
    publish: (event) => publishing.run(true, () => underneath.publish(event)),
    publishBatch: (events) => publishing.run(true, () => underneath.publishBatch(events)),
    replay: (events) => underneath.replay(events),
    subscribe: (pattern, handler, config) => underneath.subscribe(pattern, handler, config),
    unsubscribe: (subscription) => underneath.unsubscribe(subscription),
    close: () => underneath.close(),
  }
  const relay = createRelay({ store, eventLog, eventBus: bus, logger, ...opts })
  const publisher = createEventPublisher({
    eventBus: bus,
    builderContext: TEST_BUILDER_CONTEXT,
    store,
    eventLog,
    relay,
  })
  return { bus: deliveringBus(bus, relay), relay, publisher }
}

let carts = 0
const payload = (tag: string) => ({ cartId: `${tag}-${(carts += 1)}`, itemCount: 1, totalMinor: 0 })

/** A subscription's record: the ids it was handed, in order, each time it was handed one, and which of those were inline. */
interface Recorder {
  ids: string[]
  inline: string[]
  of(id: string): number
  inlineOf(id: string): number
  add(id: string): void
}

function recorder(): Recorder {
  const ids: string[] = []
  const inline: string[] = []
  const count = (list: string[], id: string) => list.filter((x) => x === id).length
  return {
    ids,
    inline,
    of: (id) => count(ids, id),
    inlineOf: (id) => count(inline, id),
    add(id) {
      ids.push(id)
      if (!inPass()) inline.push(id)
    },
  }
}

/** A derived subscription (a projection) that records what it is handed. */
async function projection(w: World, name: string): Promise<Recorder> {
  const seen = recorder()
  await w.bus.subscribe(EVT_CART_UPDATED, async (e) => seen.add(e.id), {
    name,
    derived: true,
  })
  return seen
}

/** A named subscription that is not derived (a mail): every delivery stops at `hold` while it is held, then runs `then`. */
interface Effect {
  hold: Hold
  /** Ids handed to it, as each delivery reached it. */
  entered: Recorder
  /** Ids whose delivery ran to the end without throwing. */
  done: Recorder
}

async function effect(
  w: World,
  name: string,
  then: (e: NymbalEvent<unknown>) => Promise<void> = async () => {},
): Promise<Effect> {
  const hold = createHold()
  const entered = recorder()
  const done = recorder()
  await w.bus.subscribe(
    EVT_CART_UPDATED,
    async (e) => {
      entered.add(e.id)
      await hold.pass()
      await then(e)
      done.add(e.id)
    },
    { name },
  )
  return { hold, entered, done }
}

/** Lets every held delivery go and waits for the relay to finish with them, so no pass outlives its scenario. */
async function settle(w: World, ...effects: Effect[]): Promise<void> {
  for (const e of effects) e.hold.release()
  await w.relay.drain()
}

// ─── The log as the store holds it ──────────────────────────────────────────────────────────────────────────────

function sqlite() {
  const clients = rawClients(store)
  if (clients.kind !== 'sqlite') throw new Error('expected a SQLite store')
  return clients.raw
}

interface Row {
  id: string
  seq: number
  attempts: number
  retryAt: number | null
  delivered: boolean
  dead: boolean
}

async function rowsOf(ids: string[]): Promise<Row[]> {
  if (ids.length === 0) return []
  const rows = await sqliteTurn(
    sqlite(),
    () =>
      sqlite()
        .prepare(
          `SELECT id, seq, attempts, retry_at, delivered_at, dead_at FROM events WHERE id IN (${ids
            .map(() => '?')
            .join(', ')}) ORDER BY seq`,
        )
        .all(...ids) as Array<{
        id: string
        seq: number
        attempts: number
        retry_at: string | null
        delivered_at: string | null
        dead_at: string | null
      }>,
  )
  return rows.map((r) => ({
    id: r.id,
    seq: Number(r.seq),
    attempts: Number(r.attempts),
    retryAt: r.retry_at === null ? null : Date.parse(r.retry_at),
    delivered: r.delivered_at !== null,
    dead: r.dead_at !== null,
  }))
}

async function rowOf(id: string): Promise<Row | undefined> {
  return (await rowsOf([id]))[0]
}

/** Takes every open row out of the log, so a pass sees only what the scenario appends next. */
async function settleEarlierRows(): Promise<void> {
  await sqliteTurn(sqlite(), () =>
    sqlite()
      .prepare('UPDATE events SET delivered_at = ? WHERE delivered_at IS NULL AND dead_at IS NULL')
      .run(new Date().toISOString()),
  )
}

// ─── The criteria ───────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-1: a commit answers once its derived subscriptions have the event, not its mail', () => {
  // Defect: the commit still awaits the relay pass; or skips the inline step, so the projection is stale at the
  // answer; or the pass after it hands the mail the event twice.
  it('AC-1: a transaction resolves while a named non-derived handler of its event is held, with the derived subscriber already handed the event and the row undelivered; after release and a drain the held handler has run exactly once and the row is delivered', async () => {
    await settleEarlierRows()
    const w = world()
    const derived = await projection(w, 'ac1-projection')
    const mail = await effect(w, 'ac1-mail')
    mail.hold.hold()
    try {
      const committing = store.transaction(() =>
        w.publisher.publish(EVT_CART_UPDATED, payload('ac1')),
      )

      expect(
        await settlesWithin(committing, ANSWER_BOUND_MS),
        'transaction() while the mail handler is held',
      ).toBe('resolved')
      const event = await committing
      expect(
        derived.inlineOf(event.id),
        'the derived subscriber, handed it before the answer',
      ).toBe(1)
      expect(mail.done.of(event.id), 'the mail handler at the answer').toBe(0)
      expect((await rowOf(event.id))?.delivered, 'delivered_at at the answer').toBe(false)

      mail.hold.release()
      await w.relay.drain()

      expect(mail.done.of(event.id), 'the mail handler after the drain').toBe(1)
      expect(mail.entered.of(event.id), 'deliveries the mail handler was handed').toBe(
        mail.done.of(event.id),
      )
      expect((await rowOf(event.id))?.delivered, 'delivered_at after the drain').toBe(true)
    } finally {
      await settle(w, mail)
    }
  })
})

describe('AC-2: a commit does not join the pass in flight', () => {
  // Defect: the commit's drain becomes the follow-up of a pass held on another transaction's mail, so a request waits
  // on another request's send.
  it('AC-2: while a pass is held on the mail handler of event A, a second transaction publishing B resolves with B projected; after release the mail handler is handed A then B, once each', async () => {
    await settleEarlierRows()
    const w = world()
    const derived = await projection(w, 'ac2-projection')
    const mail = await effect(w, 'ac2-mail')
    mail.hold.hold()
    try {
      const first = store.transaction(() => w.publisher.publish(EVT_CART_UPDATED, payload('ac2-a')))
      expect(
        await settlesWithin(mail.hold.waiting(1), ANSWER_BOUND_MS),
        'a pass held on the mail of A',
      ).toBe('resolved')

      const second = store.transaction(() =>
        w.publisher.publish(EVT_CART_UPDATED, payload('ac2-b')),
      )

      expect(
        await settlesWithin(second, ANSWER_BOUND_MS),
        'the second transaction while the pass is held on A',
      ).toBe('resolved')
      const b = await second
      expect(derived.inlineOf(b.id), 'B projected before its answer').toBe(1)
      expect(mail.hold.stopped, 'mail deliveries still held at the second answer').toBe(1)

      mail.hold.release()
      const a = await first
      await w.relay.drain()

      expect(mail.done.ids.filter((id) => id === a.id || id === b.id)).toEqual([a.id, b.id])
      const rows = await rowsOf([a.id, b.id])
      expect(rows.map((r) => r.id)).toEqual([a.id, b.id])
      expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq)
    } finally {
      await settle(w, mail)
    }
  })
})

describe('AC-3: answers never wait on effects, and effects lose, repeat or reorder nothing', () => {
  // Defect: a commit waits on effects; an event is projected after its answer; the pass skips, repeats or reorders an
  // event for an effect handler (a mail twice, or a shipped mail before its paid mail).
  const arbTransactions = fc.array(
    fc.record({ events: fc.integer({ min: 1, max: 3 }), held: fc.boolean() }),
    { minLength: 1, maxLength: 8 },
  )

  it('AC-3: property: over 1 to 8 transactions of 1 to 3 events each, with the mail handler held across a generated subset of them, every transaction resolves with every event it published projected; after release and a drain the mail handler was handed every event exactly once, in seq order, and every row is delivered (50 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(arbTransactions, async (transactions) => {
        await settleEarlierRows()
        const w = world()
        const derived = await projection(w, 'ac3-projection')
        const mail = await effect(w, 'ac3-mail')
        const published: string[] = []
        try {
          for (const [i, t] of transactions.entries()) {
            if (t.held) mail.hold.hold()
            else mail.hold.release()
            const committing = store.transaction(async () => {
              const ids: string[] = []
              for (let n = 0; n < t.events; n += 1) {
                ids.push((await w.publisher.publish(EVT_CART_UPDATED, payload('ac3'))).id)
              }
              return ids
            })
            const label = `transaction ${i + 1} of ${transactions.length}, mail ${t.held ? 'held' : 'released'}`

            expect(await settlesWithin(committing, ANSWER_BOUND_MS), label).toBe('resolved')
            const ids = await committing
            expect(
              ids.filter((id) => derived.inlineOf(id) === 0),
              `${label}: its events not projected at its answer`,
            ).toEqual([])
            published.push(...ids)
          }

          mail.hold.release()
          await w.relay.drain()

          const rows = await rowsOf(published)
          const mine = new Set(published)
          expect(
            mail.done.ids.filter((id) => mine.has(id)),
            'the mail handler, against the log in seq order',
          ).toEqual(rows.map((r) => r.id))
          expect(
            rows.filter((r) => !r.delivered).map((r) => r.seq),
            'undelivered rows',
          ).toEqual([])
          expect(rows).toHaveLength(published.length)
        } finally {
          await settle(w, mail)
        }
      }),
      // A run that waits costs the whole bound; one counterexample is enough.
      { numRuns: 50, endOnFailure: true },
    )
  }, 120_000)
})

describe('AC-4: failures keep the relay’s rules', () => {
  const START = Date.parse('2026-05-01T09:00:00.000Z')
  const DELAY = 60_000
  const MAX_ATTEMPTS = 3

  // Defect: a derived handler's inline failure rejects an answer whose writes committed; or it is counted twice.
  it('AC-4: a derived handler that throws inline leaves the transaction resolved, not rejected, while the mail is held; the pass then counts the delivery as one failure', async () => {
    await settleEarlierRows()
    const clock = { at: START }
    const w = world({
      maxAttempts: MAX_ATTEMPTS,
      retryDelayMs: DELAY,
      now: () => new Date(clock.at),
    })
    const thrown = recorder()
    await w.bus.subscribe(
      EVT_CART_UPDATED,
      async (e) => {
        thrown.add(e.id)
        throw new Error(`the projection refuses ${e.id}`)
      },
      { name: 'ac4-failing-projection', derived: true },
    )
    const mail = await effect(w, 'ac4-mail')
    mail.hold.hold()
    try {
      const committing = store.transaction(() =>
        w.publisher.publish(EVT_CART_UPDATED, payload('ac4-inline')),
      )

      expect(
        await settlesWithin(committing, ANSWER_BOUND_MS),
        'transaction() with a failing derived handler and the mail held',
      ).toBe('resolved')
      const event = await committing
      expect(
        thrown.inlineOf(event.id),
        'the derived handler ran (and threw) before the answer',
      ).toBe(1)

      mail.hold.release()
      await w.relay.drain()

      const row = (await rowOf(event.id))!
      expect([row.attempts, row.delivered, row.dead]).toEqual([1, false, false])
      expect(row.retryAt! - clock.at, 'the wait before the retry').toBe(DELAY)
    } finally {
      await settle(w, mail)
    }
  })

  // Defect: a failure after the answer is dropped (the event marked delivered, or never counted) because effects left
  // the relay's bookkeeping; or a dead event is not taken back by a retry.
  it('AC-4: a named non-derived handler that is held and then throws: the transaction resolves untouched; the pass records attempts 1 and retry_at = failure time + retryDelayMs; the event is dead after maxAttempts failures; retryDead then a drain hands it over once', async () => {
    await settleEarlierRows()
    const clock = { at: START }
    const w = world({
      maxAttempts: MAX_ATTEMPTS,
      retryDelayMs: DELAY,
      now: () => new Date(clock.at),
    })
    let refusing = true
    const mail = await effect(w, 'ac4-refusing-mail', async (e) => {
      if (refusing) throw new Error(`the mail host refuses ${e.id}`)
    })
    mail.hold.hold()
    try {
      const sent = payload('ac4-pass')
      const committing = store.transaction(() => w.publisher.publish(EVT_CART_UPDATED, sent))

      expect(
        await settlesWithin(committing, ANSWER_BOUND_MS),
        'transaction() while the failing mail handler is held',
      ).toBe('resolved')
      const event = await committing
      expect(event.payload).toEqual(sent)

      mail.hold.release()
      await w.relay.drain()

      const first = (await rowOf(event.id))!
      expect([first.attempts, first.delivered, first.dead]).toEqual([1, false, false])
      expect(first.retryAt! - clock.at, 'retry_at minus the failure time').toBe(DELAY)

      for (let failure = 2; failure <= MAX_ATTEMPTS; failure += 1) {
        clock.at = (await rowOf(event.id))!.retryAt!
        await w.relay.drain()
      }
      const dead = (await rowOf(event.id))!
      expect([dead.attempts, dead.delivered, dead.dead]).toEqual([MAX_ATTEMPTS, false, true])
      expect(mail.entered.of(event.id), 'deliveries the mail handler was handed').toBe(MAX_ATTEMPTS)

      refusing = false
      await store.transaction((tx) =>
        eventLog.retryDead(tx, { id: event.id }, { floor: new Date(0), limit: 10 }),
      )
      await w.relay.drain()
      await w.relay.drain()

      expect(mail.done.of(event.id), 'the mail after the retry').toBe(1)
      expect(mail.entered.of(event.id), 'deliveries after the retry').toBe(MAX_ATTEMPTS + 1)
      const after = (await rowOf(event.id))!
      expect([after.delivered, after.dead]).toEqual([true, false])
    } finally {
      await settle(w, mail)
    }
  })
})

describe('AC-5: the inline step runs outside the transaction and the caller’s scopes', () => {
  // Defect: the inline step joins or waits on the transaction that published, or runs in the caller's correlation,
  // actor or command, so a handler's writes are noted as the shopper's command.
  it('AC-5: inside the inline derived step openTransaction() and currentCorrelationId() are undefined; a derived handler that writes through store.transaction() commits its write, and the write is no audit entry of the caller’s command', async () => {
    await settleEarlierRows()
    const w = world()
    const HANDLER = 'ac5-projection'
    /** What the derived handler saw on each run the commit made itself (a pass's runs are left out). */
    const inline: Array<{
      tx: object | undefined
      correlation: string | undefined
      actor: unknown
    }> = []
    await w.bus.subscribe(
      EVT_CART_UPDATED,
      async (e) => {
        if (!inPass()) {
          inline.push({
            tx: openTransaction(),
            correlation: currentCorrelationId(),
            actor: currentActor(),
          })
        }
        await store.transaction(async (tx) => {
          audit.note('probe.project', [{ type: 'probe', id: e.id }])
          await repos.processedEvent.markProcessed(tx, HANDLER, e.id, new Date())
        })
      },
      { name: HANDLER, derived: true },
    )
    const mail = await effect(w, 'ac5-mail')
    mail.hold.hold()
    const shopper = { kind: 'customer', id: 'ac5-shopper' } as const
    const command = openCommand('cart.update', { owned: true, actor: shopper })
    try {
      const committing = runWithCorrelation('ac5-request', () =>
        runAsActor(shopper, () =>
          runInCommand(command, () =>
            store.transaction(async () => {
              audit.note('cart.update', [{ type: 'cart', id: 'ac5-cart' }])
              return w.publisher.publish(EVT_CART_UPDATED, payload('ac5'))
            }),
          ),
        ),
      )

      expect(
        await settlesWithin(committing, ANSWER_BOUND_MS),
        'transaction() while the mail handler is held',
      ).toBe('resolved')
      const event = await committing
      expect(inline, 'the inline run of the derived handler, before the answer').toEqual([
        { tx: undefined, correlation: undefined, actor: undefined },
      ])
      expect(
        await store.read((tx) => repos.processedEvent.seen(tx, HANDLER, event.id)),
        'the handler’s own write, committed',
      ).toBe(true)
      expect([...command.subjects.keys()], 'subjects of the caller’s command').toEqual([
        'cart:ac5-cart',
      ])
      const entries = await store.read((tx) => listAuditEntries(tx, { order: 'asc', limit: 100 }))
      expect(
        entries.filter((a) => a.subjects.some((s) => s.type === 'probe')),
        'audit entries naming the handler’s write',
      ).toEqual([])
    } finally {
      await settle(w, mail)
    }
  })
})

describe('AC-10: rolled back, never projected', () => {
  // Defect: the inline step replays a per-transaction list that a savepoint's rollback does not cut, so a derived
  // handler (report rollups) applies money for an event with no row, which no recompute agrees with.
  it('AC-10: E1, then E2 in a savepoint that throws and is caught, then E3: the derived subscriber is handed E1 and E3 inline, in publish order, never E2; after a drain no subscriber has E2 and no events row holds it', async () => {
    await settleEarlierRows()
    const w = world()
    const derived = await projection(w, 'ac10-projection')
    const mail = await effect(w, 'ac10-mail')
    mail.hold.hold()
    try {
      let e2: string | undefined
      const committing = store.transaction(async () => {
        const e1 = await w.publisher.publish(EVT_CART_UPDATED, payload('ac10-e1'))
        try {
          await store.savepoint(async () => {
            e2 = (await w.publisher.publish(EVT_CART_UPDATED, payload('ac10-e2'))).id
            throw new Error('the step rolls back alone')
          })
        } catch {
          // the enclosing transaction carries on
        }
        const e3 = await w.publisher.publish(EVT_CART_UPDATED, payload('ac10-e3'))
        return [e1.id, e3.id] as const
      })

      expect(
        await settlesWithin(committing, ANSWER_BOUND_MS),
        'transaction() while the mail handler is held',
      ).toBe('resolved')
      const [e1, e3] = await committing
      expect(e2, 'the rolled-back publish happened').toMatch(/^[0-9a-f-]{36}$/)
      expect(
        derived.inline.filter((id) => [e1, e2, e3].includes(id)),
        'handed to the derived subscriber before the answer',
      ).toEqual([e1, e3])

      mail.hold.release()
      await w.relay.drain()

      expect([derived.of(e2!), mail.entered.of(e2!)], 'deliveries of E2: derived, mail').toEqual([
        0, 0,
      ])
      expect((await rowsOf([e1, e2!, e3])).map((r) => r.id)).toEqual([e1, e3])
    } finally {
      await settle(w, mail)
    }
  })

  // Defect: a transaction that rolls back still projects what it published.
  it('AC-10: a transaction that publishes and then throws rejects with its error, and no derived subscriber is handed its event, inline or after a drain', async () => {
    await settleEarlierRows()
    const w = world()
    const derived = await projection(w, 'ac10-rollback-projection')
    const boom = new Error('abort after publish')
    let published: string | undefined

    await expect(
      store.transaction(async () => {
        published = (await w.publisher.publish(EVT_CART_UPDATED, payload('ac10-rollback'))).id
        throw boom
      }),
    ).rejects.toBe(boom)
    const atAnswer = derived.of(published!)
    await w.relay.drain()

    expect(
      [atAnswer, derived.of(published!)],
      'derived deliveries: at the answer, after a drain',
    ).toEqual([0, 0])
    expect(await rowsOf([published!])).toEqual([])
  })
})
