import { randomUUID } from 'node:crypto'
import { PROPOSAL_OUTCOME_UNKNOWN } from '@nymbalhq/types'
import type { CommandStore } from '../../src/db/command-store.js'
import type { EventPublisher } from '../../src/events/publisher.js'
import {
  NIGHT_SHIFT_JOBS,
  type InsightDraft,
  type NightShiftJob,
} from '../../src/night-shift/jobs.js'
import { runNightShift, type JobRun, type NightShiftDeps } from '../../src/night-shift/runner.js'
import type { RollupDelta } from '../../src/reports/fold.js'
import type { Repositories } from '../../src/repositories/index.js'
import type { Kernel } from './kernel.js'
import { eventRows } from './outbox.js'
import { writeRaw, type RawReader } from './raw.js'
import { ROLLUP_TABLES, ZONE, addDays, makeEvent, noonOf } from './report-rollups.js'
import { unaudited } from './write-audit.js'

// What the night-shift tests share: a fixed night, the runner's deps from a kernel or a replica, figures written as the
// report handler writes them (one rollup delta per day, through the repository), the store's own faults (refunds, a
// dead event, a proposal settled with an unknown outcome), and the insights, runs and events as a second connection
// reads them. Nothing here knows how a job decides.

export { ZONE, addDays, noonOf }

export const INSIGHT_CREATED = 'insight.created.v1'

/** 03:30 in London (BST) on 2026-07-15: the night of the 15th, reporting on the 14th; no clock change near it. */
export const NOW = new Date('2026-07-15T02:30:00.000Z')
export const RUN_DAY = '2026-07-15'
export const DATA_DAY = '2026-07-14'
export const DAY_MS = 86_400_000

/** The store day `n` days before the data day. */
export const daysBack = (n: number): string => addDays(DATA_DAY, -n)

export const JOB_IDS = [
  'stock-runway',
  'zero-result-term',
  'demand',
  'refund-rate',
  'operator-health',
] as const

export type Side = {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Kernel['logger']
}

/** The runner's deps over a kernel or a replica, in the store's zone. */
export function depsOf(side: Side, jobs?: NightShiftJob[]): NightShiftDeps {
  return {
    store: side.store,
    repos: side.repos,
    publisher: side.publisher,
    logger: side.logger,
    timeZone: ZONE,
    ...(jobs !== undefined && { jobs }),
  }
}

/** One of the shipped jobs, by id. */
export function shippedJob(id: (typeof JOB_IDS)[number]): NightShiftJob {
  const job = NIGHT_SHIFT_JOBS.find((j: NightShiftJob) => j.id === id)
  if (job === undefined) throw new Error(`NIGHT_SHIFT_JOBS has no job ${id}`)
  return job
}

/** The night run twice for the same `now`, as a second tick or a restart would; the second run's answer. */
export async function runTwice(side: Side, now: Date, jobs?: NightShiftJob[]): Promise<JobRun[]> {
  await runNightShift(depsOf(side, jobs), now)
  return runNightShift(depsOf(side, jobs), now)
}

/** The drafts a `read`/`detect` job gives for the night of `now`, with nothing written. */
export async function draftsOf(k: Side, job: NightShiftJob, now: Date): Promise<InsightDraft[]> {
  if (!('read' in job)) throw new Error(`${job.id} is not a read/detect job`)
  const runDay = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(now)
  const ctx = { runDay, dataDay: addDays(runDay, -1), now, timeZone: ZONE }
  const deps = depsOf(k)
  const inputs = await k.store.read((tx) => job.read(tx, deps, ctx))
  return job.detect(inputs, ctx)
}

// ---- figures ------------------------------------------------------------------------------------------------------

/** Writes the deltas in one transaction through the rollup repository, as deliveries of their events would. */
export async function applyFigures(k: Side, deltas: RollupDelta[]): Promise<void> {
  if (deltas.length === 0) return
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      for (const delta of deltas) await k.repos.reportRollup.apply(tx, delta, noonOf(DATA_DAY))
    }),
  )
}

export function paidOn(
  day: string,
  paidOrders: number,
  source = 'storefront',
  currency = 'GBP',
): RollupDelta {
  return {
    table: 'salesHours',
    hourStart: noonOf(day),
    localDay: day,
    timezone: ZONE,
    currency,
    source,
    capturedMinor: paidOrders * 1_000,
    refundedMinor: 0,
    paidOrders,
  }
}

