import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EVT_INVENTORY_CHANGED } from '@nymbalhq/types'
import { startEventRetentionSweeper } from '../../../src/sweepers/index.js'
import {
  adminSession,
  auditRows,
  CORRELATION,
  customerSession,
  outcomesOf,
  rowsOf,
  subjectIds,
  type AdminSession,
  type AuditRow,
} from '../audit.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, checkoutOf, seedVariant, type Kernel, type Seeded } from '../kernel.js'
import { openRaw, stockOf, type RawReader } from '../raw.js'
import { primedShopper } from '../security.js'
import { captureFor } from '../webhooks.js'

// AC-2 on either dialect: a kernel from `src/` served over HTTP, commands sent by an admin, a customer, guests and the
// payment webhook, and `audit_entries` read through a second connection by each request's x-correlation-id. Every
// outermost command that commits leaves exactly one `applied` entry with its actor, name, subjects and correlation
// id; a command that throws leaves none and moves no stock; a refused one leaves one `refused` entry; a schema 400
// and a cart command leave none. A guest's actor id is never its cart token, and rows are never updated or removed.

type Kind =
  | 'adjust'
  | 'markPaid'
  | 'cancel'
  | 'refund'
  | 'productCreate'
  | 'productUpdate'
  | 'customerNote'
  | 'checkoutGuest'
  | 'checkoutCustomer'
  | 'register'
  | 'customerUpdate'
  | 'webhook'
  | 'refusedTransition'
  | 'schema400'
  | 'cartAdd'
  | 'throws'

const KINDS: readonly Kind[] = [
  'adjust',
  'markPaid',
  'cancel',
  'refund',
  'productCreate',
  'productUpdate',
  'customerNote',
  'checkoutGuest',
  'checkoutCustomer',
  'register',
  'customerUpdate',
  'webhook',
  'refusedTransition',
  'schema400',
  'cartAdd',
  'throws',
]

/** The command a kind runs; the two checkouts are one command by two actors. */
const COMMAND_OF: Partial<Record<Kind, string>> = {
  adjust: 'adjust',
  markPaid: 'markPaid',
  cancel: 'cancel',
  refund: 'refund',
  productCreate: 'productCreate',
  productUpdate: 'productUpdate',
  customerNote: 'customerNote',
  checkoutGuest: 'checkout',
  checkoutCustomer: 'checkout',
  register: 'register',
  customerUpdate: 'customerUpdate',
  webhook: 'webhook',
}

type Expected =
  | {
      outcome: 'applied'
      actor: { kind: string; id?: string }
      subjects: string[]
      /** A guest's cart token, which the actor id must not hold. */
      cartToken?: string
    }
  | { outcome: 'refused' }
  | { outcome: 'none' }
  | { outcome: 'not-applied'; variantId: string; stockBefore: number }

interface Step {
  kind: Kind
  status: number
  expectedStatus: number
  correlationId: string | null
  body: unknown
  expected: Expected
}

const snapshot = (rows: AuditRow[]) => new Map(rows.map((r) => [r.id, JSON.stringify(r)]))

