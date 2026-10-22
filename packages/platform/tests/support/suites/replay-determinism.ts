import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AdapterError, ConfigError, NymbalError } from '@nymbalhq/types'
import { READ_MODELS } from '../../../src/read-models/index.js'
import { address, type Kernel } from '../kernel.js'
import {
  DOCUMENT_COLLECTIONS,
  DOCUMENT_MODELS,
  documentModelsOf,
  nativeSearchDocuments,
  rebuildFresh,
} from '../read-models.js'

// P3-02 AC-2 on one dialect (spec P3-02-replay-engine, decisions 1 and 4): determinism. Over generated command
// sequences through the services, on a fresh kernel each run, `rebuild(all)` into a fresh document store and a fresh
// search index equals the live read models collection by collection, document by document, in key order, and the live
// native index document by document. Every run starts with a fixed tour that walks each of the four live defects the
// spec names (a recategorised product, a renamed category with products, stock to zero on a product in a category, a
// customer's paid order), then a generated tail of the same commands and the rest (category deletes, product deletes,
// stock moves, pay, process, ship, deliver, cancel, refund, customer updates). A command the store refuses (a domain error) is
// a no-op; the tour must never be refused, so a harness that refuses everything cannot pass vacuously.
// Kills: orphan `products-by-category` keys after a recategorisation, inventory not patching `products-by-category`, a
// category rename not re-projecting its products, `onOrderPaid` looking the customer up by order id, and any builder
// the projections and the rebuilders do not share.

const WORDS = ['wool', 'linen', 'cedar', 'amber', 'slate', 'fern', 'cobalt', 'ivory'] as const

interface World {
  categories: string[]
  products: Array<{ id: string; variants: Array<{ id: string; priceMinor: number }> }>
  orders: Array<{ id: string; totalMinor: number }>
  customers: string[]
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
        await s.inventory.adjustStock(v.id, o.delta, 'manual', 'p3-02')
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
          email: `buyer-${tag}${o.pending ? '+stub-pending' : ''}@p3-02.test`,
          billingAddress: address,
          shippingAddress: address,
        })
        world.orders.push({ id: started.orderId, totalMinor: started.totalMinor })
        return true
      }
      case 'order.pay': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.checkout.markPaid(order.id, 'p3-02')
        return true
      }
      case 'order.process': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.order.updateStatus(order.id, 'processing', 'p3-02')
        return true
      }
      case 'order.ship': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.order.markShipped(order.id, `TRK-${tag}`, 'royal-mail', 'p3-02')
        return true
      }
      case 'order.deliver': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.order.markDelivered(order.id, 'p3-02')
        return true
      }
      case 'order.cancel': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        await s.order.cancel(order.id, 'changed mind', 'p3-02')
        return true
      }
      case 'order.refund': {
        const order = at(world.orders, o.pick)
        if (order === undefined) return false
        const amountMinor = o.half
          ? Math.max(1, Math.floor(order.totalMinor / 2))
          : order.totalMinor
        await s.refund.refund({ orderId: order.id, amountMinor, actor: 'p3-02' })
        return true
      }
      case 'customer.register': {
        const { customer } = await s.auth.register({
          email: `${o.word}-${tag}@p3-02.test`,
          password: 'correct-horse-battery',
          firstName: o.word,
        })
        world.customers.push(customer.id)
        return true
      }
      case 'customer.update': {
        const id = at(world.customers, o.pick)
        if (id === undefined) return false
        await s.customer.updateProfile(id, { firstName: o.word, phone: `0700 ${tag}` })
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
  describe(`P3-02 AC-2: a rebuild equals the live read models (${dialect})`, () => {
    it('AC-2: READ_MODELS names catalogue, orders, customers and search, and the three document models own exactly the collections decision 1 lists', () => {
      const byName = new Map(READ_MODELS.map((m) => [m.name, [...m.collections].sort()]))
      expect([...byName.keys()].sort()).toEqual(['catalogue', 'customers', 'orders', 'search'])
      for (const [name, collections] of Object.entries(DOCUMENT_MODELS)) {
        expect(byName.get(name as keyof typeof DOCUMENT_MODELS), name).toEqual(
          [...collections].sort(),
        )
      }
    })

    it('AC-2: over generated command sequences through the services (a fixed tour of the four live defects, then a generated tail), rebuild(all) into a fresh document store and index equals every live collection document by document, in key order, and the live native index document by document; the report counts what it wrote', async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(op, { minLength: 3, maxLength: 18 }), async (tail) => {
          const { kernel: k, drop } = await opts.fresh()
          try {
            const world: World = { categories: [], products: [], orders: [], customers: [] }
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
              ['catalogue', 'customers', 'orders', 'search'].sort(),
            )
          } finally {
            await k.close()
            await drop()
          }
        }),
        { numRuns: opts.runs, endOnFailure: true },
      )
    }, 600_000)
  })
}
