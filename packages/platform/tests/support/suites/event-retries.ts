import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { describe, expect, it, vi } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  AdapterError,
  ConfigError,
  EVT_CATEGORY_CREATED,
  EVT_ORDER_SHIPPED,
  EVT_PRODUCT_CREATED,
  NymbalError,
  type EmailAdapter,
  type NymbalEvent,
  type ShippingAdapter,
  type TransactionalEmail,
} from '@nymbalhq/types'
import { withIdempotency } from '../../../src/handlers/idempotency.js'
import { createLogger } from '../../../src/logger.js'
import { startEventRetentionSweeper } from '../../../src/sweepers/event-retention-sweeper.js'
import { retryDeadOf, retryFloorOf, type DeadSelection } from '../../../src/tests/event-retry.js'
import { address, checkoutOf, seedVariant, type Dialect, type Kernel } from '../kernel.js'
import { eventRows, failPublishFor, maxSeq, type FailingBus } from '../outbox.js'
import { openRaw, writeRaw, type RawReader } from '../raw.js'
import {
  DOCUMENT_COLLECTIONS,
  documentModelsOf,
  nativeSearchDocuments,
  rebuildFresh,
} from '../read-models.js'
import { createTestShipAdapter, type TestShipAdapter } from '../test-ship.js'

// The relay's retries on one dialect. A named handler that throws leaves its event in the log; the relay hands it to
// the bus again until it is delivered or, after maxAttempts, dead, and the logs say which subscription failed (AC-4).
// A failed event waits retryDelayMs × 2^(attempts − 1) before its next attempt, whatever the drains in between, and a
// restart keeps the wait (AC-5). Every handler the kernel registers is unchanged in effect when every event is retried
// once (AC-6). State is read from the log by a second connection, mail from an adapter of the suite's own.

export interface RetriesOpen {
  /** A database `fresh` made; without it, one of the kernel's own. */
  target?: string
  configure?: (config: NymbalConfig) => NymbalConfig
  appOptions?: {
    adapters?: { email?: EmailAdapter; shipping?: ShippingAdapter }
    relay?: { retryDelayMs?: number; maxAttempts?: number; now?: () => Date }
  }
  logger?: Kernel['logger']
}

export interface RetriesSuiteOptions {
  /** A kernel migrated to the newest migration, on `target` when given. */
  open(opts: RetriesOpen): Promise<Kernel>
  /** An empty database for `open`: a SQLite file path or a Postgres URL. */
  fresh(): Promise<string>
  /** Runs of the single-event properties. */
  propertyRuns: number
  /** Runs of the command-sequence property: each one a fresh kernel. */
  sequenceRuns: number
}

/** The relay's default. */
const MAX_ATTEMPTS = 5
const SHOP = 'http://retries-shop.test'

interface LogEntry {
  level: number
  msg?: string
  eventId?: unknown
  failed?: Array<{ subscription?: unknown; message?: unknown }>
}

function keptLogger(lines: string[]): Kernel['logger'] {
  return createLogger({
    pretty: false,
    level: 'warn',
    destination: { write: (line: string) => void lines.push(line) },
  })
}

const entries = (lines: string[]): LogEntry[] => lines.map((line) => JSON.parse(line) as LogEntry)

/** The relay's lines about one event's failed delivery that name the failing subscription. */
function failureLines(lines: string[], level: number, eventId: string, subscription: string) {
  return entries(lines).filter(
    (e) =>
      e.level === level &&
      e.eventId === eventId &&
      (e.failed ?? []).some((f) => f.subscription === subscription),
  )
}

/** A timestamp column as an instant, whichever way the dialect stores it. */
function instant(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  const n = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n
  return Date.parse(String(value))
}

/** The row's retry_at, read raw: the column is not part of LoggedEvent. */
async function retryAtOf(raw: RawReader, id: string): Promise<number | null> {
  const row = await raw.one<{ retry_at: unknown }>('SELECT retry_at FROM events WHERE id = ?', [id])
  return row.retry_at === null || row.retry_at === undefined ? null : instant(row.retry_at)
}

async function onlyRow(raw: RawReader, afterSeq: number, type: string) {
  const rows = await eventRows(raw, 'seq > ? AND type = ?', [afterSeq, type])
  expect(
    rows.map((r) => r.type),
    `${type} rows appended`,
  ).toEqual([type])
  return rows[0]!
}

function counter(): { add(id: string): number; of(id: string): number } {
  const counts = new Map<string, number>()
  return {
    add(id) {
      const n = (counts.get(id) ?? 0) + 1
      counts.set(id, n)
      return n
    },
    of: (id) => counts.get(id) ?? 0,
  }
}

// ─── AC-6: the store's own handlers under a saboteur ──────────────────────────────────────────────────────────────

interface Capture {
  adapter: EmailAdapter
  sent: TransactionalEmail[]
  /** Addresses every send to is refused, until removed. */
  refuse: Set<string>
}

function capture(): Capture {
  const sent: TransactionalEmail[] = []
  const refuse = new Set<string>()
  const adapter: EmailAdapter = {
    kind: 'email',
    providerName: 'retries-capture',
    capabilities: () => ['transactional'],
    producesEvents: [],
    consumesEvents: [],
    initialize: async () => undefined,
    healthCheck: async () => ({ status: 'healthy' }),
    async sendTransactional(message) {
      if (refuse.has(message.to)) throw new Error(`the capture refuses ${message.to}`)
      sent.push(message)
      return { messageId: `retries-${sent.length}`, accepted: true }
    },
    syncCustomerToList: async () => undefined,
    removeCustomerFromList: async () => undefined,
  }
  return { adapter, sent, refuse }
}

const storeConfig = (config: NymbalConfig): NymbalConfig =>
  ({
    ...config,
    commerce: { ...config.commerce, email: { provider: 'custom' } },
    http: { ...config.http, cors: { ...config.http.cors, allowedOrigins: [SHOP] } },
  }) as NymbalConfig

