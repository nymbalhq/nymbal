import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import { AdapterError, ConfigError, NymbalError } from '@nymbalhq/types'
import { createLogger } from '../../src/logger.js'
import { address, createKernel, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  DOCUMENT_COLLECTIONS,
  documentModelsOf,
  nativeSearchDocuments,
  rebuildFresh,
} from '../support/read-models.js'
import { createTestMailAdapter, type TestMailAdapter } from '../support/test-mail.js'

// AC-4: an email outage loses no send. The kernel's email adapter is the test mail adapter, switched down (every send
// rejects, its health check answers `down`) before a tour and a generated tail of commands (paid checkouts,
// registrations, back-in-stock requests and restocks); the relay's clock is then moved past three times the whole
// backoff window, draining at each step, before the adapter comes back and the log is drained. Nothing is dead, every
// event is delivered, each trigger sent its email once, and every read model equals a fresh rebuild. The relay keeps
// its default maxAttempts (5); retryDelayMs is non-zero so the waits it writes are real.

const RETRY_DELAY_MS = 60_000
const MAX_ATTEMPTS = 5
/** The sum of every wait before an event is dead: retryDelayMs × (2^maxAttempts − 1). */
const BACKOFF_WINDOW_MS = RETRY_DELAY_MS * (2 ** MAX_ATTEMPTS - 1)
/** The longest single wait: a step of this lets every waiting event be tried again on each drain. */
const STEP_MS = RETRY_DELAY_MS * 2 ** (MAX_ATTEMPTS - 1)
const SHOP = 'http://outage-shop.test'

const storeConfig = (config: NymbalConfig): NymbalConfig =>
  ({
    ...config,
    commerce: { ...config.commerce, email: { provider: 'custom' } },
    http: { ...config.http, cors: { ...config.http.cors, allowedOrigins: [SHOP] } },
  }) as NymbalConfig

interface World {
  products: Array<{ id: string; variantId: string; priceMinor: number }>
  customers: string[]
}

type Op =
  | { kind: 'checkout.paid'; pick: number; qty: number }
  | { kind: 'customer.register' }
  | { kind: 'alert.subscribe'; pick: number; who: number }
  | { kind: 'restock'; pick: number; qty: number }

const pick = fc.nat({ max: 5 })
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('checkout.paid' as const),
    pick,
    qty: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({ kind: fc.constant('customer.register' as const) }),
  fc.record({ kind: fc.constant('alert.subscribe' as const), pick, who: fc.nat({ max: 2 }) }),
  fc.record({ kind: fc.constant('restock' as const), pick, qty: fc.integer({ min: 1, max: 3 }) }),
)

/**
 * Every run makes each kind of send at least once: a register, a paid checkout, a request (left pending, so its
 * confirmation is still owed when it is delivered) and the restock of the product the seeded subscribers wait on.
 */
const TOUR: Op[] = [
  { kind: 'customer.register' },
  { kind: 'checkout.paid', pick: 0, qty: 1 },
  { kind: 'alert.subscribe', pick: 2, who: 0 },
  { kind: 'restock', pick: 1, qty: 2 },
]

/** Confirmed on product 1 with the adapter up, so the restock during the outage owes each of them an alert. */
const SUBSCRIBERS = 2

/** Seeded with the adapter up: one product in stock and two sold out, for the alerts. */
const SEED = [
  { stock: 50, priceMinor: 1200 },
  { stock: 0, priceMinor: 900 },
  { stock: 0, priceMinor: 700 },
]

function refused(error: unknown): boolean {
  return (
    error instanceof NymbalError && !(error instanceof AdapterError || error instanceof ConfigError)
  )
}

const at = <T>(list: T[], i: number): T | undefined =>
  list.length === 0 ? undefined : list[i % list.length]

const sorted = <T>(list: T[]): T[] => [...list].sort((a, b) => String(a).localeCompare(String(b)))

