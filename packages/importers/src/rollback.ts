import { NotFoundError } from '@nymbalhq/types'
import type { RemovalOutcome, Repositories, ServiceRegistry } from '@nymbalhq/platform'
import { appendRemoval, compactState, deleteState, loadState, saveState } from './state.js'
import type {
  ImportEntity,
  ImportState,
  ProgressCallback,
  RollbackPlan,
  RollbackReport,
} from './types.js'

export type RollbackRefusal = 'no-state' | 'live-store' | 'not-confirmed'

/** A rollback that removed nothing: there is no import to take out, the store has moved on, or no one agreed to it. */
export class RollbackRefusedError extends Error {
  readonly reason: RollbackRefusal
  /** For `live-store`: the store's own orders (or imported orders it has acted on) and reviews since the import. */
  readonly orders?: number
  readonly reviews?: number

  constructor(
    reason: RollbackRefusal,
    message: string,
    activity?: { orders: number; reviews: number },
  ) {
    super(`Rollback refused (${reason}): ${message}`)
    this.name = 'RollbackRefusedError'
    this.reason = reason
    if (activity !== undefined) {
      this.orders = activity.orders
      this.reviews = activity.reviews
    }
  }
}

export interface RollbackOptions {
  statePath: string
  /** Asked once the rollback is allowed and before anything is removed; without it the rollback goes ahead. */
  confirm?: (plan: RollbackPlan) => Promise<boolean>
}

export interface RollbackDeps {
  services: ServiceRegistry
  repos: Repositories
  onProgress?: ProgressCallback
}

/** Dependents before what they depend on; categories newest first, so a child goes before its parent. */
const ORDER: readonly ImportEntity[] = ['reviews', 'orders', 'customers', 'products', 'categories']

const MAP_OF = {
  categories: 'wcToNymbalCategory',
  products: 'wcToNymbalProduct',
  customers: 'wcToNymbalCustomer',
  orders: 'wcToNymbalOrder',
  reviews: 'wcToNymbalReview',
} as const satisfies Record<ImportEntity, keyof ImportState>

const zero = (): Record<ImportEntity, number> => ({
  categories: 0,
  products: 0,
  customers: 0,
  orders: 0,
  reviews: 0,
})

async function planRollback(state: ImportState, repos: Repositories): Promise<RollbackPlan> {
  const remove = zero()
  for (const e of ORDER) remove[e] = state.importedIds[e].length
  const productIds = state.importedIds.products
  const mediaUrls = await repos.product.store.read(async (tx) => {
    let n = 0
    for (const id of productIds) n += (await repos.product.findById(tx, id))?.media.length ?? 0
    return n
  })
  const created = new Set(state.importedIds.customers)
  const linked = new Set(Object.values(state.wcToNymbalCustomer).filter((id) => !created.has(id)))
  return { remove, mediaUrls, linkedCustomersKept: linked.size }
}

/** A delete that throws for a record already gone resolves `absent` instead. */
async function removal(remove: () => Promise<void>): Promise<RemovalOutcome> {
  try {
    await remove()
    return 'removed'
  } catch (err) {
    if (err instanceof NotFoundError) return 'absent'
    throw err
  }
}

/**
 * Removes every record the imports in this project created, and nothing else, then the state file and its journal.
 * Each removal is journaled as it commits, so a rollback stopped part way resumes where it stopped.
 */
export async function rollbackImport(
  opts: RollbackOptions,
  deps: RollbackDeps,
): Promise<RollbackReport> {
  const startMs = Date.now()
  const { services, repos } = deps
  const emit = deps.onProgress ?? (() => undefined)

  const state = await loadState(opts.statePath)
  if (state === null) {
    throw new RollbackRefusedError('no-state', `there is no import state at ${opts.statePath}`)
  }
  const plan = await planRollback(state, repos)

  const refuseLiveStore = async (): Promise<void> => {
    const activity = await services.importRemoval.activitySince(state.rollbackSince, {
      orders: state.importedIds.orders,
      reviews: state.importedIds.reviews,
    })
    if (activity.orders > 0 || activity.reviews > 0) {
      throw new RollbackRefusedError(
        'live-store',
        `since the import began on ${state.rollbackSince} the store has ${activity.orders} order(s) and ` +
          `${activity.reviews} review(s) of its own, so the import can no longer be separated from it`,
        activity,
      )
    }
  }
  await refuseLiveStore()
  if (opts.confirm !== undefined) {
    if (!(await opts.confirm(plan))) {
      throw new RollbackRefusedError('not-confirmed', 'nothing was removed')
    }
    // The store stays live while the prompt waits: an order placed meanwhile would be orphaned by the removal.
    await refuseLiveStore()
  }

  await compactState(opts.statePath, state)
  const remove: Record<ImportEntity, (id: string) => Promise<RemovalOutcome>> = {
    reviews: (id) => services.importRemoval.removeReview(id),
    orders: (id) => services.importRemoval.removeOrder(id),
    customers: (id) => services.importRemoval.removeCustomer(id),
    products: (id) => removal(() => services.product.delete(id)),
    categories: (id) => removal(() => services.category.delete(id)),
  }
  const removed = zero()
  const absent = zero()
  for (const entity of ORDER) {
    const ids = [...state.importedIds[entity]]
    if (entity === 'categories') ids.reverse()
    emit({ kind: 'phase', phase: `rollback ${entity}` })
    for (const [i, id] of ids.entries()) {
      const outcome = await remove[entity](id)
      if (outcome === 'removed') removed[entity] += 1
      else absent[entity] += 1
      await appendRemoval(opts.statePath, entity, id)
      emit({ kind: 'progress', entity, done: i + 1, total: ids.length })
    }
    const gone = new Set(ids)
    state.importedIds[entity] = []
    const map = state[MAP_OF[entity]]
    for (const [wcId, id] of Object.entries(map)) if (gone.has(id)) delete map[wcId]
    await saveState(opts.statePath, state)
  }
  await deleteState(opts.statePath)

  return { ...plan, removed, absent, durationMs: Date.now() - startMs }
}
