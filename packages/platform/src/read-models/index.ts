import { errorText, type DocumentStoreAdapter, type SearchDocument } from '@nymbalhq/types'
import { rawClients } from '../db/command-store.js'
import { nativeIndexDocuments } from '../adapters/search/native-adapter.js'
import type { KeysetPage } from '../repositories/index.js'
import { KEY_OF } from './builders.js'
import { catalogue } from './catalogue.js'
import { customers } from './customers.js'
import {
  SEARCH_INDEX,
  searchOf,
  type ReadModel,
  type ReadModelName,
  type RebuildContext,
  type RebuildDeps,
} from './model.js'
import { orders } from './orders.js'
import { recentlyViewed } from './recently-viewed.js'
import { search } from './search.js'

export {
  SEARCH_INDEX,
  type ReadModel,
  type ReadModelName,
  type RebuildContext,
  type RebuildDeps,
} from './model.js'

/** Every derived read model, in the order a rebuild of all of them runs. */
export const READ_MODELS: readonly ReadModel[] = [
  catalogue,
  orders,
  customers,
  search,
  recentlyViewed,
]

export const READ_MODEL_NAMES: readonly ReadModelName[] = READ_MODELS.map((m) => m.name)

/**
 * How long before the rebuild started a delivery may be stamped and still be caught up. The relay stamps
 * `delivered_at` on its own host's clock, which can run behind this process's; re-applying an event costs little,
 * skipping one loses a write.
 */
export const CATCH_UP_MARGIN_MS = 10 * 60_000

const DEFAULT_PAGE_SIZE = 200
const CATCH_UP_PAGE = 500
const SCAN_PAGE = 500

export interface CatchUpFailure {
  seq: number
  eventId: string
  type: string
  handler: string
  error: string
}

export interface RebuildReportEntry {
  model: ReadModelName
  /** Each collection swapped in and the documents it was given (the search model's is `index`). */
  collections: Array<{ name: string; documents: number }>
  /** Logged events re-applied after the swap. */
  caughtUpEvents: number
  /** Catch-up events a handler failed on: the model is swapped all the same. */
  failures: CatchUpFailure[]
  ms: number
  /** Set when the search adapter has no `replaceAll`: it was given every document, and kept any others it held. */
  note?: string
}

export type RebuildReport = RebuildReportEntry[]

/** A rebuilder failed: nothing was swapped, so every read model keeps its old contents. */
export class RebuildError extends Error {
  readonly model: ReadModelName

  constructor(model: ReadModelName, cause: unknown) {
    super(
      `the ${model} read model was not rebuilt (its old contents are kept): ${errorText(cause)}`,
      {
        cause,
      },
    )
    this.name = 'RebuildError'
    this.model = model
  }
}

function modelsOf(names: readonly string[]): ReadModel[] {
  return names.map((name) => {
    const model = READ_MODELS.find((m) => m.name === name)
    if (model === undefined) {
      throw new Error(`unknown read model "${name}": one of ${READ_MODEL_NAMES.join(', ')}, or all`)
    }
    return model
  })
}

/** The context a model rebuilds with, and the highest seq it read from the log (undefined when it reads no log). */
function contextFor(
  model: ReadModel,
  deps: RebuildDeps,
): { ctx: RebuildContext; logReadThrough: () => number | undefined } {
  const limit = deps.pageSize ?? DEFAULT_PAGE_SIZE
  let page = 0
  let logReadThrough: number | undefined
  const ctx: RebuildContext = {
    deps,
    async *pages(table, read) {
      let after: string | undefined
      for (;;) {
        await deps.onPage?.({ model: model.name, table, page })
        page += 1
        const keyset: KeysetPage = after === undefined ? { limit } : { after, limit }
        const rows = await deps.store.read((tx) => read(tx, keyset))
        if (rows.length > 0) yield rows
        if (rows.length < limit) return
        after = rows[rows.length - 1]!.id
      }
    },
    async *events(types) {
      let after = 0
      logReadThrough ??= 0
      for (;;) {
        await deps.onPage?.({ model: model.name, table: 'events', page })
        page += 1
        const rows = await deps.store.read((tx) =>
          deps.repos.eventLog.listAfter(tx, after, { types: [...types], limit }),
        )
        if (rows.length > 0) {
          after = rows[rows.length - 1]!.seq
          logReadThrough = Math.max(logReadThrough, after)
          const live = rows.filter((r) => r.deadAt === null)
          if (live.length > 0) yield live
        }
        if (rows.length < limit) return
      }
    },
  }
  return { ctx, logReadThrough: () => logReadThrough }
}

