import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  EVT_CART_CREATED,
  EVT_CART_ITEM_ADDED,
  EVT_CART_ITEM_REMOVED,
  EVT_CART_UPDATED,
  NotFoundError,
  ValidationError,
  type Cart,
  type CartItem,
  type Order,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore, type ReadTx, type Tx } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import type { CartRepository } from '../repositories/cart.js'
import type { ProductRepository } from '../repositories/product.js'
import type { VariantRepository } from '../repositories/variant.js'
import {
  createCartCatalogue,
  createCartService,
  isSellable,
  type CartCatalogue,
  type CreateCartServiceDeps,
} from './cart-service.js'
import { createLogger } from '../logger.js'

interface DepsOptions {
  now?: () => Date
  ttlSeconds?: number
  pendingOrders?: CreateCartServiceDeps['pendingOrders']
  /** Composes the service without a catalogue, so it falls back to the store's. */
  storeCatalogue?: boolean
  /** Wraps the cart repository the service is given. */
  carts?: (carts: CartRepository) => CartRepository
}

// Carts are command-store rows and their events go through the outbox on the same store. The catalogue sells every
// variant unless a test narrows `sells`.
async function makeDeps(
  sells: (variantId: string) => boolean = () => true,
  options: DepsOptions = {},
) {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, new InMemoryDocumentStore({ sweepIntervalMs: 0 }))
  const { publisher, relay } = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  )
  const catalogue: CartCatalogue = {
    sellable: async (_tx: ReadTx, variantIds: readonly string[]) =>
      new Set(variantIds.filter((id: string) => sells(id))),
  }
  const service = createCartService({
    store: commandStore,
    carts: options.carts ? options.carts(repos.cart) : repos.cart,
    publisher,
    logger,
    currency: 'GBP',
    ...(!options.storeCatalogue && { catalogue }),
    ...(options.pendingOrders && { pendingOrders: options.pendingOrders }),
    ...(options.ttlSeconds !== undefined && { ttlSeconds: options.ttlSeconds }),
    ...(options.now && { now: options.now }),
  })
  return { service, eventBus, relay, commandStore, repos }
}

const testItem = {
  variantId: 'var-1',
  productId: 'prod-1',
  productName: 'Test',
  variantName: 'Default',
  priceMinor: 1000,
  imageUrl: '',
}