const WORDS = ['wool', 'linen', 'cedar', 'amber', 'slate', 'fern'] as const

interface World {
  categories: string[]
  products: Array<{ id: string; variants: Array<{ id: string; priceMinor: number }> }>
  orders: string[]
  customers: string[]
  visitors: string[]
}

type Op =
  | { kind: 'category.create'; word: string }
  | { kind: 'category.rename'; pick: number; word: string }
  | { kind: 'category.delete'; pick: number }
  | {
      kind: 'product.create'
      word: string
      categories: number[]
      priceMinor: number
      stock: number
    }
  | { kind: 'product.update'; pick: number; word: string | null; categories: number[] | null }
  | { kind: 'product.delete'; pick: number }
  | { kind: 'stock.adjust'; pick: number; delta: number }
  | { kind: 'price.change'; pick: number; delta: number }
  | { kind: 'checkout.paid'; pick: number; qty: number; customer: number | null }
  | { kind: 'order.advance'; pick: number }
  | { kind: 'customer.register'; word: string }
  | { kind: 'view.guest'; visitor: number; pick: number }
  | { kind: 'view.customer'; customer: number; pick: number }
  | { kind: 'sign-in.fold'; visitor: number; customer: number }
  | { kind: 'alert.subscribe'; pick: number; who: number; priceDrop: boolean }

const word = fc.constantFrom(...WORDS)
const pick = fc.nat({ max: 30 })
const picks = fc.uniqueArray(fc.nat({ max: 4 }), { maxLength: 2 })

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('category.create' as const), word }),
  fc.record({ kind: fc.constant('category.rename' as const), pick, word }),
  fc.record({ kind: fc.constant('category.delete' as const), pick }),
  fc.record({
    kind: fc.constant('product.create' as const),
    word,
    categories: picks,
    priceMinor: fc.integer({ min: 200, max: 9_000 }),
    stock: fc.integer({ min: 0, max: 4 }),
  }),
  fc.record({
    kind: fc.constant('product.update' as const),
    pick,
    word: fc.option(word, { nil: null }),
    categories: fc.option(picks, { nil: null }),
  }),
  fc.record({ kind: fc.constant('product.delete' as const), pick }),
  fc.record({
    kind: fc.constant('stock.adjust' as const),
    pick,
    delta: fc.integer({ min: -3, max: 3 }),
  }),
  fc.record({
    kind: fc.constant('price.change' as const),
    pick,
    delta: fc.integer({ min: -150, max: 150 }),
  }),
  fc.record({
    kind: fc.constant('checkout.paid' as const),
    pick,
    qty: fc.integer({ min: 1, max: 2 }),
    customer: fc.option(fc.nat({ max: 3 }), { nil: null }),
  }),
  fc.record({ kind: fc.constant('order.advance' as const), pick }),
  fc.record({ kind: fc.constant('customer.register' as const), word }),
  fc.record({ kind: fc.constant('view.guest' as const), visitor: fc.nat({ max: 1 }), pick }),
  fc.record({ kind: fc.constant('view.customer' as const), customer: fc.nat({ max: 3 }), pick }),
  fc.record({
    kind: fc.constant('sign-in.fold' as const),
    visitor: fc.nat({ max: 1 }),
    customer: fc.nat({ max: 3 }),
  }),
  fc.record({
    kind: fc.constant('alert.subscribe' as const),
    pick,
    who: fc.nat({ max: 2 }),
    priceDrop: fc.boolean(),
  }),
)

/**
 * The tour every run starts with: categories, a product created in one, updated into the other and deleted; a
 * customer registered; a paid checkout taken to delivered; two back-in-stock subscribers confirmed on a sold-out
 * variant, then its restock; one price-drop subscriber confirmed, then a lower price; guest and customer views, the
 * guest signing in, and a product deleted.
 */
const TOUR: Op[] = [
  { kind: 'category.create', word: 'wool' },
  { kind: 'category.create', word: 'linen' },
  { kind: 'product.create', word: 'cedar', categories: [0], priceMinor: 1500, stock: 5 },
  { kind: 'product.create', word: 'amber', categories: [1], priceMinor: 900, stock: 0 },
  { kind: 'product.create', word: 'slate', categories: [0, 1], priceMinor: 700, stock: 2 },
  { kind: 'product.update', pick: 0, word: 'fern', categories: [1] },
  { kind: 'category.rename', pick: 0, word: 'cedar' },
  { kind: 'customer.register', word: 'slate' },
  { kind: 'checkout.paid', pick: 0, qty: 1, customer: 0 },
  { kind: 'order.advance', pick: 0 },
  { kind: 'order.advance', pick: 0 },
  { kind: 'order.advance', pick: 0 },
  { kind: 'alert.subscribe', pick: 1, who: 0, priceDrop: false },
  { kind: 'alert.subscribe', pick: 1, who: 1, priceDrop: false },
  { kind: 'stock.adjust', pick: 1, delta: 2 },
  { kind: 'alert.subscribe', pick: 0, who: 2, priceDrop: true },
  { kind: 'price.change', pick: 0, delta: -300 },
  { kind: 'view.guest', visitor: 0, pick: 0 },
  { kind: 'view.customer', customer: 0, pick: 1 },
  { kind: 'view.guest', visitor: 0, pick: 1 },
  { kind: 'sign-in.fold', visitor: 0, customer: 0 },
  { kind: 'product.delete', pick: 2 },
]

const at = <T>(list: T[], i: number): T | undefined =>
  list.length === 0 ? undefined : list[i % list.length]

function refused(error: unknown): boolean {
  return (
    error instanceof NymbalError && !(error instanceof AdapterError || error instanceof ConfigError)
  )
}

const NEXT_STATUS = {
  confirmed: 'processing',
  processing: 'shipped',
  shipped: 'delivered',
} as const

