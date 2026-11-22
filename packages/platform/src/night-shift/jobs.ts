import type { InsightFacts, InsightSeverity, Logger } from '@nymbalhq/types'
import type { CommandStore, ReadTx } from '../db/command-store.js'
import type { EventPublisher } from '../events/publisher.js'
import { freeTextSpans } from '../customer-fields.js'
import { runwayWindow } from '../reports/report.js'
import { addDays, localDayOf } from '../reports/time.js'
import type { Repositories } from '../repositories/index.js'
import type {
  SalesHourReadRow,
  SearchTermRow,
  UnitsSoldRow,
} from '../repositories/report-rollup.js'
import { OPERATOR_CHECKS } from './operator-health.js'

/** Days a dismissed insight keeps its subject quiet. */
export const SUPPRESS_DAYS = 7
export const STOCK_RUNWAY = { days: 14, minUnits: 3, minWindowDays: 7, cap: 10 }
export const ZERO_RESULT_TERMS = { minSearches: 3, quietDays: 30, cap: 5 }
export const DEMAND = {
  ordersBelow: 0.5,
  minDailyOrders: 5,
  checkoutBelow: 0.6,
  minCheckoutsDay: 10,
  minCheckoutsWeek: 50,
  viewerDetailFrom: 100,
}
export const REFUND_RATE = { minRefunds: 5, spike: 2 }

const STOREFRONT = 'storefront'
const IMPORT = 'import'
const TRAILING_DAYS = 7
const WEEK_DAYS = 7
const BASELINE_DAYS = 28
/** Refunds are read from this far back, then bucketed by store day: the baseline's first day lies inside it. */
const REFUND_READ_DAYS = 36
const DAY_MS = 86_400_000

export interface InsightDraft {
  subject: string
  severity: InsightSeverity
  summary: string
  facts: InsightFacts
}

export interface NightShiftContext {
  /** The store day the night falls in. */
  runDay: string
  /** The closed day its figures end on, the day before `runDay`. */
  dataDay: string
  now: Date
  timeZone: string
}

export interface NightShiftDeps {
  store: CommandStore
  repos: Repositories
  publisher: EventPublisher
  logger: Logger
  /** The store's zone, which decides its days. */
  timeZone: string
  /** `NIGHT_SHIFT_JOBS` when not given. */
  jobs?: NightShiftJob[]
}

/** A job that reads in a read transaction and decides purely; `detect` returns every draft, in the order a cap keeps. */
export interface ReadDetectJob<I = unknown> {
  id: string
  cap?: number
  read(tx: ReadTx, deps: NightShiftDeps, ctx: NightShiftContext): Promise<I>
  detect(inputs: I, ctx: NightShiftContext): InsightDraft[]
}

/** A job called with no transaction open (it may call a model, or open its own), which decides itself whether to act. */
export interface RunJob {
  id: string
  cap?: number
  run(deps: NightShiftDeps, ctx: NightShiftContext): Promise<InsightDraft[]>
}

export type NightShiftJob = ReadDetectJob | RunJob

const whole = (x: number) => Math.round(x)
const oneDecimal = (x: number) => Math.round(x * 10) / 10
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)

/** Storefront paid orders per store day, summed across currencies. */
function paidByDay(
  rows: SalesHourReadRow[],
  keep: (source: string) => boolean,
): Map<string, number> {
  const byDay = new Map<string, number>()
  for (const row of rows) {
    if (!keep(row.source)) continue
    byDay.set(row.localDay, (byDay.get(row.localDay) ?? 0) + row.paidOrders)
  }
  return byDay
}

function sumOver(byDay: Map<string, number>, from: string, to: string): number {
  let total = 0
  for (const [day, n] of byDay) if (day >= from && day <= to) total += n
  return total
}

// ---- stock-runway ---------------------------------------------------------------------------------------------------

interface RunwayInputs {
  windowDays: number
  rows: UnitsSoldRow[]
}

