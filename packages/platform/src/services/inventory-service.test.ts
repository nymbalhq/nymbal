import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  AdapterError,
  EVT_INVENTORY_CHANGED,
  EVT_INVENTORY_RESERVED,
  EVT_INVENTORY_RELEASED,
  EVT_INVENTORY_LOW_STOCK,
  EVT_INVENTORY_OUT_OF_STOCK,
  NotFoundError,
  ValidationError,
} from '@nymbalhq/types'
import { InMemoryDocumentStore } from '../document-store/in-memory.js'
import { InProcessEventBus } from '../event-bus/in-process.js'
import { createCommandStore } from '../db/command-store.js'
import { runMigrations } from '../db/migrate.js'
import { buildRepositories } from '../repositories/index.js'
import { createEventPublisher, createRelay } from '../index.js'
import { wirePublisher } from '../tests/publisher.js'
import { createProductService } from './product-service.js'
import { createInventoryService } from './inventory-service.js'
import { createLogger } from '../logger.js'
import { runAsActor } from '../audit/actor.js'
import { auditedCommand } from '../audit/audit.js'
import { listAuditEntries } from '../repositories/audit-entry.js'
import { runWithCorrelation } from '../events/correlation.js'
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
  const publisher = wirePublisher(
    { createEventPublisher, createRelay },
    { store: commandStore, eventLog: repos.eventLog, eventBus, logger },
  ).publisher
  const product = createProductService({ store: commandStore, repos, publisher, logger })
  const inventory = createInventoryService({ store: commandStore, repos, publisher, logger })
  return { commandStore, eventBus, product, inventory, repos }
}

async function createTestVariant(product: ReturnType<typeof createProductService>, stock = 20) {
  const snap = await product.create({
    slug: `inv-test-${Math.random().toString(36).slice(2)}`,
    name: 'Inventory Test',
    description: '',
    status: 'active',
    variants: [
      { sku: 'INV-1', name: 'Default', priceMinor: 1000, stock, lowStockThreshold: 3, options: [] },
    ],
  })
  return snap.variants[0]!
}

