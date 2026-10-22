import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startCartAbandonmentSweeper,
  startInventoryReservationSweeper,
} from '../../src/sweepers/index.js'
import { auditRows, CORRELATION, rowsOf, subjectIds, type AuditRow } from '../support/audit.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { cartWith, checkoutOf, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { captureFor } from '../support/webhooks.js'

// Acceptance tests for P3-04 AC-3 (spec P3-04-audit-trail, decision 1) on SQLite: work that starts outside HTTP is
// attributed to the system. A cart-abandonment sweep, a reservation-expiry sweep and a payment webhook each leave
// `applied` entries whose actor is `system:cart-abandonment`, `system:reservations` and `system:stripe-webhook` (the
// webhook's scope overriding the route's guest one). The sweepers are built from the kernel's own services and
// repositories as app.ts builds them, with a clock past the inactivity window and a long interval, and ticked once.
// The import half is packages/cli/src/commands/import-audit.test.ts.
// Kills: a sweep or webhook left unaudited, or attributed to nobody or to a guest.

const HOUR_MS = 60 * 60_000

let k: Kernel
let served: ServedKernel
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw('sqlite', k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

const actorOf = (row: AuditRow) => `${row.actorKind}:${row.actorId}`

/** The rows appended since `before` (row ids are unique; entries are never updated). */
async function appendedSince(before: AuditRow[]): Promise<AuditRow[]> {
  const seen = new Set(before.map((r) => r.id))
  return (await auditRows(raw)).filter((r) => !seen.has(r.id))
}

describe('P3-04 AC-3: actors outside HTTP', () => {
  it('AC-3: a cart-abandonment sweep over 2 idle carts leaves applied entries by system:cart-abandonment, and only those', async () => {
    const seeded = await seedVariant(k, 100)
    const tokens = [await cartWith(k, seeded, 1), await cartWith(k, seeded, 1)]
    const sweeper = startCartAbandonmentSweeper({
      store: k.store,
      carts: k.repos.cart,
      publisher: k.publisher,
      logger: k.logger,
      intervalMs: 3_600_000,
      inactivityMs: HOUR_MS,
      now: () => new Date(Date.now() + 2 * HOUR_MS),
    })
    const before = await auditRows(raw)
    try {
      await sweeper.tick()
    } finally {
      sweeper.stop()
    }
    const appended = await appendedSince(before)

    expect(appended.filter((r) => r.outcome === 'applied').length).toBeGreaterThan(0)
    expect(appended.map(actorOf)).toEqual(appended.map(() => 'system:cart-abandonment'))
    expect(
      tokens.filter((token) => JSON.stringify(appended).includes(token)),
      'cart tokens (bearer credentials) stored in the entries',
    ).toEqual([])
  })

  it('AC-3: a reservation-expiry sweep over 2 expired reservations leaves applied entries by system:reservations naming the variant', async () => {
    const seeded = await seedVariant(k, 100)
    await k.services.inventory.reserveStock(seeded.variantId, 1, null, -3600)
    await k.services.inventory.reserveStock(seeded.variantId, 1, null, -3600)
    const sweeper = startInventoryReservationSweeper({
      inventoryService: k.services.inventory,
      reservationRepo: k.repos.inventoryReservation,
      logger: k.logger,
      intervalMs: 3_600_000,
    })
    const before = await auditRows(raw)
    try {
      await sweeper.tick()
    } finally {
      sweeper.stop()
    }
    const appended = await appendedSince(before)
    const applied = appended.filter((r) => r.outcome === 'applied')

    expect(applied.length).toBeGreaterThan(0)
    expect(appended.map(actorOf)).toEqual(appended.map(() => 'system:reservations'))
    expect(subjectIds(applied)).toContain(seeded.variantId)
  })

  it('AC-3: a payment webhook that finalises a pending order leaves one applied entry by system:stripe-webhook naming the order, under the request’s correlation id', async () => {
    const seeded = await seedVariant(k, 100)
    const order = await checkoutOf(k, seeded, 1)
    const hook = captureFor(order)

    const res = await fetch(new URL(hook.path, served.baseUrl), {
      method: hook.method,
      headers: hook.headers,
      body: hook.body,
    })
    expect(res.status, await res.text()).toBe(200)
    const rows = await rowsOf(raw, res.headers.get(CORRELATION))

    expect(rows.map((r) => [r.outcome, actorOf(r)])).toEqual([['applied', 'system:stripe-webhook']])
    expect(subjectIds(rows)).toContain(order.orderId)
  })
})