/** Applies `o` through the services; true when it ran, false when the store refused it. */
async function apply(k: Kernel, world: World, run: string, o: Op) {
  const tag = randomUUID().slice(0, 8)
  const s = k.services
  try {
    switch (o.kind) {
      case 'checkout.paid': {
        const p = at(world.products, o.pick)!
        const cart = await s.cart.getOrCreate()
        await s.cart.addItem(cart.token, {
          variantId: p.variantId,
          productId: p.id,
          productName: 'outage product',
          variantName: 'Default',
          priceMinor: p.priceMinor,
          imageUrl: '',
          qty: o.qty,
        })
        // No `+stub-pending`: the stub pays inline, so order.paid.v1 is in the checkout's commit.
        await s.checkout.beginCheckout({
          cartToken: cart.token,
          email: `buyer-${run}-${tag}@outage.test`,
          billingAddress: address,
          shippingAddress: address,
        })
        return true
      }
      case 'customer.register': {
        const { customer } = await s.auth.register({
          email: `customer-${run}-${tag}@outage.test`,
          password: 'correct-horse-battery',
          firstName: 'Outage',
        })
        world.customers.push(customer.id)
        return true
      }
      case 'alert.subscribe': {
        const p = at(world.products, o.pick)!
        const email = `alert-${o.who}-${run}@outage.test`
        await s.alert.subscribe({
          email,
          variantId: p.variantId,
          kind: 'back_in_stock',
          origin: SHOP,
        })
        return true
      }
      case 'restock': {
        const p = at(world.products, o.pick)!
        await s.inventory.adjustStock(p.variantId, o.qty, 'manual', 'outage')
        return true
      }
    }
  } catch (error) {
    if (refused(error)) return false
    throw error
  }
}

async function seed(k: Kernel, raw: RawReader, run: string): Promise<World> {
  const world: World = { products: [], customers: [] }
  for (const [i, { stock, priceMinor }] of SEED.entries()) {
    const p = await k.services.product.create({
      slug: `outage-${run}-${i}`,
      name: `Outage ${run} ${i}`,
      description: '',
      status: 'active',
      variants: [
        {
          sku: `OUT-${run}-${i}`,
          name: 'Default',
          priceMinor,
          stock,
          lowStockThreshold: 0,
          options: [],
        },
      ],
    })
    world.products.push({ id: p.id, variantId: p.variants[0]!.id, priceMinor })
  }
  const waitedOn = world.products[1]!.variantId
  for (let i = 0; i < SUBSCRIBERS; i += 1) {
    const email = `fan-${i}-${run}@outage.test`
    await k.services.alert.subscribe({
      email,
      variantId: waitedOn,
      kind: 'back_in_stock',
      origin: SHOP,
    })
    const { confirm_token } = await raw.one<{ confirm_token: string }>(
      'SELECT confirm_token FROM alert_subscriptions WHERE email = ? AND variant_id = ?',
      [email, waitedOn],
    )
    await k.services.alert.confirm(confirm_token)
  }
  return world
}

