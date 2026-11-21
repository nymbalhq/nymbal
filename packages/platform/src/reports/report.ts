import { ValidationError } from '@nymbalhq/types'
import type { CommandStore, ReadTx } from '../db/command-store.js'
import type {
  FunnelCounts,
  ReportRollupRepository,
  SalesHourReadRow,
  SalesTotalRow,
} from '../repositories/report-rollup.js'
import { DEFINITIONS, RATE_BASIS, RATE_FLOORS } from './definitions.js'
import { addDays, daysBetween, localDayOf } from './time.js'

// The answer to `GET /api/admin/reports`, built so a model reading it cannot misstate it: every figure says what it
// counts, its period, its timezone and its currency, and a total never holds a part day.

const DEFAULT_DAYS: Record<'day' | 'hour', number> = { day: 31, hour: 7 }
const RUNWAY_DAYS = 28
const RATE_SOURCE = 'storefront'

export type ReportGrain = 'day' | 'hour'

export interface ReportDeps {
  store: CommandStore
  repo: ReportRollupRepository
  timeZone: string
  now: () => Date
}

export interface ReportQuery {
  from?: string
  to?: string
  grain?: ReportGrain
  limit: number
}

export interface SectionWindow {
  from: string
  to: string
  timezone: string
}

export interface ReportWindow extends SectionWindow {
  grain: ReportGrain | null
  closedThrough: string
}

interface MoneyFigures {
  capturedMinor: number
  refundedMinor: number
  netCapturedMinor: number
  paidOrders: number
}

export interface MoneyBySource extends MoneyFigures {
  source: string
  currency: string
}

interface MoneyRow extends MoneyFigures {
  currency: string
  bySource: MoneyBySource[]
}

export interface MoneyTotal extends MoneyRow {
  window: SectionWindow
}

export interface MoneySeriesRow extends MoneyRow {
  bucket: string
  partial: boolean
  timezone: string
}

export interface FunnelTotal extends FunnelCounts {
  source: string
  window: SectionWindow
  paidOrders: number
}

export interface FunnelSeriesRow extends FunnelCounts {
  bucket: string
  partial: boolean
  timezone: string
  source: string
  paidOrders: number
}

export interface RateOf {
  rate: number | null
  paidOrders: number
  basis: string
  window: SectionWindow
  reason?: string
}

export interface ProductSourceFigures {
  source: string
  currency: string
  units: number
  lineSubtotalMinor: number
}

export interface ProductItem {
  productId: string
  productName: string
  currency: string
  units: number
  lineSubtotalMinor: number
  bySource: ProductSourceFigures[]
}

export interface RunwayItem {
  variantId: string
  productId: string
  productName: string
  sku: string
  stock: number
  unitsSold: number
  windowDays: number
  daysLeft: number
  reason?: string
}

interface ReportHeader {
  window: ReportWindow
  since: string | null
  definitions: typeof DEFINITIONS
}

export interface DefaultReport extends ReportHeader {
  money: { totals: MoneyTotal[] }
  funnel: { totals: FunnelTotal[] }
  rates: {
    paidPerCheckoutStarted: RateOf & { checkoutsStarted: number }
    paidPerCartWithItems: RateOf & { cartsWithItems: number }
    paidPerMeasuredViewer: RateOf & { viewers: number }
  }
  topProducts: { window: SectionWindow; items: ProductItem[] }
  zeroResultSearches: { window: SectionWindow; items: Array<{ term: string; searches: number }> }
  stockRunway: { window: SectionWindow; items: RunwayItem[] }
}

export interface GrainReport extends ReportHeader {
  money: { series: MoneySeriesRow[] }
  funnel?: { series: FunnelSeriesRow[] }
}

export type ReportResponse = DefaultReport | GrainReport

const NO_FIGURES = (): FunnelCounts => ({
  viewers: 0,
  cartsWithItems: 0,
  checkoutsStarted: 0,
  paymentsFailed: 0,
})

function moneyFigures(capturedMinor: number, refundedMinor: number, paidOrders: number): MoneyFigures {
  return { capturedMinor, refundedMinor, netCapturedMinor: capturedMinor - refundedMinor, paidOrders }
}

/** Each currency's row, its figures the sum of its sources. */
function moneyRows(rows: readonly SalesTotalRow[]): MoneyRow[] {
  const byCurrency = new Map<string, SalesTotalRow[]>()
  for (const row of rows) {
    byCurrency.set(row.currency, [...(byCurrency.get(row.currency) ?? []), row])
  }
  return [...byCurrency.entries()].map(([currency, sources]) => {
    const sum = (pick: (row: SalesTotalRow) => number) => sources.reduce((s, r) => s + pick(r), 0)
    return {
      currency,
      ...moneyFigures(sum((r) => r.capturedMinor), sum((r) => r.refundedMinor), sum((r) => r.paidOrders)),
      bySource: sources.map((r) => ({
        source: r.source,
        currency,
        ...moneyFigures(r.capturedMinor, r.refundedMinor, r.paidOrders),
      })),
    }
  })
}