/** Applies `o` through the services; true when it ran, false when the store refused it or it had nothing to act on. */
async function apply(
  k: Kernel,
  raw: RawReader,
  world: World,
  run: string,
  o: Op,
): Promise<boolean> {
  const tag = randomUUID().slice(0, 8)
  const s = k.services
  try {
    switch (o.kind) {
      case 'category.create': {
        const c = await s.category.create({
          slug: `cat-${o.word}-${tag}`,
          name: `${o.word} ${tag}`,
        })
        world.categories.push(c.id)
        return true
      }
      case 'category.rename': {
        const id = at(world.categories, o.pick)
        if (id === undefined) return false
        await s.category.update(id, { name: `${o.word} renamed ${tag}` })
        return true
      }
      case 'category.delete': {
        const id = at(world.categories, o.pick)
        if (id === undefined) return false
        await s.category.delete(id)
        world.categories = world.categories.filter((c) => c !== id)
        return true
      }
      case 'product.create': {
        const categoryIds = [...new Set(o.categories.flatMap((i) => at(world.categories, i) ?? []))]
        const p = await s.product.create({
          slug: `p-${o.word}-${tag}`,
          name: `${o.word} ${tag}`,
          description: `a ${o.word} thing`,
          status: 'active',
          categoryIds,
          variants: [
            {
              sku: `RETRY-${tag}`,
              name: 'Default',
              priceMinor: o.priceMinor,
              stock: o.stock,
              lowStockThreshold: 0,
              options: [],
            },
          ],
        })
        world.products.push({
          id: p.id,
          variants: p.variants.map((v) => ({ id: v.id, priceMinor: v.priceMinor })),
        })
        return true
      }
      case 'product.update': {
        const p = at(world.products, o.pick)
        if (p === undefined) return false
        await s.product.update(p.id, {
          ...(o.word !== null && { name: `${o.word} ${tag}` }),
          ...(o.categories !== null && {
            categoryIds: [...new Set(o.categories.flatMap((i) => at(world.categories, i) ?? []))],
          }),
        })
        return true
      }
      case 'product.delete': {
        const p = at(world.products, o.pick)
        if (p === undefined) return false
        await s.product.delete(p.id)
        world.products = world.products.filter((x) => x.id !== p.id)
        return true
      }
      case 'stock.adjust': {
        const v = at(world.products, o.pick)?.variants[0]
        if (v === undefined || o.delta === 0) return false
        await s.inventory.adjustStock(v.id, o.delta, 'manual', 'retries')
        return true
      }
      case 'price.change': {
        const p = at(world.products, o.pick)
        const v = p?.variants[0]
        if (p === undefined || v === undefined || o.delta === 0) return false
        const priceMinor = Math.max(1, v.priceMinor + o.delta)
        await s.product.update(p.id, { variants: [{ id: v.id, priceMinor }] })
        v.priceMinor = priceMinor
        return true
      }
      case 'checkout.paid': {
        const p = at(world.products, o.pick)
        const v = p?.variants[0]
        if (p === undefined || v === undefined) return false
        const customerId = o.customer === null ? null : (at(world.customers, o.customer) ?? null)
        const cart = await s.cart.getOrCreate(undefined, customerId)
        await s.cart.addItem(cart.token, {
          variantId: v.id,
          productId: p.id,
          productName: 'retried product',
          variantName: 'Default',
          priceMinor: v.priceMinor,
          imageUrl: '',
          qty: o.qty,
        })
        // No `+stub-pending`: the stub pays inline, so order.paid.v1 is in the checkout's commit.
        const started = await s.checkout.beginCheckout({
          cartToken: cart.token,
          customerId,
          email: `buyer-${run}-${tag}@retries.test`,
          billingAddress: address,
          shippingAddress: address,
        })
        world.orders.push(started.orderId)
        return true
      }
      case 'order.advance': {
        const id = at(world.orders, o.pick)
        if (id === undefined) return false
        const { status } = await raw.one<{ status: string }>(
          'SELECT status FROM orders WHERE id = ?',
          [id],
        )
        const next = NEXT_STATUS[status as keyof typeof NEXT_STATUS]
        if (next === undefined) return false
        if (next === 'processing') await s.order.updateStatus(id, 'processing', 'retries')
        else if (next === 'shipped')
          await s.order.markShipped(id, `TRK-${tag}`, 'royal-mail', 'retries')
        else await s.order.markDelivered(id, 'retries')
        return true
      }
      case 'customer.register': {
        const { customer } = await s.auth.register({
          email: `${o.word}-${run}-${tag}@retries.test`,
          password: 'correct-horse-battery',
          firstName: o.word,
        })
        world.customers.push(customer.id)
        return true
      }
      case 'view.guest': {
        const p = at(world.products, o.pick)
        if (p === undefined) return false
        return s.recentlyViewed.record({ kind: 'visitor', id: world.visitors[o.visitor]! }, p.id)
      }
      case 'view.customer': {
        const p = at(world.products, o.pick)
        const id = at(world.customers, o.customer)
        if (p === undefined || id === undefined) return false
        return s.recentlyViewed.record({ kind: 'customer', id }, p.id)
      }
      case 'sign-in.fold': {
        const id = at(world.customers, o.customer)
        if (id === undefined) return false
        await s.recentlyViewed.fold(world.visitors[o.visitor]!, id)
        return true
      }
      case 'alert.subscribe': {
        const v = at(world.products, o.pick)?.variants[0]
        if (v === undefined) return false
        const email = `alert-${o.who}-${run}@retries.test`
        const kind = o.priceDrop ? 'price_drop' : 'back_in_stock'
        await s.alert.subscribe({ email, variantId: v.id, kind, origin: SHOP })
        const [row] = await raw.rows<{ confirm_token: string; status: string }>(
          'SELECT confirm_token, status FROM alert_subscriptions WHERE email = ? AND variant_id = ? AND kind = ?',
          [email, v.id, kind],
        )
        if (row !== undefined && row.status === 'pending') await s.alert.confirm(row.confirm_token)
        return true
      }
    }
  } catch (error) {
    if (refused(error)) return false
    throw error
  }
}

