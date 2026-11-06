import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  EVT_CUSTOMER_DELETED,
  type DocumentStoreAdapter,
  type NymbalEvent,
  type PutOptions,
  type QueryParams,
  type QueryResult,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../../src/document-store/in-memory.js'
import type { DerivedHandler } from '../../src/handlers/derived.js'
import {
  diffReadModel,
  READ_MODELS,
  rebuild,
  type ReadModelDiff,
  type ReadModelName,
} from '../../src/read-models/index.js'
import {
  address,
  cartWith,
  createKernel,
  seedVariant,
  type Kernel,
  type Seeded,
} from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { openRaw, type RawReader } from '../support/raw.js'
import { rebuildDeps } from '../support/read-models.js'

// Two reprojections of one entity racing, as `nymbal replay`'s catch-up beside a live server does, or two replicas:
// one reads the entity's rows and then has its document writes held, at the granularity of single writes, while the
// entity changes and another reprojection of it runs to the end. Once every reprojection has returned, the read model
// must equal what a rebuild writes from the rows as they are now (`diffReadModel` reports no change), and an entity
// that is gone has no document. The live projections are the read models' own handlers, bound to a document store that
// can hold a reprojection's writes; each is called with the events the change appended to the log, as the relay would.

/** A promise and the function that resolves it. */
function signal(): { promise: Promise<void>; fire(): void } {
  let fire!: () => void
  const promise = new Promise<void>((resolve) => {
    fire = resolve
  })
  return { promise, fire }
}

/** One reprojection's writes: which of them wait (by their index, the mask repeating), and what runs before each. */
class Hold {
  private open = false
  private writes = 0
  private release: (() => void) | null = null
  private parked = signal()

  constructor(
    private readonly mask: readonly boolean[],
    private readonly onWrite?: (collection: string, key: string) => Promise<void>,
  ) {}

  async before(collection: string, key: string): Promise<void> {
    const n = this.writes
    this.writes += 1
    await this.onWrite?.(collection, key)
    if (this.open || this.mask.length === 0 || !this.mask[n % this.mask.length]) return
    await new Promise<void>((resolve) => {
      this.release = resolve
      this.parked.fire()
    })
  }

  get waiting(): boolean {
    return this.release !== null
  }

  /** Resolves once a write is waiting. */
  parkedAt(): Promise<void> {
    return this.release !== null ? Promise.resolve() : this.parked.promise
  }

  /** Lets the waiting write through; a later write in the mask waits again. */
  step(): void {
    const release = this.release
    this.release = null
    this.parked = signal()
    release?.()
  }

  /** Lets every write through, now and after. */
  openAll(): void {
    this.open = true
    this.step()
  }
}

/** A document store whose writes, made inside a held reprojection, wait on its hold. */
class HoldingDocumentStore implements DocumentStoreAdapter {
  constructor(
    private readonly inner: DocumentStoreAdapter,
    private readonly holds: AsyncLocalStorage<Hold>,
  ) {}

  private async gate(collection: string, key: string): Promise<void> {
    await this.holds.getStore()?.before(collection, key)
  }

  capabilities(): readonly string[] {
    return this.inner.capabilities()
  }
  get<T>(collection: string, key: string): Promise<T | null> {
    return this.inner.get<T>(collection, key)
  }
  async put<T>(collection: string, key: string, document: T, options?: PutOptions): Promise<void> {
    await this.gate(collection, key)
    await this.inner.put(collection, key, document, options)
  }
  async delete(collection: string, key: string): Promise<void> {
    await this.gate(collection, key)
    await this.inner.delete(collection, key)
  }
  query<T>(collection: string, params: QueryParams): Promise<QueryResult<T>> {
    return this.inner.query<T>(collection, params)
  }
  batchGet<T>(collection: string, keys: string[]): Promise<Map<string, T>> {
    return this.inner.batchGet<T>(collection, keys)
  }
  async batchPut<T>(collection: string, items: Map<string, T>): Promise<void> {
    for (const key of items.keys()) await this.gate(collection, key)
    await this.inner.batchPut(collection, items)
  }
  replaceCollection<T>(collection: string, entries: AsyncIterable<[string, T]>): Promise<void> {
    return this.inner.replaceCollection(collection, entries)
  }
  close(): Promise<void> {
    return this.inner.close()
  }
}

/** One reprojection: a handler called with one event, maybe under a hold. */
interface Run {
  handler: DerivedHandler
  event: NymbalEvent<unknown>
  hold: Hold | null
  done: Promise<void>
  returned: boolean
  error?: unknown
}

