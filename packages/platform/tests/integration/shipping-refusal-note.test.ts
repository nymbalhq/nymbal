import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normaliseTrackingNumber } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { customSlots } from '../support/inbound-webhooks.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { adminClient, type AdminClient } from '../support/money.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { primedShopper } from '../support/security.js'
import {
  drained,
  orderState,
  processingOrder,
  shippedEvents,
  shipThroughAdmin,
} from '../support/shipping-orders.js'
import { createTestShipAdapter, type TestShipAdapter } from '../support/test-ship.js'
import { unaudited } from '../support/write-audit.js'

// A tracking number the carrier refuses leaves one system note on the order, read through the admin's notes route:
// once however often the event is delivered, beside whatever notes the order holds, and never in the document its
// owner reads. Through the served kernel, the provider being the test shipping adapter.

interface Note {
  body: string
  actor: string
  at: string
}

const freshNumber = (): string => `1Z${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`

/** A tracking number as a merchant may type it: grouped by spaces, lower case. */
const typed = (n: string): string => (n.match(/.{1,4}/g) ?? [n]).join(' ').toLowerCase()

const REASON = 'the carrier does not recognise this number'
const SHOPPER_WORDS = 'Leave it with the neighbour at number 3'
const ADMIN_WORDS = 'Customer called about delivery'

const noteBody = (provider: string, reason: string): string =>
  `Tracking was not registered with ${provider}: ${reason}. Carrier updates will not arrive for this order.`

let k: Kernel
let served: ServedKernel
let raw: RawReader
let admin: AdminClient
const ship: TestShipAdapter = createTestShipAdapter()