describe('CartService', () => {
  it('getOrCreate creates a new cart and emits cart.created', async () => {
    const { service, eventBus } = await makeDeps()
    const received: unknown[] = []
    await eventBus.subscribe(EVT_CART_CREATED, (e) => {
      received.push(e.payload)
    })
    const cart = await service.getOrCreate()
    expect(cart.token).toBeTruthy()
    expect(cart.items).toHaveLength(0)
    expect(received).toHaveLength(1)
  })

  it('getOrCreate returns existing cart on second call', async () => {
    const { service } = await makeDeps()
    const a = await service.getOrCreate()
    const b = await service.getOrCreate(a.token)
    expect(b.token).toBe(a.token)
  })

  it('get returns null for unknown token', async () => {
    const { service } = await makeDeps()
    expect(await service.get('nope')).toBeNull()
  })

  it('addItem adds item to cart and emits item.added + updated', async () => {
    const { service, eventBus } = await makeDeps()
    const added: unknown[] = []
    const updated: unknown[] = []
    await eventBus.subscribe(EVT_CART_ITEM_ADDED, (e) => {
      added.push(e.payload)
    })
    await eventBus.subscribe(EVT_CART_UPDATED, (e) => {
      updated.push(e.payload)
    })
    const cart = await service.getOrCreate()
    const updated_cart = await service.addItem(cart.token, testItem)
    expect(updated_cart.items).toHaveLength(1)
    expect(updated_cart.subtotalMinor).toBe(1000)
    expect(added).toHaveLength(1)
    expect(updated.length).toBeGreaterThanOrEqual(1)
  })

  it('addItem accumulates qty for same variant', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, { ...testItem, qty: 2 })
    const final = await service.addItem(cart.token, { ...testItem, qty: 3 })
    expect(final.items[0]!.qty).toBe(5)
    expect(final.subtotalMinor).toBe(5000)
  })

  it('addItem rejects qty <= 0', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await expect(service.addItem(cart.token, { ...testItem, qty: 0 })).rejects.toThrow(
      ValidationError,
    )
  })

  it('addItem throws for unknown cart token', async () => {
    const { service } = await makeDeps()
    await expect(service.addItem('unknown', testItem)).rejects.toThrow(NotFoundError)
  })

  it('updateItemQuantity changes qty', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    const updated = await service.updateItemQuantity(cart.token, testItem.variantId, 5)
    expect(updated.items[0]!.qty).toBe(5)
    expect(updated.subtotalMinor).toBe(5000)
  })

  it('updateItemQuantity with qty=0 removes item and emits removed', async () => {
    const { service, eventBus } = await makeDeps()
    const removed: unknown[] = []
    await eventBus.subscribe(EVT_CART_ITEM_REMOVED, (e) => {
      removed.push(e.payload)
    })
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    const updated = await service.updateItemQuantity(cart.token, testItem.variantId, 0)
    expect(updated.items).toHaveLength(0)
    expect(removed).toHaveLength(1)
  })

  it('updateItemQuantity rejects negative qty', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    await expect(service.updateItemQuantity(cart.token, testItem.variantId, -1)).rejects.toThrow(
      ValidationError,
    )
  })

  it('updateItemQuantity throws for missing variant', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await expect(service.updateItemQuantity(cart.token, 'var-none', 2)).rejects.toThrow(
      NotFoundError,
    )
  })

  it('removeItem removes item and emits removed', async () => {
    const { service, eventBus } = await makeDeps()
    const removed: unknown[] = []
    await eventBus.subscribe(EVT_CART_ITEM_REMOVED, (e) => {
      removed.push(e.payload)
    })
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    const updated = await service.removeItem(cart.token, testItem.variantId)
    expect(updated.items).toHaveLength(0)
    expect(removed).toHaveLength(1)
  })

  it('removeItem on non-existent variant still resolves (no event)', async () => {
    const { service, eventBus } = await makeDeps()
    const removed: unknown[] = []
    await eventBus.subscribe(EVT_CART_ITEM_REMOVED, (e) => {
      removed.push(e.payload)
    })
    const cart = await service.getOrCreate()
    const updated = await service.removeItem(cart.token, 'var-ghost')
    expect(updated.items).toHaveLength(0)
    await new Promise((r) => setTimeout(r, 10))
    expect(removed).toHaveLength(0)
  })

  it('clear empties cart', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, testItem)
    const cleared = await service.clear(cart.token)
    expect(cleared.items).toHaveLength(0)
    expect(cleared.subtotalMinor).toBe(0)
  })

  it('attachCustomer sets customerId', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    const updated = await service.attachCustomer(cart.token, 'cust-1')
    expect(updated.customerId).toBe('cust-1')
  })

  it('merge: if guest missing, returns customer cart', async () => {
    const { service } = await makeDeps()
    const customerCart = await service.getOrCreate()
    const merged = await service.merge('ghost-token', customerCart.token)
    expect(merged.token).toBe(customerCart.token)
  })

  it('merge: if customer cart missing, renames guest cart to customerToken', async () => {
    const { service } = await makeDeps()
    const guest = await service.getOrCreate()
    await service.addItem(guest.token, { ...testItem, variantId: 'g-var' })
    const merged = await service.merge(guest.token, 'new-cust-token')
    expect(merged.token).toBe('new-cust-token')
    expect(merged.items).toHaveLength(1)
  })

  it('merge: combines guest items into customer cart', async () => {
    const { service } = await makeDeps()
    const guestItem = {
      variantId: 'g-var',
      productId: 'p2',
      productName: 'G',
      variantName: 'D',
      priceMinor: 500,
      imageUrl: '',
    }
    const guest = await service.getOrCreate()
    await service.addItem(guest.token, guestItem)
    const customerCart = await service.getOrCreate()
    await service.addItem(customerCart.token, testItem)
    const merged = await service.merge(guest.token, customerCart.token)
    expect(merged.items).toHaveLength(2)
  })

  it('AC-6: merge: a variant on both carts takes the sum of the two quantities', async () => {
    const { service } = await makeDeps()
    const guest = await service.getOrCreate()
    await service.addItem(guest.token, { ...testItem, qty: 5 })
    const customerCart = await service.getOrCreate()
    await service.addItem(customerCart.token, { ...testItem, qty: 3 })
    const merged = await service.merge(guest.token, customerCart.token)
    expect(merged.items[0]!.qty).toBe(5 + 3)
  })
})

