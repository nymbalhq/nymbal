import fc from 'fast-check'
import type { NymbalEvent } from '@nymbalhq/types'
import type { CommandStore } from '../db/command-store.js'
import { createEventBuilder } from '../events/builder.js'
import { retryFloor } from '../index.js'
import type { EventLogRepository, LoggedEvent } from '../repositories/event-log.js'
import { TEST_BUILDER_CONTEXT } from './publisher.js'

// What the tests of retrying dead events share on either dialect: the retry, a generated log with a generated
// selection, and the same selection done in memory over `listAll`.

export interface DeadSelection {
  seq?: number
  id?: string
  types?: string[]
  since?: Date
  until?: Date
}

export interface RetryBounds {
  floor: Date
  limit: number
}

export const retryDeadOf = (log: EventLogRepository): EventLogRepository['retryDead'] =>
  log.retryDead

export const listDeadOf = (log: EventLogRepository): EventLogRepository['listDead'] => log.listDead

export const countDeadOf = (log: EventLogRepository): EventLogRepository['countDead'] =>
  log.countDead

/** `retryFloor` as `@nymbalhq/platform` exports it. */
export const retryFloorOf = (now: Date, retentionDays: number): Date =>
  retryFloor(now, retentionDays)

// ─── A generated log and selection ────────────────────────────────────────────────────────────────────────────────

const makeEvent = createEventBuilder(TEST_BUILDER_CONTEXT)
export const T0 = new Date('2026-01-01T00:00:00.000Z')
export const minutes = (n: number): Date => new Date(T0.getTime() + n * 60_000)

const TYPES = [
  'order.created.v1',
  'order.paid.v1',
  'cart.updated.v1',
  'category.created.v1',
  'a_c.v1',
  'a%c.v1',
  'abc.v1',
] as const
const GLOBS = ['order.*', '*.v1', 'category.created.v1', 'a_c.v1', 'a%c.v1', 'a*c.v1', 'cart.*']

type RowKind = 'dead' | 'deadDelivered' | 'waiting' | 'delivered' | 'fresh'

export interface RetryScenarioRow {
  kind: RowKind
  type: string
  minute: number
  attempts: number
}

export interface RetryScenario {
  rows: RetryScenarioRow[]
  seqPick: number | undefined
  idPick: number | undefined
  types: string[] | undefined
  since: number | undefined
  until: number | undefined
  floorMinute: number
  floorDeltaMs: number
  limit: number
}

const arbRow: fc.Arbitrary<RetryScenarioRow> = fc.record({
  kind: fc.constantFrom<RowKind>('dead', 'dead', 'deadDelivered', 'waiting', 'delivered', 'fresh'),
  type: fc.constantFrom(...TYPES),
  minute: fc.integer({ min: 0, max: 8 }),
  attempts: fc.integer({ min: 1, max: 4 }),
})

export const arbRetryScenario: fc.Arbitrary<RetryScenario> = fc.record({
  rows: fc.array(arbRow, { minLength: 1, maxLength: 14 }),
  seqPick: fc.option(fc.nat({ max: 20 }), { nil: undefined }),
  idPick: fc.option(fc.nat({ max: 20 }), { nil: undefined }),
  types: fc.option(fc.uniqueArray(fc.constantFrom(...GLOBS), { minLength: 1, maxLength: 2 }), {
    nil: undefined,
  }),
  since: fc.option(fc.integer({ min: 0, max: 9 }), { nil: undefined }),
  until: fc.option(fc.integer({ min: 0, max: 9 }), { nil: undefined }),
  floorMinute: fc.integer({ min: 0, max: 9 }),
  floorDeltaMs: fc.constantFrom(-1, 0, 1),
  limit: fc.integer({ min: 1, max: 16 }),
})