describe('InventoryService', () => {
  it('adjustStock increases stock and emits inventory.changed', async () => {
    const { commandStore, eventBus, product, inventory, repos } = await setup()
    const variant = await createTestVariant(product, 10)
    const changed: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_CHANGED, (e) => {
      changed.push(e.payload)
    })
    const result = await inventory.adjustStock(variant.id, 5, 'manual', 'admin')
    expect(result.newQty).toBe(15)
    const fresh = await commandStore.read((tx) => repos.variant.findById(tx, variant.id))
    expect(fresh?.stock).toBe(15)
    expect(changed.length).toBeGreaterThanOrEqual(1)
    await commandStore.close()
  })

  it('adjustStock decreases stock', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 10)
    const result = await inventory.adjustStock(variant.id, -4, 'manual', 'admin')
    expect(result.newQty).toBe(6)
    await commandStore.close()
  })

  it('adjustStock throws ValidationError when going below zero', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 5)
    await expect(inventory.adjustStock(variant.id, -10, 'manual', 'admin')).rejects.toThrow(
      ValidationError,
    )
    await commandStore.close()
  })

  it('adjustStock throws NotFoundError for unknown variant', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.adjustStock('nope', 1, 'manual', 'admin')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('adjustStock emits low_stock when threshold crossed', async () => {
    const { commandStore, eventBus, product, inventory } = await setup()
    const variant = await createTestVariant(product, 5)
    const lowStock: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_LOW_STOCK, (e) => {
      lowStock.push(e.payload)
    })
    await inventory.adjustStock(variant.id, -3, 'manual', 'admin')
    await new Promise((r) => setTimeout(r, 10))
    expect(lowStock).toHaveLength(1)
    await commandStore.close()
  })

  it('adjustStock emits out_of_stock when stock reaches zero', async () => {
    const { commandStore, eventBus, product, inventory } = await setup()
    const variant = await createTestVariant(product, 3)
    const oos: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_OUT_OF_STOCK, (e) => {
      oos.push(e.payload)
    })
    await inventory.adjustStock(variant.id, -3, 'manual', 'admin')
    await new Promise((r) => setTimeout(r, 10))
    expect(oos).toHaveLength(1)
    await commandStore.close()
  })

  it('reserveStock deducts from available stock and emits reserved', async () => {
    const { commandStore, eventBus, product, inventory, repos } = await setup()
    const variant = await createTestVariant(product, 20)
    const reserved: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_RESERVED, (e) => {
      reserved.push(e.payload)
    })
    const result = await inventory.reserveStock(variant.id, 5)
    expect(result.reservationId).toBeTruthy()
    expect(result.expiresAt).toBeTruthy()
    const fresh = await commandStore.read((tx) => repos.variant.findById(tx, variant.id))
    expect(fresh?.stock).toBe(15)
    await new Promise((r) => setTimeout(r, 10))
    expect(reserved).toHaveLength(1)
    await commandStore.close()
  })

  it('reserveStock throws when insufficient stock', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 5)
    await expect(inventory.reserveStock(variant.id, 10)).rejects.toThrow(AdapterError)
    await commandStore.close()
  })

  it('reserveStock rejects qty <= 0', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 10)
    await expect(inventory.reserveStock(variant.id, 0)).rejects.toThrow(ValidationError)
    await commandStore.close()
  })

  it('releaseReservation restores stock and emits released', async () => {
    const { commandStore, eventBus, product, inventory, repos } = await setup()
    const variant = await createTestVariant(product, 10)
    const { reservationId } = await inventory.reserveStock(variant.id, 4)
    const released: unknown[] = []
    await eventBus.subscribe(EVT_INVENTORY_RELEASED, (e) => {
      released.push(e.payload)
    })
    await inventory.releaseReservation(reservationId, 'cancelled')
    const fresh = await commandStore.read((tx) => repos.variant.findById(tx, variant.id))
    expect(fresh?.stock).toBe(10)
    await new Promise((r) => setTimeout(r, 10))
    expect(released).toHaveLength(1)
    await commandStore.close()
  })

  it('releaseReservation is idempotent (missing reservation is silently ignored)', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.releaseReservation('ghost-id', 'abandoned')).resolves.not.toThrow()
    await commandStore.close()
  })

  it('commitReservation removes reservation without restoring stock', async () => {
    const { commandStore, product, inventory, repos } = await setup()
    const variant = await createTestVariant(product, 10)
    const { reservationId } = await inventory.reserveStock(variant.id, 4)
    await inventory.commitReservation(reservationId, 'fulfillment')
    const resAfter = await commandStore.read((tx) =>
      repos.inventoryReservation.findById(tx, reservationId),
    )
    expect(resAfter).toBeNull()
    const fresh = await commandStore.read((tx) => repos.variant.findById(tx, variant.id))
    expect(fresh?.stock).toBe(6)
    await commandStore.close()
  })

  it('commitReservation throws for unknown reservation', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.commitReservation('nope', 'fulfillment')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('getStockStatus returns correct status for in_stock', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 20)
    const status = await inventory.getStockStatus(variant.id)
    expect(status.status).toBe('in_stock')
    expect(status.stock).toBe(20)
    await commandStore.close()
  })

  it('getStockStatus returns low_stock when at threshold', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 3)
    const status = await inventory.getStockStatus(variant.id)
    expect(status.status).toBe('low_stock')
    await commandStore.close()
  })

  it('getStockStatus returns out_of_stock when zero', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 0)
    const status = await inventory.getStockStatus(variant.id)
    expect(status.status).toBe('out_of_stock')
    await commandStore.close()
  })

  it('getStockStatus throws NotFoundError for unknown variant', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.getStockStatus('nope')).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('reserveStock throws NotFoundError for unknown variant', async () => {
    const { commandStore, inventory } = await setup()
    await expect(inventory.reserveStock('unknown-variant', 1, null)).rejects.toThrow(NotFoundError)
    await commandStore.close()
  })

  it('commitReservation throws NotFoundError when variant is deleted after reservation', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 5)
    const { reservationId } = await inventory.reserveStock(variant.id, 1, null)
    // Delete the product (which deletes the variant) to force the variant-not-found path in commitReservation
    const products = await product.list()
    const p = products.find((pr) => pr.variants.some((v) => v.id === variant.id))!
    await product.delete(p.id)
    await expect(inventory.commitReservation(reservationId, 'test')).rejects.toThrow(NotFoundError)
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

