import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { v7 as uuidv7 } from 'uuid'
import { describe, expect, it } from 'vitest'
import { AdapterError, ConfigError, NymbalError } from '@nymbalhq/types'
import { READ_MODELS } from '../../../src/read-models/index.js'
import { serveKernel, type ServedKernel } from '../http.js'
import { address, createKernel, type Kernel } from '../kernel.js'
import { login, primedShopper } from '../security.js'
import {
  DOCUMENT_COLLECTIONS,
  DOCUMENT_MODELS,
  documentModelsOf,
  nativeSearchDocuments,
  rebuildFresh,
} from '../read-models.js'

// AC-2 on one dialect: determinism. Over generated command sequences through the services, on a fresh kernel each run,
// `rebuild(all)` into a fresh document store and a fresh search index equals the live read models collection by
// collection, document by document, in key order, and the live native index document by document. Every run starts
// with a fixed tour (a recategorised product, a renamed category with products, stock to zero on a product in a
// category, a customer's paid order), then a generated tail of the same commands and the rest (category deletes,
// product deletes, stock moves, pay, process, ship, deliver, cancel, refund, customer updates). A command the store
// refuses (a domain error) is a no-op; the tour must never be refused, so a harness that refuses everything cannot
// pass vacuously.

const WORDS = ['wool', 'linen', 'cedar', 'amber', 'slate', 'fern', 'cobalt', 'ivory'] as const

interface World {
  categories: string[]
  products: Array<{ id: string; variants: Array<{ id: string; priceMinor: number }> }>
  orders: Array<{ id: string; totalMinor: number }>
  customers: string[]
  /** Each customer's email, by the customer's index. */
  emails: string[]
  /** The run's guest visitors: fresh ids, as the capture route mints them. */
  visitors: string[]
}

const PASSWORD = 'correct-horse-battery'

function emptyWorld(): World {
  return {
    categories: [],
    products: [],
    orders: [],
    customers: [],
    emails: [],
    visitors: [uuidv7(), uuidv7(), uuidv7()],
  }
}

type Op =
  | { kind: 'category.create'; word: string }
  | { kind: 'category.rename'; pick: number; word: string }
  | { kind: 'category.delete'; pick: number }
  | {
      kind: 'product.create'
      word: string
      categories: number[]
      prices: number[]
      stock: number
      status: 'active' | 'draft'
    }
  | { kind: 'product.update'; pick: number; word: string | null; categories: number[] | null }
  | { kind: 'product.delete'; pick: number }
  | { kind: 'stock.adjust'; pick: number; variant: number; delta: number }
  | {
      kind: 'checkout'
      pick: number
      variant: number
      qty: number
      customer: number | null
      pending: boolean
    }
  | { kind: 'order.pay'; pick: number }
  | { kind: 'order.process'; pick: number }
  | { kind: 'order.ship'; pick: number }
  | { kind: 'order.deliver'; pick: number }
  | { kind: 'order.cancel'; pick: number }
  | { kind: 'order.refund'; pick: number; half: boolean }
  | { kind: 'customer.register'; word: string }
  | { kind: 'customer.update'; pick: number; word: string }
  | { kind: 'view.guest'; visitor: number; pick: number }
  | { kind: 'view.customer'; customer: number; pick: number }
  | { kind: 'sign-in.fold'; visitor: number; customer: number }
  | { kind: 'product.unpublish'; pick: number }
  | { kind: 'product.publish'; pick: number }

