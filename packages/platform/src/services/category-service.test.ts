import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  EVT_CATEGORY_CREATED,
  EVT_CATEGORY_UPDATED,
  EVT_CATEGORY_DELETED,
  EVT_PRODUCT_UPDATED,
  NotFoundError,
  ValidationError,
  type Category,
  type CategoryUpdatedV1Payload,
  type EventBusAdapter,
  type ProductUpdatedV1Payload,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createCategoryService, wouldCycle } from './category-service.js'
import { createProductService } from './product-service.js'
import { createLogger } from '../logger.js'
import { runAsActor } from '../audit/actor.js'
import { auditedCommand } from '../audit/audit.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import type { CommandStore } from '../db/command-store.js'

async function setup() {
  const commandStore = createCommandStore(
    // @ts-expect-error minimal config
    { infrastructure: { commandStore: 'sqlite' }, store: { name: 'test', currency: 'GBP' } },
    { sqlitePath: ':memory:' },
  )
  await runMigrations(commandStore, {
    migrationsRoot: new URL('../../migrations', import.meta.url).pathname,
  })
  const documentStore = new InMemoryDocumentStore({ sweepIntervalMs: 0 })
  const logger = createLogger({ pretty: false, level: 'error' })
  const eventBus = new InProcessEventBus({ logger })
  const repos = buildRepositories(commandStore, documentStore)
  const { publisher, relay } = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  )
  const service = createCategoryService({ repos, publisher, logger })
  const products = createProductService({
    store: commandStore,
    repos,
    publisher,
    logger,
    currency: 'GBP',
  })
  return { commandStore, eventBus, service, relay, repos, products }
}

