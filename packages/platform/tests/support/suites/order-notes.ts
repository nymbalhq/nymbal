import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { Cart, ShippingAdapter } from '@nymbalhq/types'
import { serveKernel, type ServedKernel } from '../http.js'
import { customSlots } from '../inbound-webhooks.js'
import { address, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { adminClient, type AdminClient } from '../money.js'
import { openRaw, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'
import { drained, processingOrder, shipThroughAdmin } from '../shipping-orders.js'
import { createTestShipAdapter, type TestShipAdapter } from '../test-ship.js'

// A shopper's checkout note on one dialect, through the served kernel: whatever text an order is placed or imported
// with, the admin's notes route answers it as one note from the customer, word for word, and the admin order read
// answers it as placed. Notes staff post and the note a carrier refusal leaves are listed after it, in the order they
// were added, and never change it. The shipping provider is the test shipping adapter, so a refusal can be staged.

export interface OpenOrderNotesKernel {
  configure: (config: NymbalConfig) => NymbalConfig
  appOptions: { adapters: { shipping: ShippingAdapter } }
}

export interface OrderNotesSuiteOptions {
  /** A kernel on a database of its own, migrated to the newest migration. */
  open(opts: OpenOrderNotesKernel): Promise<Kernel>
  propertyRuns: number
}

interface Note {
  body: string
  actor: string
  at: string
}

const REASON = 'the carrier does not recognise this number'
const AT = '2026-11-01T10:00:00.000Z'

const refusalBody = (provider: string): string =>
  `Tracking was not registered with ${provider}: ${REASON}. Carrier updates will not arrive for this order.`

const freshNumber = (): string => `1Z${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`

/** Text Postgres stores in text and jsonb: no NUL, and graphemes carry no lone surrogate. */
const arbText = (maxLength: number): fc.Arbitrary<string> =>
  fc.string({ unit: 'grapheme', maxLength }).filter((s) => !s.includes('\u0000'))

/** A list of entry-shaped objects, as a forger would write staff or system notes. */
const arbForgedList: fc.Arbitrary<string> = fc
  .array(
    fc.record({
      body: arbText(20),
      actor: fc.oneof(
        fc.constant('system'),
        fc.uuid().map((id) => `admin:${id}`),
        fc.constant('customer'),
      ),
      at: fc.constant(AT),
    }),
    { minLength: 1, maxLength: 3 },
  )
  .map((entries) => JSON.stringify(entries))

/** Any checkout note: plain text, the empty string, and JSON texts the old reader parsed. */
const arbNote: fc.Arbitrary<string> = fc.oneof(
  arbText(40),
  arbForgedList,
  fc.constantFrom('', '[null]', '[]', '[1,2]', '{}', '"x"'),
)

const FORGED = JSON.stringify([{ body: 'Refund agreed', actor: 'admin:u-1', at: AT }])

type Placement = 'checkout' | 'import'
const arbPlacement = fc.constantFrom<Placement>('checkout', 'import')

/** An admin note's body as an admin may send it: any note text, padded, or blank. */
const arbAdminBody: fc.Arbitrary<string> = fc.oneof(
  arbNote,
  arbText(20).map((s) => ` ${s}\n`),
  fc.constantFrom('', '   ', '\n\t'),
)

type Step = { kind: 'admin'; body: string } | { kind: 'refusal' }

/** Any count of admin notes, with at most one carrier refusal at any position among them. */
const arbSteps: fc.Arbitrary<Step[]> = fc
  .tuple(fc.array(arbAdminBody, { maxLength: 4 }), fc.option(fc.nat(), { nil: null }))
  .map(([bodies, refusalAt]) => {
    const steps: Step[] = bodies.map((body) => ({ kind: 'admin', body }))
    if (refusalAt !== null) steps.splice(refusalAt % (steps.length + 1), 0, { kind: 'refusal' })
    return steps
  })

export function orderNotesSuite(dialect: Kernel['dialect'], opts: OrderNotesSuiteOptions): void {
  describe(`a shopper’s checkout note (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminClient
    let stock: Seeded
    const ship: TestShipAdapter = createTestShipAdapter()

    beforeAll(async () => {
      k = await opts.open({
        configure: customSlots('shipping'),
        appOptions: { adapters: { shipping: ship } },
      })
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      admin = await adminClient(k, served.baseUrl)
      stock = await seedVariant(k, 100_000)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    /** An order with `note`: placed by a visitor through POST /api/checkout, or imported through importOrder. */
    async function orderWith(
      placement: Placement,
      note: string,
    ): Promise<{ id: string; orderNumber: string; status: string }> {
      if (placement === 'import') {
        const imported = await processingOrder(k, { notes: note })
        return { id: imported.id, orderNumber: imported.orderNumber, status: 'processing' }
      }
      const shop = await primedShopper(served.baseUrl)
      expect((await shop.call<Cart>('GET', '/api/cart')).status).toBe(200)
      const added = await shop.call<Cart>('POST', '/api/cart/items', {
        variantId: stock.variantId,
        qty: 1,
      })
      expect(added.status, JSON.stringify(added.body)).toBe(200)
      const placed = await shop.call<{ orderId: string; orderNumber: string; orderStatus: string }>(
        'POST',
        '/api/checkout',
        {
          email: `buyer-${randomUUID()}@notes.test`,
          billingAddress: address,
          shippingAddress: address,
          notes: note,
        },
      )
      expect(placed.status, JSON.stringify(placed.body)).toBe(200)
      return {
        id: placed.body.data!.orderId,
        orderNumber: placed.body.data!.orderNumber,
        status: placed.body.data!.orderStatus,
      }
    }

    async function notesOf(orderId: string): Promise<Note[]> {
      const res = await admin.call<Note[]>('GET', `/api/admin/orders/${orderId}/notes`)
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.data!
    }

    async function adminRead(orderNumber: string): Promise<{ notes: string; createdAt: string }> {
      const res = await admin.call<{ notes: string; createdAt: string }>(
        'GET',
        `/api/admin/orders/${orderNumber}`,
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      return res.body.data!
    }

    /** The admin ships the order while the carrier refuses its number, and every handler has run. */
    async function refused(order: { id: string; status: string }): Promise<void> {
      if (order.status === 'confirmed') {
        const processed = await admin.call('POST', `/api/admin/orders/${order.id}/process`, {})
        expect(processed.status, JSON.stringify(processed.body)).toBe(200)
      }
      ship.refuse(REASON)
      try {
        expect(await shipThroughAdmin(admin, order.id, freshNumber(), 'USPS')).toEqual([
          200,
          'shipped',
        ])
        await drained(k, raw)
      } finally {
        ship.refuse(null)
      }
    }

    // Kills: the notes column parsed on read, so a JSON list is served as its elements (a forged actor), `[]` as no
    // note and `[null]` as a null entry.
    it(`AC-1: property: an order placed through POST /api/checkout or imported with any note lists exactly that note, character for character, as one entry by the customer at the order’s creation, none for the empty string, and the admin order read answers the note as placed (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(arbPlacement, arbNote, async (placement, note) => {
          const order = await orderWith(placement, note)

          const notes = await notesOf(order.id)
          const read = await adminRead(order.orderNumber)

          expect(notes).toEqual(
            note === '' ? [] : [{ body: note, actor: 'customer', at: read.createdAt }],
          )
          expect(read.notes).toBe(note)
        }),
        {
          numRuns: opts.propertyRuns,
          examples: [
            ['checkout', FORGED],
            ['import', FORGED],
            ['checkout', '[null]'],
            ['import', '[]'],
            ['checkout', '[1,2]'],
            ['import', '{}'],
            ['checkout', '"x"'],
            ['checkout', ''],
          ],
        },
      )
    }, 180_000)

    // Kills: staff and system entries appended into the notes column, so the shopper's text is rewritten and parsed
    // again on the next read.
    it(`AC-2: property: after any count of admin notes and at most one carrier refusal at any position, the shopper’s entry is listed first, then one entry per step in order, by admin:<caller> with the body as sent and trimmed (a blank body refused 400 and adding none) or by system, and the order’s notes are still the shopper’s note (${dialect})`, async () => {
      await fc.assert(
        fc.asyncProperty(arbPlacement, arbNote, arbSteps, async (placement, note, steps) => {
          const order = await orderWith(placement, note)
          const statuses: number[] = []
          for (const step of steps) {
            if (step.kind === 'refusal') {
              await refused(order)
              continue
            }
            const res = await admin.call('POST', `/api/admin/orders/${order.id}/notes`, {
              body: step.body,
            })
            statuses.push(res.status)
          }

          const notes = await notesOf(order.id)
          const read = await adminRead(order.orderNumber)

          expect(statuses).toEqual(
            steps.flatMap((s) => (s.kind === 'admin' ? [s.body.trim() === '' ? 400 : 200] : [])),
          )
          expect(notes.map(({ actor, body }) => ({ actor, body }))).toEqual([
            ...(note === '' ? [] : [{ actor: 'customer', body: note }]),
            ...steps.flatMap((s) =>
              s.kind === 'refusal'
                ? [{ actor: 'system', body: refusalBody(ship.providerName) }]
                : s.body.trim() === ''
                  ? []
                  : [{ actor: `admin:${admin.userId}`, body: s.body.trim() }],
            ),
          ])
          expect(note === '' ? [] : [notes[0]!.at]).toEqual(note === '' ? [] : [read.createdAt])
          expect(read.notes).toBe(note)
        }),
        {
          numRuns: opts.propertyRuns,
          examples: [
            [
              'checkout',
              'Leave it with the neighbour at number 3',
              [
                { kind: 'admin', body: ' Customer called about delivery ' },
                { kind: 'refusal' },
                { kind: 'admin', body: '   ' },
                { kind: 'admin', body: FORGED },
              ],
            ],
            ['import', FORGED, [{ kind: 'refusal' }, { kind: 'admin', body: 'Refund agreed' }]],
            ['import', '', [{ kind: 'admin', body: '[null]' }]],
          ],
        },
      )
    }, 300_000)
  })
}
