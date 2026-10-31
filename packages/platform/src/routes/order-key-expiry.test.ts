import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Order, OrderHistoryEntry, OrderStatus, ResponseEnvelope } from '@nymbalhq/types'
import {
  addKey,
  headerOf,
  ORDER_EMAIL_HEADER,
  ORDER_KEY_HEADER,
  orderRig,
  placeOrder,
  wire,
  type OrderRig,
} from '../tests/order-routes.js'

// GET /api/orders/:orderNumber once a key has expired: the key opens its order again only beside that order's email,
// in `x-nymbal-order-email`, matched in any case and with surrounding space. The order's own expired key with no email
// is told `orders.key_expired`, so the page can ask for the email; every other refusal is the answer a number no order
// has, to the byte, so a stranger cannot tell the order exists. Keys expire by their row's `expires_at`.

const HOUR = 3_600_000
const CREATED = '2026-10-01T09:00:00.000Z'
const STATUSES: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
]
const ADDRESS = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Main St',
  city: 'London',
  region: 'England',
  postalCode: 'E1 6AN',
  country: 'GB',
}

const orderKey = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)

/** One guest order: its status, the local part of its email, and how long ago its key expired. */
const guest = fc.record({
  status: fc.constantFrom(...STATUSES),
  local: fc.stringMatching(/^[a-z][a-z0-9.]{0,11}$/),
  expiredAgoMs: fc.integer({ min: 60_000, max: 400 * 24 * HOUR }),
})

/** How a shopper might type the order's email: any letters flipped to capitals, with space or tabs around it. */
const typing = fc.record({
  upper: fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }),
  before: fc.constantFrom('', ' ', '  ', '\t', ' \t'),
  after: fc.constantFrom('', ' ', '   ', '\t', '\t '),
})

type Typing = typeof typing extends fc.Arbitrary<infer T> ? T : never

function typed(email: string, t: Typing): string {
  const cased = [...email]
    .map((c, i) => (t.upper[i % t.upper.length] ? c.toUpperCase() : c))
    .join('')
  return `${t.before}${cased}${t.after}`
}

function orderOf(
  i: number,
  status: OrderStatus,
  email: string,
): { order: Order; history: OrderHistoryEntry[] } {
  const id = `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`
  const paid = status !== 'pending' && status !== 'cancelled'
  const order: Order = {
    id,
    orderNumber: `NYM-${String(1000 + i)}`,
    sequence: 1000 + i,
    customerId: null,
    status,
    email,
    billingAddress: ADDRESS,
    shippingAddress: ADDRESS,
    lineItems: [
      {
        variantId: 'v-1',
        productId: 'p-1',
        productName: 'Widget',
        variantName: 'Default',
        sku: 'W-1',
        qty: 1,
        unitPriceMinor: 2500,
        lineSubtotalMinor: 2500,
        lineTaxMinor: 0,
        lineTotalMinor: 2500,
        imageUrl: '',
      },
    ],
    subtotalMinor: 2500,
    taxTotalMinor: 0,
    shippingTotalMinor: 0,
    discountTotalMinor: 0,
    totalMinor: 2500,
    currency: 'GBP',
    notes: '',
    metadata: {},
    paymentIntentId: null,
    capturedMinor: paid ? 2500 : 0,
    capturedAt: paid ? CREATED : null,
    refundedMinor: 0,
    captureMethod: paid ? 'provider' : null,
    createdAt: CREATED,
    updatedAt: CREATED,
  }
  const history: OrderHistoryEntry[] = [
    {
      id: `h-${i}`,
      orderId: id,
      fromStatus: null,
      toStatus: 'pending',
      actor: 'system:checkout',
      note: 'order draft created',
      timestamp: CREATED,
    },
  ]
  return { order, history }
}

interface Placed {
  orderNumber: string
  email: string
  expired: string
  open: string
}

async function read(
  rig: OrderRig,
  orderNumber: string,
  headers: Record<string, string>,
  via: 'served' | 'nothing' = 'served',
): Promise<ResponseEnvelope> {
  return (via === 'served' ? rig.invoke : rig.nothing)('GET', '/api/orders/:orderNumber', {
    params: { orderNumber },
    headers,
  })
}

const errorCode = (resp: ResponseEnvelope) =>
  (resp.body as { error?: { code?: string } }).error?.code

