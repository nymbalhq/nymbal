import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EVT_CART_ABANDONED, type Cart, type NymbalEvent } from '@nymbalhq/types'
import { startCartAbandonmentSweeper } from '../../src/sweepers/index.js'
import { cartWith, createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { eventRows, failPublishFor, type EventRow, type FailingBus } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'

// P1-03 AC-9 on SQLite: an event published outside any transaction (cart.abandoned.v1 from the abandonment sweeper's
// tick) is appended to the log and delivered from it; with the bus rejecting, the row stays for the relay.

const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000

let k: Kernel
let raw: RawReader
let failing: FailingBus | undefined
const delivered: NymbalEvent<unknown>[] = []

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  raw = openRaw(k.dialect, k.target)
  await k.eventBus.subscribe(EVT_CART_ABANDONED, (event) => {
    delivered.push(event)
  })
}, 60_000)

afterEach(() => {
  failing?.restore()
  failing = undefined
})

afterAll(async () => {
  await raw?.close()
  await k?.close()
})

/** A cart with one item whose last activity was two days ago. */
async function staleCart(): Promise<string> {
  const token = await cartWith(k, await seedVariant(k, 5), 1)
  const cart = await k.documentStore.get<Cart>('carts', token)
  if (cart === null) throw new Error(`cart ${token} is not in the document store`)
  await k.documentStore.put<Cart>('carts', token, {
    ...cart,
    updatedAt: new Date(Date.now() - TWO_DAYS_MS).toISOString(),
  })
  return token
}

async function abandonedRows(token: string): Promise<EventRow[]> {
  const rows = await eventRows(raw, 'type = ?', [EVT_CART_ABANDONED])
  return rows.filter((r) => (r.envelope.payload as { cartId?: string }).cartId === token)
}

function sweeper() {
  return startCartAbandonmentSweeper({
    documentStore: k.documentStore,
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