const MAX_LINE_QTY = 99

const lineOf = (variantId: string) => ({ ...testItem, variantId, productId: `p-${variantId}` })

type Outcome = { cart: Cart } | { error: { code?: string; context?: unknown } }

const settle = (p: Promise<Cart>): Promise<Outcome> =>
  p.then(
    (cart) => ({ cart }),
    (error: { code?: string; context?: unknown }) => ({ error }),
  )

const quantities = (cart: Cart): Array<[string, number]> =>
  cart.items
    .map((i): [string, number] => [i.variantId, i.qty])
    .sort(([a], [b]) => a.localeCompare(b))

describe('the line ceiling', () => {
  const command = fc.record({
    kind: fc.constantFrom('add' as const, 'update' as const),
    variantId: fc.constantFrom('cap-a', 'cap-b', 'cap-c'),
    qty: fc.integer({ min: 0, max: 150 }),
  })

  // Kills: addItem summing onto a line with no ceiling, and updateItemQuantity setting a line above it.
  it('AC-1: property: after any sequence of addItem and updateItemQuantity (qty 0..150) every line is within 1..99, and a command that would take a line past 99 throws cart.qty_limit naming the variant, the ceiling and what the cart held, leaving the cart as it was', async () => {
    const { service } = await makeDeps()
    await fc.assert(
      fc.asyncProperty(fc.array(command, { minLength: 1, maxLength: 12 }), async (commands) => {
        const { token } = await service.getOrCreate()
        const model = new Map<string, number>()
        for (const c of commands) {
          const before = await service.get(token)
          const onCart = model.get(c.variantId) ?? 0
          const outcome = await settle(
            c.kind === 'add'
              ? service.addItem(token, { ...lineOf(c.variantId), qty: c.qty })
              : service.updateItemQuantity(token, c.variantId, c.qty),
          )
          const after = await service.get(token)
          const label = `${c.kind} ${c.variantId} × ${c.qty} onto ${onCart}`

          // What the command should do: refused for an input the service already refuses (add 0, update of a
          // variant not on the cart), refused at the ceiling, or applied.
          const refusedAnyway = c.kind === 'add' ? c.qty === 0 : onCart === 0
          const next = c.kind === 'add' ? onCart + c.qty : c.qty
          const verdict = refusedAnyway ? 'refused' : next > MAX_LINE_QTY ? 'limit' : 'applied'
          const refused = 'error' in outcome ? outcome.error : null

          expect(refused === null ? 'applied' : 'refused', label).toBe(
            verdict === 'applied' ? 'applied' : 'refused',
          )
          expect(
            verdict === 'limit' ? { code: refused?.code, context: refused?.context } : null,
            label,
          ).toEqual(
            verdict === 'limit'
              ? {
                  code: 'cart.qty_limit',
                  context: { variantId: c.variantId, max: MAX_LINE_QTY, onCart },
                }
              : null,
          )
          expect(refused === null ? before : after, `${label}: the cart after a refusal`).toEqual(
            before,
          )
          if (verdict === 'applied' && next === 0) model.delete(c.variantId)
          if (verdict === 'applied' && next > 0) model.set(c.variantId, next)

          for (const line of after!.items) {
            expect(line.qty, label).toBeGreaterThanOrEqual(1)
            expect(line.qty, label).toBeLessThanOrEqual(MAX_LINE_QTY)
          }
          expect(quantities(after!), label).toEqual(
            [...model].sort(([a], [b]) => a.localeCompare(b)),
          )
        }
      }),
      { numRuns: 60 },
    )
  })
})