describe('InventoryService: audit notes', () => {
  it('AC-2: under an actor with no opener, adjust, reserve, release and commit each leave one applied entry naming the variant; a release of nothing leaves none', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 10)
    await runAsActor(importer, () => inventory.adjustStock(variant.id, 5, 'manual', 'admin'))
    const first = await runAsActor(importer, () => inventory.reserveStock(variant.id, 2))
    await runAsActor(importer, () => inventory.releaseReservation(first.reservationId, 'cancelled'))
    const second = await runAsActor(importer, () => inventory.reserveStock(variant.id, 3))
    await runAsActor(importer, () =>
      inventory.commitReservation(second.reservationId, 'fulfillment'),
    )
    await runAsActor(importer, () => inventory.releaseReservation('ghost-id', 'abandoned'))
    const subjects = [{ type: 'variant', id: variant.id }]
    expect(await noted(commandStore)).toEqual([
      { actor: importer, command: 'inventory.adjust', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'inventory.reserve', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'inventory.release', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'inventory.reserve', subjects, outcome: 'applied', status: null },
      { actor: importer, command: 'inventory.commit', subjects, outcome: 'applied', status: null },
    ])
    await commandStore.close()
  })

  it('AC-2: an adjustment refused inside its transaction is recorded as inventory.adjust refused, naming the variant', async () => {
    const { commandStore, product, inventory } = await setup()
    const variant = await createTestVariant(product, 5)
    await expect(
      runAsActor(admin, () =>
        auditedCommand(commandStore, undefined, () =>
          inventory.adjustStock(variant.id, -10, 'manual', 'admin'),
        ),
      ),
    ).rejects.toThrow(ValidationError)
    expect(await noted(commandStore)).toEqual([
      {
        actor: admin,
        command: 'inventory.adjust',
        subjects: [{ type: 'variant', id: variant.id }],
        outcome: 'refused',
        status: 400,
      },
    ])
    await commandStore.close()
  })
})

// A restock is stock going from 0 to above 0 on a variant, by an adjustment or by a released reservation. Each step
// runs under a correlation id of its own, and its events are the log rows it appended. No handler is registered here,
// so an event that only a subscriber publishes (outside the stock transaction) never reaches the log.
const RESTOCKED = 'product.restocked.v1'
const CHANGED = 'inventory.changed.v1'

type StockOp =
  | { kind: 'adjust'; delta: number }
  | { kind: 'reserve'; qty: number }
  | { kind: 'release'; pick: number }

const arbStockOp: fc.Arbitrary<StockOp> = fc.oneof(
  fc
    .integer({ min: -3, max: 4 })
    .filter((delta) => delta !== 0)
    .map((delta) => ({ kind: 'adjust' as const, delta })),
  fc.integer({ min: 1, max: 3 }).map((qty) => ({ kind: 'reserve' as const, qty })),
  fc.nat({ max: 5 }).map((pick) => ({ kind: 'release' as const, pick })),
)

interface LoggedStep {
  type: string
  correlationId: string
  payload: Record<string, unknown>
}

async function appendedAfter(
  commandStore: CommandStore,
  repos: Awaited<ReturnType<typeof setup>>['repos'],
  seq: number,
): Promise<LoggedStep[]> {
  const all = await commandStore.read((tx) => repos.eventLog.listAll(tx))
  return all
    .filter((logged) => logged.seq > seq)
    .map((logged) => ({
      type: logged.event.type,
      correlationId: logged.event.correlationId,
      payload: logged.event.payload as Record<string, unknown>,
    }))
}

async function lastSeq(
  commandStore: CommandStore,
  repos: Awaited<ReturnType<typeof setup>>['repos'],
): Promise<number> {
  return commandStore.read((tx) => repos.eventLog.maxSeq(tx))
}