describe('CategoryService', () => {
  it('list returns empty array initially', async () => {
    const { service, commandStore } = await setup()
    expect(await service.list()).toEqual([])
    await commandStore.close()
  })

  it('create returns category and emits category.created', async () => {
    const { service, eventBus, commandStore, relay } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CATEGORY_CREATED, (e) => {
      events.push(e.payload)
    })
    const cat = await service.create({ slug: 'apparel', name: 'Apparel' })
    expect(cat.id).toBeTruthy()
    expect(cat.slug).toBe('apparel')
    await relay.drain()
    expect(events).toHaveLength(1)
    await commandStore.close()
  })

  it('create throws ValidationError for empty slug', async () => {
    const { service, commandStore } = await setup()
    await expect(service.create({ slug: '   ', name: 'Bad' })).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('create throws ValidationError for duplicate slug', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'dup-slug', name: 'First' })
    await expect(service.create({ slug: 'dup-slug', name: 'Second' })).rejects.toThrow(
      ValidationError,
    )
    await commandStore.close()
  })

  it('getById returns created category', async () => {
    const { service, commandStore } = await setup()
    const created = await service.create({ slug: 'shoes', name: 'Shoes' })
    const found = await service.getById(created.id)
    // A round trip through the repository loses nothing the caller was handed.
    expect(found).toEqual(created)
    await commandStore.close()
  })

  it('getById throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.getById('nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('getBySlug returns category', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'books', name: 'Books' })
    const found = await service.getBySlug('books')
    expect(found.name).toBe('Books')
    await commandStore.close()
  })

  it('getBySlug throws NotFoundError for unknown slug', async () => {
    const { service, commandStore } = await setup()
    await expect(service.getBySlug('ghost-slug')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('update patches name and emits category.updated', async () => {
    const { service, eventBus, commandStore, relay } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CATEGORY_UPDATED, (e) => {
      events.push(e.payload)
    })
    const created = await service.create({
      slug: 'electro',
      name: 'Electronics',
      description: 'Gadgets',
      position: 3,
    })
    const updated = await service.update(created.id, { name: 'Consumer Electronics' })
    // A patch changes only the fields it names; the event carries the row the caller got back.
    expect(updated).toEqual({ ...created, name: 'Consumer Electronics' })
    await relay.drain()
    expect(events).toEqual([{ category: updated }])
    await commandStore.close()
  })

  it('update throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.update('nope', { name: 'X' })).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('AC-3: a category with neither products nor children is deleted alone, answers 0 and 0, and emits category.deleted', async () => {
    const { service, eventBus, commandStore, relay } = await setup()
    const events: unknown[] = []
    await eventBus.subscribe(EVT_CATEGORY_DELETED, (e) => {
      events.push(e.payload)
    })
    const kept = await service.create({ slug: 'to-keep', name: 'Keep Me' })
    const created = await service.create({ slug: 'to-delete', name: 'Delete Me' })
    const before = await service.list()
    const answer = await service.delete(created.id)
    const after = await service.list()
    expect(answer).toEqual({ detachedProducts: 0, movedChildren: 0 })
    await expect(service.getById(created.id)).rejects.toThrow(NotFoundError)
    // Exactly one row goes, and it is the one named: a delete without its id filter empties the table.
    expect(after).toHaveLength(before.length - 1)
    expect(after.map((c) => c.id)).toEqual([kept.id])
    await relay.drain()
    expect(events).toEqual([{ categoryId: created.id, slug: created.slug }])
    await commandStore.close()
  })

  it('delete throws NotFoundError for unknown id', async () => {
    const { service, commandStore } = await setup()
    await expect(service.delete('nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('list returns all created categories', async () => {
    const { service, commandStore } = await setup()
    await service.create({ slug: 'c1', name: 'C1' })
    await service.create({ slug: 'c2', name: 'C2' })
    const list = await service.list()
    expect(list).toHaveLength(2)
    await commandStore.close()
  })
})

// A service notes the command it runs and the records it touches into the open command, and writes no row itself.
// Under an actor with no opener (an import), each transaction a service notes in is a command of its own.
const importer = { kind: 'import', id: 'woocommerce' } as const
const admin = { kind: 'admin', id: 'admin-1' } as const

const noted = async (commandStore: CommandStore) =>
  (await commandStore.read((tx) => listAuditEntries(tx, { order: 'asc', limit: 100 }))).map(
    (e) => ({
      actor: e.actor,
      command: e.command,
      subjects: e.subjects,
      outcome: e.outcome,
      status: e.responseStatus,
    }),
  )

describe('CategoryService: audit notes', () => {
  it('AC-2: under an actor with no opener, create, update and delete each leave one applied entry naming the category', async () => {
    const { service, commandStore } = await setup()
    const cat = await runAsActor(importer, () =>
      service.create({ slug: 'audited', name: 'Audited' }),
    )
    await runAsActor(importer, () => service.update(cat.id, { name: 'Renamed' }))
    await runAsActor(importer, () => service.delete(cat.id))
    const subjects = [{ type: 'category', id: cat.id }]
    expect(await noted(commandStore)).toEqual([
      { actor: importer, command: 'category.create', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'category.update', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'category.delete', subjects, outcome: 'applied', status: null },
    ])
    await commandStore.close()
  })

  it('AC-2: a create refused before its transaction is recorded as category.create refused; with no actor nothing is recorded', async () => {
    const { service, commandStore } = await setup()
    await expect(
      runAsActor(admin, () =>
        auditedCommand(commandStore, undefined, () =>
          service.create({ slug: '  ', name: 'Blank' }),
        ),
      ),
    ).rejects.toThrow(ValidationError)
    await service.create({ slug: 'unscoped', name: 'No actor' })
    expect(await noted(commandStore)).toEqual([
      { actor: admin, command: 'category.create', subjects: [], outcome: 'refused', status: 400 },
    ])
    await commandStore.close()
  })
})

// The category tree: every parentId names a category that exists and no category is its own ancestor, whatever
// sequence of creates, moves and deletes is asked for; a delete takes the category's products and children with it.

type Link = Pick<Category, 'id' | 'parentId'>

/** True when `parentId` is `id` or has `id` among its ancestors, by walking parents (bounded, so a cycle ends it). */
function referenceCycle(rows: readonly Link[], id: string, parentId: string): boolean {
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]))
  let at: string | null | undefined = parentId
  for (let i = 0; i <= rows.length && at !== null && at !== undefined; i += 1) {
    if (at === id) return true
    at = parentOf.get(at)
  }
  return false
}