const sorted = <T>(list: T[]): T[] => [...list].sort((a, b) => String(a).localeCompare(String(b)))

/** Hands the log to the bus until every event is delivered or dead. */
async function drainedOut(k: Kernel, raw: RawReader): Promise<void> {
  await vi.waitFor(
    async () => {
      await k.app.relay.drain()
      const open = (await eventRows(raw)).filter((r) => r.deliveredAt == null && r.deadAt == null)
      expect(open.map((r) => r.type)).toEqual([])
    },
    { timeout: 20_000, interval: 20 },
  )
}

// ─── The suite ────────────────────────────────────────────────────────────────────────────────────────────────────

export function eventRetriesSuite(dialect: Dialect, options: RetriesSuiteOptions): void {
  describe(`event delivery retries (${dialect})`, () => {
    it(`AC-4: property: a named handler that fails its first f deliveries (f from 0 to ${MAX_ATTEMPTS + 1}) leaves the event delivered iff f < maxAttempts, with attempts min(f, maxAttempts) and dead_at iff f ≥ maxAttempts; a dead event is never handed to the bus again; a keyed side effect beside it lands once; each failure's warn line and the dead event's error line name the subscription and the event`, async () => {
      const lines: string[] = []
      const k = await options.open({ logger: keptLogger(lines) })
      const raw = openRaw(k.dialect, k.target)
      const PROBE = 'retries-probe'
      const EFFECT = 'retries-effect'
      const delivered = counter()
      const effects = counter()
      const failuresLeft = new Map<string, number>()
      let nextF = 0
      try {
        await k.eventBus.subscribe(
          EVT_CATEGORY_CREATED,
          async (e: NymbalEvent<unknown>) => {
            delivered.add(e.id)
            if (!failuresLeft.has(e.id)) failuresLeft.set(e.id, nextF)
            const left = failuresLeft.get(e.id)!
            if (left > 0) {
              failuresLeft.set(e.id, left - 1)
              throw new Error(`the probe refuses ${e.id}`)
            }
          },
          { name: PROBE },
        )
        await k.eventBus.subscribe(
          EVT_CATEGORY_CREATED,
          withIdempotency(EFFECT, async (e: NymbalEvent<unknown>) => void effects.add(e.id), {
            repo: k.repos.processedEvent,
          }),
          { name: EFFECT },
        )

        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 0, max: MAX_ATTEMPTS + 1 }), async (f) => {
            nextF = f
            const before = await maxSeq(raw)
            await k.services.category.create({ slug: `retry-${randomUUID()}`, name: 'Retried' })
            const { id } = await onlyRow(raw, before, EVT_CATEGORY_CREATED)
            for (let drain = 0; drain < MAX_ATTEMPTS + 2; drain += 1) await k.app.relay.drain()

            const [row] = await eventRows(raw, 'id = ?', [id])
            const label = `f = ${f}`
            expect(row!.deliveredAt != null, `${label}: delivered`).toBe(f < MAX_ATTEMPTS)
            expect(row!.attempts, `${label}: attempts`).toBe(Math.min(f, MAX_ATTEMPTS))
            expect(row!.deadAt != null, `${label}: dead`).toBe(f >= MAX_ATTEMPTS)
            expect(delivered.of(id), `${label}: handed to the bus`).toBe(
              f < MAX_ATTEMPTS ? f + 1 : MAX_ATTEMPTS,
            )
            expect(effects.of(id), `${label}: the keyed side effect`).toBe(1)
            expect(failureLines(lines, 40, id, PROBE).length, `${label}: warn lines`).toBe(
              Math.min(f, MAX_ATTEMPTS - 1),
            )
            const dead = failureLines(lines, 50, id, PROBE).filter((e) => /dead/i.test(e.msg ?? ''))
            expect(dead.length, `${label}: the dead event's error line`).toBe(
              f >= MAX_ATTEMPTS ? 1 : 0,
            )
          }),
          {
            numRuns: options.propertyRuns,
            examples: [[0], [1], [MAX_ATTEMPTS - 1], [MAX_ATTEMPTS], [MAX_ATTEMPTS + 1]],
          },
        )
      } finally {
        await raw.close()
        await k.close()
      }
    }, 300_000)

    it('AC-5: with retryDelayMs d and an injected clock, retry_at after failure k is the failure time + d × 2^(k−1); drains before it, the commit drains of other commands among them, leave the bus call count unchanged; the first drain at retry_at hands the event to the bus; a new app over the same database keeps the wait', async () => {
      const target = await options.fresh()
      const DELAY = 60_000
      const clock = { at: Date.now() }
      const now = () => new Date(clock.at)
      const open = () =>
        options.open({ target, appOptions: { relay: { retryDelayMs: DELAY, now } } })
      // The bus refuses every product.created.v1, so each drain that hands the event over is one more failure.
      const refusals: FailingBus[] = []
      const handedOver = (id: string) =>
        refusals.reduce((n, f) => n + f.rejected.filter((r) => r === id).length, 0)
      let k = await open()
      let raw = openRaw(k.dialect, k.target)
      try {
        refusals.push(failPublishFor(k.eventBus, [EVT_PRODUCT_CREATED]))
        const before = await maxSeq(raw)
        let failedAt = clock.at
        await seedVariant(k, 1)
        const { id } = await onlyRow(raw, before, EVT_PRODUCT_CREATED)

        for (let failure = 1; failure < MAX_ATTEMPTS; failure += 1) {
          const [row] = await eventRows(raw, 'id = ?', [id])
          expect([row!.attempts, row!.deliveredAt ?? null], `after failure ${failure}`).toEqual([
            failure,
            null,
          ])
          expect(handedOver(id), `bus calls after failure ${failure}`).toBe(failure)
          const retryAt = await retryAtOf(raw, id)
          expect(retryAt, `retry_at after failure ${failure}`).toBe(
            failedAt + DELAY * 2 ** (failure - 1),
          )

          clock.at = retryAt! - 1
          await k.services.category.create({ slug: `traffic-${randomUUID()}`, name: 'Traffic' })
          await k.app.relay.drain()
          expect(handedOver(id), `drains before retry_at, after failure ${failure}`).toBe(failure)

          if (failure === 2) {
            await raw.close()
            await k.close()
            k = await open()
            raw = openRaw(k.dialect, k.target)
            refusals.push(failPublishFor(k.eventBus, [EVT_PRODUCT_CREATED]))
            await k.app.relay.drain()
            const [kept] = await eventRows(raw, 'id = ?', [id])
            expect([kept!.attempts, kept!.deliveredAt ?? null], 'after the restart').toEqual([
              failure,
              null,
            ])
            expect(await retryAtOf(raw, id), 'retry_at after the restart').toBe(retryAt)
            expect(handedOver(id), 'the restart handed the waiting event to the bus').toBe(failure)
          }

          clock.at = retryAt!
          failedAt = clock.at
          await k.app.relay.drain()
          expect(handedOver(id), `the first drain at retry_at, after failure ${failure}`).toBe(
            failure + 1,
          )
        }

        const [dead] = await eventRows(raw, 'id = ?', [id])
        expect([dead!.attempts, dead!.deadAt != null]).toEqual([MAX_ATTEMPTS, true])
      } finally {
        for (const f of refusals) f.restore()
        await raw.close()
        await k.close()
      }
    }, 120_000)

    it('AC-6: property: with a named saboteur on * that throws on the first delivery of every event, over generated command sequences through the services (a fixed tour of a paid checkout taken to delivered, a register, product create, update and delete, category edits, a restock with two active alert subscribers, a price drop with one, views and a visitor merge, then a generated tail), once every event is delivered each read-model collection and the search index equal a fresh rebuild document by document; one order-placed email per paid order, one shipped email per order.shipped, one welcome per customer, one confirmation per alert request, one alert per alert.sent.v1 and none twice for a row and trigger, one review request per delivered order; and every event took exactly one retry', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(op, { minLength: 2, maxLength: 10 }), async (tail) => {
          const mail = capture()
          const k = await options.open({
            configure: storeConfig,
            appOptions: { adapters: { email: mail.adapter } },
          })
          const raw = openRaw(k.dialect, k.target)
          const reviews: string[] = []
          const run = randomUUID().slice(0, 8)
          try {
            const adapter = k.app.adapters.reviews
            const requestReview = adapter.requestReview.bind(adapter)
            adapter.requestReview = async (orderId: string) => {
              reviews.push(orderId)
              return requestReview(orderId)
            }
            const sabotaged = new Set<string>()
            await k.eventBus.subscribe(
              '*',
              async (e: NymbalEvent<unknown>) => {
                if (sabotaged.has(e.id)) return
                sabotaged.add(e.id)
                throw new Error(`the saboteur refuses ${e.id} once`)
              },
              { name: 'retries-saboteur' },
            )
            const start = await maxSeq(raw)
            const world: World = {
              categories: [],
              products: [],
              orders: [],
              customers: [],
              visitors: [uuidv7(), uuidv7()],
            }
            let toured = 0
            for (const o of TOUR) if (await apply(k, raw, world, run, o)) toured += 1
            expect(toured, 'a tour command was refused, so the run proves less than it says').toBe(
              TOUR.length,
            )
            for (const o of tail) await apply(k, raw, world, run, o)
            await drainedOut(k, raw)

            const log = await eventRows(raw, 'seq > ?', [start])
            expect(
              log
                .filter((r) => r.attempts !== 1 || r.deliveredAt == null)
                .map((r) => [r.type, r.attempts]),
              'events not delivered on their first retry',
            ).toEqual([])

            const live = await documentModelsOf(k.documentStore)
            const liveIndex = await nativeSearchDocuments(k)
            const rebuilt = await rebuildFresh(k)
            for (const name of DOCUMENT_COLLECTIONS) {
              expect(live[name], `collection ${name}`).toEqual(rebuilt.documents[name])
            }
            expect(liveIndex, 'the search index').toEqual(rebuilt.search)

            const payloads = (type: string) =>
              log
                .filter((r) => r.type === type)
                .map((r) => r.envelope.payload as Record<string, string>)
            const mailed = (...templates: string[]) =>
              mail.sent.filter((m) => templates.includes(m.template))

            const numbers = new Map(
              (
                await raw.rows<{ id: string; order_number: string }>(
                  'SELECT id, order_number FROM orders',
                )
              ).map((r) => [r.id, r.order_number]),
            )
            const paid = [...new Set(payloads('order.paid.v1').map((p) => p['orderId']!))]
            expect(
              sorted(mailed('order-placed').map((m) => String(m.vars['orderNumber']))),
            ).toEqual(sorted(paid.map((id) => numbers.get(id))))
            // The tour ships one order; a retried order.shipped.v1 must not mail its shopper twice.
            expect(
              sorted(mailed('order-shipped').map((m) => String(m.vars['orderNumber']))),
              'shipped emails against order.shipped.v1, by order number',
            ).toEqual(sorted(payloads('order.shipped.v1').map((p) => numbers.get(p['orderId']!))))

            expect(sorted(mailed('welcome').map((m) => m.to))).toEqual(
              sorted(payloads('customer.created.v1').map((p) => p['email']!)),
            )

            const rows = new Map(
              (
                await raw.rows<{ id: string; email: string }>(
                  'SELECT id, email FROM alert_subscriptions',
                )
              ).map((r) => [r.id, r.email]),
            )
            expect(
              sorted(mailed('alert-confirm', 'alert-confirm-price-drop').map((m) => m.to)),
            ).toEqual(
              sorted(payloads('alert.requested.v1').map((p) => rows.get(p['subscriptionId']!))),
            )

            const sent = payloads('alert.sent.v1')
            const template = {
              back_in_stock: 'alert-back-in-stock',
              price_drop: 'alert-price-drop',
            }
            expect(
              sorted(
                mailed('alert-back-in-stock', 'alert-price-drop').map(
                  (m) => `${m.template} ${m.to}`,
                ),
              ),
            ).toEqual(
              sorted(
                sent.map(
                  (p) =>
                    `${template[p['kind'] as keyof typeof template]} ${rows.get(p['subscriptionId']!)}`,
                ),
              ),
            )
            const pairs = sent.map((p) => `${p['subscriptionId']} ${p['triggerEventId']}`)
            expect(new Set(pairs).size, 'a row alerted twice for one trigger').toBe(pairs.length)
            // The tour's restock and price drop alert all three of its subscribers.
            expect(sorted([...new Set(sent.map((p) => p['kind']))])).toEqual([
              'back_in_stock',
              'price_drop',
            ])

            expect(sorted(reviews)).toEqual(
              sorted([...new Set(payloads('order.delivered.v1').map((p) => p['orderId']!))]),
            )
          } finally {
            await raw.close()
            await k.close()
          }
        }),
        { numRuns: options.sequenceRuns, endOnFailure: true },
      )
    }, 600_000)
  })

  describe(`retrying a dead event (${dialect})`, () => {
    const NOT_DEAD_BEFORE = new Date(0)

    /** Puts the dead rows the selection takes back in the log, as `nymbal events retry` does. */
    const retry = (k: Kernel, selection: DeadSelection = {}) =>
      k.store.transaction((tx) =>
        retryDeadOf(k.repos.eventLog)(tx, selection, { floor: NOT_DEAD_BEFORE, limit: 100 }),
      )

    /** The relay's retries, one pass each: with retryDelayMs 0 each pass is one more attempt. */
    async function drains(k: Kernel, passes: number): Promise<void> {
      for (let pass = 0; pass < passes; pass += 1) await k.app.relay.drain()
    }

    const trackingConfig = (config: NymbalConfig): NymbalConfig => {
      const base = storeConfig(config)
      return {
        ...base,
        commerce: { ...base.commerce, shipping: { provider: 'custom' } },
      } as NymbalConfig
    }

    interface ShippingStore {
      k: Kernel
      raw: RawReader
      mail: Capture
      ship: TestShipAdapter
    }

    async function openShippingStore(): Promise<ShippingStore> {
      const mail = capture()
      const ship = createTestShipAdapter()
      const k = await options.open({
        configure: trackingConfig,
        appOptions: { adapters: { email: mail.adapter, shipping: ship } },
      })
      return { k, raw: openRaw(k.dialect, k.target), mail, ship }
    }

    /** An order shipped while the tracking provider rejects it: its email goes out on the first delivery and the event dies. */
    async function shippedEventDead(store: ShippingStore): Promise<{ id: string; number: string }> {
      const { k, raw, ship } = store
      const seeded = await seedVariant(k, 5)
      const started = await checkoutOf(k, seeded, 1, `shipped-${randomUUID()}@retries.test`)
      await k.services.order.updateStatus(started.orderId, 'processing', 'retries')
      ship.rejectNext(MAX_ATTEMPTS)
      const number = `TRK${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`
      const before = await maxSeq(raw)
      await k.services.order.markShipped(started.orderId, number, 'royal-mail', 'retries')
      const { id } = await onlyRow(raw, before, EVT_ORDER_SHIPPED)
      await drains(k, MAX_ATTEMPTS - 1)
      const [row] = await eventRows(raw, 'id = ?', [id])
      expect([row!.attempts, row!.deadAt != null], 'the shipped event, killed by tracking').toEqual(
        [MAX_ATTEMPTS, true],
      )
      return { id, number }
    }

    it('AC-4: a dead event, whose last failure left it a wait of minutes, is delivered once on the next relay pass after retryDead, with attempts 0 and no dead_at, and not again by the pass after it', async () => {
      const DELAY = 60_000
      const clock = { at: Date.now() }
      const k = await options.open({
        appOptions: { relay: { retryDelayMs: DELAY, now: () => new Date(clock.at) } },
      })
      const raw = openRaw(k.dialect, k.target)
      try {
        const refusing = failPublishFor(k.eventBus, [EVT_CATEGORY_CREATED])
        const before = await maxSeq(raw)
        await k.services.category.create({ slug: `dead-${randomUUID()}`, name: 'Dead' })
        const { id } = await onlyRow(raw, before, EVT_CATEGORY_CREATED)
        for (let failure = 1; failure < MAX_ATTEMPTS; failure += 1) {
          clock.at = (await retryAtOf(raw, id))!
          await k.app.relay.drain()
        }
        const [dead] = await eventRows(raw, 'id = ?', [id])
        expect([dead!.attempts, dead!.deadAt != null], 'the event is dead').toEqual([
          MAX_ATTEMPTS,
          true,
        ])
        expect(await retryAtOf(raw, id), 'its last wait is still ahead').toBeGreaterThan(clock.at)

        const delivered = counter()
        await k.eventBus.subscribe(
          EVT_CATEGORY_CREATED,
          async (e: NymbalEvent<unknown>) => void delivered.add(e.id),
          { name: 'retries-after-dead' },
        )
        refusing.restore()
        clock.at += 1_000
        await retry(k)
        await k.app.relay.drain()

        expect(delivered.of(id), 'deliveries on the pass after the retry').toBe(1)
        const [row] = await eventRows(raw, 'id = ?', [id])
        expect([row!.deliveredAt != null, row!.attempts, row!.deadAt ?? null]).toEqual([
          true,
          0,
          null,
        ])

        await k.app.relay.drain()
        expect(delivered.of(id), 'deliveries after one more pass').toBe(1)
      } finally {
        await raw.close()
        await k.close()
      }
    }, 60_000)

    it(`AC-5: property: after a retry, a handler that fails its next f deliveries (f from 0 to ${MAX_ATTEMPTS + 1}) leaves the event delivered iff f < maxAttempts, with attempts min(f, maxAttempts) and dead_at iff f ≥ maxAttempts; the bus takes it exactly min(f + 1, maxAttempts) more times and never again from later passes`, async () => {
      const k = await options.open({})
      const raw = openRaw(k.dialect, k.target)
      const PROBE = 'retries-after-retry'
      let failing: number | 'always' = 'always'
      const called = counter()
      try {
        await k.eventBus.subscribe(
          EVT_CATEGORY_CREATED,
          async (e: NymbalEvent<unknown>) => {
            called.add(e.id)
            if (failing === 'always') throw new Error(`the probe refuses ${e.id}`)
            if (failing > 0) {
              failing -= 1
              throw new Error(`the probe refuses ${e.id} again`)
            }
          },
          { name: PROBE },
        )
        await fc.assert(
          fc.asyncProperty(fc.integer({ min: 0, max: MAX_ATTEMPTS + 1 }), async (f) => {
            failing = 'always'
            const before = await maxSeq(raw)
            await k.services.category.create({ slug: `retry-${randomUUID()}`, name: 'Retried' })
            const { id } = await onlyRow(raw, before, EVT_CATEGORY_CREATED)
            await drains(k, MAX_ATTEMPTS - 1)
            const [dead] = await eventRows(raw, 'id = ?', [id])
            expect([dead!.attempts, dead!.deadAt != null], 'dead before the retry').toEqual([
              MAX_ATTEMPTS,
              true,
            ])
            const handedBefore = called.of(id)

            failing = f
            await retry(k, { id })
            await drains(k, MAX_ATTEMPTS + 2)

            const label = `f = ${f}`
            const [row] = await eventRows(raw, 'id = ?', [id])
            expect(called.of(id) - handedBefore, `${label}: bus calls after the retry`).toBe(
              Math.min(f + 1, MAX_ATTEMPTS),
            )
            expect(row!.deliveredAt != null, `${label}: delivered`).toBe(f < MAX_ATTEMPTS)
            expect(row!.attempts, `${label}: attempts`).toBe(Math.min(f, MAX_ATTEMPTS))
            expect(row!.deadAt != null, `${label}: dead`).toBe(f >= MAX_ATTEMPTS)
          }),
          {
            numRuns: options.propertyRuns,
            examples: [[0], [1], [MAX_ATTEMPTS - 1], [MAX_ATTEMPTS], [MAX_ATTEMPTS + 1]],
          },
        )
      } finally {
        await raw.close()
        await k.close()
      }
    }, 300_000)

    it('AC-7: an order.shipped.v1 that mailed its customer and died on a failing shipping-start-tracking: once the failure is fixed, a retry registers the tracking number, sends no second shipped email and leaves the audit entries as they were', async () => {
      const store = await openShippingStore()
      const { k, raw, mail, ship } = store
      try {
        const { id, number } = await shippedEventDead(store)
        const mailed = () => mail.sent.filter((m) => m.template === 'order-shipped').length
        expect(mailed(), 'the shipped email, sent on the first delivery').toBe(1)
        const callsBefore = ship.startCalls.length
        const auditBefore = await raw.count('audit_entries')

        await retry(k, { id })
        await k.app.relay.drain()

        const [row] = await eventRows(raw, 'id = ?', [id])
        expect(row!.deliveredAt != null, 'the event is delivered').toBe(true)
        expect(
          ship.startCalls.slice(callsBefore).map((c) => c.trackingNumber),
          'tracking numbers registered after the retry',
        ).toEqual([number])
        expect(ship.startAnswers.at(-1)).toBe('tracking')
        expect(mailed(), 'shipped emails after the retry').toBe(1)
        expect(await raw.count('audit_entries'), 'audit entries').toBe(auditBefore)
      } finally {
        await raw.close()
        await k.close()
      }
    }, 120_000)

    it('AC-7: a product.restocked.v1 that mailed one subscriber and failed another until it died: once the mail is fixed, a retry mails only the row that failed', async () => {
      const mail = capture()
      const k = await options.open({
        configure: storeConfig,
        appOptions: { adapters: { email: mail.adapter } },
      })
      const raw = openRaw(k.dialect, k.target)
      try {
        const seeded = await seedVariant(k, 0)
        const tag = randomUUID().slice(0, 8)
        const emails = [`mailed-${tag}@retries.test`, `refused-${tag}@retries.test`]
        for (const email of emails) {
          await k.services.alert.subscribe({
            email,
            variantId: seeded.variantId,
            kind: 'back_in_stock',
            origin: SHOP,
          })
          const { confirm_token: token } = await raw.one<{ confirm_token: string }>(
            'SELECT confirm_token FROM alert_subscriptions WHERE email = ? AND variant_id = ?',
            [email, seeded.variantId],
          )
          await k.services.alert.confirm(token)
        }
        const [mailedTo, refusedTo] = emails as [string, string]
        const before = await maxSeq(raw)
        mail.refuse.add(refusedTo)
        await k.services.inventory.adjustStock(seeded.variantId, 1, 'manual', 'retries')
        const { id } = await onlyRow(raw, before, 'product.restocked.v1')
        await drains(k, MAX_ATTEMPTS - 1)
        const [dead] = await eventRows(raw, 'id = ?', [id])
        expect(dead!.deadAt != null, 'the restock is dead').toBe(true)
        const sent = (to: string) =>
          mail.sent.filter((m) => m.to === to && m.template === 'alert-back-in-stock').length
        expect([sent(mailedTo), sent(refusedTo)], 'alerts before the retry').toEqual([1, 0])

        mail.refuse.delete(refusedTo)
        await retry(k, { id })
        await k.app.relay.drain()

        expect([sent(mailedTo), sent(refusedTo)], 'alerts after the retry').toEqual([1, 1])
        const [row] = await eventRows(raw, 'id = ?', [id])
        expect(row!.deliveredAt != null, 'the restock is delivered').toBe(true)
      } finally {
        await raw.close()
        await k.close()
      }
    }, 120_000)

    it('AC-8: a dead event already marked delivered is cleared by the retry with its delivered_at unchanged, no handler runs on the next pass, and once no longer dead it is one retention removes', async () => {
      const k = await options.open({})
      const raw = openRaw(k.dialect, k.target)
      try {
        const before = await maxSeq(raw)
        await k.services.category.create({ slug: `delivered-${randomUUID()}`, name: 'Delivered' })
        const { id, deliveredAt } = await onlyRow(raw, before, EVT_CATEGORY_CREATED)
        expect(deliveredAt != null, 'the fixture: the event delivered at its commit').toBe(true)
        await k.store.transaction((tx) => k.repos.eventLog.recordFailure(tx, id, new Date(), 1))
        const handled = counter()
        await k.eventBus.subscribe(
          EVT_CATEGORY_CREATED,
          async (e: NymbalEvent<unknown>) => void handled.add(e.id),
          { name: 'retries-delivered' },
        )
        const cutoff = new Date(Date.now() + 365 * 24 * 60 * 60_000)
        await k.store.transaction((tx) => k.repos.eventLog.deleteDeliveredBefore(tx, cutoff))
        const [held] = await eventRows(raw, 'id = ?', [id])
        expect(held?.deadAt != null, 'retention keeps a dead row, delivered or not').toBe(true)

        await retry(k, { id })
        await k.app.relay.drain()

        const [row] = await eventRows(raw, 'id = ?', [id])
        expect([row!.deadAt ?? null, row!.attempts], 'cleared by the retry').toEqual([null, 0])
        expect(instant(row!.deliveredAt), 'delivered_at is unchanged').toBe(instant(deliveredAt))
        expect(handled.of(id), 'handlers run by the next pass').toBe(0)

        const deleted = await k.store.transaction((tx) =>
          k.repos.eventLog.deleteDeliveredBefore(tx, cutoff),
        )
        expect(await eventRows(raw, 'id = ?', [id]), 'retention removes it').toEqual([])
        expect(deleted, 'the delete counts it').toBeGreaterThanOrEqual(1)
      } finally {
        await raw.close()
        await k.close()
      }
    }, 60_000)

    it('AC-17: an order.shipped.v1 past retention, its processed_events record swept by the real sweeper, is not taken by retryDead with the real retryFloor: it stays dead and no second shipped email is sent, while a younger dead event in the same retry is taken and delivered', async () => {
      const store = await openShippingStore()
      const { k, raw, mail } = store
      try {
        const { id: oldId } = await shippedEventDead(store)
        const mailed = () => mail.sent.filter((m) => m.template === 'order-shipped').length
        const mailedBefore = mailed()
        expect(mailedBefore, 'the shipped email, sent on the first delivery').toBe(1)

        const retentionDays = k.config.events.retentionDays
        const aged = new Date(Date.now() - (retentionDays + 1) * 24 * 60 * 60_000).toISOString()
        await writeRaw(k.dialect, k.target, 'UPDATE events SET created_at = ? WHERE id = ?', [
          aged,
          oldId,
        ])
        await writeRaw(
          k.dialect,
          k.target,
          'UPDATE processed_events SET processed_at = ? WHERE event_id = ?',
          [aged, oldId],
        )
        const records = () => raw.count('processed_events', 'event_id = ?', [oldId])
        const recordsBefore = await records()
        expect(recordsBefore, 'the delivery records to sweep').toBeGreaterThanOrEqual(1)
        const sweeper = startEventRetentionSweeper({
          store: k.store,
          eventLog: k.repos.eventLog,
          processedEvents: k.repos.processedEvent,
          logger: k.logger,
          retentionDays,
        })
        await sweeper.tick()
        sweeper.stop()
        expect(await records(), 'the record of the first delivery after the sweep').toBe(0)

        const refusing = failPublishFor(k.eventBus, [EVT_CATEGORY_CREATED])
        const beforeYoung = await maxSeq(raw)
        await k.services.category.create({ slug: `young-${randomUUID()}`, name: 'Young' })
        const { id: youngId } = await onlyRow(raw, beforeYoung, EVT_CATEGORY_CREATED)
        await drains(k, MAX_ATTEMPTS - 1)
        refusing.restore()
        const [deadYoung] = await eventRows(raw, 'id = ?', [youngId])
        expect(deadYoung!.deadAt != null, 'the younger event is dead').toBe(true)

        const floor = retryFloorOf(new Date(), retentionDays)
        const taken = await k.store.transaction((tx) =>
          retryDeadOf(k.repos.eventLog)(tx, {}, { floor, limit: 100 }),
        )
        await k.app.relay.drain()

        expect(
          taken.map((r) => r.event.id),
          'the retry takes the younger event and leaves the aged one',
        ).toEqual([youngId])
        const [old] = await eventRows(raw, 'id = ?', [oldId])
        expect(old!.deadAt != null, 'the aged event stays dead').toBe(true)
        expect(mailed(), 'shipped emails after the retry').toBe(mailedBefore)
        const [young] = await eventRows(raw, 'id = ?', [youngId])
        expect(young!.deliveredAt != null, 'the younger event is delivered').toBe(true)
      } finally {
        await raw.close()
        await k.close()
      }
    }, 120_000)
  })
}
