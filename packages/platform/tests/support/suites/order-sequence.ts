import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { checkoutOf, seedVariant, type Kernel } from '../kernel.js'
import { openRaw, type RawReader } from '../raw.js'

// The order-number counter on one dialect, through the repository inside the command store's own transactions: a
// fresh store's first allocations, however many start at once, and an existing store's next ones. Each test opens the
// stores it needs from `start`, a kernel on a database of its own; the counter row is read through a second
// connection. On SQLite whole transactions are serialised, so the race cannot happen there: the same assertions are
// the dialect invariant the Postgres run must meet.

const DEFAULT_START = 1000
const WAITER_DEADLINE_MS = 5000

interface Opened {
  k: Kernel
  raw: RawReader
}

type Outcome = { ok: number } | { error: string }

/** What an allocation came to: its value, or the error code and message a failure carries (or its cause carries). */
async function outcomeOf(allocation: Promise<number>): Promise<Outcome> {
  try {
    return { ok: await allocation }
  } catch (error) {
    const seen: string[] = []
    for (
      let e: unknown = error;
      e !== undefined && e !== null;
      e = (e as { cause?: unknown }).cause
    ) {
      const { code, message } = e as { code?: unknown; message?: unknown }
      seen.push([code, message].filter((part) => part !== undefined).join(' '))
    }
    return { error: seen.join(' <- ') }
  }
}

export function orderSequenceSuite(dialect: Kernel['dialect'], start: () => Promise<Kernel>): void {
  describe(`order numbers from the counter row (${dialect})`, () => {
    const open = new Set<Opened>()

    async function fresh(): Promise<Opened> {
      const k = await start()
      const opened = { k, raw: openRaw(k.dialect, k.target) }
      open.add(opened)
      return opened
    }

    async function shut(opened: Opened): Promise<void> {
      open.delete(opened)
      await opened.raw.close()
      await opened.k.close()
    }

    afterEach(async () => {
      for (const opened of [...open]) await shut(opened)
    })

    /** One allocation in a transaction of its own. */
    function allocate(k: Kernel, startFrom: number): Promise<number> {
      return k.store.transaction((tx) => k.repos.orderSequence.nextSequence(tx, startFrom))
    }

    /**
     * Has the store hold `n` connections at once and hand them back idle, as a running store's pool is, so `n`
     * allocations begin together instead of each waiting on a new connection while the first commits.
     */
    async function warmed(k: Kernel, n: number): Promise<void> {
      await Promise.all(
        Array.from({ length: n }, () =>
          k.store.read(() => new Promise<void>((resolve) => setTimeout(resolve, 20))),
        ),
      )
    }

    /** The counter row's next_value as committed, or null when the store has no row yet. */
    async function counter(raw: RawReader): Promise<number | null> {
      const [row] = await raw.rows<{ next_value: number | string }>(
        'SELECT next_value FROM order_sequences WHERE id = 1',
      )
      return row === undefined ? null : Number(row.next_value)
    }

    /** Postgres backends of this database waiting on a lock. */
    async function lockWaiters(raw: RawReader): Promise<number> {
      const [row] = await raw.rows<{ n: number | string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
      )
      return Number(row?.n ?? 0)
    }

    /**
     * Resolves once a second allocation is queued behind the held one: on Postgres when a backend waits on a lock (or
     * the deadline passes, and the outcomes decide), on SQLite after a macrotask, by which time it waits its turn.
     */
    async function secondIsWaiting(raw: RawReader): Promise<void> {
      if (dialect === 'sqlite') {
        await new Promise((resolve) => setTimeout(resolve, 0))
        return
      }
      const deadline = Date.now() + WAITER_DEADLINE_MS
      while ((await lockWaiters(raw)) < 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    it(`AC-1: on a fresh store, an allocation started while the first is held open in its transaction waits for it, then the two commit startFrom and startFrom + 1 and next_value is startFrom + 2 (${dialect})`, async () => {
      const { k, raw } = await fresh()
      const startFrom = DEFAULT_START
      expect(await counter(raw), 'a fresh store has no counter row').toBeNull()

      let allocated!: (value: number) => void
      const firstAllocated = new Promise<number>((resolve) => {
        allocated = resolve
      })
      let release!: () => void
      const released = new Promise<void>((resolve) => {
        release = resolve
      })
      const first = k.store.transaction(async (tx) => {
        const value = await k.repos.orderSequence.nextSequence(tx, startFrom)
        allocated(value)
        await released
        return value
      })
      // Held: the first has allocated and not committed. A failure before that fails the test here.
      await Promise.race([firstAllocated, first])

      // Started from the test, not from inside the first's callback, so it opens a transaction of its own.
      const second = allocate(k, startFrom)
      await secondIsWaiting(raw)
      release()

      const outcomes = await Promise.all([outcomeOf(first), outcomeOf(second)])
      expect(outcomes).toEqual([{ ok: startFrom }, { ok: startFrom + 1 }])
      expect(await counter(raw)).toBe(startFrom + outcomes.length)
    })

    it(`AC-2: for N from 2 to 24 concurrent first allocations on a fresh store, the answers are N distinct values from startFrom to startFrom + N - 1 and next_value is startFrom + N (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 24 }),
          fc.integer({ min: 1, max: 1_000_000 }),
          async (n, startFrom) => {
            const opened = await fresh()
            try {
              await warmed(opened.k, n)
              const outcomes = await Promise.all(
                Array.from({ length: n }, () => outcomeOf(allocate(opened.k, startFrom))),
              )
              const failed = outcomes.filter((o): o is { error: string } => 'error' in o)
              expect(failed, `${n} concurrent first allocations from ${startFrom}`).toEqual([])
              const values = outcomes.map((o) => (o as { ok: number }).ok)
              const low = Math.min(...values)
              const high = Math.max(...values)
              expect(new Set(values).size).toBe(n)
              expect(low).toBe(startFrom)
              expect(high - low).toBe(n - 1)
              expect(await counter(opened.raw)).toBe(startFrom + n)
            } finally {
              await shut(opened)
            }
          },
        ),
        { numRuns: 2 },
      )
    })

    it(`AC-4: on a store with an order placed, order numbers continue by one and each allocation answers the stored next_value and stores it plus one, whatever startFrom it is given (${dialect})`, async () => {
      const { k, raw } = await fresh()
      const seeded = await seedVariant(k, 10)
      const numberOf = (orderNumber: string): number => Number(orderNumber.split('-').pop())

      const a = await checkoutOf(k, seeded, 1)
      const beforeB = await counter(raw)
      const b = await checkoutOf(k, seeded, 1)
      expect(numberOf(b.orderNumber), `${a.orderNumber} then ${b.orderNumber}`).toBe(
        numberOf(a.orderNumber) + 1,
      )
      const [rowB] = await raw.rows<{ sequence: number | string }>(
        'SELECT sequence FROM orders WHERE id = ?',
        [b.orderId],
      )
      expect(Number(rowB?.sequence)).toBe(beforeB)
      expect(await counter(raw)).toBe(Number(rowB?.sequence) + 1)

      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 5 }),
          async (starts) => {
            for (const startFrom of starts) {
              const before = await counter(raw)
              const value = await allocate(k, startFrom)
              expect(value, `allocation given startFrom ${startFrom}`).toBe(before)
              expect(await counter(raw)).toBe(value + 1)
            }
          },
        ),
        { numRuns: 5 },
      )
    })
  })
}