function descendantsOf(rows: readonly Link[], id: string): string[] {
  return rows.filter((r) => r.id !== id && referenceCycle(rows, id, r.id)).map((r) => r.id)
}

/** Every parentId exists, and walking parents from any category reaches a root in at most n steps. */
function expectForest(rows: readonly Link[], context: string): void {
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const row of rows) {
    if (row.parentId !== null) {
      expect(byId.has(row.parentId), `${context}: the parent of ${row.id} exists`).toBe(true)
    }
    let at: string | null = row.id
    let steps = 0
    while (at !== null && steps <= rows.length) {
      at = byId.get(at)?.parentId ?? null
      steps += 1
    }
    expect(steps, `${context}: steps from ${row.id} to a root`).toBeLessThanOrEqual(rows.length)
  }
}

interface Seen {
  type: string
  payload: unknown
}

async function record(bus: EventBusAdapter, types: readonly string[]): Promise<Seen[]> {
  const seen: Seen[] = []
  for (const type of types) {
    await bus.subscribe(type, (event) => {
      seen.push({ type, payload: event.payload })
    })
  }
  return seen
}

const UNKNOWN_ID = '00000000-0000-7000-8000-000000000000'

type Step =
  | { kind: 'create'; parent: 'none' | 'existing' | 'unknown'; pick: number }
  | {
      kind: 'move'
      target: number
      to: 'existing' | 'self' | 'descendant' | 'unknown' | 'null'
      pick: number
    }
  | { kind: 'delete'; target: number }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('create' as const),
      parent: fc.constantFrom('none' as const, 'existing' as const, 'unknown' as const),
      pick: fc.nat(),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('move' as const),
      target: fc.nat(),
      to: fc.constantFrom(
        'existing' as const,
        'self' as const,
        'descendant' as const,
        'unknown' as const,
        'null' as const,
      ),
      pick: fc.nat(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), target: fc.nat() }) },
)

const variant = (sku: string) => ({
  sku,
  name: 'Default',
  priceMinor: 1000,
  stock: 1,
  lowStockThreshold: 0,
  options: [],
})