/** A kernel on a SQLite file of its own, and the read models' handlers bound to a holding document store. */
interface Bench {
  k: Kernel
  raw: RawReader
  docs: InMemoryDocumentStore
  holds: AsyncLocalStorage<Hold>
  handlers(model: ReadModelName): DerivedHandler[]
  close(): Promise<void>
}

async function bench(models: readonly ReadModelName[]): Promise<Bench> {
  const k = await createKernel({ dialect: 'sqlite' })
  const raw = openRaw('sqlite', k.target)
  const docs = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const holds = new AsyncLocalStorage<Hold>()
  const deps = rebuildDeps(k, { documentStore: new HoldingDocumentStore(docs, holds) })
  // The documents start as a rebuild writes them.
  await rebuild(models, rebuildDeps(k, { documentStore: docs }))
  return {
    k,
    raw,
    docs,
    holds,
    handlers: (model) => READ_MODELS.find((m) => m.name === model)!.handlers(deps),
    async close() {
      await raw.close()
      await docs.close()
      await k.close()
    },
  }
}

function start(
  b: Bench,
  handler: DerivedHandler,
  event: NymbalEvent<unknown>,
  hold: Hold | null,
): Run {
  const run = { handler, event, hold, returned: false } as Run
  const handled =
    hold === null ? handler.handle(event) : b.holds.run(hold, () => handler.handle(event))
  run.done = Promise.resolve(handled).then(
    () => {
      run.returned = true
    },
    (err: unknown) => {
      run.returned = true
      run.error = err
    },
  )
  return run
}

/** Until the run waits at a held write, or has returned. */
async function reached(run: Run): Promise<void> {
  if (run.hold === null) await run.done
  else await Promise.race([run.done, run.hold.parkedAt()])
}

/** The events appended to the log after `seq`, in order. */
async function eventsAfter(raw: RawReader, seq: number): Promise<NymbalEvent<unknown>[]> {
  return (await eventRows(raw, 'seq > ?', [seq])).map((row) => row.envelope)
}

/** Runs `act`, then the handlers of `model` its events trigger, each under the hold `holdOf` gives it (null: to the end). */
async function changed(
  b: Bench,
  model: ReadModelName,
  act: () => Promise<unknown>,
  holdOf: () => Hold | null,
): Promise<Run[]> {
  const seq = await maxSeq(b.raw)
  await act()
  const runs: Run[] = []
  for (const event of await eventsAfter(b.raw, seq)) {
    for (const handler of b.handlers(model).filter((h) => h.types.includes(event.type))) {
      const run = start(b, handler, event, holdOf())
      runs.push(run)
      await reached(run)
    }
  }
  return runs
}

/**
 * Lets every held write through, in the order given, each run to its end; a run that rejected `did not settle` is run
 * again, as the relay retries a failed delivery.
 */
async function finish(runs: readonly Run[]): Promise<string[]> {
  for (const run of runs) {
    run.hold?.openAll()
    await run.done
  }
  const failures: string[] = []
  for (const run of runs) {
    if (run.error === undefined) continue
    if (!/did not settle/.test(String(run.error))) {
      failures.push(`${run.handler.name} on ${run.event.type}: ${String(run.error)}`)
      continue
    }
    let error: unknown = run.error
    for (let attempt = 0; attempt < 3 && error !== undefined; attempt += 1) {
      error = undefined
      await Promise.resolve(run.handler.handle(run.event)).catch((err: unknown) => {
        error = err
      })
    }
    if (error !== undefined) failures.push(`${run.handler.name} retried: ${String(error)}`)
  }
  return failures
}

/** The named collections of a diff, each with what it added, changed and removed. */
function countsOf(diff: ReadModelDiff, names: readonly string[]) {
  return names.map((name) => {
    const c = diff.collections.find((x) => x.name === name)
    return { name, added: c?.added, changed: c?.changed, removed: c?.removed }
  })
}

const settledTo = (names: readonly string[]) =>
  names.map((name) => ({ name, added: 0, changed: 0, removed: 0 }))

// ─── One product, its variant and two categories ──────────────────────────────────────────────────────────────────────

type Change =
  | { kind: 'edit'; n: number }
  | { kind: 'price'; priceMinor: number }
  | { kind: 'stock'; delta: number }
  | { kind: 'assign'; cat: number }
  | { kind: 'unassign'; cat: number }
  | { kind: 'rename'; cat: number; n: number }
  | { kind: 'delete' }

type Step =
  | { kind: 'change'; change: Change; hold: boolean[] | null }
  | { kind: 'release'; pick: number }