export function funnelOn(
  day: string,
  figures: { checkoutsStarted?: number; viewers?: number },
  source = 'storefront',
): RollupDelta {
  return {
    table: 'funnelDays',
    localDay: day,
    timezone: ZONE,
    source,
    viewers: figures.viewers ?? 0,
    cartsWithItems: 0,
    checkoutsStarted: figures.checkoutsStarted ?? 0,
    paymentsFailed: 0,
  }
}

export interface SoldVariant {
  variantId: string
  productId: string
  productName: string
  sku: string
}

export function soldOn(
  day: string,
  v: SoldVariant,
  units: number,
  source = 'storefront',
): RollupDelta {
  return {
    table: 'productDays',
    localDay: day,
    timezone: ZONE,
    variantId: v.variantId,
    currency: 'GBP',
    source,
    productId: v.productId,
    productName: v.productName,
    variantName: 'Default',
    sku: v.sku,
    units,
    lineSubtotalMinor: units * 1_000,
  }
}

export function searchedOn(day: string, term: string, searches: number): RollupDelta {
  return { table: 'searchDays', localDay: day, timezone: ZONE, term, searches }
}

/** The store days `from` back to `to` back from the data day, oldest first (`daysRange(27, 0)` is 28 days). */
export function daysRange(fromBack: number, toBack: number): string[] {
  const days: string[] = []
  for (let n = fromBack; n >= toBack; n -= 1) days.push(daysBack(n))
  return days
}

/** `total` paid orders spread over `days` as evenly as whole orders go, the remainder on the earliest days. */
export function spreadPaid(total: number, days: string[], source = 'storefront'): RollupDelta[] {
  const base = Math.floor(total / days.length)
  const extra = total - base * days.length
  return days
    .map((day, i) => paidOn(day, base + (i < extra ? 1 : 0), source))
    .filter((d) => d.table === 'salesHours' && d.paidOrders > 0)
}

// ---- the store's own faults ---------------------------------------------------------------------------------------

export interface RefundSeed {
  orderId: string
  at: Date
  actor?: string
  status?: 'pending' | 'succeeded' | 'failed'
  reason?: string | null
}

/** One `order_refunds` row through the repository; by default a succeeded refund an admin made. */
export async function seedRefund(k: Side, seed: RefundSeed): Promise<void> {
  await unaudited(() =>
    k.store.transaction((tx) =>
      k.repos.orderRefund.insert(tx, {
        id: randomUUID(),
        orderId: seed.orderId,
        amountMinor: 500,
        currency: 'GBP',
        providerRefundId: `re_${randomUUID()}`,
        status: seed.status ?? 'succeeded',
        reason: seed.reason ?? null,
        actor: seed.actor ?? 'admin:night-shift-suite',
        createdAt: seed.at,
      }),
    ),
  )
}

/** One event in the log that the relay gave up on: appended and failed past its last attempt in one transaction. */
export async function seedDeadEvent(k: Side): Promise<string> {
  const event = makeEvent(
    'product.viewed.v1',
    { productId: randomUUID(), viewer: { kind: 'visitor', id: `dead-${randomUUID()}` } },
    { timestamp: noonOf(daysBack(2)) },
  )
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      await k.repos.eventLog.append(tx, [event])
      await k.repos.eventLog.recordFailure(tx, event.id, noonOf(daysBack(1)), 1)
    }),
  )
  return event.id
}

/** A proposal approved and then settled `failed` with `code` at `settledAt`, as the stuck sweeper leaves one. */
export async function seedSettledProposal(
  k: Side,
  settledAt: Date,
  code: string = PROPOSAL_OUTCOME_UNKNOWN,
): Promise<string> {
  const id = randomUUID()
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      await k.repos.proposal.insert(tx, {
        id,
        tool: 'order_cancel',
        command: 'order.cancel',
        args: {},
        handles: null,
        idempotencyKey: null,
        proposerId: 'admin-proposer',
        agentName: 'night-shift-suite-agent',
        agentVersion: null,
        correlationId: randomUUID(),
        createdAt: new Date(settledAt.getTime() - 60 * 60_000),
      })
      await k.repos.proposal.decide(tx, id, {
        status: 'approved',
        by: { kind: 'admin', id: 'admin-approver' },
        at: new Date(settledAt.getTime() - 30 * 60_000),
      })
      await k.repos.proposal.settle(tx, id, {
        status: 'failed',
        outcome: { status: 500, code },
        at: settledAt,
      })
    }),
  )
  return id
}

export interface InsightSeed {
  job: string
  subject: string
  runDay: string
  status: 'open' | 'dismissed'
  dismissedAt: Date | null
}