const word = fc.constantFrom(...WORDS)
const pick = fc.nat({ max: 50 })
const picks = fc.uniqueArray(fc.nat({ max: 6 }), { maxLength: 3 })

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('category.create' as const), word }),
  fc.record({ kind: fc.constant('category.rename' as const), pick, word }),
  fc.record({ kind: fc.constant('category.delete' as const), pick }),
  fc.record({
    kind: fc.constant('product.create' as const),
    word,
    categories: picks,
    prices: fc.array(fc.integer({ min: 1, max: 50_000 }), { minLength: 1, maxLength: 2 }),
    stock: fc.integer({ min: 0, max: 6 }),
    status: fc.constantFrom('active' as const, 'draft' as const),
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
    variant: fc.nat({ max: 1 }),
    delta: fc.integer({ min: -6, max: 6 }),
  }),
  fc.record({
    kind: fc.constant('checkout' as const),
    pick,
    variant: fc.nat({ max: 1 }),
    qty: fc.integer({ min: 1, max: 3 }),
    customer: fc.option(fc.nat({ max: 5 }), { nil: null }),
    pending: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('order.pay' as const), pick }),
  fc.record({ kind: fc.constant('order.process' as const), pick }),
  fc.record({ kind: fc.constant('order.ship' as const), pick }),
  fc.record({ kind: fc.constant('order.deliver' as const), pick }),
  fc.record({ kind: fc.constant('order.cancel' as const), pick }),
  fc.record({ kind: fc.constant('order.refund' as const), pick, half: fc.boolean() }),
  fc.record({ kind: fc.constant('customer.register' as const), word }),
  fc.record({ kind: fc.constant('customer.update' as const), pick, word }),
  fc.record({ kind: fc.constant('view.guest' as const), visitor: fc.nat({ max: 2 }), pick }),
  fc.record({ kind: fc.constant('view.customer' as const), customer: fc.nat({ max: 5 }), pick }),
  fc.record({
    kind: fc.constant('sign-in.fold' as const),
    visitor: fc.nat({ max: 2 }),
    customer: fc.nat({ max: 5 }),
  }),
  fc.record({ kind: fc.constant('product.unpublish' as const), pick }),
  fc.record({ kind: fc.constant('product.publish' as const), pick }),
)

/**
 * The tour every run starts with, over an empty world: categories 0 and 1, product 0 in category 0 and product 1 in
 * both, customer 0 with a paid order (then processing, then shipped), a pending order paid by hand and half refunded, a
 * cancelled one,
 * then product 0 moved to category 1 and renamed, category 0 renamed, product 0's first variant to zero stock, the
 * customer updated, and a product created and deleted.
 */
const TOUR: Op[] = [
  { kind: 'category.create', word: 'wool' },
  { kind: 'category.create', word: 'linen' },
  {
    kind: 'product.create',
    word: 'cedar',
    categories: [0],
    prices: [1200, 1500],
    stock: 5,
    status: 'active',
  },
  {
    kind: 'product.create',
    word: 'amber',
    categories: [0, 1],
    prices: [900],
    stock: 5,
    status: 'active',
  },
  { kind: 'customer.register', word: 'slate' },
  { kind: 'checkout', pick: 0, variant: 0, qty: 1, customer: 0, pending: false },
  { kind: 'checkout', pick: 1, variant: 0, qty: 1, customer: null, pending: true },
  { kind: 'order.pay', pick: 1 },
  { kind: 'order.refund', pick: 1, half: true },
  { kind: 'order.process', pick: 0 },
  { kind: 'order.ship', pick: 0 },
  { kind: 'checkout', pick: 1, variant: 0, qty: 1, customer: 0, pending: true },
  { kind: 'order.cancel', pick: 2 },
  { kind: 'product.update', pick: 0, word: 'fern', categories: [1] },
  { kind: 'category.rename', pick: 0, word: 'cobalt' },
  { kind: 'stock.adjust', pick: 0, variant: 0, delta: -4 },
  { kind: 'customer.update', pick: 0, word: 'ivory' },
  {
    kind: 'product.create',
    word: 'slate',
    categories: [1],
    prices: [700],
    stock: 2,
    status: 'active',
  },
  { kind: 'product.delete', pick: 2 },
  // Recently viewed: a guest's views, a customer's, the guest signing in, a second guest, and a viewed product
  // unpublished and published again.
  { kind: 'view.guest', visitor: 0, pick: 0 },
  { kind: 'view.customer', customer: 0, pick: 1 },
  { kind: 'view.guest', visitor: 0, pick: 1 },
  { kind: 'sign-in.fold', visitor: 0, customer: 0 },
  { kind: 'view.guest', visitor: 1, pick: 0 },
  { kind: 'view.guest', visitor: 1, pick: 1 },
  { kind: 'product.unpublish', pick: 1 },
  { kind: 'product.publish', pick: 1 },
  { kind: 'product.unpublish', pick: 0 },
]

const at = <T>(list: T[], i: number): T | undefined =>
  list.length === 0 ? undefined : list[i % list.length]

/** A refusal: the store said no to the command and changed nothing. Anything else is the harness's or the store's fault. */
function refused(error: unknown): boolean {
  return (
    error instanceof NymbalError && !(error instanceof AdapterError || error instanceof ConfigError)
  )
}