const stockRunway: ReadDetectJob<RunwayInputs> = {
  id: 'stock-runway',
  cap: STOCK_RUNWAY.cap,
  async read(tx, deps, ctx) {
    const since = await deps.repos.reportRollup.since(tx)
    if (since === null) return { windowDays: 0, rows: [] }
    const { from, windowDays } = runwayWindow(ctx.dataDay, since)
    if (windowDays < STOCK_RUNWAY.minWindowDays) return { windowDays, rows: [] }
    return { windowDays, rows: await deps.repos.reportRollup.unitsSold(tx, from, ctx.dataDay) }
  },
  detect({ windowDays, rows }) {
    return rows
      .filter((row) => row.stock > 0 && row.unitsSold >= STOCK_RUNWAY.minUnits)
      .map((row) => ({ row, daysLeft: row.stock / (row.unitsSold / windowDays) }))
      .filter(({ daysLeft }) => daysLeft < STOCK_RUNWAY.days)
      .sort((a, b) => a.daysLeft - b.daysLeft || a.row.variantId.localeCompare(b.row.variantId))
      .map(({ row, daysLeft }) => {
        const left = Math.floor(daysLeft)
        return {
          subject: `variant:${row.variantId}`,
          severity: 'warning' as const,
          summary:
            `${row.productName} (${row.sku}) has ${left} ${plural(left, 'day', 'days')} of stock left: ` +
            `${row.stock} on hand, ${row.unitsSold} sold in the last ${windowDays} days.`,
          facts: {
            productName: row.productName,
            sku: row.sku,
            stock: row.stock,
            unitsSold: row.unitsSold,
            windowDays,
            daysLeft: left,
          },
        }
      })
  },
}

// ---- zero-result-term -----------------------------------------------------------------------------------------------

/**
 * An email or phone number typed into search is the shopper's own data, never a subject. A term is free text even
 * when it is one word, so a bare `07700900123` is looked at as a phone too.
 */
const holdsContact = (term: string) =>
  freeTextSpans(term, 'email').length > 0 || freeTextSpans(term, 'phone', ` ${term}`).length > 0

const zeroResultTerm: ReadDetectJob<SearchTermRow[]> = {
  id: 'zero-result-term',
  cap: ZERO_RESULT_TERMS.cap,
  read(tx, deps, ctx) {
    const quietFrom = addDays(ctx.dataDay, -ZERO_RESULT_TERMS.quietDays)
    return deps.repos.reportRollup.newZeroResultTerms(
      tx,
      ctx.dataDay,
      quietFrom,
      ZERO_RESULT_TERMS.minSearches,
    )
  },
  detect(terms) {
    return terms
      .filter(({ term }) => !holdsContact(term))
      .map(({ term, searches }) => ({
        subject: `term:${term}`,
        severity: 'info' as const,
        summary:
          `Shoppers searched for "${term}" ${searches} times yesterday and found nothing; ` +
          `nobody had searched for it in the ${ZERO_RESULT_TERMS.quietDays} days before.`,
        facts: { term, searches, quietDays: ZERO_RESULT_TERMS.quietDays },
      }))
  },
}

// ---- demand ---------------------------------------------------------------------------------------------------------

interface DemandInputs {
  paid: Map<string, number>
  started: Map<string, number>
  viewers: number
}

const demand: ReadDetectJob<DemandInputs | null> = {
  id: 'demand',
  async read(tx, deps, ctx) {
    const from = addDays(ctx.dataDay, -TRAILING_DAYS)
    const live = await deps.repos.reportRollup.liveSince(tx)
    if (live === null || live > from) return null
    const sales = await deps.repos.reportRollup.salesHours(tx, from, ctx.dataDay)
    const funnel = await deps.repos.reportRollup.funnelDays(tx, from, ctx.dataDay)
    const started = new Map<string, number>()
    let viewers = 0
    for (const row of funnel) {
      if (row.source !== STOREFRONT) continue
      started.set(row.localDay, row.checkoutsStarted)
      if (row.localDay === ctx.dataDay) viewers = row.viewers
    }
    return { paid: paidByDay(sales, (source) => source === STOREFRONT), started, viewers }
  },
  detect(inputs, ctx) {
    if (inputs === null) return []
    const from = addDays(ctx.dataDay, -TRAILING_DAYS)
    const before = addDays(ctx.dataDay, -1)
    const paid = inputs.paid.get(ctx.dataDay) ?? 0
    const trailingPaid = sumOver(inputs.paid, from, before)
    const mean = trailingPaid / TRAILING_DAYS
    const drafts: InsightDraft[] = []

    if (mean >= DEMAND.minDailyOrders && paid < DEMAND.ordersBelow * mean) {
      const trailingMean = oneDecimal(mean)
      const percentOfMean = whole((paid / mean) * 100)
      const viewerDetail = inputs.viewers >= DEMAND.viewerDetailFrom
      const paidPerViewerPercent = viewerDetail ? whole((paid / inputs.viewers) * 100) : 0
      drafts.push({
        subject: 'orders',
        severity: 'warning',
        summary:
          `Storefront paid orders fell to ${paid} yesterday, ${percentOfMean}% of the ${trailingMean} a day ` +
          `over the week before.` +
          (viewerDetail
            ? ` ${inputs.viewers} shoppers viewed the store; ${paidPerViewerPercent}% of them paid.`
            : ''),
        facts: {
          paidOrders: paid,
          trailingMean,
          percentOfMean,
          ...(viewerDetail && { viewers: inputs.viewers, paidPerViewerPercent }),
        },
      })
    }

    const started = inputs.started.get(ctx.dataDay) ?? 0
    const trailingStarted = sumOver(inputs.started, from, before)
    if (
      started >= DEMAND.minCheckoutsDay &&
      trailingStarted >= DEMAND.minCheckoutsWeek &&
      paid / started < DEMAND.checkoutBelow * (trailingPaid / trailingStarted)
    ) {
      const successPercent = whole((paid / started) * 100)
      const trailingSuccessPercent = whole((trailingPaid / trailingStarted) * 100)
      drafts.push({
        subject: 'checkout',
        severity: 'critical',
        summary:
          `Checkout success fell to ${successPercent}% yesterday (${paid} paid of ${started} started), ` +
          `against ${trailingSuccessPercent}% over the week before.`,
        facts: {
          paidOrders: paid,
          checkoutsStarted: started,
          successPercent,
          trailingSuccessPercent,
        },
      })
    }
    return drafts
  },
}