describe('InventoryService: a restock is an event', () => {
  it('AC-1: property: over random adjust, reserve and release sequences, product.restocked.v1 is in the log exactly at each step taking stock from 0 to above 0, equal to that step’s inventory.changed.v1 and under its correlation id; a refused step leaves neither', async () => {
    const seen = { adjustRestocks: 0, releaseRestocks: 0 }
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 3 }),
        fc.array(arbStockOp, { minLength: 1, maxLength: 12 }),
        async (initial, ops) => {
          const { commandStore, product, inventory, repos } = await setup()
          try {
            const variant = await createTestVariant(product, initial)
            const owner = await commandStore.read((tx) => repos.variant.findById(tx, variant.id))
            const productId = owner!.productId
            const held: Array<{ id: string; qty: number }> = []
            let stock = initial

            for (const op of ops) {
              const correlationId = `restock-${randomUUID()}`
              const before = await lastSeq(commandStore, repos)
              // The model: what the step does to the stock, and the error it is refused with.
              let next = stock
              let expectedRefusal: string | null = null
              if (op.kind === 'adjust') {
                if (stock + op.delta < 0) expectedRefusal = 'ValidationError'
                else next = stock + op.delta
              } else if (op.kind === 'reserve') {
                if (op.qty > stock) expectedRefusal = 'AdapterError'
                else next = stock - op.qty
              } else if (held.length > 0) {
                next = stock + held[op.pick % held.length]!.qty
              }
              const refused = expectedRefusal !== null

              let refusal: string | null = null
              let answered: number | null = null
              await runWithCorrelation(correlationId, async () => {
                try {
                  if (op.kind === 'adjust') {
                    answered = (
                      await inventory.adjustStock(variant.id, op.delta, 'manual', 'admin')
                    ).newQty
                  } else if (op.kind === 'reserve') {
                    const { reservationId } = await inventory.reserveStock(variant.id, op.qty)
                    held.push({ id: reservationId, qty: op.qty })
                  } else if (held.length > 0) {
                    const [released] = held.splice(op.pick % held.length, 1)
                    await inventory.releaseReservation(released!.id, 'expired')
                  }
                } catch (err) {
                  refusal =
                    err instanceof ValidationError
                      ? 'ValidationError'
                      : err instanceof AdapterError
                        ? 'AdapterError'
                        : String(err)
                }
              })
              expect([refusal, answered ?? next], JSON.stringify(op)).toEqual([
                expectedRefusal,
                next,
              ])

              const step = await appendedAfter(commandStore, repos, before)
              const changed = step.filter((e) => e.type === CHANGED)
              const restocked = step.filter((e) => e.type === RESTOCKED)
              const isRestock = !refused && stock <= 0 && next > 0
              const label = `${JSON.stringify(op)} from ${stock}`

              expect(
                restocked.map((e) => e.payload),
                label,
              ).toEqual(
                isRestock
                  ? [{ productId, variantId: variant.id, previousQty: stock, newQty: next }]
                  : [],
              )
              // The restock carries exactly what the step's own inventory.changed says, under the step's correlation.
              expect(
                restocked.map((e) => e.payload),
                label,
              ).toEqual(
                changed
                  .filter(
                    (e) => Number(e.payload['previousQty']) <= 0 && Number(e.payload['newQty']) > 0,
                  )
                  .map((e) => ({
                    productId,
                    variantId: e.payload['variantId'],
                    previousQty: e.payload['previousQty'],
                    newQty: e.payload['newQty'],
                  })),
              )
              expect(
                restocked.map((e) => e.correlationId),
                label,
              ).toEqual(restocked.map(() => correlationId))
              // A refused step appends neither event.
              expect(
                refused ? step.filter((e) => e.type === CHANGED || e.type === RESTOCKED) : [],
                label,
              ).toEqual([])
              if (isRestock) seen[op.kind === 'adjust' ? 'adjustRestocks' : 'releaseRestocks'] += 1
              stock = next
            }

            const fresh = await commandStore.read((tx) => repos.variant.findById(tx, variant.id))
            expect(fresh?.stock).toBe(stock)
          } finally {
            await commandStore.close()
          }
        },
      ),
      {
        numRuns: 40,
        // A restock by adjustment and one by a released reservation lead the generated runs.
        examples: [
          [0, [{ kind: 'adjust', delta: 2 }]],
          [
            1,
            [
              { kind: 'reserve', qty: 1 },
              { kind: 'release', pick: 0 },
            ],
          ],
          [
            0,
            [
              { kind: 'adjust', delta: -1 },
              { kind: 'reserve', qty: 1 },
            ],
          ],
        ],
      },
    )
    expect(Math.min(seen.adjustRestocks, seen.releaseRestocks)).toBeGreaterThan(0)
  }, 120_000)
})
