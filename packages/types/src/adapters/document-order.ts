import { ValidationError } from '../errors.js'
import type { QueryParams, QueryResult } from './document-store.js'

// The one order and filter every document store is held to: the in-memory store runs it, and stores that cannot
// order or filter the same way on their server fetch candidates and run it in the process.

const collator = new Intl.Collator(undefined, { sensitivity: 'base' })

/** Number, then string, then any other type, then null and missing: so values of different types never tie. */
function rankOf(value: unknown): number {
  if (typeof value === 'number') return 0
  if (typeof value === 'string') return 1
  if (value === null || value === undefined) return 3
  return 2
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0
}

function compareOther(a: unknown, b: unknown): number {
  const ta = typeof a
  const tb = typeof b
  if (ta !== tb) return ta < tb ? -1 : 1
  if (ta === 'boolean') return Number(a) - Number(b)
  const ja = JSON.stringify(a) ?? ''
  const jb = JSON.stringify(b) ?? ''
  return ja < jb ? -1 : ja > jb ? 1 : 0
}

/**
 * A total order over document values: numbers numerically, strings by `Intl.Collator` at base sensitivity (case and
 * accents tie), other types after strings, and null or missing last. Values of different types rank by type first.
 */
export function compareDocumentValues(a: unknown, b: unknown): number {
  const ra = rankOf(a)
  const rb = rankOf(b)
  if (ra !== rb) return ra - rb
  switch (ra) {
    case 0:
      return sign((a as number) - (b as number))
    case 1:
      return sign(collator.compare(a as string, b as string))
    case 2:
      return sign(compareOther(a, b))
    default:
      return 0
  }
}

export type SortKeyCondition = Pick<NonNullable<QueryParams['sortKey']>, 'operator' | 'value'>

/** `eq` is `===`; `gt`, `lt` and `between` (inclusive, `[low, high]`) are `compareDocumentValues`. */
export function matchesSortKey(value: unknown, condition: SortKeyCondition): boolean {
  const target = condition.value
  switch (condition.operator) {
    case 'eq':
      return value === target
    case 'gt':
      return compareDocumentValues(value, target) > 0
    case 'lt':
      return compareDocumentValues(value, target) < 0
    case 'between': {
      if (!Array.isArray(target) || target.length !== 2) return false
      const [low, high] = target as [unknown, unknown]
      return compareDocumentValues(value, low) >= 0 && compareDocumentValues(value, high) <= 0
    }
    default:
      return false
  }
}

/** The value at a dotted path (`priceRange.minMinor`); missing anywhere along it is `undefined`. */
export function documentValueAt(doc: unknown, path: string): unknown {
  let value: unknown = doc
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

export const DEFAULT_QUERY_LIMIT = 50

interface Order {
  /** The field ordered by, or null for the document key alone. */
  field: string | null
  direction: 'asc' | 'desc'
}

interface Position {
  key: string
  value: unknown
}

function orderOf(params: QueryParams): Order {
  if (params.orderBy !== undefined) {
    return { field: params.orderBy.field, direction: params.orderBy.direction }
  }
  const direction = (params.ascending ?? true) ? 'asc' : 'desc'
  return { field: params.sortKey?.field ?? null, direction }
}

const isNullish = (value: unknown): boolean => value === null || value === undefined

/** Nulls and missing values last in either direction; ties by key ascending, so no two documents tie. */
function comparePositions(a: Position, b: Position, order: Order): number {
  if (order.field !== null) {
    const an = isNullish(a.value)
    const bn = isNullish(b.value)
    if (an !== bn) return an ? 1 : -1
    let c = an ? 0 : compareDocumentValues(a.value, b.value)
    if (order.direction === 'desc') c = -c
    if (c !== 0) return c
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  }
  const c = a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  return order.direction === 'desc' ? -c : c
}

/** What a cursor is bound to: the order and the partition, so a cursor reused under another is refused. */
function cursorScope(order: Order, params: QueryParams): string {
  return JSON.stringify([order.field, order.direction, params.partitionKey])
}

function decodeCursor(cursor: string, scope: string): Position {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  } catch {
    decoded = null
  }
  const c = decoded as { o?: unknown; k?: unknown; v?: unknown } | null
  if (c === null || typeof c !== 'object' || typeof c.o !== 'string' || typeof c.k !== 'string') {
    throw new ValidationError('The cursor is not valid', { context: { cursor } })
  }
  if (c.o !== scope) {
    throw new ValidationError('The cursor was issued under another order', { context: { cursor } })
  }
  return { key: c.k, value: c.v ?? null }
}

/**
 * One page of `params` over the documents of a collection: filter by partition (`'*'` for all) and sort key, order,
 * then seek past the cursor by value, so a document deleted between pages neither restarts nor repeats the walk.
 */
export function queryDocuments<T>(
  documents: Iterable<readonly [string, unknown]>,
  params: QueryParams,
): QueryResult<T> {
  const limit = params.limit ?? DEFAULT_QUERY_LIMIT
  const order = orderOf(params)
  const scope = cursorScope(order, params)
  const after = params.cursor ? decodeCursor(params.cursor, scope) : null
  const { partitionKey, sortKey } = params

  const matches: Array<{ position: Position; doc: unknown }> = []
  for (const [key, doc] of documents) {
    const record = (doc ?? {}) as Record<string, unknown>
    if (partitionKey.value !== '*' && record[partitionKey.field] !== partitionKey.value) continue
    if (sortKey !== undefined && !matchesSortKey(record[sortKey.field], sortKey)) continue
    const value = order.field === null ? null : (documentValueAt(record, order.field) ?? null)
    const position = { key, value }
    if (after !== null && comparePositions(position, after, order) <= 0) continue
    matches.push({ position, doc })
  }
  matches.sort((a, b) => comparePositions(a.position, b.position, order))

  const page = matches.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor =
    matches.length > limit && last !== undefined
      ? Buffer.from(
          JSON.stringify({ o: scope, k: last.position.key, v: last.position.value }),
          'utf8',
        ).toString('base64url')
      : null
  return { items: page.map((m) => m.doc as T), nextCursor }
}