/** Applies `o`; true when it ran, false when the store refused it or it had nothing to act on. */
async function apply(k: Kernel, world: World, o: Op): Promise<boolean> {
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
          status: o.status,
          categoryIds,
          variants: o.prices.map((priceMinor, i) => ({
            sku: `SKU-${tag}-${i}`,
            name: `size ${i}`,
            priceMinor,
            stock: o.stock,
            lowStockThreshold: 0,
            options: [],
          })),
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
        const v = at(at(world.products, o.pick)?.variants ?? [], o.variant)
        if (v === undefined || o.delta === 0) return false
        await s.inventory.adjustStock(v.id, o.delta, 'manual', 'replay')
        return true
      }
      case 'checkout': {
        const p = at(world.products, o.pick)
        const v = at(p?.variants ?? [], o.variant)
        if (p === undefined || v === undefined) return false
        const customerId = o.customer === null ? null : (at(world.customers, o.customer) ?? null)
        const cart = await s.cart.getOrCreate(undefined, customerId)
        await s.cart.addItem(cart.token, {
          variantId: v.id,
          productId: p.id,
          productName: 'replay product',
          variantName: 'variant',
          priceMinor: v.priceMinor,
          imageUrl: '',
          qty: o.qty,
        })
        const started = await s.checkout.beginCheckout({
          cartToken: cart.token,
          customerId,
          email: `buyer-${tag}${o.pending ? '+stub-pending' : ''}@replay.test`,
          billingAddress: address,
          shippingAddress: address,
        })
        world.orders.push({ id: started.orderId, totalMinor: started.totalMinor })
        return true
      }
      case 'order.pay': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.checkout.markPaid(order.id, 'replay')
        return true
      }
      case 'order.process': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.order.updateStatus(order.id, 'processing', 'replay')
        return true
      }
      case 'order.ship': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.order.markShipped(order.id, `TRK-${tag}`, 'royal-mail', 'replay')
        return true
      }
      case 'order.deliver': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.order.markDelivered(order.id, 'replay')
        return true
      }
      case 'order.cancel': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.order.cancel(order.id, 'changed mind', 'replay')
        return true
      }
      case 'order.refund': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        const amountMinor = o.half
          ? Math.max(1, Math.floor(order.totalMinor / 2))
          : order.totalMinor
        await s.refund.refund({ orderId: order.id, amountMinor, actor: 'replay' })
        return true
      }
      case 'customer.register': {
        const email = `${o.word}-${tag}@replay.test`
        const { customer } = await s.auth.register({
          email,
          password: PASSWORD,
          firstName: o.word,
        })
        world.customers.push(customer.id)
        world.emails.push(email)
        return true
      }
      case 'customer.update': {
        const id = at(world.customers, o.pick)
        if (id === undefined) return false
        await s.customer.updateProfile(id, { firstName: o.word, phone: `0700 ${tag}` })
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
      case 'product.unpublish': {
        const p = at(world.products, o.pick)
        if (p === undefined) return false
        await s.product.unpublish(p.id)
        return true
      }
      case 'product.publish': {
        const p = at(world.products, o.pick)
        if (p === undefined) return false
        await s.product.publish(p.id)
        return true
      }
    }
  } catch (error) {
    if (refused(error)) return false
    throw error
  }
}

export interface DeterminismOptions {
  /** Property runs: each one a fresh kernel. */
  runs: number
  /** A kernel on an empty, migrated database of its own, and how to drop it. */
  fresh(): Promise<{ kernel: Kernel; drop(): Promise<void> }>
}

