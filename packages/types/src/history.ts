import type { AuditActor } from './audit.js'

/** The records whose history the admin reads from the event log. */
export type HistoryKind = 'order' | 'product' | 'customer'

/** One field an event changed: `path` is a dot path into the view, array items with an `id` keyed by it. */
export interface HistoryChange {
  path: string
  from: unknown
  to: unknown
}

/** One event that changed a record's view, or the base event the view starts from (`base`, no changes). */
export interface HistoryEntry {
  seq: number
  at: string
  type: string
  correlationId: string
  /** From the `applied` audit entry of the event's correlation id; null when there is none. */
  actor: AuditActor | null
  command: string | null
  base: boolean
  changes: HistoryChange[]
}

/** A page of `GET /api/admin/{orders,products,customers}/:id/history`, newest first. */
export interface HistoryPage {
  /** The earliest base event the log still holds; null when the record predates the log's window. */
  historyStartsAt: string | null
  retentionDays: number
  entries: HistoryEntry[]
  nextCursor: string | null
}

/** `GET <admin detail>?at=<t>`: the record as the log folds it at `asOf`. */
export interface AsOfRead<T = Record<string, unknown>> {
  asOf: string
  historyStartsAt: string
  record: T
}