describe('reading an order whose key has expired', () => {
  // Kills: an expired key that still opens alone; an email compared exactly, so a capital or a space locks the guest
  // out; a 403, or a body that differs from an unknown number's, which tells a stranger the order exists; the hint
  // given for any key, or with an email sent.
  it('AC-2: property: over generated guest orders, an expired key with the order’s email in any case and padded answers 200 with the order; the order’s own expired key with no email header answers 404 orders.key_expired and no-store; the own key with a wrong email, another order’s key (expired or open) with this order’s email, the email with no key, no credential at all, and an unknown number read with this order’s key and email each answer the unknown-number 404 byte for byte, with no-store; an unexpired key alone answers 200', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(guest, { minLength: 2, maxLength: 3, selector: (g) => g.local }),
        fc.uniqueArray(orderKey, { minLength: 6, maxLength: 6 }),
        typing,
        async (guests, keys, t) => {
          const rig = await orderRig()
          try {
            const now = Date.now()
            const placed: Placed[] = []
            for (const [i, g] of guests.entries()) {
              const email = `${g.local}@orders.test`
              const { order, history } = orderOf(i, g.status, email)
              await placeOrder(rig, order, history)
              const expired = keys[2 * i]!
              const open = keys[2 * i + 1]!
              addKey(rig, order.id, expired, { expiresAt: new Date(now - g.expiredAgoMs) })
              addKey(rig, order.id, open, { expiresAt: new Date(now + 24 * HOUR) })
              placed.push({ orderNumber: order.orderNumber, email, expired, open })
            }

            for (const o of placed) {
              const n = o.orderNumber
              const others = placed.filter((x) => x !== o)
              const label = (what: string) => `${n} (${o.email}) read with ${what}`

              const opened: Array<[string, Record<string, string>]> = [
                [
                  `its expired key and "${typed(o.email, t)}"`,
                  { [ORDER_KEY_HEADER]: o.expired, [ORDER_EMAIL_HEADER]: typed(o.email, t) },
                ],
                [
                  'its expired key and its email in capitals, padded',
                  {
                    [ORDER_KEY_HEADER]: o.expired,
                    [ORDER_EMAIL_HEADER]: `  ${o.email.toUpperCase()}\t`,
                  },
                ],
                ['its unexpired key alone', { [ORDER_KEY_HEADER]: o.open }],
              ]
              for (const [what, headers] of opened) {
                const resp = await read(rig, n, headers)
                expect(resp.status, label(what)).toBe(200)
                expect(
                  (resp.body as { data?: { orderNumber?: string } }).data?.orderNumber,
                  label(what),
                ).toBe(n)
                expect(headerOf(resp, 'cache-control'), label(what)).toBe('no-store')
              }

              const hinted = await read(rig, n, { [ORDER_KEY_HEADER]: o.expired })
              expect(hinted.status, label('its expired key and no email')).toBe(404)
              expect(errorCode(hinted), label('its expired key and no email')).toBe(
                'orders.key_expired',
              )
              expect(headerOf(hinted, 'cache-control'), label('its expired key and no email')).toBe(
                'no-store',
              )

              const unknown = await read(rig, n, {}, 'nothing')
              expect(unknown.status, `${n} on a store with no orders`).toBe(404)
              const refused: Array<[string, Record<string, string>]> = [
                ...others.map(
                  (x) =>
                    [
                      `its expired key and another order’s email (${x.email})`,
                      { [ORDER_KEY_HEADER]: o.expired, [ORDER_EMAIL_HEADER]: x.email },
                    ] as [string, Record<string, string>],
                ),
                [
                  'its expired key and a near miss of its email',
                  { [ORDER_KEY_HEADER]: o.expired, [ORDER_EMAIL_HEADER]: `x${o.email}` },
                ],
                ...others.flatMap((x) => [
                  [
                    `${x.orderNumber}’s expired key and this order’s email`,
                    { [ORDER_KEY_HEADER]: x.expired, [ORDER_EMAIL_HEADER]: o.email },
                  ] as [string, Record<string, string>],
                  [
                    `${x.orderNumber}’s unexpired key and this order’s email`,
                    { [ORDER_KEY_HEADER]: x.open, [ORDER_EMAIL_HEADER]: o.email },
                  ] as [string, Record<string, string>],
                ]),
                ['its email and no key', { [ORDER_EMAIL_HEADER]: o.email }],
                ['no credential', {}],
              ]
              for (const [what, headers] of refused) {
                const resp = await read(rig, n, headers)
                expect(resp.status, label(what)).toBe(404)
                expect(wire(resp), label(what)).toBe(wire(unknown))
                expect(headerOf(resp, 'cache-control'), label(what)).toBe('no-store')
              }

              const stranger = `${n}9`
              const unknownStranger = await read(rig, stranger, {}, 'nothing')
              const probed = await read(rig, stranger, {
                [ORDER_KEY_HEADER]: o.expired,
                [ORDER_EMAIL_HEADER]: o.email,
              })
              expect(
                probed.status,
                `${stranger}, a number no order has, with ${n}’s key and email`,
              ).toBe(404)
              expect(wire(probed), `${stranger} with ${n}’s key and email`).toBe(
                wire(unknownStranger),
              )
            }
          } finally {
            await rig.close()
          }
        },
      ),
      { numRuns: 25 },
    )
  })
})
