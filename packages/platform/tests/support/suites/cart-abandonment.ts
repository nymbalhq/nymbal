import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CART_ABANDONED, NotFoundError, type Cart } from '@nymbalhq/types'
import { address, seedVariant, type Dialect, type Seeded } from '../kernel.js'
import { eventRows } from '../outbox.js'
import { openRaw, type RawReader } from '../raw.js'
import {
  clockAt,
  lineFor,
  migrateTarget,
  openReplica,
  type Clock,
  type Replica,
} from '../replica.js'

// P1-04 AC-5 to AC-9 on one dialect: the abandonment sweeper notifies each cart once per period of inactivity, across
// restarts and replicas, reaches every eligible cart whatever the batch size, and deletes expired carts before it
// looks for abandoned ones. Replicas are command stores on one database (tests/support/replica.ts); time is the
// replica's clock, so a cart's last write and the sweeper's `now` are what the test says they are.

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const INACTIVITY_MS = HOUR_MS
/** Past the inactivity window, with room on either side of its edge. */
const PAST_INACTIVITY_MS = INACTIVITY_MS + MINUTE_MS

interface Notice {
  cartId: string
  lastActivityAt: string
}

export function cartAbandonmentSuite(
  dialect: Dialect,
  /** A fresh, empty database for this suite: its target and how to drop it afterwards. */
  fresh: () => Promise<{ target: string; drop(): Promise<void> }>,
): void {
  describe(`cart abandonment (${dialect})`, () => {
    let db: { target: string; drop(): Promise<void> }
    let raw: RawReader
    const open: Replica[] = []

    beforeAll(async () => {
      db = await fresh()
      await migrateTarget(dialect, db.target)
      raw = openRaw(dialect, db.target)
    }, 60_000)

    afterEach(async () => {
      for (const replica of open.splice(0)) await replica.close()
    })

    afterAll(async () => {
      await raw?.close()
      await db?.drop()
    })

    async function replica(clock: Clock, ttlSeconds?: number): Promise<Replica> {
      const r = await openReplica(dialect, db.target, {
        clock,
        ...(ttlSeconds !== undefined && { ttlSeconds }),
      })
      open.push(r)
      return r
    }

    async function cartWithItems(r: Replica, seeded: Seeded, qty = 1): Promise<Cart> {
      const cart = await r.services.cart.getOrCreate()
      return r.services.cart.addItem(cart.token, lineFor(seeded, qty))
    }

    /** The cart.abandoned.v1 payloads in the log for these tokens, in seq order. */
    async function noticesFor(tokens: string[]): Promise<Map<string, Notice[]>> {
      const rows = await eventRows(raw, 'type = ?', [EVT_CART_ABANDONED])
      const byToken = new Map<string, Notice[]>(tokens.map((t) => [t, []]))
      for (const row of rows) {
        const payload = row.envelope.payload as Notice
        byToken.get(payload.cartId)?.push(payload)
      }
      return byToken
    }

    async function countsFor(tokens: string[]): Promise<Record<string, number>> {
      const notices = await noticesFor(tokens)
      return Object.fromEntries(tokens.map((t) => [t, notices.get(t)!.length]))
    }

    function at(iso: string): number {
      return new Date(iso).getTime()
    }

    it('AC-5: one notice across a restart: sweeper A ticks and stops, a new sweeper on the same database ticks later, and the log holds exactly one cart.abandoned.v1 for the cart, with cartId = token and lastActivityAt = its last write', async () => {
      const clock = clockAt()
      const a = await replica(clock)
      const seeded = await seedVariant(a, 5)
      const cart = await cartWithItems(a, seeded)

      clock.advance(PAST_INACTIVITY_MS)
      const sweepA = a.startSweeper({ inactivityMs: INACTIVITY_MS })
      await sweepA.tick()
      sweepA.stop()

      clock.advance(HOUR_MS)
      const b = await replica(clock)
      const sweepB = b.startSweeper({ inactivityMs: INACTIVITY_MS })
      await sweepB.tick()
      sweepB.stop()

      const notices = (await noticesFor([cart.token])).get(cart.token)!
      expect(notices.map((n) => n.cartId)).toEqual([cart.token])
      expect(at(notices[0]!.lastActivityAt)).toBe(at(cart.updatedAt))
    })

    it('AC-6: one notice across replicas: N eligible carts and two sweepers on two command stores ticking concurrently leave exactly N cart.abandoned.v1 rows, one per token', async () => {
      const clock = clockAt()
      const a = await replica(clock)
      const b = await replica(clock)
      const seeded = await seedVariant(a, 50)
      const n = 6
      const tokens: string[] = []
      for (let i = 0; i < n; i += 1) tokens.push((await cartWithItems(a, seeded)).token)

      clock.advance(PAST_INACTIVITY_MS)
      const sweepA = a.startSweeper({ inactivityMs: INACTIVITY_MS })
      const sweepB = b.startSweeper({ inactivityMs: INACTIVITY_MS })
      await Promise.all([sweepA.tick(), sweepB.tick()])

      const notices = await noticesFor(tokens)
      const all = tokens.flatMap((t) => notices.get(t)!.map((notice) => notice.cartId))
      expect(all.length).toBe(n)
      expect(all.slice().sort()).toEqual(tokens.slice().sort())
    })

    it('AC-7: who is notified: items-and-idle and converted-then-refilled-then-idle get a notice; empty-and-idle and items-and-recent do not; a write to a notified cart re-arms it for one more notice at the next idle period, and only it', async () => {
      const clock = clockAt()
      const r = await replica(clock)
      const seeded = await seedVariant(r, 50, { priceMinor: 900 })

      const empty = await r.services.cart.getOrCreate()
      const idle = await cartWithItems(r, seeded)
      const converted = await cartWithItems(r, seeded)
      const started = await r.services.checkout.beginCheckout({
        cartToken: converted.token,
        email: `convert-${randomUUID()}@p1-04.test`,
        billingAddress: address,
        shippingAddress: address,
      })
      await r.services.checkout.finalize(started.paymentIntent.id, {
        amountMinor: started.totalMinor,
        currency: started.currency,
      })
      expect((await r.services.cart.get(converted.token))?.items, 'conversion empties').toEqual([])
      await r.services.cart.addItem(converted.token, lineFor(seeded, 1))

      clock.advance(PAST_INACTIVITY_MS)
      const recent = await cartWithItems(r, seeded)
      const tokens = [empty.token, idle.token, converted.token, recent.token]

      const sweep = r.startSweeper({ inactivityMs: INACTIVITY_MS })
      await sweep.tick()
      expect(await countsFor(tokens)).toEqual({
        [empty.token]: 0,
        [idle.token]: 1,
        [converted.token]: 1,
        [recent.token]: 0,
      })
      const first = (await noticesFor([idle.token])).get(idle.token)![0]!
      expect(at(first.lastActivityAt)).toBe(at(idle.updatedAt))

      // A write after the notice starts a new period; the recent cart is touched again so it stays recent.
      const rewritten = await r.services.cart.addItem(idle.token, lineFor(seeded, 1))
      clock.advance(PAST_INACTIVITY_MS)
      await r.services.cart.addItem(recent.token, lineFor(seeded, 1))
      await sweep.tick()
      expect(await countsFor(tokens)).toEqual({
        [empty.token]: 0,
        [idle.token]: 2,
        [converted.token]: 1,
        [recent.token]: 0,
      })
      const [, second] = (await noticesFor([idle.token])).get(idle.token)!
      expect(at(second!.lastActivityAt)).toBe(at(rewritten.updatedAt))
      expect(at(second!.lastActivityAt)).toBeGreaterThan(at(first.lastActivityAt))
    }, 60_000)

    it('AC-8: no cap: with batchSize b and 2b + 1 eligible carts, one tick notifies every one of them exactly once', async () => {
      const clock = clockAt()
      const r = await replica(clock)
      const seeded = await seedVariant(r, 100)
      const batchSize = 3
      const n = 2 * batchSize + 1
      const tokens: string[] = []
      for (let i = 0; i < n; i += 1) tokens.push((await cartWithItems(r, seeded)).token)

      clock.advance(PAST_INACTIVITY_MS)
      const sweep = r.startSweeper({ inactivityMs: INACTIVITY_MS, batchSize })
      await sweep.tick()

      const counts = await countsFor(tokens)
      expect(Object.keys(counts).length).toBe(n)
      expect(Object.values(counts)).toEqual(tokens.map(() => 1))
    })

    it('AC-9: sliding expiry: expiresAt = write time + ttl and moves with every write; past it the cart reads as missing and addItem throws NotFoundError; a tick deletes expired carts, never notifies them, and leaves an unexpired idle cart readable and notified', async () => {
      const ttlSeconds = 3600
      const inactivityMs = 30 * MINUTE_MS
      const clock = clockAt()
      const r = await replica(clock, ttlSeconds)
      const seeded = await seedVariant(r, 50)

      const t0 = clock.now()
      const created = await r.services.cart.getOrCreate()
      expect(at(created.expiresAt)).toBe(t0.getTime() + ttlSeconds * 1000)

      clock.advance(30 * MINUTE_MS)
      const t1 = clock.now()
      const written = await r.services.cart.addItem(created.token, lineFor(seeded, 1))
      expect(at(written.expiresAt)).toBe(t1.getTime() + ttlSeconds * 1000)
      expect(at(written.expiresAt)).toBeGreaterThan(at(created.expiresAt))

      // Unexpired at t2 (41 min old < ttl) and idle past the window (> 30 min): notified, not deleted.
      clock.set(new Date(t1.getTime() + 20 * MINUTE_MS))
      const live = await cartWithItems(r, seeded, 2)

      // t2: `written` is 61 min past its last write, 1 min past its expiresAt, and idle past the window too.
      clock.set(new Date(t1.getTime() + 61 * MINUTE_MS))
      const rowsBefore = await raw.count('carts')
      expect(await r.services.cart.get(written.token)).toBeNull()
      await expect(
        r.services.cart.addItem(written.token, lineFor(seeded, 1)),
      ).rejects.toBeInstanceOf(NotFoundError)

      const sweep = r.startSweeper({ inactivityMs })
      await sweep.tick()

      expect(await raw.count('carts')).toBe(rowsBefore - 1)
      const liveAfter = await r.services.cart.get(live.token)
      expect(liveAfter?.items.map((i) => [i.variantId, i.qty])).toEqual([[seeded.variantId, 2]])
      expect(await countsFor([written.token, live.token])).toEqual({
        [written.token]: 0,
        [live.token]: 1,
      })
    })
  })
}