/** Each bucket and currency's row of the series; `bucketOf` is what the rows of one bucket have in common. */
function moneySeries(
  hours: readonly SalesHourReadRow[],
  bucketOf: (row: SalesHourReadRow) => string,
  today: string,
): MoneySeriesRow[] {
  const groups = new Map<
    string,
    { bucket: string; day: string; timezone: string; bySource: Map<string, SalesTotalRow> }
  >()
  for (const row of hours) {
    const bucket = bucketOf(row)
    const key = `${bucket}|${row.currency}`
    const group =
      groups.get(key) ??
      { bucket, day: row.localDay, timezone: row.timezone, bySource: new Map<string, SalesTotalRow>() }
    groups.set(key, group)
    const source = group.bySource.get(row.source)
    if (source === undefined) group.bySource.set(row.source, { ...row })
    else {
      source.capturedMinor += row.capturedMinor
      source.refundedMinor += row.refundedMinor
      source.paidOrders += row.paidOrders
    }
  }
  return [...groups.values()].flatMap((group) =>
    moneyRows([...group.bySource.values()]).map((row) => ({
      bucket: group.bucket,
      partial: group.day === today,
      timezone: group.timezone,
      ...row,
    })),
  )
}

function rateOf<K extends 'checkoutsStarted' | 'cartsWithItems' | 'viewers'>(
  key: K,
  basisKey: keyof typeof RATE_BASIS,
  denominator: number,
  paidOrders: number,
  window: SectionWindow,
  anyClosedDay: boolean,
): RateOf & Record<K, number> {
  const floor = RATE_FLOORS[key]
  const reason = !anyClosedDay
    ? 'No closed day in this range.'
    : denominator < floor
      ? `Fewer than ${floor} ${key === 'checkoutsStarted' ? 'checkouts started' : key === 'cartsWithItems' ? 'carts with items' : 'viewers'} in the window, too few to state a rate.`
      : undefined
  return {
    rate: reason === undefined ? paidOrders / denominator : null,
    paidOrders,
    [key]: denominator,
    basis: RATE_BASIS[basisKey],
    window,
    ...(reason !== undefined && { reason }),
  } as RateOf & Record<K, number>
}

function assertRange(from: string, to: string, grain: ReportGrain | undefined): void {
  if (from > to) {
    throw new ValidationError('from must not be after to', { context: { from, to } })
  }
  if (grain !== undefined && daysBetween(from, to) > DEFAULT_DAYS[grain]) {
    throw new ValidationError(`A grain=${grain} range is at most ${DEFAULT_DAYS[grain]} days`, {
      context: { from, to, grain },
    })
  }
}

/** The report for `query`: only closed days reach a total or a rate; today appears only in a `grain` read's series. */
export async function readReport(deps: ReportDeps, query: ReportQuery): Promise<ReportResponse> {
  const { store, repo, timeZone, now } = deps
  const today = localDayOf(now(), timeZone)
  const closedThrough = addDays(today, -1)
  const to = query.to ?? today
  const from = query.from ?? addDays(to, -(DEFAULT_DAYS[query.grain ?? 'day'] - 1))
  assertRange(from, to, query.grain)

  return store.read(async (tx) => {
    const since = await repo.since(tx)
    if (query.grain !== undefined) {
      return grainReport(repo, tx, { from, to, today, closedThrough, since, grain: query.grain, timeZone })
    }
    return defaultReport(repo, tx, { from, to, today, closedThrough, since, timeZone }, query)
  })
}

interface Period {
  from: string
  to: string
  today: string
  closedThrough: string
  since: string | null
  timeZone: string
}

async function grainReport(
  repo: ReportRollupRepository,
  tx: ReadTx,
  period: Period & { grain: ReportGrain },
): Promise<GrainReport> {
  const { from, to, today, closedThrough, since, grain, timeZone } = period
  const hours = await repo.salesHours(tx, from, to)
  const header: ReportHeader = {
    window: { from, to, timezone: timeZone, grain, closedThrough },
    since,
    definitions: DEFINITIONS,
  }
  if (grain === 'hour') {
    return { ...header, money: { series: moneySeries(hours, (r) => r.hourStart.toISOString(), today) } }
  }
  const days = await repo.funnelDays(tx, from, to)
  const series = new Map<string, FunnelSeriesRow>()
  const rowOf = (bucket: string, timezone: string, source: string) => {
    const key = `${bucket}|${source}`
    const row =
      series.get(key) ??
      { bucket, partial: bucket === today, timezone, source, ...NO_FIGURES(), paidOrders: 0 }
    series.set(key, row)
    return row
  }
  for (const day of days) {
    const { localDay, timezone, source, ...counts } = day
    Object.assign(rowOf(localDay, timezone, source), counts)
  }
  for (const hour of hours) {
    if (hour.paidOrders !== 0) rowOf(hour.localDay, hour.timezone, hour.source).paidOrders += hour.paidOrders
  }
  return {
    ...header,
    money: { series: moneySeries(hours, (r) => r.localDay, today) },
    funnel: {
      series: [...series.values()].sort(
        (a, b) => a.bucket.localeCompare(b.bucket) || a.source.localeCompare(b.source),
      ),
    },
  }
}