/** An insight row as an earlier night (and, for a dismissed one, a later dismiss) left it, through the repository. */
export async function seedInsight(k: Side, seed: InsightSeed): Promise<void> {
  await unaudited(() =>
    k.store.transaction(async (tx) => {
      await k.repos.insight.insert(tx, {
        id: randomUUID(),
        job: seed.job,
        subject: seed.subject,
        runDay: seed.runDay,
        dataDay: addDays(seed.runDay, -1),
        status: seed.status,
        severity: 'warning',
        summary: `Seeded insight about ${seed.subject}.`,
        facts: {},
        createdAt: noonOf(addDays(seed.runDay, -1)),
        dismissedAt: seed.dismissedAt,
      })
    }),
  )
}

/** Empties everything a night reads or writes, so one kernel serves many fixtures. */
export async function resetNight(k: Pick<Kernel, 'dialect' | 'target' | 'app'>): Promise<void> {
  // A night's events are delivered after it returns. A raw SQLite write on a second connection while that delivery's
  // transaction is open waits with the thread asleep, so the transaction never commits: the delivery finishes first.
  await k.app.relay.drain()
  const statements = [
    'DELETE FROM insights',
    'DELETE FROM night_shift_runs',
    'DELETE FROM order_refunds',
    'DELETE FROM proposals',
    `DELETE FROM events WHERE type = '${INSIGHT_CREATED}'`,
    'DELETE FROM events WHERE dead_at IS NOT NULL',
    ...ROLLUP_TABLES.map((table) => `DELETE FROM ${table}`),
  ]
  for (const sql of statements) await writeRaw(k.dialect, k.target, sql)
}

// ---- what the night left ------------------------------------------------------------------------------------------

export interface InsightRow {
  id: string
  job: string
  subject: string
  runDay: string
  dataDay: string
  status: string
  severity: string
  summary: string
  facts: Record<string, string | number | null>
}

const parsed = (value: unknown) =>
  (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, string | number | null>

/** The `insights` table as a second connection reads it, oldest run day first, then subject. */
export async function insightRows(raw: RawReader, job?: string): Promise<InsightRow[]> {
  const rows = await raw.rows<Record<string, unknown>>(
    `SELECT id, job, subject, run_day, data_day, status, severity, summary, facts FROM insights${
      job === undefined ? '' : ' WHERE job = ?'
    } ORDER BY run_day, subject`,
    job === undefined ? [] : [job],
  )
  return rows.map((r) => ({
    id: String(r['id']),
    job: String(r['job']),
    subject: String(r['subject']),
    runDay: String(r['run_day']),
    dataDay: String(r['data_day']),
    status: String(r['status']),
    severity: String(r['severity']),
    summary: String(r['summary']),
    facts: parsed(r['facts']),
  }))
}

export interface InsightPayload {
  insightId: string
  job: string
  subject: string
  day: string
  dataDay: string
  severity: string
  summary: string
  facts: Record<string, string | number | null>
}

/** The payload of every `insight.created.v1` in the log, in log order; `job` narrows it. */
export async function insightEvents(raw: RawReader, job?: string): Promise<InsightPayload[]> {
  const rows = await eventRows(raw, 'type = ?', [INSIGHT_CREATED])
  return rows
    .map((row) => row.envelope.payload as InsightPayload)
    .filter((p) => job === undefined || p.job === job)
}

export interface RunRow {
  job: string
  runDay: string
  status: string
  insights: number
  error: string | null
}

export async function runRows(raw: RawReader): Promise<RunRow[]> {
  const rows = await raw.rows<Record<string, unknown>>(
    'SELECT job, run_day, status, insights, error FROM night_shift_runs ORDER BY run_day, job',
  )
  return rows.map((r) => ({
    job: String(r['job']),
    runDay: String(r['run_day']),
    status: String(r['status']),
    insights: Number(r['insights']),
    error: r['error'] == null ? null : String(r['error']),
  }))
}

/** Each number a sentence prints (`5`, `12.5`), in order. */
export function numbersIn(summary: string): string[] {
  return summary.match(/\d+(?:\.\d+)?/g) ?? []
}

/** The numbers in `summary` that no `facts` value carries in its string form: none, for an honest sentence. */
export function numbersNotInFacts(summary: string, facts: Record<string, unknown>): string[] {
  const carried = Object.values(facts).map((v) => String(v))
  return numbersIn(summary).filter((n) => !carried.some((value) => value.includes(n)))
}

/** A draft for a probe job. */
export function draft(subject: string, facts: InsightDraft['facts'] = { count: 1 }): InsightDraft {
  return { subject, severity: 'info', summary: `Probe ${subject}.`, facts }
}
