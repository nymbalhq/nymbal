import type { AdminSession, Answer } from './audit-http.js'
import type { RawReader } from './raw.js'

// Support for the admin history tests: the as-of views as Decision 3 publishes them, computed here from the
// live admin reads so a test holds its own oracle beside the kernel's `to<Kind>AsOf`; the `?at=` and `…/history`
// routes of Decision 5; and the clock steps AC-1 takes between commands. Nothing here knows how the fold, the subject
// columns or the routes are implemented.

export type HistoryKind = 'order' | 'product' | 'customer'

type Json = Record<string, unknown>

function without(record: Json, keys: readonly string[]): Json {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)))
}

/** Decision 3: the admin order read without the fields no event carries. */
export const ORDER_OMITTED = [
  'notes',
  'metadata',
  'updatedAt',
  'capturedAt',
  'captureMethod',
  'history',
] as const
export const ORDER_PAYMENT_OMITTED = ['refunds', 'refundableMinor'] as const
/** Decision 2: CustomerSnapshot's keys, and so CustomerAsOf's. */
export const CUSTOMER_SNAPSHOT_KEYS = [
  'id',
  'email',
  'firstName',
  'lastName',
  'phone',
  'addresses',
  'createdAt',
] as const

/** `GET /api/admin/orders/:orderNumber`'s data as OrderAsOf. */
export function orderView(read: Json): Json {
  const payment = read['payment'] as Json
  return { ...without(read, ORDER_OMITTED), payment: without(payment, ORDER_PAYMENT_OMITTED) }
}

/** A ProductSnapshot (as JSON) as ProductAsOf: without `variants[].updatedAt`, and `categoryIds` a sorted set. */
export function productView(snapshot: Json): Json {
  const variants = snapshot['variants'] as Json[]
  return {
    ...snapshot,
    variants: variants.map((v) => without(v, ['updatedAt'])),
    categoryIds: [...(snapshot['categoryIds'] as string[])].sort(),
  }
}

/** `GET /api/admin/customers/:id`'s data as CustomerAsOf. */
export function customerView(read: Json): Json {
  const customer = read['customer'] as Json
  return Object.fromEntries(CUSTOMER_SNAPSHOT_KEYS.map((key) => [key, customer[key]]))
}

const COLLECTION: Record<HistoryKind, string> = {
  order: 'orders',
  product: 'products',
  customer: 'customers',
}

/** The admin detail read's path: an order by its number, a product or a customer by id. */
export function detailPath(kind: HistoryKind, key: string): string {
  return `/api/admin/${COLLECTION[kind]}/${encodeURIComponent(key)}`
}

export interface AsOfBody {
  asOf: string
  historyStartsAt: string | null
  record: Json
}

/** `GET <detail>?at=<at>` as the admin. */
export function readAsOf(
  admin: AdminSession,
  kind: HistoryKind,
  key: string,
  at: string,
): Promise<Answer<AsOfBody>> {
  return admin.send<AsOfBody>('GET', `${detailPath(kind, key)}?at=${encodeURIComponent(at)}`)
}

export interface HistoryEntry {
  seq: number
  at: string
  type: string
  correlationId: string
  actor: { kind: string; id: string } | null
  command: string | null
  base: boolean
  changes: Array<{ path: string; from: unknown; to: unknown }>
}

export interface HistoryPage {
  historyStartsAt: string | null
  retentionDays: number
  entries: HistoryEntry[]
  nextCursor: string | null
}

export function historyPath(kind: HistoryKind, id: string): string {
  return `/api/admin/${COLLECTION[kind]}/${encodeURIComponent(id)}/history`
}

/** One page of `GET …/:id/history`. */
export function readHistory(
  admin: AdminSession,
  kind: HistoryKind,
  id: string,
  query: { cursor?: string; limit?: number } = {},
): Promise<Answer<HistoryPage>> {
  const params = new URLSearchParams()
  if (query.cursor !== undefined) params.set('cursor', query.cursor)
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  const qs = params.toString()
  return admin.send<HistoryPage>('GET', `${historyPath(kind, id)}${qs === '' ? '' : `?${qs}`}`)
}

/** The data of a 200, or a thrown error naming what came back instead. */
export function dataOf<T>(answer: Answer<T>, what: string): T {
  if (answer.status !== 200 || answer.body.data === undefined) {
    throw new Error(`${what}: ${answer.status} ${JSON.stringify(answer.body)}`)
  }
  return answer.body.data
}

/** Resolves once the clock reads a later millisecond than `ms`. Waits on the clock itself, never a fixed time. */
export async function pastMillisecond(ms: number): Promise<void> {
  while (Date.now() <= ms) await new Promise((resolve) => setImmediate(resolve))
}

/**
 * The instant AC-1 records after a command: a millisecond later than everything the command and its read did, and
 * the next command starts a millisecond after it, so `created_at ≤ t` holds for exactly the events before `t`.
 */
export async function instantAfter(): Promise<string> {
  await pastMillisecond(Date.now())
  const t = Date.now()
  await pastMillisecond(t)
  return new Date(t).toISOString()
}

/** Resolves once no event in the log is waiting for delivery (the retention sweep deletes only delivered ones). */
export async function untilDelivered(raw: RawReader, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const waiting = await raw.count('events', 'delivered_at IS NULL AND dead_at IS NULL')
    if (waiting === 0) return
    if (Date.now() > deadline) throw new Error(`${waiting} event(s) still undelivered`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** `JSON.parse(JSON.stringify(x))`: a service's answer as the HTTP route serialises it. */
export function asJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/** The `error.context` of a refusal (`fail(code, message, status, context)`), or `{}` when it has none. */
export function contextOf(answer: Answer<unknown>): Record<string, unknown> {
  const error = answer.body.error as { context?: Record<string, unknown> } | undefined
  return error?.context ?? {}
}