export function auditEntriesSuite(
  dialect: string,
  start: () => Promise<Kernel>,
  opts: { runs: number },
): void {
  describe(`AC-2: every outermost command leaves one entry, in its transaction (${dialect})`, () => {
    let k: Kernel
    let served: ServedKernel
    let raw: RawReader
    let admin: AdminSession
    let customer: Awaited<ReturnType<typeof customerSession>>
    let stocked: Seeded
    /** Every command name seen per command, across every test of this suite. */
    const names = new Map<string, Set<string>>()

    beforeAll(async () => {
      k = await start()
      served = await serveKernel(k)
      raw = openRaw(k.dialect, k.target)
      admin = await adminSession(k, served.baseUrl)
      customer = await customerSession(served.baseUrl)
      stocked = await seedVariant(k, 1_000_000)
    }, 60_000)

    afterAll(async () => {
      await raw?.close()
      await served?.stop()
    })

    async function guestWithCart() {
      const s = await primedShopper(served.baseUrl)
      const cart = await s.call('GET', '/api/cart')
      if (cart.status !== 200) throw new Error(`GET /api/cart: ${JSON.stringify(cart.body)}`)
      const added = await s.call('POST', '/api/cart/items', {
        variantId: stocked.variantId,
        qty: 1,
      })
      if (added.status !== 200) throw new Error(`cart add: ${JSON.stringify(added.body)}`)
      return { s, token: s.jar.get('nymbal.cart')! }
    }

    const pendingOrder = () => checkoutOf(k, stocked, 1)
    const paidOrder = () => checkoutOf(k, stocked, 1, `paid-${randomUUID()}@audit.test`)

    function step(
      kind: Kind,
      res: { status: number; headers: Headers; body: unknown },
      expectedStatus: number,
      expected: Expected,
    ): Step {
      return {
        kind,
        status: res.status,
        expectedStatus,
        correlationId: res.headers.get(CORRELATION),
        body: res.body,
        expected,
      }
    }

    const asAdmin = { kind: 'admin' } as const

    async function run(kind: Kind): Promise<Step> {
      const adminActor = { ...asAdmin, id: admin.userId }
      switch (kind) {
        case 'adjust': {
          const res = await admin.send('POST', `/api/admin/inventory/${stocked.variantId}/adjust`, {
            delta: 1,
            reason: 'manual',
          })
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: adminActor,
            subjects: [stocked.variantId],
          })
        }
        case 'markPaid': {
          const order = await pendingOrder()
          const res = await admin.send('POST', `/api/admin/orders/${order.orderId}/mark-paid`, {})
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: adminActor,
            subjects: [order.orderId],
          })
        }
        case 'cancel': {
          const order = await pendingOrder()
          const res = await admin.send('POST', `/api/admin/orders/${order.orderId}/cancel`, {})
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: adminActor,
            subjects: [order.orderId],
          })
        }
        case 'refund': {
          const order = await paidOrder()
          const res = await admin.send('POST', `/api/admin/orders/${order.orderId}/refund`, {
            amountMinor: 1,
          })
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: adminActor,
            subjects: [order.orderId],
          })
        }
        case 'productCreate': {
          const tag = randomUUID()
          const res = await admin.send<{ id: string }>('POST', '/api/admin/products', {
            slug: `audit-ac2-${tag}`,
            name: 'Audited',
            description: '',
            status: 'draft',
            variants: [
              { sku: `AC2-${tag}`, name: 'Default', priceMinor: 900, stock: 1, options: [] },
            ],
          })
          return step(kind, res, 201, {
            outcome: 'applied',
            actor: adminActor,
            subjects: [res.body.data?.id ?? '(no id answered)'],
          })
        }
        case 'productUpdate': {
          const seeded = await seedVariant(k, 1)
          const res = await admin.send('PATCH', `/api/admin/products/${seeded.productId}`, {
            name: `Renamed ${randomUUID()}`,
          })
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: adminActor,
            subjects: [seeded.productId],
          })
        }
        case 'customerNote': {
          const res = await admin.send(
            'POST',
            `/api/admin/customers/${customer.customerId}/notes`,
            {
              body: 'Called about a parcel',
            },
          )
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: adminActor,
            subjects: [customer.customerId],
          })
        }
        case 'checkoutGuest': {
          const { s, token } = await guestWithCart()
          const res = await s.call<{ orderId: string }>('POST', '/api/checkout', {
            email: `guest-${randomUUID()}+stub-pending@audit.test`,
            billingAddress: address,
            shippingAddress: address,
          })
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: { kind: 'guest' },
            subjects: [res.body.data?.orderId ?? '(no order)', stocked.variantId],
            cartToken: token,
          })
        }
        case 'checkoutCustomer': {
          const cart = await customer.send('GET', '/api/cart')
          if (cart.status !== 200) throw new Error(`GET /api/cart: ${JSON.stringify(cart.body)}`)
          const added = await customer.send('POST', '/api/cart/items', {
            variantId: stocked.variantId,
            qty: 1,
          })
          if (added.status !== 200) throw new Error(`cart add: ${JSON.stringify(added.body)}`)
          const res = await customer.send<{ orderId: string }>('POST', '/api/checkout', {
            email: `${customer.email.replace('@', '+stub-pending@')}`,
            billingAddress: address,
            shippingAddress: address,
          })
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: { kind: 'customer', id: customer.customerId },
            subjects: [res.body.data?.orderId ?? '(no order)', stocked.variantId],
          })
        }
        case 'register': {
          const s = await primedShopper(served.baseUrl)
          const res = await s.call<{ customer: { id: string } }>('POST', '/api/auth/register', {
            email: `reg-${randomUUID()}@audit.test`,
            password: 'audit-correct-horse',
          })
          return step(kind, res, 201, {
            outcome: 'applied',
            actor: { kind: 'guest' },
            subjects: [res.body.data?.customer.id ?? '(no customer)'],
          })
        }
        case 'customerUpdate': {
          const res = await customer.send('PATCH', '/api/customers/me', {
            firstName: `Ada ${randomUUID().slice(0, 6)}`,
          })
          return step(kind, res, 200, {
            outcome: 'applied',
            actor: { kind: 'customer', id: customer.customerId },
            subjects: [customer.customerId],
          })
        }
        case 'webhook': {
          const order = await pendingOrder()
          const hook = captureFor(order)
          const res = await fetch(new URL(hook.path, served.baseUrl), {
            method: hook.method,
            headers: hook.headers,
            body: hook.body,
          })
          const body: unknown = await res.json().catch(() => null)
          return step(kind, { status: res.status, headers: res.headers, body }, 200, {
            outcome: 'applied',
            actor: { kind: 'system', id: 'stripe-webhook' },
            subjects: [order.orderId],
          })
        }
        case 'refusedTransition': {
          const order = await pendingOrder()
          const res = await admin.send('POST', `/api/admin/orders/${order.orderId}/mark-delivered`)
          return step(kind, res, 409, { outcome: 'refused' })
        }
        case 'schema400': {
          const res = await admin.send('POST', `/api/admin/inventory/${stocked.variantId}/adjust`, {
            delta: 'one',
            reason: 'manual',
          })
          return step(kind, res, 400, { outcome: 'none' })
        }
        case 'cartAdd': {
          const s = await primedShopper(served.baseUrl)
          const res = await s.call('POST', '/api/cart/items', {
            variantId: stocked.variantId,
            qty: 1,
          })
          return step(kind, res, 200, { outcome: 'none' })
        }
        case 'throws': {
          const seeded = await seedVariant(k, 50)
          const publisher = k.publisher
          const original = publisher.publish
          // The publish runs inside adjustStock's transaction, after the stock write: throwing there rolls it back.
          const passThrough = original as (...args: unknown[]) => Promise<unknown>
          publisher.publish = (async (type: string, payload: unknown, options?: unknown) => {
            if (type === EVT_INVENTORY_CHANGED) {
              throw new Error('audit: publish refused mid-transaction')
            }
            return passThrough.call(publisher, type, payload, options)
          }) as typeof publisher.publish
          try {
            const res = await admin.send(
              'POST',
              `/api/admin/inventory/${seeded.variantId}/adjust`,
              {
                delta: 5,
                reason: 'manual',
              },
            )
            return step(kind, res, 500, {
              outcome: 'not-applied',
              variantId: seeded.variantId,
              stockBefore: seeded.initialStock,
            })
          } finally {
            publisher.publish = original
          }
        }
      }
    }

    /** Runs `kind` and checks the entries its request left, and that no earlier entry changed or went. */
    async function runAndCheck(kind: Kind): Promise<void> {
      const before = snapshot(await auditRows(raw))
      const done = await run(kind)
      const context = `${kind}: ${done.status} ${JSON.stringify(done.body)}`
      expect(done.status, context).toBe(done.expectedStatus)
      const rows = await rowsOf(raw, done.correlationId)
      const { expected } = done

      if (expected.outcome === 'applied') {
        expect(outcomesOf(rows), context).toEqual(['applied'])
        const [row] = rows
        expect(row!.correlationId, context).toBe(done.correlationId)
        expect(row!.actorKind, context).toBe(expected.actor.kind)
        if (expected.actor.id !== undefined) expect(row!.actorId, context).toBe(expected.actor.id)
        expect(row!.actorId.length, `${context}: an actor id`).toBeGreaterThan(0)
        if (expected.cartToken !== undefined) {
          expect(
            row!.actorId.includes(expected.cartToken),
            `${context}: the cart token in the actor id`,
          ).toBe(false)
        }
        expect(
          expected.subjects.filter((id) => !subjectIds(rows).includes(id)),
          `${context}: subjects missing from ${JSON.stringify(row!.subjects)}`,
        ).toEqual([])
        if (kind === 'checkoutGuest' || kind === 'checkoutCustomer') {
          expect(row!.command, context).toBe('checkout.place')
        }
        const command = COMMAND_OF[kind]!
        names.set(command, (names.get(command) ?? new Set()).add(row!.command))
      } else if (expected.outcome === 'refused') {
        expect(outcomesOf(rows), context).toEqual(['refused'])
      } else if (expected.outcome === 'none') {
        expect(rows, context).toEqual([])
      } else {
        expect(
          rows.filter((r) => r.outcome === 'applied'),
          context,
        ).toEqual([])
        expect(await stockOf(raw, expected.variantId), context).toBe(expected.stockBefore)
      }

      const after = await auditRows(raw)
      const now = snapshot(after)
      expect(after.length, `${context}: row count`).toBeGreaterThanOrEqual(before.size)
      for (const [id, was] of before) {
        expect(now.get(id), `${context}: earlier entry ${id} changed or went`).toBe(was)
      }
    }

    /** One command name per command, and no two commands sharing one. */
    function expectNamesConsistent(): void {
      for (const [command, seen] of names) {
        expect([...seen], `${command}: command names recorded`).toHaveLength(1)
      }
      const all = [...names.values()].map((seen) => [...seen][0])
      expect(new Set(all).size, `command names ${JSON.stringify([...names])}`).toBe(all.length)
    }

    it('AC-2: each kind of command, in turn: one applied entry with its actor, name, subjects and correlation id; one refused entry for a refused command, none for a schema 400, a cart command or a thrown one', async () => {
      for (const kind of KINDS) await runAndCheck(kind)
      expectNamesConsistent()
    }, 120_000)

    it(`AC-2: property (${opts.runs} runs): generated sequences of commands by generated actors each leave exactly the entries their outcome calls for, and no entry is ever updated`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.constantFrom(...KINDS), { minLength: 1, maxLength: 6 }),
          async (kinds) => {
            for (const kind of kinds) await runAndCheck(kind)
            expectNamesConsistent()
          },
        ),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 300_000)

    it('AC-2: entries survive the event-retention sweep, which deletes the delivered events around them', async () => {
      await runAndCheck('adjust')
      const before = await auditRows(raw)
      const eventsBefore = await raw.count('events')
      const sweeper = startEventRetentionSweeper({
        store: k.store,
        eventLog: k.repos.eventLog,
        processedEvents: k.repos.processedEvent,
        logger: k.logger,
        retentionDays: 0,
        intervalMs: 3_600_000,
      })
      try {
        await sweeper.tick()
      } finally {
        sweeper.stop()
      }

      expect(await raw.count('events'), 'the sweep deleted delivered events').toBeLessThan(
        eventsBefore,
      )
      expect(before.length).toBeGreaterThan(0)
      expect(await auditRows(raw)).toEqual(before)
    }, 60_000)
  })
}