async function defaultReport(
  repo: ReportRollupRepository,
  tx: ReadTx,
  period: Period,
  query: ReportQuery,
): Promise<DefaultReport> {
  const { from, today, closedThrough, since, timeZone } = period
  const closedTo = period.to < closedThrough ? period.to : closedThrough
  const window: SectionWindow = { from, to: closedTo, timezone: timeZone }
  const anyClosedDay = from <= closedTo

  const sales = await repo.salesTotals(tx, from, closedTo)
  const funnel = await repo.funnelTotals(tx, from, closedTo)
  const money = moneyRows(sales).map((row) => ({ ...row, window }))

  const paidBySource = new Map<string, number>()
  for (const row of sales) {
    paidBySource.set(row.source, (paidBySource.get(row.source) ?? 0) + row.paidOrders)
  }
  const countsBySource = new Map<string, FunnelCounts>()
  for (const { source, ...counts } of funnel) countsBySource.set(source, counts)
  const funnelSources = [...new Set([...countsBySource.keys(), ...paidBySource.keys()])].sort()
  const funnelTotals: FunnelTotal[] = funnelSources.map((source) => ({
    source,
    window,
    ...(countsBySource.get(source) ?? NO_FIGURES()),
    paidOrders: paidBySource.get(source) ?? 0,
  }))

  const counted = countsBySource.get(RATE_SOURCE) ?? NO_FIGURES()
  const paid = paidBySource.get(RATE_SOURCE) ?? 0

  const topItems = new Map<string, ProductItem>()
  for (const row of await repo.productTotals(tx, from, closedTo)) {
    const key = `${row.productId}|${row.currency}`
    const item =
      topItems.get(key) ??
      {
        productId: row.productId,
        productName: row.productName,
        currency: row.currency,
        units: 0,
        lineSubtotalMinor: 0,
        bySource: [],
      }
    topItems.set(key, item)
    item.units += row.units
    item.lineSubtotalMinor += row.lineSubtotalMinor
    item.bySource.push({
      source: row.source,
      currency: row.currency,
      units: row.units,
      lineSubtotalMinor: row.lineSubtotalMinor,
    })
  }
  const topProducts = [...topItems.values()]
    .sort((a, b) => b.units - a.units || a.productId.localeCompare(b.productId))
    .slice(0, query.limit)

  // A search reads a day still open as well, once a `to` of today asks it to.
  const searchesTo = query.to === undefined ? closedTo : period.to < today ? period.to : today
  const searches = await repo.zeroResultTerms(tx, from, searchesTo, query.limit)

  const earliestRunway = addDays(closedThrough, -(RUNWAY_DAYS - 1))
  const runwayFrom = since !== null && since > earliestRunway ? since : earliestRunway
  const windowDays = daysBetween(runwayFrom, closedThrough)
  const sold = windowDays > 0 ? await repo.unitsSold(tx, runwayFrom, closedThrough) : []
  const runway: RunwayItem[] = sold
    .map((row) => ({
      variantId: row.variantId,
      productId: row.productId,
      productName: row.productName,
      sku: row.sku,
      stock: row.stock,
      unitsSold: row.unitsSold,
      windowDays,
      daysLeft: row.stock <= 0 ? 0 : row.stock / (row.unitsSold / windowDays),
      ...(row.stock <= 0 && { reason: 'No stock left.' }),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft || a.variantId.localeCompare(b.variantId))
    .slice(0, query.limit)

  return {
    window: { ...window, grain: null, closedThrough },
    since,
    definitions: DEFINITIONS,
    money: { totals: money },
    funnel: { totals: funnelTotals },
    rates: {
      paidPerCheckoutStarted: rateOf('checkoutsStarted', 'paidPerCheckoutStarted', counted.checkoutsStarted, paid, window, anyClosedDay),
      paidPerCartWithItems: rateOf('cartsWithItems', 'paidPerCartWithItems', counted.cartsWithItems, paid, window, anyClosedDay),
      paidPerMeasuredViewer: rateOf('viewers', 'paidPerMeasuredViewer', counted.viewers, paid, window, anyClosedDay),
    },
    topProducts: { window, items: topProducts },
    zeroResultSearches: { window: { from, to: searchesTo, timezone: timeZone }, items: searches },
    stockRunway: {
      window: { from: runwayFrom, to: closedThrough, timezone: timeZone },
      items: runway,
    },
  }
}