describe('merge', () => {
  const POOL = ['mg-1', 'mg-2', 'mg-3', 'mg-4', 'mg-5', 'mg-6']
  const side = fc.uniqueArray(
    fc.record({
      variantId: fc.constantFrom(...POOL),
      qty: fc.integer({ min: 1, max: MAX_LINE_QTY }),
    }),
    { selector: (l) => l.variantId, maxLength: POOL.length },
  )

  /** Each side's copy of a line has its own price and name, so the result shows whose fields it kept. */
  const fieldsOf = (whose: 'guest' | 'customer', variantId: string) => {
    const n = POOL.indexOf(variantId) + 1
    return {
      ...lineOf(variantId),
      productName: `${whose} ${variantId}`,
      priceMinor: whose === 'guest' ? 100 * n + 1 : 1000 * n + 7,
    }
  }

  // Kills: Math.max for a shared variant, no ceiling on the sum, an unsellable line kept, the guest's fields kept
  // over the customer's, a stale subtotal, the guest cart left behind.
  it("AC-6: property: merge(G, C) holds each sellable variant of either cart once at min(99, G + C) with C's fields where both hold it, no unsellable variant, subtotalMinor = Σ priceMinor × qty, C's token, and G is no longer readable", async () => {
    let selling = new Set<string>(POOL)
    const { service } = await makeDeps((id) => selling.has(id))
    await fc.assert(
      fc.asyncProperty(side, side, fc.subarray(POOL), async (guestLines, customerLines, sold) => {
        selling = new Set(POOL)
        const guest = await service.getOrCreate()
        for (const l of guestLines) {
          await service.addItem(guest.token, { ...fieldsOf('guest', l.variantId), qty: l.qty })
        }
        const customer = await service.getOrCreate()
        for (const l of customerLines) {
          await service.addItem(customer.token, {
            ...fieldsOf('customer', l.variantId),
            qty: l.qty,
          })
        }
        selling = new Set(sold)

        const merged = await service.merge(guest.token, customer.token)

        const g = new Map(guestLines.map((l) => [l.variantId, l.qty]))
        const c = new Map(customerLines.map((l) => [l.variantId, l.qty]))
        const expected = POOL.filter((v) => selling.has(v) && (g.has(v) || c.has(v))).map((v) => {
          const fields = fieldsOf(c.has(v) ? 'customer' : 'guest', v)
          return [
            v,
            Math.min(MAX_LINE_QTY, (g.get(v) ?? 0) + (c.get(v) ?? 0)),
            fields.priceMinor,
            fields.productName,
          ]
        })
        const shown = (items: CartItem[]) =>
          items
            .map((i) => [i.variantId, i.qty, i.priceMinor, i.productName])
            .sort(([a], [b]) => String(a).localeCompare(String(b)))

        expect(merged.token).toBe(customer.token)
        expect(shown(merged.items)).toEqual(expected)
        expect(new Set(merged.items.map((i) => i.variantId)).size).toBe(merged.items.length)
        expect(merged.subtotalMinor).toBe(
          merged.items.reduce((sum, i) => sum + i.priceMinor * i.qty, 0),
        )
        expect(await service.get(guest.token)).toBeNull()
        expect(await service.get(customer.token)).toEqual(merged)
      }),
      { numRuns: 60 },
    )
  })
})