beforeAll(async () => {
  k = await createKernel({
    dialect: 'sqlite',
    configure: customSlots('shipping'),
    appOptions: { adapters: { shipping: ship } },
  })
  served = await serveKernel(k)
  raw = openRaw(k.dialect, k.target)
  admin = await adminClient(k, served.baseUrl)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

async function notesOf(orderId: string): Promise<Note[]> {
  const res = await admin.call<Note[]>('GET', `/api/admin/orders/${orderId}/notes`)
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  return res.body.data!
}

/** The `notes` column as the admin notes route leaves it, written directly: that route's own write is not this test's. */
function storedNotes(notes: Array<{ body: string; actor: string }>): string {
  return JSON.stringify(notes.map((note) => ({ ...note, at: '2026-11-01T10:00:00.000Z' })))
}

async function setStoredNotes(orderId: string, notes: string): Promise<void> {
  await unaudited(() =>
    k.store.transaction((tx) => k.repos.order.setNotes(tx, orderId, notes, new Date())),
  )
}

describe('a tracking number the carrier refuses', () => {
  it('AC-7: the order has, after the event is delivered, one system note naming the provider and the reason, the number as sent and as typed appears nowhere in its body, and the order stays shipped', async () => {
    const order = await processingOrder(k)
    const n = freshNumber()
    const asTyped = typed(n)
    ship.refuse((p) => `tracking_number ${p.trackingNumber} is invalid (you entered "${asTyped}")`)

    try {
      const answer = await shipThroughAdmin(admin, order.id, asTyped, 'USPS')
      const afterShip = await orderState(raw, order.id)
      await drained(k, raw)

      const notes = await notesOf(order.id)
      expect(answer).toEqual([200, 'shipped'])
      expect(notes.map((note) => [note.actor, note.body])).toEqual([
        [
          'system',
          noteBody(ship.providerName, 'tracking_number *** is invalid (you entered "***")'),
        ],
      ])
      const leaks = notes.filter(
        (note) => note.body.includes(normaliseTrackingNumber(n)) || note.body.includes(asTyped),
      )
      expect(leaks).toEqual([])
      expect(await orderState(raw, order.id)).toEqual(afterShip)
      expect(afterShip[0]).toBe('shipped')
    } finally {
      ship.refuse(null)
    }
  }, 60_000)

  it('AC-8: property: for any count of deliveries of the same order.shipped.v1 event, a refusal leaves exactly one note, a provider that accepts leaves none, an admin note survives, and a plain-string checkout note before the refusal is listed once with its words and actor customer', async () => {
    type Prior = 'none' | 'admin' | 'shopper' | 'both'
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          redeliveries: fc.integer({ min: 0, max: 4 }),
          refuses: fc.boolean(),
          prior: fc.constantFrom<Prior>('none', 'admin', 'shopper', 'both'),
        }),
        async ({ redeliveries, refuses, prior }) => {
          const hasShopper = prior === 'shopper' || prior === 'both'
          const hasAdmin = prior === 'admin' || prior === 'both'
          // Alone, the shopper's note stays the plain string checkout writes; beside an admin note it is the JSON the
          // route leaves.
          const order = await processingOrder(k, prior === 'shopper' ? { notes: SHOPPER_WORDS } : {})
          if (hasAdmin) {
            await setStoredNotes(
              order.id,
              storedNotes([
                ...(hasShopper ? [{ body: SHOPPER_WORDS, actor: 'customer' }] : []),
                { body: ADMIN_WORDS, actor: 'admin:u-1' },
              ]),
            )
          }
          ship.refuse(refuses ? REASON : null)

          try {
            const answer = await shipThroughAdmin(admin, order.id, freshNumber(), 'USPS')
            await drained(k, raw)
            const [event] = await shippedEvents(raw, order.id)
            for (let i = 0; i < redeliveries; i += 1) await k.eventBus.publish(event!.envelope)

            const notes = await notesOf(order.id)
            expect(answer).toEqual([200, 'shipped'])
            expect(notes.map((note) => [note.actor.split(':')[0], note.body])).toEqual([
              ...(hasShopper ? [['customer', SHOPPER_WORDS]] : []),
              ...(hasAdmin ? [['admin', ADMIN_WORDS]] : []),
              ...(refuses ? [['system', noteBody(ship.providerName, REASON)]] : []),
            ])
          } finally {
            ship.refuse(null)
          }
        },
      ),
      {
        numRuns: 16,
        examples: [
          [{ redeliveries: 3, refuses: true, prior: 'both' }],
          [{ redeliveries: 2, refuses: false, prior: 'shopper' }],
          [{ redeliveries: 1, refuses: true, prior: 'shopper' }],
        ],
      },
    )
  }, 120_000)

  it('AC-9: GET /api/orders/:number, as the order’s owner, carries no note after a refusal, while the note is on the order', async () => {
    const shop = await primedShopper(served.baseUrl)
    const email = `owner-${randomUUID()}@orders.test`
    const registered = await shop.call<{ accessToken: string }>('POST', '/api/auth/register', {
      email,
      password: 'orders-correct-horse',
    })
    expect(registered.status, JSON.stringify(registered.body)).toBe(201)
    const owner = await raw.one<{ id: string }>('SELECT id FROM customers WHERE email = ?', [email])
    const order = await processingOrder(k, { customerId: owner.id })
    ship.refuse(REASON)

    try {
      await shipThroughAdmin(admin, order.id, freshNumber(), 'USPS')
      await drained(k, raw)

      const headers = { authorization: `Bearer ${registered.body.data!.accessToken}` }
      const read = await shop.call<Record<string, unknown>>(
        'GET',
        `/api/orders/${order.orderNumber}`,
        undefined,
        { headers },
      )
      const onOrder = await notesOf(order.id)

      expect(read.status, JSON.stringify(read.body)).toBe(200)
      expect(onOrder.map((note) => note.body)).toEqual([noteBody(ship.providerName, REASON)])
      expect(JSON.stringify(read.body)).not.toContain(onOrder[0]!.body)
      expect(Object.keys(read.body.data!)).not.toContain('notes')
    } finally {
      ship.refuse(null)
    }
  }, 60_000)
})