interface Collected {
  model: ReadModel
  /** When its first page was read: catch-up starts from here, less the margin. */
  startedAt: number
  /** The new contents, by collection (`SEARCH_INDEX` for search), then by key. */
  writes: Map<string, Map<string, unknown>>
  /** For a model rebuilt from the log, the last seq it read: its catch-up starts above it. */
  logReadThrough: number | undefined
}

/** Reads every document of `model` into memory, so a rebuilder that fails part-way leaves nothing half-swapped. */
async function collect(model: ReadModel, deps: RebuildDeps): Promise<Collected> {
  const startedAt = Date.now()
  const owned = model.target === 'search' ? [SEARCH_INDEX] : model.collections
  const writes = new Map(owned.map((c) => [c, new Map<string, unknown>()]))
  const { ctx, logReadThrough } = contextFor(model, deps)
  try {
    for await (const w of model.rebuild(ctx)) {
      const into = writes.get(w.collection)
      if (into === undefined) throw new Error(`it wrote to ${w.collection}, which it does not own`)
      into.set(w.key, w.doc)
    }
  } catch (error) {
    throw new RebuildError(model.name, error)
  }
  return { model, startedAt, writes, logReadThrough: logReadThrough() }
}

async function* entries<T>(docs: Map<string, T>): AsyncGenerator<[string, T]> {
  yield* docs
}

/** Swaps the collected contents in; returns the note a search adapter without `replaceAll` earns. */
async function swap({ model, writes }: Collected, deps: RebuildDeps): Promise<string | undefined> {
  if (model.target === 'documents') {
    for (const collection of model.collections) {
      await deps.documentStore.replaceCollection(collection, entries(writes.get(collection)!))
    }
    return undefined
  }
  const search = searchOf(deps)
  const docs = [...writes.get(SEARCH_INDEX)!.values()] as SearchDocument[]
  if (search.replaceAll !== undefined) {
    await search.replaceAll(docs)
    return undefined
  }
  await search.index(docs)
  return `${search.providerName} has no replaceAll: every document was indexed, removals not guaranteed`
}

/**
 * Re-applies, in seq order, every logged event that is not dead and was delivered at or after `since` or not yet, to
 * the model's handlers, called directly so a failure is collected instead of logged by the bus. The handlers write
 * the state they read at handle time, so an event applied twice changes nothing.
 */
async function catchUp(
  model: ReadModel,
  since: Date,
  deps: RebuildDeps,
  afterSeq = 0,
): Promise<{ applied: number; failures: CatchUpFailure[] }> {
  const handlers = model.handlers(deps)
  const failures: CatchUpFailure[] = []
  let applied = 0
  for (;;) {
    const page = await deps.store.read((tx) =>
      deps.repos.eventLog.listForCatchUp(tx, since, { afterSeq, limit: CATCH_UP_PAGE }),
    )
    for (const { seq, event } of page) {
      afterSeq = seq
      const matching = handlers.filter((h) => h.types.includes(event.type))
      if (matching.length === 0) continue
      applied += 1
      for (const h of matching) {
        try {
          await h.handle(event)
        } catch (error) {
          failures.push({
            seq,
            eventId: event.id,
            type: event.type,
            handler: h.name,
            error: errorText(error),
          })
        }
      }
    }
    if (page.length < CATCH_UP_PAGE) return { applied, failures }
  }
}