describe('what a cart may hold', () => {
  const variantStatuses = ['active', 'inactive'] as const
  const productStatuses = ['active', 'draft', 'archived'] as const

  it('isSellable holds exactly when the variant and its product are both active', () => {
    for (const v of variantStatuses) {
      for (const p of productStatuses) {
        expect(isSellable({ status: v }, { status: p }), `${v}/${p}`).toBe(
          v === 'active' && p === 'active',
        )
      }
    }
  })

  // Kills: a variant whose product is missing or unsellable answered sellable, a missing variant throwing.
  it('property: createCartCatalogue answers exactly the asked ids whose variant and product exist and are both active', async () => {
    const world = fc.dictionary(
      fc.constantFrom('v1', 'v2', 'v3', 'v4', 'v5'),
      fc.record({
        variant: fc.constantFrom(...variantStatuses),
        product: fc.option(fc.constantFrom(...productStatuses), { nil: undefined }),
      }),
    )
    await fc.assert(
      fc.asyncProperty(
        world,
        fc.array(fc.constantFrom('v1', 'v2', 'v3', 'v4', 'v5', 'v-none')),
        async (variants, asked) => {
          const variant = {
            findById: async (_tx: ReadTx, id: string) => {
              const v = variants[id]
              return v ? { id, productId: `p-${id}`, status: v.variant } : null
            },
          } as unknown as VariantRepository
          const product = {
            findById: async (_tx: ReadTx, id: string) => {
              const p = variants[id.slice(2)]?.product
              return p ? { id, status: p } : null
            },
          } as unknown as ProductRepository

          const sellable = await createCartCatalogue({ variant, product }).sellable(
            {} as ReadTx,
            asked,
          )

          const expected = asked.filter((id) => {
            const v = variants[id]
            return v?.variant === 'active' && v.product === 'active'
          })
          expect([...sellable].sort()).toEqual([...new Set(expected)].sort())
        },
      ),
      { numRuns: 100 },
    )
  })

  it('a service composed without a catalogue uses the store’s: at a merge it drops a line whose variant the store does not hold', async () => {
    const { service } = await makeDeps(() => true, { storeCatalogue: true })
    const guest = await service.getOrCreate()
    await service.addItem(guest.token, { ...testItem, variantId: 'not-in-the-store' })
    const customer = await service.getOrCreate()

    const merged = await service.merge(guest.token, customer.token)

    expect(merged.items).toEqual([])
    expect(await service.get(customer.token)).toEqual(merged)
  })
})

const T0 = Date.parse('2026-06-01T12:00:00.000Z')

async function recordEvents(eventBus: InProcessEventBus): Promise<Array<[string, unknown]>> {
  const seen: Array<[string, unknown]> = []
  for (const type of [
    EVT_CART_CREATED,
    EVT_CART_ITEM_ADDED,
    EVT_CART_ITEM_REMOVED,
    EVT_CART_UPDATED,
  ]) {
    await eventBus.subscribe(type, (e) => {
      seen.push([type, e.payload])
    })
  }
  return seen
}

