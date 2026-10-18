import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EVT_CART_ABANDONED, type NymbalEvent } from '@nymbalhq/types'
import { createCartService } from '../../src/services/cart-service.js'
import { startCartAbandonmentSweeper } from '../../src/sweepers/index.js'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { eventRows, failPublishFor, type EventRow, type FailingBus } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { lineFor } from '../support/replica.js'

// P1-03 AC-9 on SQLite: an event the abandonment sweeper's tick publishes (cart.abandoned.v1) is appended to the log
// and delivered from it; with the bus rejecting, the row stays for the relay.
// Each test gets its own kernel: the sweeper announces every stale cart on the database, so a cart left by an
// earlier test would add rows (and relay retries) to the next one's assertions.

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000

let k: Kernel
let raw: RawReader
let failing: FailingBus | undefined
let delivered: NymbalEvent<unknown>[]

beforeEach(async () => {
  delivered = []
  k = await createKernel({ dialect: 'sqlite' })
  raw = openRaw(k.dialect, k.target)
  await k.eventBus.subscribe(EVT_CART_ABANDONED, (event) => {
    delivered.push(event)
  })
}, 60_000)

afterEach(async () => {
  failing?.restore()
  failing = undefined
  await raw?.close()
  await k?.close()
})

/** A cart with one item whose last activity was two days ago: written through a cart service whose clock is. */
async function staleCart(): Promise<string> {
  const seeded = await seedVariant(k, 5)
  const twoDaysAgo = new Date(Date.now() - TWO_DAYS_MS)
  const cart = createCartService({
    store: k.store,
    carts: k.repos.cart,
    publisher: k.publisher,
    logger: k.logger,
    currency: k.config.store.currency,
    now: () => twoDaysAgo,
  })
  const created = await cart.getOrCreate()
  await cart.addItem(created.token, lineFor(seeded, 1))
  return created.token
}

async function abandonedRows(token: string): Promise<EventRow[]> {
  const rows = await eventRows(raw, 'type = ?', [EVT_CART_ABANDONED])
  return rows.filter((r) => (r.envelope.payload as { cartId?: string }).cartId === token)
}

function sweeper() {
  return startCartAbandonmentSweeper({
    store: k.store,
    carts: k.repos.cart,
    publisher: k.publisher,
    logger: k.logger,
    intervalMs: 3_600_000,
    inactivityMs: 60_000,
  })
}

describe('AC-9: publish outside a transaction is durable too', () => {
  it('AC-9: the abandonment sweeper tick() appends one cart.abandoned.v1 row for the stale cart and delivers that row, once', async () => {
    const token = await staleCart()
    const sweep = sweeper()
    try {
      await sweep.tick()
    } finally {
      sweep.stop()
    }

    const rows = await abandonedRows(token)
    expect(rows.map((r) => r.deliveredAt != null)).toEqual([true])
    expect(delivered.filter((e) => e.id === rows[0]!.id)).toHaveLength(1)
  })

  it('AC-9: with the bus rejecting cart.abandoned.v1 the row remains undelivered (attempts 1), and a later relay drain delivers it once', async () => {
    const token = await staleCart()
    failing = failPublishFor(k.eventBus, [EVT_CART_ABANDONED])
    const sweep = sweeper()
    try {
      await sweep.tick()
    } finally {
      sweep.stop()
    }

    const [row, ...extra] = await abandonedRows(token)
    expect(extra).toEqual([])
    expect(row, 'the cart.abandoned.v1 row').toBeDefined()
    expect(row!.deliveredAt ?? null).toBeNull()
    expect(failing.rejected).toEqual([row!.id])
    expect(row!.attempts, 'attempts = the bus calls that rejected this row').toBe(
      failing.rejected.filter((id) => id === row!.id).length,
    )
    expect(delivered.filter((e) => e.id === row!.id)).toHaveLength(0)

    failing.restore()
    await k.app.relay.drain()

    const [after] = await abandonedRows(token)
    expect(after!.deliveredAt).not.toBeNull()
    expect(delivered.filter((e) => e.id === row!.id)).toHaveLength(1)
  })
})