/**
 * Rebuilds `names` from the command store's tables: every model is read first, then each is swapped in (atomically
 * per collection) and caught up with the events delivered since its read began. A rebuilder that throws rejects with
 * a `RebuildError` before anything is swapped. Catch-up failures are in the report.
 */
export async function rebuild(
  names: readonly ReadModelName[],
  deps: RebuildDeps,
): Promise<RebuildReport> {
  const collected: Collected[] = []
  for (const model of modelsOf(names)) collected.push(await collect(model, deps))
  const report: RebuildReport = []
  for (const c of collected) {
    const note = await swap(c, deps)
    const { applied, failures } = await catchUp(
      c.model,
      new Date(c.startedAt - CATCH_UP_MARGIN_MS),
      deps,
      c.logReadThrough,
    )
    const entry: RebuildReportEntry = {
      model: c.model.name,
      collections: [...c.writes].map(([name, docs]) => ({ name, documents: docs.size })),
      caughtUpEvents: applied,
      failures,
      ms: Date.now() - c.startedAt,
      ...(note !== undefined && { note }),
    }
    report.push(entry)
    const log =
      failures.length > 0 ? deps.logger.warn.bind(deps.logger) : deps.logger.debug.bind(deps.logger)
    log(
      { model: entry.model, collections: entry.collections, caughtUpEvents: applied, failures },
      `read model ${entry.model} rebuilt`,
    )
  }
  return report
}

export interface CollectionDiff {
  name: string
  added: number
  changed: number
  removed: number
}

export interface ReadModelDiff {
  model: ReadModelName
  collections: CollectionDiff[]
  /** Why the model was not compared, when it was not. */
  skipped?: string
}

/** JSON with sorted keys: two documents equal when they would be stored alike, whatever their key order. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      )
    }
    return v
  }
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value ?? null))))
}

/**
 * The live collection, by the key its builder files each document under: read by full scans only, which leave a
 * store's internal order alone (a Redis point read can advance a hash's rehash and reorder it).
 */
async function liveOf(
  store: DocumentStoreAdapter,
  collection: string,
): Promise<Map<string, unknown>> {
  const keyOf = KEY_OF[collection]!
  const live = new Map<string, unknown>()
  let cursor: string | undefined
  for (;;) {
    const page = await store.query(collection, {
      partitionKey: { field: 'id', value: '*' },
      limit: SCAN_PAGE,
      ...(cursor !== undefined && { cursor }),
    })
    for (const doc of page.items) live.set(keyOf(doc), doc)
    if (page.nextCursor === null) return live
    cursor = page.nextCursor
  }
}

function compare(
  name: string,
  next: Map<string, unknown>,
  live: Map<string, unknown>,
): CollectionDiff {
  let added = 0
  let changed = 0
  for (const [key, doc] of next) {
    if (!live.has(key)) added += 1
    else if (canonical(live.get(key)) !== canonical(doc)) changed += 1
  }
  return { name, added, changed, removed: live.size - (next.size - added) }
}

/** Rebuilds `name` into memory and counts, per collection, what differs from the live read model; writes nothing. */
export async function diffReadModel(
  name: ReadModelName,
  deps: RebuildDeps,
): Promise<ReadModelDiff> {
  const [model] = modelsOf([name])
  const { writes } = await collect(model!, deps)
  if (model!.target === 'search') {
    const { providerName } = searchOf(deps)
    if (providerName !== 'native') {
      return {
        model: name,
        collections: [],
        skipped: `the ${providerName} search adapter cannot list its documents, so it is not compared`,
      }
    }
    const held = await nativeIndexDocuments(rawClients(deps.store))
    const live = new Map<string, unknown>(held.map((d) => [d.id, d]))
    return {
      model: name,
      collections: [compare(SEARCH_INDEX, writes.get(SEARCH_INDEX)!, live)],
    }
  }
  const collections: CollectionDiff[] = []
  for (const collection of model!.collections) {
    const live = await liveOf(deps.documentStore, collection)
    collections.push(compare(collection, writes.get(collection)!, live))
  }
  return { model: name, collections }
}
