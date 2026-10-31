import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  EVT_CART_ABANDONED,
  EVT_CATEGORY_CREATED,
  EVT_PAYMENT_FAILED,
  EVT_PRODUCT_CREATED,
  type NymbalEvent,
} from '@nymbalhq/types'
import { createKernel, seedVariant, type Kernel } from '../support/kernel.js'
import { eventRows, failPublishFor, maxSeq, type FailingBus } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { unaudited } from '../support/write-audit.js'

// AC-6 on SQLite: a bus publish that rejects keeps the event in the log and does not fail the committed command.
// A later drain delivers it once; after five failed attempts it is dead and no drain hands it to the bus again.
// The wrapper replaces `publish` on the bus instance, which the relay looks up at call time.

const MAX_ATTEMPTS = 5

let k: Kernel
let raw: RawReader
let failing: FailingBus | undefined
const delivered: NymbalEvent<unknown>[] = []

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  raw = openRaw(k.dialect, k.target)
  await k.eventBus.subscribe('*', (event) => {
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

function deliveries(id: string): number {
  return delivered.filter((e) => e.id === id).length
}

describe('AC-6: delivery failure keeps the event and does not fail the command', () => {
  it('AC-6: product.create resolves with its writes committed while the bus rejects product.created.v1; the row stays undelivered with attempts 1; a drain without the wrapper delivers it once', async () => {
    const before = await maxSeq(raw)
    failing = failPublishFor(k.eventBus, [EVT_PRODUCT_CREATED])

    const seeded = await seedVariant(k, 3)

    expect(await raw.count('products', 'id = ?', [seeded.productId])).toBe(1)
    const [row] = await eventRows(raw, 'seq > ? AND type = ?', [before, EVT_PRODUCT_CREATED])
    expect(row, 'the product.created.v1 row').toBeDefined()
    expect(failing.rejected).toEqual([row!.id])
    expect({
      delivered: row!.deliveredAt ?? null,
      attempts: row!.attempts,
      dead: row!.deadAt ?? null,
    }).toEqual({
      delivered: null,
      attempts: 1,
      dead: null,
    })
    expect(deliveries(row!.id)).toBe(0)

    failing.restore()
    await k.app.relay.drain()

    const [after] = await eventRows(raw, 'id = ?', [row!.id])
    expect(after!.deliveredAt).not.toBeNull()
    expect(deliveries(row!.id)).toBe(1)

    await k.app.relay.drain()
    expect(deliveries(row!.id), 'a delivered row is not handed to the bus again').toBe(1)
  })

  it('AC-6: a rejected event does not hold back the next one: in one transaction the rejected payment.failed.v1 stays undelivered and the cart.abandoned.v1 after it is delivered', async () => {
    failing = failPublishFor(k.eventBus, [EVT_PAYMENT_FAILED])
    const tag = randomUUID()

    const [failedId, abandonedId] = await unaudited(() =>
      k.store.transaction(async () => {
        const failed = await k.publisher.publish(EVT_PAYMENT_FAILED, {
          paymentId: `pi_${tag}`,
          orderId: '',
          reason: 'card_declined',
        })
        const abandoned = await k.publisher.publish(EVT_CART_ABANDONED, {
          cartId: `cart_${tag}`,
          lastActivityAt: new Date().toISOString(),
        })
        return [failed.id, abandoned.id]
      }),
    )

    const rows = await eventRows(raw, 'id IN (?, ?)', [failedId, abandonedId])
    expect(rows.map((r) => ({ id: r.id, delivered: r.deliveredAt != null }))).toEqual([
      { id: failedId, delivered: false },
      { id: abandonedId, delivered: true },
    ])
    expect(deliveries(abandonedId)).toBe(1)
    expect(deliveries(failedId)).toBe(0)
  })

  it(`AC-6: a poison event: ${MAX_ATTEMPTS} failed attempts set dead_at (not before), attempts equals the bus calls, and later drains never hand it to the bus`, async () => {
    failing = failPublishFor(k.eventBus, [EVT_CATEGORY_CREATED])
    const before = await maxSeq(raw)

    await k.services.category.create({ slug: `poison-${randomUUID()}`, name: 'Poison' })

    const [row] = await eventRows(raw, 'seq > ? AND type = ?', [before, EVT_CATEGORY_CREATED])
    expect(row, 'the category.created.v1 row').toBeDefined()
    const id = row!.id
    const attemptsOf = async () => (await eventRows(raw, 'id = ?', [id]))[0]!

    for (let drain = 1; drain < MAX_ATTEMPTS; drain += 1) {
      const now = await attemptsOf()
      expect(now.attempts).toBe(failing.rejected.filter((r) => r === id).length)
      expect(now.deadAt ?? null, `dead after ${now.attempts} attempts`).toBeNull()
      await k.app.relay.drain()
    }

    const dead = await attemptsOf()
    expect(dead.attempts).toBe(MAX_ATTEMPTS)
    expect(failing.rejected.filter((r) => r === id).length).toBe(MAX_ATTEMPTS)
    expect(dead.deadAt).not.toBeNull()
    expect(dead.deliveredAt ?? null).toBeNull()

    await k.app.relay.drain()
    await k.app.relay.drain()
    expect(failing.rejected.filter((r) => r === id).length, 'a dead event was retried').toBe(
      MAX_ATTEMPTS,
    )
    expect((await attemptsOf()).attempts).toBe(MAX_ATTEMPTS)
    expect(deliveries(id)).toBe(0)
  })
})
