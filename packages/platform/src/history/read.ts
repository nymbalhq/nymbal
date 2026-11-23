import type { AsOfRead, HistoryEntry, HistoryKind, HistoryPage } from '@nymbalhq/types'
import type { ReadTx } from '../db/command-store.js'
import type { AuditEntryRepository } from '../repositories/audit-entry.js'
import type { EventLogRepository, SubjectEvent } from '../repositories/event-log.js'
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

  async function readAll(tx: ReadTx, subjects: EventSubject[]): Promise<SubjectEvent[]> {
    const rows: SubjectEvent[] = []
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
  async function rowsOf(tx: ReadTx, kind: HistoryKind, id: string): Promise<SubjectEvent[]> {
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
  function startOf(kind: HistoryKind, rows: SubjectEvent[]): number {
    const horizon = Date.now() - retentionDays * DAY_MS
    return rows.findIndex((row) => isBaseEvent(kind, row) && row.createdAt.getTime() >= horizon)
  }

  /**
   * Each entry's actor and command: those of the `applied` entry its event's command id names, else (an event appended
   * outside a command, or before the log kept the id) of the earliest `applied` entry of its correlation.
   */
  async function actorsOf(
    tx: ReadTx,
    entries: HistoryEntry[],
    commandOf: ReadonlyMap<number, string | null>,
  ): Promise<void> {
    const ids = new Set<string>()
    for (const entry of entries) {
      const id = commandOf.get(entry.seq)
      if (id != null) ids.add(id)
    }
    const byCommand = new Map<string, Pick<HistoryEntry, 'actor' | 'command'>>()
    for (const found of await auditEntries.byIds(tx, [...ids])) {
      if (found.outcome === 'applied') {
        byCommand.set(found.id, { actor: found.actor, command: found.command })
      }
    }
    const unnamed: HistoryEntry[] = []
    for (const entry of entries) {
      const id = commandOf.get(entry.seq)
      const own = id == null ? undefined : byCommand.get(id)
      if (own === undefined) unnamed.push(entry)
      else Object.assign(entry, own)
    }

    const byCorrelation = new Map<string, Pick<HistoryEntry, 'actor' | 'command'>>()
    for (const correlation of new Set(unnamed.map((e) => e.correlationId))) {
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
    for (const entry of unnamed) Object.assign(entry, byCorrelation.get(entry.correlationId))
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
        await actorsOf(tx, shown, new Map(rows.map((row) => [row.seq, row.commandId])))
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