// ---- refund-rate ----------------------------------------------------------------------------------------------------

interface RefundInputs {
  refundDays: string[]
  paid: Map<string, number>
}

const refundRate: ReadDetectJob<RefundInputs | null> = {
  id: 'refund-rate',
  async read(tx, deps, ctx) {
    const baselineFrom = addDays(ctx.dataDay, -(WEEK_DAYS + BASELINE_DAYS - 1))
    const live = await deps.repos.reportRollup.liveSince(tx)
    if (live === null || live > baselineFrom) return null
    const since = new Date(ctx.now.getTime() - REFUND_READ_DAYS * DAY_MS)
    const times = await deps.repos.orderRefund.countedRefundTimes(tx, since)
    const sales = await deps.repos.reportRollup.salesHours(tx, baselineFrom, ctx.dataDay)
    return {
      refundDays: times.map((at) => localDayOf(at, ctx.timeZone)),
      paid: paidByDay(sales, (source) => source !== IMPORT),
    }
  },
  detect(inputs, ctx) {
    if (inputs === null) return []
    const weekFrom = addDays(ctx.dataDay, -(WEEK_DAYS - 1))
    const baselineTo = addDays(ctx.dataDay, -WEEK_DAYS)
    const baselineFrom = addDays(ctx.dataDay, -(WEEK_DAYS + BASELINE_DAYS - 1))
    const within = (from: string, to: string) =>
      inputs.refundDays.filter((day) => day >= from && day <= to).length
    const refunds = within(weekFrom, ctx.dataDay)
    const baselineRefunds = within(baselineFrom, baselineTo)
    const paidOrders = sumOver(inputs.paid, weekFrom, ctx.dataDay)
    const baselinePaidOrders = sumOver(inputs.paid, baselineFrom, baselineTo)
    if (refunds < REFUND_RATE.minRefunds || paidOrders === 0 || baselinePaidOrders === 0) return []
    // refunds / paid ≥ 2 × baselineRefunds / baselinePaid, kept in whole numbers.
    if (refunds * baselinePaidOrders < REFUND_RATE.spike * baselineRefunds * paidOrders) return []
    const ratePercent = oneDecimal((refunds / paidOrders) * 100)
    const baselineRatePercent = oneDecimal((baselineRefunds / baselinePaidOrders) * 100)
    return [
      {
        subject: 'store',
        severity: 'warning',
        summary:
          `Refunds rose to ${ratePercent}% of paid orders in the week to yesterday (${refunds} of ${paidOrders}), ` +
          `against ${baselineRatePercent}% (${baselineRefunds} of ${baselinePaidOrders}) in the four weeks before.`,
        facts: {
          refunds,
          paidOrders,
          ratePercent,
          baselineRefunds,
          baselinePaidOrders,
          baselineRatePercent,
        },
      },
    ]
  },
}

// ---- operator-health ------------------------------------------------------------------------------------------------

const operatorHealth: ReadDetectJob<InsightDraft[]> = {
  id: 'operator-health',
  async read(tx, deps, ctx) {
    const drafts: InsightDraft[] = []
    for (const check of OPERATOR_CHECKS) {
      const found = await check.find(tx, deps, ctx)
      if (found !== null) drafts.push(found)
    }
    return drafts
  },
  detect(drafts) {
    return drafts
  },
}

/** The jobs a night runs, in order; operator health last, so it sees tonight's failed runs. */
export const NIGHT_SHIFT_JOBS: NightShiftJob[] = [
  stockRunway,
  zeroResultTerm,
  demand,
  refundRate,
  operatorHealth,
]