interface Subject {
  tag: string
  productId: string
  slug: string
  variantId: string
  stock: number
  categories: Array<{ id: string; slug: string }>
  assigned: Set<number>
  deleted: boolean
}

const CATALOGUE_COLLECTIONS = ['products', 'products-by-category'] as const

async function subject(k: Kernel): Promise<Subject> {
  const tag = randomUUID().slice(0, 8)
  const categories = []
  for (const n of [0, 1]) {
    const c = await k.services.category.create({ slug: `settle-${tag}-${n}`, name: `Shelf ${n}` })
    categories.push({ id: c.id, slug: c.slug })
  }
  const product = await k.services.product.create({
    slug: `settle-${tag}`,
    name: `Settle ${tag}`,
    description: '',
    status: 'active',
    variants: [
      {
        sku: `SETTLE-${tag}`,
        name: 'Default',
        priceMinor: 1500,
        stock: 4,
        lowStockThreshold: 0,
        options: [],
      },
    ],
  })
  return {
    tag,
    productId: product.id,
    slug: product.slug,
    variantId: product.variants[0]!.id,
    stock: 4,
    categories,
    assigned: new Set(),
    deleted: false,
  }
}

/** The subject made, and every reprojection its creation triggers run to the end. */
async function created(b: Bench): Promise<Subject> {
  let s: Subject | undefined
  const failures = await finish(
    await changed(
      b,
      'catalogue',
      async () => {
        s = await subject(b.k)
      },
      () => null,
    ),
  )
  expect(failures, 'projecting the subject’s creation').toEqual([])
  return s!
}

/** Makes the change through the services; false when it would change nothing. */
async function apply(k: Kernel, s: Subject, c: Change): Promise<boolean> {
  if (s.deleted) return false
  const update = (input: Parameters<Kernel['services']['product']['update']>[1]) =>
    k.services.product.update(s.productId, input)
  switch (c.kind) {
    case 'edit':
      await update({ name: `Settle ${s.tag} ${c.n}` })
      return true
    case 'price':
      await update({ variants: [{ id: s.variantId, priceMinor: c.priceMinor }] })
      return true
    case 'stock': {
      const delta = Math.max(c.delta, -s.stock)
      if (delta === 0) return false
      await k.services.inventory.adjustStock(s.variantId, delta, 'manual', 'settle-suite')
      s.stock += delta
      return true
    }
    case 'assign':
    case 'unassign': {
      const has = s.assigned.has(c.cat)
      if (has === (c.kind === 'assign')) return false
      if (c.kind === 'assign') s.assigned.add(c.cat)
      else s.assigned.delete(c.cat)
      await update({ categoryIds: [...s.assigned].map((i) => s.categories[i]!.id) })
      return true
    }
    case 'rename':
      await k.services.category.update(s.categories[c.cat]!.id, { name: `Shelf ${c.n}` })
      return true
    case 'delete':
      await k.services.product.delete(s.productId)
      s.deleted = true
      return true
  }
}

const arbChange: fc.Arbitrary<Change> = fc.oneof(
  fc.record({ kind: fc.constant('edit' as const), n: fc.nat(999) }),
  fc.record({
    kind: fc.constant('price' as const),
    priceMinor: fc.integer({ min: 100, max: 5000 }),
  }),
  fc.record({
    kind: fc.constant('stock' as const),
    delta: fc.integer({ min: -3, max: 3 }).filter((d) => d !== 0),
  }),
  fc.record({ kind: fc.constant('assign' as const), cat: fc.nat(1) }),
  fc.record({ kind: fc.constant('unassign' as const), cat: fc.nat(1) }),
  fc.record({ kind: fc.constant('rename' as const), cat: fc.nat(1), n: fc.nat(999) }),
  fc.constant({ kind: 'delete' as const }),
)

const arbStep: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('change' as const),
      change: arbChange,
      hold: fc.option(
        fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }).filter((m) => m.some(Boolean)),
        { nil: null, freq: 2 },
      ),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('release' as const), pick: fc.nat(7) }) },
)