export function replayDeterminismSuite(dialect: Kernel['dialect'], opts: DeterminismOptions): void {
  describe(`AC-2: a rebuild equals the live read models (${dialect})`, () => {
    it('AC-9: READ_MODELS names catalogue, orders, customers, search and recently-viewed, and the four document models own exactly their collections', () => {
      const byName = new Map(READ_MODELS.map((m) => [m.name, [...m.collections].sort()]))
      expect([...byName.keys()].sort()).toEqual(
        ['catalogue', 'customers', 'orders', 'recently-viewed', 'search'].sort(),
      )
      for (const [name, collections] of Object.entries(DOCUMENT_MODELS)) {
        expect(byName.get(name as keyof typeof DOCUMENT_MODELS), name).toEqual(
          [...collections].sort(),
        )
      }
    })

    it('AC-9: over generated command sequences through the services (a fixed tour of the four live defects and of guest and customer views, a sign-in with a visitor cookie, an unpublish and a publish, then a generated tail of the same and the rest), rebuild(all) into a fresh document store and index equals every live collection document by document, in key order, and the live native index document by document; the report counts what it wrote', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(op, { minLength: 3, maxLength: 18 }), async (tail) => {
          const { kernel: k, drop } = await opts.fresh()
          try {
            const world = emptyWorld()
            let toured = 0
            for (const o of TOUR) if (await apply(k, world, o)) toured += 1
            expect(toured, 'a tour command was refused, so the run proves less than it says').toBe(
              TOUR.length,
            )
            for (const o of tail) await apply(k, world, o)
            await k.app.relay.drain()

            const live = await documentModelsOf(k.documentStore)
            const liveIndex = await nativeSearchDocuments(k)
            const rebuilt = await rebuildFresh(k)
            // The tour's views leave lists, so an equality of two empty recently-viewed collections proves nothing.
            expect(
              live['recently-viewed']?.length ?? 0,
              'live recently-viewed lists',
            ).toBeGreaterThan(0)

            for (const name of DOCUMENT_COLLECTIONS) {
              expect(rebuilt.documents[name], `collection ${name}`).toEqual(live[name])
            }
            expect(rebuilt.search, 'the search index').toEqual(liveIndex)

            const reported = new Map(
              rebuilt.report.flatMap((entry) =>
                entry.collections.map((c) => [c.name, c.documents] as const),
              ),
            )
            for (const name of DOCUMENT_COLLECTIONS) {
              expect(reported.get(name), `report count for ${name}`).toBe(
                rebuilt.documents[name]!.length,
              )
            }
            expect(rebuilt.report.map((e) => e.model).sort()).toEqual(
              ['catalogue', 'customers', 'orders', 'recently-viewed', 'search'].sort(),
            )
          } finally {
            await k.close()
            await drop()
          }
        }),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 600_000)

    it('AC-9: after the tour, a second app over the same database with an empty in-memory document store serves every visitor and customer the GET /api/recently-viewed list the first served', async () => {
      const { kernel: k, drop } = await opts.fresh()
      let first: ServedKernel | undefined
      let second: ServedKernel | undefined
      let firstClosed = false
      try {
        const world = emptyWorld()
        let toured = 0
        for (const o of TOUR) if (await apply(k, world, o)) toured += 1
        expect(toured, 'a tour command was refused').toBe(TOUR.length)

        first = await serveKernel(k)
        const before = await servedLists(first, world)
        firstClosed = true
        await first.stop()

        const reopened = await createKernel(
          dialect === 'sqlite'
            ? { dialect: 'sqlite', sqlitePath: k.target }
            : { dialect: 'postgres', postgresUrl: k.target },
        )
        second = await serveKernel(reopened)
        const after = await servedLists(second, world)

        expect(
          Object.values(before).some((ids) => ids.length > 0),
          'some list to compare',
        ).toBe(true)
        expect(after).toEqual(before)
      } finally {
        if (!firstClosed) await (first?.stop() ?? k.close())
        await second?.stop()
        await drop()
      }
    }, 120_000)
  })
}

/** What `GET /api/recently-viewed` serves each of the world's visitors (by cookie) and customers (by bearer), by viewer. */
async function servedLists(s: ServedKernel, world: World): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {}
  async function read(label: string, headers: Record<string, string>, jar?: Map<string, string>) {
    const shop = await primedShopper(s.baseUrl, jar)
    const res = await shop.call<{ items: Array<{ id: string }> }>(
      'GET',
      '/api/recently-viewed',
      undefined,
      { headers },
    )
    expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(200)
    out[label] = (res.body.data?.items ?? []).map((p) => p.id)
  }
  for (const id of world.visitors) {
    await read(`visitor:${id}`, {}, new Map([['nymbal.visitor', id]]))
  }
  for (const [i, id] of world.customers.entries()) {
    const shop = await primedShopper(s.baseUrl)
    const answer = await login(s.baseUrl, shop.jar, { email: world.emails[i]!, password: PASSWORD })
    expect(answer.status, `login ${world.emails[i]}`).toBe(200)
    await read(`customer:${id}`, { authorization: `Bearer ${answer.body.data!.accessToken}` })
  }
  return out
}
