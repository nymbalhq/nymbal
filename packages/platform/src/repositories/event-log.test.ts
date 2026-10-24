import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import type { NymbalEvent } from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { createEventBuilder } from '../events/builder.js'
import { TEST_BUILDER_CONTEXT } from '../tests/publisher.js'
import { buildRepositories } from './index.js'
import type { LoggedEvent } from './event-log.js'

// The event log's reads and retention writes on SQLite (spec P3-01-event-log-surface): each filter is checked against
// the same selection done in memory over `listAll`, and every write against the rows it must leave alone.

const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)
const T0 = new Date('2026-01-01T00:00:00.000Z')
const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000)

async function setup() {
  const store = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(store, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const repos = buildRepositories(store, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const log = repos.eventLog
  return {
    store,
    log,
    /** Appends `events` with the clock at `at`, so their `createdAt` is `at`. */
    async append(events: NymbalEvent<unknown>[], at: Date = T0): Promise<void> {
      vi.setSystemTime(at)
      await store.transaction((tx) => log.append(tx, events))
    },
    all: () => store.read((tx) => log.listAll(tx)),
    seqOf: async (id: string): Promise<number> => {
      const row = (await store.read((tx) => log.listAll(tx))).find((r) => r.event.id === id)
      if (row === undefined) throw new Error(`no row for ${id}`)
      return row.seq
    },
  }
}
type Env = Awaited<ReturnType<typeof setup>>

const ids = (rows: LoggedEvent[]): string[] => rows.map((r) => r.event.id)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('event log: append, listAll, maxSeq', () => {
  it('maxSeq is 0 on an empty log and the last seq after appends that cross a chunk', async () => {
    const env = await setup()
    expect(await env.store.read((tx) => env.log.maxSeq(tx))).toBe(0)

    const events = Array.from({ length: 150 }, (_, i) => makeEvent(`order.n${i}.v1`, { i }))
    await env.append(events, minutes(3))
    const rows = await env.all()

    expect(ids(rows)).toEqual(events.map((e) => e.id))
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.seq).toBeGreaterThan(rows[i - 1]!.seq)
    expect(rows.map((r) => r.event)).toEqual(events)
    for (const row of rows) {
      expect(row.deliveredAt).toBeNull()
      expect(row.deadAt).toBeNull()
      expect(row.attempts).toBe(0)
      expect(row.createdAt).toEqual(minutes(3))
    }
    expect(await env.store.read((tx) => env.log.maxSeq(tx))).toBe(rows.at(-1)!.seq)
  })

  it('an append of exactly one chunk writes each event once', async () => {
    const env = await setup()
    const events = Array.from({ length: 100 }, (_, i) => makeEvent('cart.updated.v1', { i }))
    await env.append(events)
    expect(ids(await env.all())).toEqual(events.map((e) => e.id))
  })
})

describe('event log: delivery state', () => {
  it('markDelivered, recordFailure and listUndelivered agree on which rows are pending', async () => {
    const env = await setup()
    const [delivered, dying, failing, pending] = [1, 2, 3, 4].map((i) =>
      makeEvent('order.created.v1', { i }),
    )
    await env.append([delivered!, dying!, failing!, pending!])

    await env.store.transaction((tx) => env.log.markDelivered(tx, [], minutes(1)))
    expect((await env.all()).every((r) => r.deliveredAt === null)).toBe(true)

    await env.store.transaction(async (tx) => {
      await env.log.markDelivered(tx, [delivered!.id], minutes(1))
      await env.log.recordFailure(tx, dying!.id, minutes(2), 2)
      await env.log.recordFailure(tx, dying!.id, minutes(3), 2)
      await env.log.recordFailure(tx, failing!.id, minutes(4), 3)
    })

    const byId = new Map((await env.all()).map((r) => [r.event.id, r]))
    expect(byId.get(delivered!.id)).toMatchObject({ deliveredAt: minutes(1), deadAt: null, attempts: 0 })
    expect(byId.get(dying!.id)).toMatchObject({ deliveredAt: null, deadAt: minutes(3), attempts: 2 })
    expect(byId.get(failing!.id)).toMatchObject({ deliveredAt: null, deadAt: null, attempts: 1 })
    expect(byId.get(pending!.id)).toMatchObject({ deliveredAt: null, deadAt: null, attempts: 0 })

    const undelivered = (limit: number, after?: number) =>
      env.store.read((tx) => env.log.listUndelivered(tx, limit, after))
    expect(ids(await undelivered(10))).toEqual([failing!.id, pending!.id])
    expect(ids(await undelivered(1))).toEqual([failing!.id])
    expect(ids(await undelivered(10, byId.get(failing!.id)!.seq))).toEqual([pending!.id])
  })
})

describe('event log: retention', () => {
  /** Delivered before the cutoff (two), at it, after it; undelivered; delivered and then dead. */
  async function retentionLog(env: Env) {
    const rows = {
      early: makeEvent('order.created.v1', { n: 'early' }),
      earlier: makeEvent('order.created.v1', { n: 'earlier' }),
      atCutoff: makeEvent('order.created.v1', { n: 'at' }),
      late: makeEvent('order.created.v1', { n: 'late' }),
      undelivered: makeEvent('order.created.v1', { n: 'undelivered' }),
      dead: makeEvent('order.created.v1', { n: 'dead' }),
    }
    await env.append(Object.values(rows))
    await env.store.transaction(async (tx) => {
      await env.log.markDelivered(tx, [rows.early.id], minutes(2))
      await env.log.markDelivered(tx, [rows.earlier.id], minutes(1))
      await env.log.markDelivered(tx, [rows.atCutoff.id], minutes(10))
      await env.log.markDelivered(tx, [rows.late.id], minutes(11))
      await env.log.markDelivered(tx, [rows.dead.id], minutes(1))
      await env.log.recordFailure(tx, rows.dead.id, minutes(1), 1)
    })
    return rows
  }

  it('listDeliveredBefore is the delivered, not dead rows delivered strictly before the cutoff, by seq', async () => {
    const env = await setup()
    const rows = await retentionLog(env)
    const before = (limit: number) =>
      env.store.read((tx) => env.log.listDeliveredBefore(tx, minutes(10), limit))

    expect(ids(await before(10))).toEqual([rows.early.id, rows.earlier.id])
    expect(ids(await before(1))).toEqual([rows.early.id])
  })

  it('deleteDeliveredBefore deletes only rows delivered before the cutoff and counts them', async () => {
    const env = await setup()
    const rows = await retentionLog(env)
    const deleted = await env.store.transaction((tx) => env.log.deleteDeliveredBefore(tx, minutes(10)))
    const left = ids(await env.all())

    expect(left).not.toContain(rows.early.id)
    expect(left).not.toContain(rows.earlier.id)
    expect(left).toEqual(
      expect.arrayContaining([rows.atCutoff.id, rows.late.id, rows.undelivered.id]),
    )
    expect(deleted).toBe(6 - left.length)
  })

  it('deleteSeqs deletes only the named rows that are delivered and not dead, and counts them', async () => {
    const env = await setup()
    const rows = await retentionLog(env)
    const seq = (e: NymbalEvent<unknown>) => env.seqOf(e.id)
    const named = [rows.early, rows.late, rows.undelivered, rows.dead]
    const seqs = await Promise.all(named.map(seq))

    expect(await env.store.transaction((tx) => env.log.deleteSeqs(tx, []))).toBe(0)
    const deleted = await env.store.transaction((tx) => env.log.deleteSeqs(tx, seqs))

    expect(deleted).toBe(2)
    expect(ids(await env.all())).toEqual([
      rows.earlier.id,
      rows.atCutoff.id,
      rows.undelivered.id,
      rows.dead.id,
    ])
  })

  it('deleteSeqs deletes every named row across more than one chunk', async () => {
    const env = await setup()
    const events = Array.from({ length: 620 }, (_, i) => makeEvent('order.created.v1', { i }))
    for (let i = 0; i < events.length; i += 100) await env.append(events.slice(i, i + 100))
    await env.store.transaction((tx) =>
      env.log.markDelivered(
        tx,
        events.map((e) => e.id),
        minutes(1),
      ),
    )
    const all = await env.all()
    const keep = all.at(-1)!
    const seqs = all.slice(0, -1).map((r) => r.seq)

    const deleted = await env.store.transaction((tx) => env.log.deleteSeqs(tx, seqs))

    expect(deleted).toBe(619)
    expect(ids(await env.all())).toEqual([keep.event.id])
  })
})

describe('event log: queryByCorrelation and listAfter', () => {
  async function correlatedLog(env: Env) {
    const c = 'corr-a'
    const created = makeEvent('order.created.v1', {}, { correlationId: c })
    const added = makeEvent('order.item.added.v1', {}, { correlationId: c })
    const cart = makeEvent('cart.updated.v1', {}, { correlationId: c })
    const other = makeEvent('order.created.v1', {}, { correlationId: 'corr-b' })
    await env.append([created], minutes(0))
    await env.append([other], minutes(0))
    await env.append([added], minutes(1))
    await env.append([cart], minutes(2))
    return { c, created, added, cart, other }
  }

  it('returns one correlation id by seq, narrowed by types, since (inclusive), until (exclusive) and limit', async () => {
    const env = await setup()
    const { c, created, added, cart, other } = await correlatedLog(env)
    const query = (filter: Parameters<Env['log']['queryByCorrelation']>[2]) =>
      env.store.read((tx) => env.log.queryByCorrelation(tx, c, filter)).then(ids)

    expect(await query({ limit: 10 })).toEqual([created.id, added.id, cart.id])
    expect(await query({ limit: 10, types: [] })).toEqual([created.id, added.id, cart.id])
    expect(await query({ limit: 2 })).toEqual([created.id, added.id])
    expect(await query({ limit: 10, types: ['order.*'] })).toEqual([created.id, added.id])
    expect(await query({ limit: 10, types: ['cart.updated.v1', 'order.created.v1'] })).toEqual([
      created.id,
      cart.id,
    ])
    expect(await query({ limit: 10, since: minutes(1) })).toEqual([added.id, cart.id])
    expect(await query({ limit: 10, until: minutes(2) })).toEqual([created.id, added.id])
    expect(await query({ limit: 10, since: minutes(1), until: minutes(2) })).toEqual([added.id])
    expect(
      await env.store.read((tx) => env.log.queryByCorrelation(tx, 'corr-b', { limit: 10 })).then(ids),
    ).toEqual([other.id])
  })

  it('a type glob matches GLOB metacharacters other than * literally', async () => {
    const env = await setup()
    const literalQ = makeEvent('a?c', {}, { correlationId: 'g' })
    const literalB = makeEvent('a[b]c', {}, { correlationId: 'g' })
    const plain = makeEvent('abc', {}, { correlationId: 'g' })
    await env.append([literalQ, literalB, plain])
    const query = (types: string[]) =>
      env.store.read((tx) => env.log.queryByCorrelation(tx, 'g', { limit: 10, types })).then(ids)

    expect(await query(['a?c'])).toEqual([literalQ.id])
    expect(await query(['a[b]c'])).toEqual([literalB.id])
    expect(await query(['a*c'])).toEqual([literalQ.id, literalB.id, plain.id])
  })

  it('listAfter is listAll above the seq, of the given types, cut at the limit', async () => {
    const types = ['order.created.v1', 'order.paid.v1', 'cart.updated.v1'] as const
    const globs = [[], ['order.*'], ['cart.updated.v1'], ['order.paid.v1', 'cart.*']] as const
    const env = await setup()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...types), { minLength: 1, maxLength: 12 }),
        fc.nat({ max: 14 }),
        fc.constantFrom(...globs),
        fc.integer({ min: 1, max: 14 }),
        async (appended, offset, glob, limit) => {
          await env.append(appended.map((t) => makeEvent(t, {})))
          const all = await env.all()
          const after = all[0]!.seq - 1 + offset
          const matches = (t: string) =>
            glob.length === 0 ||
            glob.some((g) => (g.endsWith('*') ? t.startsWith(g.slice(0, -1)) : t === g))
          const expected = all.filter((r) => r.seq > after && matches(r.event.type)).slice(0, limit)

          const got = await env.store.read((tx) =>
            env.log.listAfter(tx, after, { types: [...glob], limit }),
          )
          expect(ids(got)).toEqual(ids(expected))
        },
      ),
      { numRuns: 25 },
    )
  })
})
