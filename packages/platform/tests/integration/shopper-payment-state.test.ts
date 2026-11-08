import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ORDER_KEY_HEADER, paymentState, type OrderStatus } from '@nymbalhq/types'
import { hashOrderKey, mintOrderKey } from '../../src/order-access-key.js'
import { customerSession } from '../support/audit-http.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import {
  address,
  checkoutOf,
  createKernel,
  seedVariant,
  type Kernel,
  type Seeded,
} from '../support/kernel.js'
import { adminClient, storedMoney, type AdminClient } from '../support/money.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { unaudited } from '../support/write-audit.js'

// What a shopper reads of a refund on a served SQLite kernel: `payment.state` from the stored amounts, on the keyed
// answer, the owner's answer and the owner's list; and a key holder gets no amount.

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminClient
let seeded: Seeded

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminClient(k, served.baseUrl)
  seeded = await seedVariant(k, 40)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

interface Answered {
  status: number
  body: Record<string, unknown>
}

async function read(path: string, headers: Record<string, string> = {}): Promise<Answered> {
  const res = await fetch(`${served.baseUrl}${path}`, { headers: { accept: 'application/json', ...headers } })
  const body = (await res.json()) as { data: Record<string, unknown> }
  return { status: res.status, body: body.data }
}

const TOTAL = 2500

/** An imported order with these amounts, for its owner or (with no owner) reachable by the key answered. */
async function importWith(
  amounts: { capturedMinor: number; refundedMinor: number },
  customerId: string | null,
) {
  const orderId = uuidv7()
  const orderNumber = `PAY-${randomUUID().slice(0, 8)}`
  const status: OrderStatus = amounts.capturedMinor === 0 ? 'pending' : 'confirmed'
  await k.services.order.importOrder({
    orderId,
    orderNumber,
    status,
    customerId,
    email: `buyer-${randomUUID()}@payment-state.test`,
    billingAddress: address,
    shippingAddress: address,
    lineItems: [],
    subtotalMinor: TOTAL,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: TOTAL,
    currency: 'GBP',
    createdAt: new Date(),
    ...(amounts.capturedMinor > 0 && {
      capturedMinor: amounts.capturedMinor,
      refundedMinor: amounts.refundedMinor,
      captureMethod: 'import' as const,
    }),
  })
  const { key } = mintOrderKey()
  const now = new Date()
  await unaudited(() =>
    k.store.transaction((tx) =>
      k.repos.orderAccessKey.insert(tx, {
        id: randomUUID(),
        orderId,
        keyHash: hashOrderKey(key),
        purpose: 'checkout',
        createdAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
      }),
    ),
  )
  await k.app.relay.drain()
  return { orderId, orderNumber, key }
}

const amounts = fc
  .constantFrom('unpaid', 'paid', 'part', 'whole')
  .chain((kind) =>
    kind === 'unpaid'
      ? fc.constant({ capturedMinor: 0, refundedMinor: 0 })
      : kind === 'paid'
        ? fc.constant({ capturedMinor: TOTAL, refundedMinor: 0 })
        : kind === 'whole'
          ? fc.constant({ capturedMinor: TOTAL, refundedMinor: TOTAL })
          : fc
              .integer({ min: 1, max: TOTAL - 1 })
              .map((refundedMinor) => ({ capturedMinor: TOTAL, refundedMinor })),
  )

describe('a shopper reads what was refunded from payment.state', () => {
  // Defect: the state is missing or computed from something other than the stored amounts; a key holder is shown an amount.
  it('AC-12: property: GET /api/orders/:n with a key, as its owner, and GET /api/orders answer payment.state equal to paymentState of the amounts, for all four states; the key holder’s answer carries no capturedMinor, refundedMinor or amount under payment', async () => {
    const owner = await customerSession(served.baseUrl)
    await fc.assert(
      fc.asyncProperty(amounts, async (money) => {
        const expected = paymentState(money)
        const keyed = await importWith(money, null)
        const owned = await importWith(money, owner.customerId)

        const byKey = await read(`/api/orders/${keyed.orderNumber}`, {
          [ORDER_KEY_HEADER]: keyed.key,
        })
        const byOwner = await owner.send<Record<string, unknown>>(
          'GET',
          `/api/orders/${owned.orderNumber}`,
        )
        const list = await owner.send<Array<Record<string, unknown>>>('GET', '/api/orders')
        const listed = (list.body.data ?? []).find((o) => o['orderNumber'] === owned.orderNumber)

        const stateOf = (o: Record<string, unknown> | undefined) =>
          (o?.['payment'] as { state?: string } | undefined)?.state
        expect([byKey.status, stateOf(byKey.body)], JSON.stringify(byKey.body)).toEqual([
          200,
          expected,
        ])
        expect([byOwner.status, stateOf(byOwner.body.data)]).toEqual([200, expected])
        expect(stateOf(listed), JSON.stringify(list.body)).toBe(expected)

        const keyedPayment = byKey.body['payment'] as Record<string, unknown>
        expect(Object.keys(keyedPayment), 'the keyed payment carries the state alone').toEqual([
          'state',
        ])
        expect(
          ['capturedMinor', 'refundedMinor'].filter((f) => f in byKey.body),
          'the keyed answer leaks an amount',
        ).toEqual([])
      }),
      { numRuns: 16 },
    )
  }, 120_000)

  // Defect: the shopper's state is stale after a real refund (read from a stored doc rather than the amounts).
  it('AC-12: after real refunds through the admin route, the key holder’s payment.state follows the stored amounts: partially_refunded, then refunded', async () => {
    const placed = await checkoutOf(k, seeded, 1, `guest-${randomUUID()}@payment-state.test`)
    expect(placed.orderStatus).toBe('confirmed')
    const key = (placed as { orderKey?: string }).orderKey
    expect(key, 'a guest checkout answers a key').toMatch(/^[A-Za-z0-9_-]{43}$/)
    const seen: Array<[string | undefined, string]> = []
    for (const amountMinor of [1, placed.totalMinor - 1]) {
      const res = await admin.call('POST', `/api/admin/orders/${placed.orderId}/refund`, {
        amountMinor,
      })
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      await k.app.relay.drain()
      const stored = await storedMoney(raw, placed.orderId)
      const answer = await read(`/api/orders/${placed.orderNumber}`, { [ORDER_KEY_HEADER]: key! })
      seen.push([
        (answer.body['payment'] as { state?: string } | undefined)?.state,
        paymentState(stored),
      ])
    }
    expect(seen).toEqual([
      ['partially_refunded', 'partially_refunded'],
      ['refunded', 'refunded'],
    ])
  }, 60_000)
})
