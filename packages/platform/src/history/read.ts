import type { AsOfRead, HistoryEntry, HistoryKind, HistoryPage } from '@nymbalhq/types'
import type { ReadTx } from '../db/command-store.js'
import type { AuditEntryRepository } from '../repositories/audit-entry.js'
import type { EventLogRepository, LoggedEvent } from '../repositories/event-log.js'
import { diffViews } from './diff.js'
import { isBaseEvent, isDeleted, startFold, type Folded, type HistoryView } from './fold.js'
import type { EventSubject } from './subject.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** Rows a subject's log is read in per query. */
const READ_PAGE = 1_000

export type AsOfOutcome =
  | { kind: 'record'; read: AsOfRead<HistoryView> }
  | { kind: 'before_start'; historyStartsAt: string | null }
  | { kind: 'deleted'; deletedAt: string }
  | { kind: 'not_found' }

export interface HistoryReaderDeps {
  eventLog: EventLogRepository
  auditEntries: AuditEntryRepository
  retentionDays: number
}

/** A record of `kind` by its id, and whether its row is live: with neither a row nor an event it is not found. */
export interface HistorySubject {
  kind: HistoryKind
  id: string
  live: boolean
}

export interface HistoryReader {
  /** The record as the log folds it at `at`: every event of it from its history's start appended at or before `at`. */
  asOf(subject: HistorySubject, at: Date): Promise<AsOfOutcome>
  /** One page of the record's history, newest first, entries before `beforeSeq`; null when it is not found. */
  list(
    subject: HistorySubject,
    page: { beforeSeq?: number; limit: number },
  ): Promise<HistoryPage | null>
}

export function createHistoryReader(deps: HistoryReaderDeps): HistoryReader {
  const { eventLog, auditEntries, retentionDays } = deps
  const { store } = eventLog

  async function readAll(tx: ReadTx, subjects: EventSubject[]): Promise<LoggedEvent[]> {
    const rows: LoggedEvent[] = []
    for (;;) {
      const last = rows[rows.length - 1]
      const page = await eventLog.listBySubjects(tx, subjects, {
        limit: READ_PAGE,
        ...(last !== undefined && { afterSeq: last.seq }),
      })
      rows.push(...page)
      if (page.length < READ_PAGE) return rows
    }
  }

  /** The subject's rows by seq; a product's include those of every variant its snapshots name. */
  async function rowsOf(tx: ReadTx, kind: HistoryKind, id: string): Promise<LoggedEvent[]> {
    const own = await readAll(tx, [{ type: kind, id }])
    if (kind !== 'product') return own
    const variantIds = new Set<string>()
    for (const row of own) {
      if (!isBaseEvent('product', row)) continue
      const product = (row.event.payload as { product: { variants?: Array<{ id?: unknown }> } })
        .product
      for (const variant of product.variants ?? []) {
        if (typeof variant.id === 'string') variantIds.add(variant.id)
      }
    }
    if (variantIds.size === 0) return own
    return readAll(tx, [
      { type: 'product', id },
      ...[...variantIds].map((variantId) => ({ type: 'variant', id: variantId })),
    ])
  }

  /** The index of the earliest base event at or after the retention horizon, or -1: the log never guesses past it. */
  function startOf(kind: HistoryKind, rows: LoggedEvent[]): number {
    const horizon = Date.now() - retentionDays * DAY_MS
    return rows.findIndex((row) => isBaseEvent(kind, row) && row.createdAt.getTime() >= horizon)
  }

  async function actorsOf(tx: ReadTx, entries: HistoryEntry[]): Promise<void> {
    const byCorrelation = new Map<string, Pick<HistoryEntry, 'actor' | 'command'>>()
    for (const correlation of new Set(entries.map((e) => e.correlationId))) {
      const [applied] = await auditEntries.list(tx, {
        correlation,
        outcome: 'applied',
        order: 'asc',
        limit: 1,
      })
      byCorrelation.set(
        correlation,
        applied === undefined
          ? { actor: null, command: null }
          : { actor: applied.actor, command: applied.command },
      )
    }
    for (const entry of entries) Object.assign(entry, byCorrelation.get(entry.correlationId))
  }

  return {
    asOf(subject, at) {
      return store.read(async (tx) => {
        const rows = await rowsOf(tx, subject.kind, subject.id)
        if (rows.length === 0 && !subject.live) return { kind: 'not_found' }
        const start = startOf(subject.kind, rows)
        if (start < 0) return { kind: 'before_start', historyStartsAt: null }
        const startsAt = rows[start]!.createdAt
        if (at.getTime() < startsAt.getTime()) {
          return { kind: 'before_start', historyStartsAt: startsAt.toISOString() }
        }
        const fold = startFold(subject.kind)
        let view: Folded = null
        for (const row of rows.slice(start)) {
          if (row.createdAt.getTime() <= at.getTime()) view = fold.apply(row)
        }
        if (isDeleted(view)) return { kind: 'deleted', deletedAt: view.deletedAt }
        return {
          kind: 'record',
          read: { asOf: at.toISOString(), historyStartsAt: startsAt.toISOString(), record: view! },
        }
      })
    },

    list(subject, page) {
      return store.read(async (tx) => {
        const rows = await rowsOf(tx, subject.kind, subject.id)
        if (rows.length === 0 && !subject.live) return null
        const start = startOf(subject.kind, rows)
        if (start < 0)
          return { historyStartsAt: null, retentionDays, entries: [], nextCursor: null }
        const entries: HistoryEntry[] = []
        const fold = startFold(subject.kind)
        let view: Folded = null
        for (const [i, row] of rows.slice(start).entries()) {
          const before = view
          view = fold.apply(row)
          const changes = diffViews(before, view)
          if (i > 0 && changes.length === 0) continue
          entries.push({
            seq: row.seq,
            at: row.createdAt.toISOString(),
            type: row.event.type,
            correlationId: row.event.correlationId,
            actor: null,
            command: null,
            base: i === 0,
            changes,
          })
        }
        const newest = entries
          .reverse()
          .filter((e) => page.beforeSeq === undefined || e.seq < page.beforeSeq)
        const shown = newest.slice(0, page.limit)
        await actorsOf(tx, shown)
        const last = shown[shown.length - 1]
        return {
          historyStartsAt: rows[start]!.createdAt.toISOString(),
          retentionDays,
          entries: shown,
          nextCursor: newest.length > shown.length && last !== undefined ? String(last.seq) : null,
        }
      })
    },
  }
}