describe('cart lifetime and events', () => {
  // Kills: a ttl not in milliseconds, a cart readable at or after its expiry, the error naming no resource.
  it('every write slides the expiry to the write time + ttl, and the cart reads missing from its expiry on', async () => {
    let t = T0
    const { service } = await makeDeps(() => true, { ttlSeconds: 60, now: () => new Date(t) })
    const created = await service.getOrCreate()
    t += 10_000
    const added = await service.addItem(created.token, testItem)

    expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(60_000)
    expect(Date.parse(added.expiresAt) - Date.parse(added.updatedAt)).toBe(60_000)
    expect(Date.parse(added.updatedAt)).toBe(t)

    t = Date.parse(added.expiresAt) - 1
    expect(await service.get(created.token)).toEqual(added)
    t = Date.parse(added.expiresAt)
    expect(await service.get(created.token)).toBeNull()
    await expect(service.addItem(created.token, testItem)).rejects.toMatchObject({
      code: 'not_found',
      context: { resource: 'cart', identifier: created.token },
    })
  })

  // Kills: cart.created on every getOrCreate, empty event payloads, an item count that subtracts, a qty-0 update
  // that drops every line.
  it('each command emits its events with the cart, the variant, the quantity and the cart’s totals', async () => {
    const { service, eventBus, relay } = await makeDeps()
    const seen = await recordEvents(eventBus)
    const cart = await service.getOrCreate()
    await service.getOrCreate(cart.token)
    await service.addItem(cart.token, { ...testItem, variantId: 'a', qty: 2 })
    await service.addItem(cart.token, { ...testItem, variantId: 'b', qty: 3, priceMinor: 70 })
    const afterUpdate = await service.updateItemQuantity(cart.token, 'a', 0)
    const afterRemove = await service.removeItem(cart.token, 'b')
    await relay.drain()

    const cartId = cart.token
    expect(quantities(afterUpdate)).toEqual([['b', 3]])
    expect(afterRemove.items).toEqual([])
    expect(seen).toEqual([
      [EVT_CART_CREATED, { cartId, token: cartId }],
      [EVT_CART_ITEM_ADDED, { cartId, variantId: 'a', qty: 2 }],
      [EVT_CART_UPDATED, { cartId, itemCount: 2, totalMinor: 2 * testItem.priceMinor }],
      [EVT_CART_ITEM_ADDED, { cartId, variantId: 'b', qty: 3 }],
      [EVT_CART_UPDATED, { cartId, itemCount: 5, totalMinor: 2 * testItem.priceMinor + 3 * 70 }],
      [EVT_CART_ITEM_REMOVED, { cartId, variantId: 'a' }],
      [EVT_CART_UPDATED, { cartId, itemCount: 3, totalMinor: 3 * 70 }],
      [EVT_CART_ITEM_REMOVED, { cartId, variantId: 'b' }],
      [EVT_CART_UPDATED, { cartId, itemCount: 0, totalMinor: 0 }],
    ])
  })

  it('with no ttl given a cart lives thirty days from its last write', async () => {
    let t = T0
    const { service } = await makeDeps(() => true, { now: () => new Date(t) })
    const cart = await service.getOrCreate()
    const days = (c: Cart) => (Date.parse(c.expiresAt) - Date.parse(c.updatedAt)) / 86_400_000

    expect(days(cart)).toBe(30)
    t += 86_400_000 * 29
    expect(days(await service.addItem(cart.token, testItem))).toBe(30)
  })

  // Kills: a ceiling that refuses the ceiling itself.
  it('a line can be set or added to exactly 99, and not to 100', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, { ...testItem, variantId: 'set', qty: 1 })
    await service.addItem(cart.token, { ...testItem, variantId: 'add', qty: 98 })

    const atCeiling = await service.updateItemQuantity(cart.token, 'set', MAX_LINE_QTY)
    const added = await service.addItem(cart.token, { ...testItem, variantId: 'add', qty: 1 })

    expect(quantities(atCeiling)).toEqual([
      ['add', 98],
      ['set', MAX_LINE_QTY],
    ])
    expect(quantities(added)).toEqual([
      ['add', MAX_LINE_QTY],
      ['set', MAX_LINE_QTY],
    ])
    await expect(
      service.updateItemQuantity(cart.token, 'set', MAX_LINE_QTY + 1),
    ).rejects.toMatchObject({ code: 'cart.qty_limit' })
    expect(await service.get(cart.token)).toEqual(added)
  })

  it('a line keeps the product slug it was added with, and has none when added without one', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await service.addItem(cart.token, {
      ...testItem,
      variantId: 'slugged',
      productSlug: 'a-widget',
    })
    const after = await service.addItem(cart.token, { ...testItem, variantId: 'plain' })

    const { qty: _qty, ...fields } = { ...testItem, qty: 1 }
    expect(after.items).toStrictEqual([
      { ...fields, variantId: 'slugged', productSlug: 'a-widget', qty: 1 },
      { ...fields, variantId: 'plain', qty: 1 },
    ])
    expect((await service.get(cart.token))?.items[0]?.productSlug).toBe('a-widget')
  })

  it('a refused command names what it refused: the quantity, or the missing line', async () => {
    const { service } = await makeDeps()
    const cart = await service.getOrCreate()
    await expect(service.addItem(cart.token, { ...testItem, qty: -4 })).rejects.toThrow('-4')
    await expect(service.updateItemQuantity(cart.token, 'x', -7)).rejects.toThrow('-7')
    await expect(service.updateItemQuantity(cart.token, 'x', 2)).rejects.toMatchObject({
      code: 'not_found',
      context: { resource: 'cart_item', identifier: 'x' },
    })
  })
})