/** Every kind of row, each matched by no selection but its own, with room under the limit. */
export const SCENARIO_EXAMPLE: RetryScenario = {
  rows: [
    { kind: 'dead', type: 'order.created.v1', minute: 1, attempts: 2 },
    { kind: 'dead', type: 'a_c.v1', minute: 2, attempts: 1 },
    { kind: 'deadDelivered', type: 'a%c.v1', minute: 3, attempts: 1 },
    { kind: 'waiting', type: 'order.paid.v1', minute: 3, attempts: 1 },
    { kind: 'delivered', type: 'cart.updated.v1', minute: 4, attempts: 1 },
    { kind: 'fresh', type: 'abc.v1', minute: 4, attempts: 1 },
    { kind: 'dead', type: 'abc.v1', minute: 5, attempts: 3 },
  ],
  seqPick: undefined,
  idPick: undefined,
  types: undefined,
  since: undefined,
  until: undefined,
  floorMinute: 2,
  floorDeltaMs: 0,
  limit: 16,
}

/** What a dialect gives the scenario: its store and log, an append dated `at`, and every column of every row. */
export interface RetryLogEnv {
  store: CommandStore
  log: EventLogRepository
  append(events: NymbalEvent<unknown>[], at: Date): Promise<void>
  dump(): Promise<Array<Record<string, unknown>>>
}

/** A log of the scenario's rows, each brought to its kind through the repository's own writes. */
export async function seedRetryLog(env: RetryLogEnv, rows: RetryScenarioRow[]): Promise<void> {
  const { store, log } = env
  for (const [i, row] of rows.entries()) {
    const event = makeEvent(row.type, { i })
    await env.append([event], minutes(row.minute))
    const at = minutes(row.minute + 1)
    const retryAt = minutes(row.minute + 3)
    await store.transaction(async (tx) => {
      if (row.kind === 'delivered' || row.kind === 'deadDelivered') {
        await log.markDelivered(tx, [event.id], at)
      }
      if (row.kind === 'dead' || row.kind === 'deadDelivered') {
        for (let n = 1; n <= row.attempts; n += 1) {
          await log.recordFailure(tx, event.id, at, row.attempts, retryAt)
        }
      }
      if (row.kind === 'waiting') await log.recordFailure(tx, event.id, at, 99, retryAt)
    })
  }
}

/** The scenario's selection over the log it made: a pick past the last row names nothing. */
export function selectionOf(s: RetryScenario, logged: LoggedEvent[]): DeadSelection {
  const picked = (pick: number) => logged[pick]
  return {
    ...(s.seqPick !== undefined && { seq: picked(s.seqPick)?.seq ?? 1_000_000 }),
    ...(s.idPick !== undefined && {
      id: picked(s.idPick)?.event.id ?? '00000000-0000-7000-8000-000000000000',
    }),
    ...(s.types !== undefined && { types: s.types }),
    ...(s.since !== undefined && { since: minutes(s.since) }),
    ...(s.until !== undefined && { until: minutes(s.until) }),
  }
}

const floorOf = (s: RetryScenario): Date =>
  new Date(minutes(s.floorMinute).getTime() + s.floorDeltaMs)

export const boundsOf = (s: RetryScenario): RetryBounds => ({
  floor: floorOf(s),
  limit: s.limit,
})

function matchesGlob(type: string, glob: string): boolean {
  const pattern = glob.replace(/[.+?^${}()|[\]\\%_]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${pattern}$`).test(type)
}

function matchesSelection(row: LoggedEvent, s: DeadSelection): boolean {
  return (
    (s.seq === undefined || row.seq === s.seq) &&
    (s.id === undefined || row.event.id === s.id) &&
    (s.types === undefined || s.types.some((g) => matchesGlob(row.event.type, g))) &&
    (s.since === undefined || row.createdAt.getTime() >= s.since.getTime()) &&
    (s.until === undefined || row.createdAt.getTime() < s.until.getTime())
  )
}

/** The dead rows of `all` the selection takes, by seq. */
export function deadMatching(all: LoggedEvent[], s: DeadSelection): LoggedEvent[] {
  return all
    .filter((r) => r.deadAt !== null && matchesSelection(r, s))
    .sort((a, b) => a.seq - b.seq)
}

/** What a retry must take: the dead rows the selection takes with `created_at >= floor`, the oldest `limit`. */
export function retryExpected(
  all: LoggedEvent[],
  selection: DeadSelection,
  bounds: RetryBounds,
): LoggedEvent[] {
  return deadMatching(all, selection)
    .filter((r) => r.createdAt.getTime() >= bounds.floor.getTime())
    .slice(0, bounds.limit)
}