describe('read models settle when two reprojections of one entity race', () => {
  it('AC-1: property: over random changes to one product (fields, price, stock, categories assigned, unassigned or renamed, deleted) and random schedules holding a reprojection’s writes, one by one or a subset of them, until a later reprojection of the product has returned, once every reprojection has returned products and products-by-category equal a rebuild and a deleted product has no document', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbStep, { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        async (steps, newestFirst) => {
          const b = await bench(['catalogue'])
          try {
            const s = await created(b)
            const runs: Run[] = []
            for (const step of steps) {
              if (step.kind === 'change') {
                const hold = step.hold
                runs.push(
                  ...(await changed(
                    b,
                    'catalogue',
                    () => apply(b.k, s, step.change),
                    () => (hold === null ? null : new Hold(hold)),
                  )),
                )
              } else {
                const waiting = runs.filter((r) => !r.returned && r.hold?.waiting === true)
                if (waiting.length === 0) continue
                const run = waiting[step.pick % waiting.length]!
                run.hold!.step()
                await reached(run)
              }
            }

            const failures = await finish(newestFirst ? [...runs].reverse() : runs)
            expect(failures, 'reprojections that failed other than by not settling').toEqual([])
            const diff = await diffReadModel(
              'catalogue',
              rebuildDeps(b.k, { documentStore: b.docs }),
            )
            expect(countsOf(diff, CATALOGUE_COLLECTIONS), JSON.stringify(steps)).toEqual(
              settledTo(CATALOGUE_COLLECTIONS),
            )
            const byCategory = await b.docs.query<{ slug: string }>('products-by-category', {
              partitionKey: { field: 'partitionKey', value: '*' },
            })
            expect(
              {
                product: (await b.docs.get('products', s.slug)) !== null,
                byCategory: byCategory.items.filter((d) => d.slug === s.slug).length,
              },
              'the product’s documents: none once it is deleted',
            ).toEqual({
              product: !s.deleted,
              byCategory: s.deleted ? 0 : s.assigned.size,
            })
          } finally {
            await b.close()
          }
        },
      ),
      {
        numRuns: 15,
        examples: [
          [
            [
              { kind: 'change', change: { kind: 'price', priceMinor: 900 }, hold: [true] },
              { kind: 'change', change: { kind: 'price', priceMinor: 700 }, hold: null },
            ],
            true,
          ],
          [
            [
              { kind: 'change', change: { kind: 'assign', cat: 0 }, hold: [false, true] },
              { kind: 'change', change: { kind: 'unassign', cat: 0 }, hold: null },
              { kind: 'change', change: { kind: 'assign', cat: 1 }, hold: null },
            ],
            true,
          ],
          [
            [
              { kind: 'change', change: { kind: 'stock', delta: 2 }, hold: [true] },
              { kind: 'change', change: { kind: 'delete' }, hold: null },
            ],
            false,
          ],
        ],
      },
    )
  }, 300_000)

  it('AC-1: a reprojection whose product changes under every write throws did not settle in place of a fourth round, after three; run again, as the relay retries it, it leaves products and products-by-category equal to a rebuild', async () => {
    const b = await bench(['catalogue'])
    try {
      const s = await created(b)
      let rounds = 0
      const restless = new Hold([], async (collection, key) => {
        if (collection !== 'products' || key !== s.slug) return
        rounds += 1
        await b.k.services.inventory.adjustStock(s.variantId, 1, 'manual', 'settle-suite')
      })
      const seq = await maxSeq(b.raw)
      await apply(b.k, s, { kind: 'edit', n: 1 })
      const event = (await eventsAfter(b.raw, seq)).find((e) => e.type === 'product.updated.v1')!
      const [reproject] = b.handlers('catalogue').filter((h) => h.types.includes(event.type))

      await expect(b.holds.run(restless, () => reproject!.handle(event))).rejects.toThrow(
        /did not settle/,
      )
      expect(rounds, 'products writes before the throw').toBe(3)

      await reproject!.handle(event)
      const diff = await diffReadModel('catalogue', rebuildDeps(b.k, { documentStore: b.docs }))
      expect(countsOf(diff, CATALOGUE_COLLECTIONS)).toEqual(settledTo(CATALOGUE_COLLECTIONS))
    } finally {
      await b.close()
    }
  }, 60_000)
})

// ─── The other reprojections, one held interleaving each ──────────────────────────────────────────────────────────────

/**
 * `make` creates the entity and every reprojection its events trigger is held before its first write; `move` changes
 * the entity and its reprojections run to the end; then the held writes go through. Answers the diff of `model`.
 */
async function heldThenMoved(
  model: ReadModelName,
  make: (k: Kernel) => Promise<void>,
  move: (k: Kernel) => Promise<void>,
): Promise<{ diff: ReadModelDiff; held: number; failures: string[] }> {
  const b = await bench([model])
  try {
    const held = await changed(
      b,
      model,
      () => make(b.k),
      () => new Hold([true]),
    )
    const moved = await changed(
      b,
      model,
      () => move(b.k),
      () => null,
    )
    const failures = await finish([...moved, ...held])
    const diff = await diffReadModel(model, rebuildDeps(b.k, { documentStore: b.docs }))
    return { diff, held: held.length, failures }
  } finally {
    await b.close()
  }
}