describe('merge and signIn', () => {
  /** A cart (a guest's when `customerId` is null) holding these lines. */
  async function cartOf(
    service: Awaited<ReturnType<typeof makeDeps>>['service'],
    customerId: string | null,
    lines: Array<[string, number]>,
    token?: string,
  ): Promise<Cart> {
    let cart = await service.getOrCreate(token, customerId)
    for (const [variantId, qty] of lines) {
      cart = await service.addItem(cart.token, { ...lineOf(variantId), qty })
    }
    return cart
  }

  it('merge of a cart into itself leaves it as it was, and with neither cart live is not_found for the customer’s token', async () => {
    const { service } = await makeDeps()
    const cart = await cartOf(service, null, [['a', 2]])

    const merged = await service.merge(cart.token, cart.token)

    expect(quantities(merged)).toEqual([['a', 2]])
    expect(await service.get(cart.token)).toEqual(merged)
    await expect(service.merge('gone-g', 'gone-c')).rejects.toMatchObject({
      code: 'not_found',
      context: { resource: 'cart', identifier: 'gone-c' },
    })
  })

  // Kills: two transactions locking the same pair in opposite orders, and so waiting on each other.
  it('property: merge and signIn lock their carts in token order', async () => {
    const locked: string[] = []
    const { service } = await makeDeps(() => true, {
      carts: (carts) => ({
        ...carts,
        lock: (tx, token) => {
          locked.push(token)
          return carts.lock(tx, token)
        },
      }),
    })
    let run = 0
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.stringMatching(/^[a-z0-9]{1,6}$/), { minLength: 2, maxLength: 2 }),
        async ([a, b]) => {
          run += 1
          const [guestToken, customerToken] = [`${a}-${run}`, `${b}-${run}`]
          await cartOf(service, null, [['x', 1]], guestToken)
          await cartOf(service, `cust-${run}`, [['y', 1]], customerToken)
          const sorted = [guestToken, customerToken].sort()

          locked.length = 0
          await service.signIn(guestToken, `cust-${run}`)
          expect(locked).toEqual(sorted)

          await cartOf(service, null, [['x', 1]], guestToken)
          locked.length = 0
          await service.merge(guestToken, customerToken)
          expect(locked).toEqual(sorted)
        },
      ),
      { numRuns: 30 },
    )
  })

  it("signIn with a guest cart and the customer's cart folds the guest's lines into the customer's at min(99, G + C) and removes the guest cart", async () => {
    const { service } = await makeDeps()
    const guest = await cartOf(service, null, [
      ['a', 60],
      ['b', 1],
    ])
    const customer = await cartOf(service, 'cust', [
      ['a', 50],
      ['c', 2],
    ])

    const result = await service.signIn(guest.token, 'cust')

    expect(result?.token).toBe(customer.token)
    expect(result?.customerId).toBe('cust')
    expect(quantities(result!)).toEqual([
      ['a', MAX_LINE_QTY],
      ['b', 1],
      ['c', 2],
    ])
    expect(await service.get(guest.token)).toBeNull()
    expect(await service.get(customer.token)).toEqual(result)
  })

  it('signIn with a guest cart whose checkout is in progress keeps the guest cart, with its fields for a shared line, and removes the customer’s', async () => {
    const { service } = await makeDeps(() => true, {
      pendingOrders: {
        findPendingByCartToken: async (_tx, token) =>
          token === pendingToken ? ({ id: 'order-1' } as Order) : null,
      },
    })
    const pendingToken = 'guest-with-checkout'
    const guest = await cartOf(service, null, [['a', 2]], pendingToken)
    const customer = await service.getOrCreate(undefined, 'cust')
    await service.addItem(customer.token, { ...lineOf('a'), productName: 'theirs', qty: 3 })
    await service.addItem(customer.token, { ...lineOf('b'), qty: 1 })

    const result = await service.signIn(guest.token, 'cust')

    expect(result?.token).toBe(guest.token)
    expect(result?.customerId).toBe('cust')
    expect(quantities(result!)).toEqual([
      ['a', 5],
      ['b', 1],
    ])
    expect(result?.items.find((i) => i.variantId === 'a')?.productName).toBe(testItem.productName)
    expect(await service.get(customer.token)).toBeNull()
    expect(await service.get(guest.token)).toEqual(result)
  })

  it('signIn with only a guest cart gives it the customer and drops its unsellable lines', async () => {
    let selling = new Set(['a', 'b'])
    const { service, eventBus, relay } = await makeDeps((id) => selling.has(id))
    const guest = await cartOf(service, null, [
      ['a', 2],
      ['b', 3],
    ])
    selling = new Set(['a'])
    const seen = await recordEvents(eventBus)

    const result = await service.signIn(guest.token, 'cust')
    await relay.drain()

    expect(result?.token).toBe(guest.token)
    expect(result?.customerId).toBe('cust')
    expect(quantities(result!)).toEqual([['a', 2]])
    expect(result?.subtotalMinor).toBe(2 * testItem.priceMinor)
    expect(await service.get(guest.token)).toEqual(result)
    expect(seen).toEqual([
      [
        EVT_CART_UPDATED,
        { cartId: guest.token, itemCount: 2, totalMinor: 2 * testItem.priceMinor },
      ],
    ])
  })

  it('signIn with only the customer’s cart drops its lines that are no longer sellable', async () => {
    let selling = new Set(['a', 'b'])
    const { service } = await makeDeps((id) => selling.has(id))
    const own = await cartOf(service, 'cust', [
      ['a', 2],
      ['b', 3],
    ])
    selling = new Set(['b'])

    const result = await service.signIn(undefined, 'cust')

    expect(result?.token).toBe(own.token)
    expect(quantities(result!)).toEqual([['b', 3]])
    expect(await service.get(own.token)).toEqual(result)
  })

  it('signIn with only a guest cart, every line sellable, gives it the customer with its lines as they were', async () => {
    const { service } = await makeDeps()
    const guest = await cartOf(service, null, [
      ['a', 2],
      ['b', 3],
    ])

    const result = await service.signIn(guest.token, 'cust')

    expect(result?.token).toBe(guest.token)
    expect(result?.customerId).toBe('cust')
    expect(quantities(result!)).toEqual(quantities(guest))
    expect(await service.get(guest.token)).toEqual(result)
  })

  it('signIn of a guest cart already the customer’s, all sellable, gives it back unwritten', async () => {
    let t = T0
    const { service, eventBus, relay } = await makeDeps(() => true, { now: () => new Date(t) })
    const own = await cartOf(service, 'cust', [['a', 4]])
    t += 60_000
    const seen = await recordEvents(eventBus)

    const results = [
      await service.signIn(undefined, 'cust'),
      await service.signIn('no-such-cart', 'cust'),
      await service.signIn(own.token, 'cust'),
    ]
    await relay.drain()

    expect(results).toEqual([own, own, own])
    expect(await service.get(own.token)).toEqual(own)
    expect(seen).toEqual([])
  })

  it('signIn never takes another customer’s cart, whatever token the request carried', async () => {
    const { service } = await makeDeps()
    const theirs = await cartOf(service, 'owner', [['a', 2]])
    const mine = await cartOf(service, 'me', [['b', 1]])

    const toMe = await service.signIn(theirs.token, 'me')
    const toNoCart = await service.signIn(theirs.token, 'someone-else')

    expect(toMe).toEqual(mine)
    expect(toNoCart).toBeNull()
    expect(await service.get(theirs.token)).toEqual(theirs)
    expect(await service.signIn(undefined, 'nobody')).toBeNull()
  })

  // The customer's cart is looked up without a lock; what counts is the cart once locked.
  it('signIn with the customer’s cart taken or expired between the lookup and the lock claims the guest cart alone', async () => {
    let t = T0
    let interfere: (cart: Cart) => Cart = (c) => c
    const { service, commandStore, repos } = await makeDeps(() => true, {
      now: () => new Date(t),
      carts: (carts) => ({
        ...carts,
        findLiveByCustomer: async (tx, customerId, at) => {
          const found = await carts.findLiveByCustomer(tx, customerId, at)
          if (found) await carts.put(tx as Tx, interfere(found))
          return found
        },
      }),
    })

    for (const change of [
      (c: Cart): Cart => ({ ...c, customerId: 'another' }),
      (c: Cart): Cart => ({ ...c, expiresAt: new Date(t).toISOString() }),
    ]) {
      t += 1000
      const own = await cartOf(service, 'cust', [['a', 1]])
      const guest = await cartOf(service, null, [['b', 2]])
      interfere = change

      const result = await service.signIn(guest.token, 'cust')

      expect(result?.token).toBe(guest.token)
      expect(quantities(result!)).toEqual([['b', 2]])
      expect(await commandStore.read((tx) => repos.cart.findByToken(tx, own.token))).toEqual(
        change(own),
      )
    }
  })
})