describe('CategoryService: the tree', () => {
  it('AC-1: property: after any sequence of creates, parent moves and deletes every parentId exists and every category reaches a root; a refused step names its code and changes no row and publishes no event', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 14 }), async (steps) => {
        const { service, eventBus, relay, commandStore } = await setup()
        try {
          const seen = await record(eventBus, [
            EVT_CATEGORY_CREATED,
            EVT_CATEGORY_UPDATED,
            EVT_CATEGORY_DELETED,
            EVT_PRODUCT_UPDATED,
          ])
          for (const [i, step] of steps.entries()) {
            const rows = await service.list()
            const context = `step ${i} ${JSON.stringify(step)} over ${JSON.stringify(rows.map((r) => [r.id, r.parentId]))}`
            const ids = new Set(rows.map((r) => r.id))
            let act: () => Promise<unknown>
            let refusal: string | null = null
            // The parent the answer carries when the step is applied; a delete answers no category.
            let parentAfter: string | null | undefined

            if (step.kind === 'create') {
              const parentId =
                step.parent === 'unknown'
                  ? UNKNOWN_ID
                  : step.parent === 'existing' && rows.length > 0
                    ? rows[step.pick % rows.length]!.id
                    : null
              if (parentId !== null && !ids.has(parentId)) refusal = 'category.parent_unknown'
              act = () =>
                service.create({
                  slug: `c-${i}`,
                  name: `C ${i}`,
                  ...(parentId !== null && { parentId }),
                })
              parentAfter = parentId
            } else if (rows.length === 0) {
              continue
            } else if (step.kind === 'move') {
              const target = rows[step.target % rows.length]!
              const below = descendantsOf(rows, target.id)
              // `existing` is a legal move whenever one exists, so applied moves are tried as often as refused ones.
              const legal = rows.filter((r) => !referenceCycle(rows, target.id, r.id))
              const parentId =
                step.to === 'null'
                  ? null
                  : step.to === 'unknown'
                    ? UNKNOWN_ID
                    : step.to === 'self'
                      ? target.id
                      : step.to === 'descendant'
                        ? (below[step.pick % Math.max(below.length, 1)] ?? target.id)
                        : legal.length > 0
                          ? legal[step.pick % legal.length]!.id
                          : rows[step.pick % rows.length]!.id
              if (parentId !== null && !ids.has(parentId)) refusal = 'category.parent_unknown'
              else if (parentId !== null && referenceCycle(rows, target.id, parentId))
                refusal = 'category.parent_cycle'
              act = () => service.update(target.id, { parentId })
              parentAfter = parentId
            } else {
              const target = rows[step.target % rows.length]!
              act = () => service.delete(target.id)
              parentAfter = undefined
            }

            await relay.drain()
            const eventsBefore = seen.length
            const outcome = await act().then(
              (result) => ({
                refusal: null,
                parentId: step.kind === 'delete' ? undefined : (result as Category).parentId,
              }),
              (e: unknown) => ({
                refusal:
                  e instanceof ValidationError ? e.code : `not a ValidationError: ${String(e)}`,
                parentId: undefined,
              }),
            )
            await relay.drain()
            const rowsAfter = await service.list()

            expect(outcome, context).toEqual(
              refusal === null
                ? { refusal: null, parentId: parentAfter }
                : { refusal, parentId: undefined },
            )
            // A refused step leaves every row and publishes nothing; an applied one is judged by the forest below.
            expect(refusal === null ? rows : rowsAfter, `${context}: rows after a refusal`).toEqual(
              rows,
            )
            expect(
              refusal === null ? 0 : seen.length - eventsBefore,
              `${context}: events after a refusal`,
            ).toBe(0)
            expectForest(rowsAfter, context)
          }
        } finally {
          await relay.drain()
          await commandStore.close()
        }
      }),
      { numRuns: 30 },
    )
  }, 120_000)

  it('AC-2: property: wouldCycle agrees with a walk up the parents for any forest and any pair of its ids', () => {
    const chain: Link[] = [
      { id: 'c', parentId: 'b' },
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
    ]
    // Three deep: a check of the direct parent alone answers false here.
    expect(wouldCycle(chain, 'a', 'c')).toBe(true)
    expect(wouldCycle(chain, 'c', 'a')).toBe(false)

    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }).chain((n) =>
          fc.record({
            parents: fc.array(fc.nat(), { minLength: n, maxLength: n }),
            order: fc.shuffledSubarray(
              Array.from({ length: n }, (_, k) => k),
              { minLength: n, maxLength: n },
            ),
            id: fc.nat({ max: n - 1 }),
            parent: fc.nat({ max: n - 1 }),
          }),
        ),
        ({ parents, order, id, parent }) => {
          const parentOf = (k: number): string | null => {
            const p = k === 0 ? -1 : (parents[k]! % (k + 1)) - 1
            return p < 0 ? null : `n${p}`
          }
          const forest: Link[] = order.map((k) => ({ id: `n${k}`, parentId: parentOf(k) }))
          expect(wouldCycle(forest, `n${id}`, `n${parent}`)).toBe(
            referenceCycle(forest, `n${id}`, `n${parent}`),
          )
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-3: property: a delete detaches each product (keeping its other categories) and moves each child to the parent, with one event each, and answers the two counts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }), { maxLength: 4 }),
        fc.integer({ min: 0, max: 3 }),
        fc.boolean(),
        async (memberships, childCount, parented) => {
          const { service, products, eventBus, relay, repos, commandStore } = await setup()
          try {
            const others: Category[] = []
            for (let j = 0; j < 3; j += 1) {
              others.push(await service.create({ slug: `other-${j}`, name: `Other ${j}` }))
            }
            const target = await service.create({
              slug: 'target',
              name: 'Target',
              parentId: parented ? others[0]!.id : null,
            })
            const children: Category[] = []
            for (let j = 0; j < childCount; j += 1) {
              children.push(
                await service.create({
                  slug: `child-${j}`,
                  name: `Child ${j}`,
                  parentId: target.id,
                }),
              )
            }
            const firstChild = children[0]
            const grandchild =
              firstChild === undefined
                ? undefined
                : await service.create({
                    slug: 'grandchild',
                    name: 'Grandchild',
                    parentId: firstChild.id,
                  })
            const held: Array<{ id: string; keep: string[] }> = []
            for (const [i, member] of memberships.entries()) {
              const keep = others.filter((_, j) => member[j]).map((c) => c.id)
              const product = await products.create({
                slug: `held-${i}`,
                name: `Held ${i}`,
                status: 'active',
                categoryIds: [target.id, ...keep],
                variants: [variant(`HELD-${i}`)],
              })
              held.push({ id: product.id, keep })
            }
            await products.create({
              slug: 'bystander',
              name: 'Bystander',
              status: 'active',
              categoryIds: [others[1]!.id],
              variants: [variant('BYSTANDER')],
            })
            await relay.drain()
            const seen = await record(eventBus, [
              EVT_PRODUCT_UPDATED,
              EVT_CATEGORY_UPDATED,
              EVT_CATEGORY_DELETED,
            ])

            const answer = await service.delete(target.id)
            await relay.drain()

            expect(answer).toEqual({
              detachedProducts: held.length,
              movedChildren: children.length,
            })
            for (const product of held) {
              const now = await commandStore.read((tx) =>
                repos.productCategory.listCategoriesForProduct(tx, product.id),
              )
              expect([...now].sort(), `categories of ${product.id}`).toEqual(
                [...product.keep].sort(),
              )
            }
            expect(
              await commandStore.read((tx) =>
                repos.productCategory.listProductsForCategory(tx, target.id),
              ),
            ).toEqual([])

            const snapshots = seen
              .filter((e) => e.type === EVT_PRODUCT_UPDATED)
              .map((e) => (e.payload as ProductUpdatedV1Payload).product)
            expect(snapshots.map((p) => p.id).sort()).toEqual(held.map((p) => p.id).sort())
            for (const snapshot of snapshots) {
              const expected = held.find((h) => h.id === snapshot.id)!.keep
              expect([...snapshot.categoryIds].sort(), `snapshot of ${snapshot.id}`).toEqual(
                [...expected].sort(),
              )
            }

            const byId = new Map((await service.list()).map((c) => [c.id, c]))
            expect(children.map((c) => byId.get(c.id)?.parentId)).toEqual(
              children.map(() => target.parentId),
            )
            // A grandchild stays under its own parent: only the direct children move.
            expect(grandchild && byId.get(grandchild.id)?.parentId).toBe(grandchild?.parentId)
            const moved = seen
              .filter((e) => e.type === EVT_CATEGORY_UPDATED)
              .map((e) => (e.payload as CategoryUpdatedV1Payload).category)
            expect(moved.map((c) => c.id).sort()).toEqual(children.map((c) => c.id).sort())
            expect(moved.map((c) => c.parentId)).toEqual(children.map(() => target.parentId))
            expect(
              seen.filter((e) => e.type === EVT_CATEGORY_DELETED).map((e) => e.payload),
            ).toEqual([{ categoryId: target.id, slug: target.slug }])
          } finally {
            await relay.drain()
            await commandStore.close()
          }
        },
      ),
      { numRuns: 25 },
    )
  }, 120_000)
})