async function registered(k: Kernel): Promise<string> {
  const { customer } = await k.services.auth.register({
    email: `settle-${randomUUID()}@settle.test`,
    password: 'correct-horse-battery',
  })
  return customer.id
}

describe('the other read models settle under the same race', () => {
  it('AC-2: an order whose status moves between a held reprojection’s read and its writes does not keep the stale status in orders or orders-by-customer', async () => {
    let orderId = ''
    const { diff, held, failures } = await heldThenMoved(
      'orders',
      async (k) => {
        const customerId = await registered(k)
        orderId = randomUUID()
        const total = 2500
        await k.services.order.importOrder({
          orderId,
          orderNumber: `SET-${randomUUID().slice(0, 8)}`,
          status: 'processing',
          customerId,
          email: `buyer-${randomUUID()}@settle.test`,
          billingAddress: address,
          shippingAddress: address,
          lineItems: [
            {
              variantId: randomUUID(),
              productId: randomUUID(),
              productName: 'Settled Widget',
              variantName: 'Default',
              sku: 'SETTLED-1',
              qty: 1,
              unitPriceMinor: total,
              lineSubtotalMinor: total,
              lineTaxMinor: 0,
              lineTotalMinor: total,
              imageUrl: '',
            },
          ],
          subtotalMinor: total,
          taxTotalMinor: 0,
          shippingTotalMinor: 0,
          discountTotalMinor: 0,
          totalMinor: total,
          currency: 'GBP',
          createdAt: new Date(),
          capturedMinor: total,
          captureMethod: 'import',
          refundedMinor: 0,
        })
      },
      async (k) => {
        await k.services.order.markShipped(orderId, '1ZSETTLE0001', 'Royal Mail', 'settle-suite')
      },
    )
    expect(held, 'reprojections held').toBeGreaterThanOrEqual(1)
    expect(failures).toEqual([])
    expect(countsOf(diff, ['orders', 'orders-by-customer'])).toEqual(
      settledTo(['orders', 'orders-by-customer']),
    )
  }, 60_000)

  // The profile carries the customer's order count and spend, not its name: a paid order is what moves it.
  it('AC-2: a customer whose stats move (an order paid) between a held reprojection’s read and its writes does not keep the old stats in customer-profiles', async () => {
    let customerId = ''
    let seeded!: Seeded
    const { diff, held, failures } = await heldThenMoved(
      'customers',
      async (k) => {
        seeded = await seedVariant(k, 5)
        customerId = await registered(k)
      },
      async (k) => {
        await k.services.checkout.beginCheckout({
          cartToken: await cartWith(k, seeded, 1),
          customerId,
          email: `paid-${randomUUID()}@settle.test`,
          billingAddress: address,
          shippingAddress: address,
        })
      },
    )
    expect(held, 'reprojections held').toBeGreaterThanOrEqual(1)
    expect(failures).toEqual([])
    expect(countsOf(diff, ['customer-profiles'])).toEqual(settledTo(['customer-profiles']))
  }, 60_000)

  it('AC-2: a customer deleted between a held reprojection’s read and its writes has no document in customer-profiles', async () => {
    let customerId = ''
    const { diff, held, failures } = await heldThenMoved(
      'customers',
      async (k) => {
        customerId = await registered(k)
      },
      async (k) => {
        await k.store.transaction(async (tx) => {
          await k.repos.customer.delete(tx, customerId)
          await k.publisher.publish(EVT_CUSTOMER_DELETED, { customerId })
        })
      },
    )
    expect(held, 'reprojections held').toBeGreaterThanOrEqual(1)
    expect(failures).toEqual([])
    expect(countsOf(diff, ['customer-profiles'])).toEqual(settledTo(['customer-profiles']))
  }, 60_000)

  it('AC-2: a category whose name changes between a held reprojection’s read and its writes does not keep the old name in categories', async () => {
    let categoryId = ''
    const { diff, held, failures } = await heldThenMoved(
      'catalogue',
      async (k) => {
        const tag = randomUUID().slice(0, 8)
        categoryId = (await k.services.category.create({ slug: `settle-${tag}`, name: 'Before' }))
          .id
      },
      async (k) => {
        await k.services.category.update(categoryId, { name: 'After' })
      },
    )
    expect(held, 'reprojections held').toBeGreaterThanOrEqual(1)
    expect(failures).toEqual([])
    expect(countsOf(diff, ['categories'])).toEqual(settledTo(['categories']))
  }, 60_000)
})