/** Hands the log to the bus, moving the relay's clock a step each time, until every row is delivered or dead. */
async function drainedOut(k: Kernel, raw: RawReader, clock: { offset: number }): Promise<void> {
  await vi.waitFor(
    async () => {
      clock.offset += STEP_MS
      await k.app.relay.drain()
      const open = (await eventRows(raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
      expect(open.map((r) => r.type)).toEqual([])
    },
    { timeout: 20_000, interval: 20 },
  )
}

describe('AC-4: an email outage loses no send', () => {
  it('AC-4: property: with the email adapter down across generated command sequences (paid checkouts, registrations, alert requests and restocks) and the relay clock moved past 3 × the full backoff window, then the adapter up and the log drained: no events row is dead, every row is delivered, one order-placed email per paid order, one welcome per customer, one confirmation per alert request and one alert per alert.sent.v1, none twice, every send refused in the outage made once after it, and every read model equals a fresh rebuild', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 0, maxLength: 6 }), async (tail) => {
        const mail: TestMailAdapter = createTestMailAdapter()
        const clock = { offset: 0 }
        const k = await createKernel({
          dialect: 'sqlite',
          configure: storeConfig,
          // Every refused send is a handler failure the kernel logs at error.
          logger: createLogger({ pretty: false, level: 'silent' }),
          appOptions: {
            adapters: { email: mail },
            relay: {
              retryDelayMs: RETRY_DELAY_MS,
              now: () => new Date(Date.now() + clock.offset),
            },
          },
        })
        const raw = openRaw(k.dialect, k.target)
        const run = randomUUID().slice(0, 8)
        try {
          const world = await seed(k, raw, run)
          await k.app.relay.drain()
          const start = await maxSeq(raw)
          const sentBefore = mail.sent.length

          mail.down('test-mail: connection refused')
          let toured = 0
          for (const o of TOUR) if (await apply(k, world, run, o)) toured += 1
          expect(toured, 'a tour command was refused, so the run proves less than it says').toBe(
            TOUR.length,
          )
          for (const o of tail) await apply(k, world, run, o)
          for (let moved = 0; moved <= 3 * BACKOFF_WINDOW_MS; moved += STEP_MS) {
            clock.offset += STEP_MS
            await k.app.relay.drain()
          }
          expect(mail.sent.length, 'a send got through while the adapter was down').toBe(sentBefore)

          mail.up()
          await drainedOut(k, raw, clock)

          const log = await eventRows(raw, 'seq > ?', [start])
          expect(
            log.filter((r) => r.deadAt != null).map((r) => `${r.type} after ${r.attempts}`),
            'events dead after the outage',
          ).toEqual([])
          expect(
            log.filter((r) => r.deliveredAt == null).map((r) => r.type),
            'events never delivered',
          ).toEqual([])

          const payloads = (type: string) =>
            log
              .filter((r) => r.type === type)
              .map((r) => r.envelope.payload as Record<string, string>)
          const since = mail.sent.slice(sentBefore)
          const mailed = (...templates: string[]) =>
            since.filter((m) => templates.includes(m.template))

          const numbers = new Map(
            (
              await raw.rows<{ id: string; order_number: string }>(
                'SELECT id, order_number FROM orders',
              )
            ).map((r) => [r.id, r.order_number]),
          )
          const paid = [...new Set(payloads('order.paid.v1').map((p) => p['orderId']!))]
          expect(sorted(mailed('order-placed').map((m) => String(m.vars['orderNumber'])))).toEqual(
            sorted(paid.map((id) => numbers.get(id))),
          )
          expect(sorted(mailed('welcome').map((m) => m.to))).toEqual(
            sorted(payloads('customer.created.v1').map((p) => p['email']!)),
          )
          const subscribers = new Map(
            (
              await raw.rows<{ id: string; email: string }>(
                'SELECT id, email FROM alert_subscriptions',
              )
            ).map((r) => [r.id, r.email]),
          )
          expect(sorted(mailed('alert-confirm').map((m) => m.to))).toEqual(
            sorted(
              payloads('alert.requested.v1').map((p) => subscribers.get(p['subscriptionId']!)),
            ),
          )
          expect(sorted(mailed('alert-back-in-stock').map((m) => m.to))).toEqual(
            sorted(payloads('alert.sent.v1').map((p) => subscribers.get(p['subscriptionId']!))),
          )
          const key = (m: { template: string; to: string }) => `${m.template} ${m.to}`
          expect(sorted([...new Set(mail.refused.map(key))])).toEqual(
            sorted([...new Set(since.map(key))]),
          )
          expect(
            mailed('alert-back-in-stock').length,
            'alerts owed to the seeded subscribers',
          ).toBe(SUBSCRIBERS)

          const live = await documentModelsOf(k.documentStore)
          const liveIndex = await nativeSearchDocuments(k)
          const rebuilt = await rebuildFresh(k)
          for (const name of DOCUMENT_COLLECTIONS) {
            expect(live[name], `collection ${name}`).toEqual(rebuilt.documents[name])
          }
          expect(liveIndex, 'the search index').toEqual(rebuilt.search)
        } finally {
          await raw.close()
          await k.close()
        }
      }),
      { numRuns: 6, endOnFailure: true },
    )
  }, 120_000)
})