describe('CategoryService: reorder', () => {
  it("AC-5: property: any order of one parent's children numbers them 0..n-1 with one category.updated per child that moved; an omitted, repeated or foreign id is refused category.reorder_mismatch with no write and no event", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }).chain((n) =>
          fc.record({
            positions: fc.array(fc.nat({ max: n }), { minLength: n, maxLength: n }),
            order: fc.shuffledSubarray(
              Array.from({ length: n + 1 }, (_, k) => k),
              { minLength: n + 1, maxLength: n + 1 },
            ),
            parented: fc.boolean(),
            bad: fc.constantFrom('none', 'none', 'omit', 'repeat', 'foreign'),
            pick: fc.nat(),
          }),
        ),
        async ({ positions, order, parented, bad, pick }) => {
          const { service, eventBus, relay, commandStore } = await setup()
          try {
            // `other` is a root with a child of its own, so a parent's children are never every row.
            const other = await service.create({ slug: 'other', name: 'Other', position: 0 })
            const cousin = await service.create({
              slug: 'cousin',
              name: 'Cousin',
              parentId: other.id,
            })
            const parent = parented
              ? await service.create({ slug: 'parent', name: 'Parent', position: 1 })
              : null
            const parentId = parent?.id ?? null
            const kids: Category[] = []
            for (const [k, position] of positions.entries()) {
              kids.push(
                await service.create({
                  slug: `kid-${k}`,
                  name: `Kid ${k}`,
                  position,
                  ...(parentId !== null && { parentId }),
                }),
              )
            }
            const siblings = parent === null ? [other, ...kids] : kids
            const foreign = parent === null ? [cousin] : [cousin, other, parent]
            const good = order.filter((k) => k < siblings.length).map((k) => siblings[k]!.id)
            const ids = [...good]
            const j = pick % ids.length
            if (bad === 'omit') ids.splice(j, 1)
            if (bad === 'repeat') ids[j] = ids[(j + 1) % ids.length]!
            if (bad === 'foreign') ids[j] = foreign[pick % foreign.length]!.id
            if (bad === 'repeat' && ids.length === 1) ids.push(ids[0]!)

            await relay.drain()
            const before = await service.list()
            const byId = new Map(before.map((c) => [c.id, c]))
            const seen = await record(eventBus, [EVT_CATEGORY_UPDATED])
            const context = `${bad} ${JSON.stringify(ids)} over ${JSON.stringify(before.map((c) => [c.id, c.parentId, c.position]))}`

            const outcome = await service.reorder(parentId, ids).then(
              (answer) => ({ answer, refusal: null }),
              (e: unknown) => ({
                answer: null,
                refusal:
                  e instanceof ValidationError ? e.code : `not a ValidationError: ${String(e)}`,
              }),
            )
            await relay.drain()
            const after = await service.list()
            const sortById = (rows: readonly Category[]) =>
              [...rows].sort((a, b) => a.id.localeCompare(b.id))

            // Applied: the parent's children hold 0..n-1 in the order asked and every other row is as it was.
            // Refused: nothing is written and nothing is published.
            const applied = bad === 'none'
            const expected = good.map((id, position) => ({ ...byId.get(id)!, position }))
            const renumbered = new Map((applied ? expected : []).map((c) => [c.id, c] as const))
            expect(outcome, context).toEqual(
              applied
                ? { answer: expected, refusal: null }
                : { answer: null, refusal: 'category.reorder_mismatch' },
            )
            expect(sortById(after), context).toEqual(
              sortById(before.map((c) => renumbered.get(c.id) ?? c)),
            )
            expect(
              seen.map((e) => (e.payload as CategoryUpdatedV1Payload).category),
              context,
            ).toEqual(
              applied ? expected.filter((c) => byId.get(c.id)!.position !== c.position) : [],
            )
          } finally {
            await relay.drain()
            await commandStore.close()
          }
        },
      ),
      { numRuns: 40 },
    )
  }, 120_000)

  it('AC-5: under an actor with no opener, a reorder leaves one applied category.reorder entry naming each id in the order given', async () => {
    const { service, commandStore, relay } = await setup()
    const a = await service.create({ slug: 'a', name: 'A', position: 0 })
    const b = await service.create({ slug: 'b', name: 'B', position: 1 })
    await runAsActor(importer, () => service.reorder(null, [b.id, a.id]))
    expect(await noted(commandStore)).toEqual([
      {
        actor: importer,
        command: 'category.reorder',
        subjects: [
          { type: 'category', id: b.id },
          { type: 'category', id: a.id },
        ],
        outcome: 'applied',
        status: null,
      },
    ])
    await relay.drain()
    await commandStore.close()
  })
})
