// The answer to `GET /api/admin/reports`. Every money figure is in minor units of its row's currency and no figure
// sums or converts across currencies. A money total may hold today, marked `partial`; a rate, a funnel total and top
// products count closed days only.

export type ReportGrain = 'day' | 'hour'

/** The store days a section counts, both ends included, as `YYYY-MM-DD` in `timezone`. */
export interface ReportSectionWindow {
  from: string
  to: string
  timezone: string
}

export interface ReportWindow extends ReportSectionWindow {
  grain: ReportGrain | null
  /** The last closed store day: yesterday, or `to` when it is earlier. */
  closedThrough: string
}

interface ReportMoneyFigures {
  capturedMinor: number
  refundedMinor: number
  /** Captured less refunded; a refund counts on its own day, so it can be negative. */
  netCapturedMinor: number
  paidOrders: number
}

export interface ReportMoneyBySource extends ReportMoneyFigures {
  source: string
  currency: string
}

interface ReportMoneyRow extends ReportMoneyFigures {
  currency: string
  bySource: ReportMoneyBySource[]
}

export interface ReportMoneyTotal extends ReportMoneyRow {
  window: ReportSectionWindow
  /** True when the total holds today, whose figures may still change. */
  partial: boolean
}

export interface ReportMoneySeriesRow extends ReportMoneyRow {
  bucket: string
  partial: boolean
  timezone: string
}

export interface ReportFunnelCounts {
  viewers: number
  cartsWithItems: number
  checkoutsStarted: number
  paymentsFailed: number
}

export interface ReportFunnelTotal extends ReportFunnelCounts {
  source: string
  window: ReportSectionWindow
  paidOrders: number
}

export interface ReportFunnelSeriesRow extends ReportFunnelCounts {
  bucket: string
  partial: boolean
  timezone: string
  source: string
  paidOrders: number
}

/** A ratio computed by the server; `null` with a `reason` when its parts are under the floor or no day is closed. */
export interface ReportRate {
  rate: number | null
  paidOrders: number
  basis: string
  window: ReportSectionWindow
  reason?: string
}

export interface ReportProductSourceFigures {
  source: string
  currency: string
  units: number
  lineSubtotalMinor: number
}

export interface ReportProductItem {
  productId: string
  productName: string
  currency: string
  units: number
  lineSubtotalMinor: number
  bySource: ReportProductSourceFigures[]
}

export interface ReportRunwayItem {
  variantId: string
  productId: string
  productName: string
  sku: string
  stock: number
  unitsSold: number
  windowDays: number
  /** Stock over units sold per day across `windowDays`; 0 with a `reason` when no stock is left. */
  daysLeft: number
  reason?: string
}

/** What each figure counts, keyed by field name. */
export type ReportDefinitions = Readonly<Record<string, string>>

interface ReportHeader {
  window: ReportWindow
  /** The earliest store day with any figure; null when there is none yet. */
  since: string | null
  definitions: ReportDefinitions
}

/** The answer with no `grain`: totals, rates and lists over the window. */
export interface ReportSummary extends ReportHeader {
  money: { totals: ReportMoneyTotal[] }
  funnel: { totals: ReportFunnelTotal[] }
  rates: {
    paidPerCheckoutStarted: ReportRate & { checkoutsStarted: number }
    paidPerCartWithItems: ReportRate & { cartsWithItems: number }
    paidPerMeasuredViewer: ReportRate & { viewers: number }
  }
  topProducts: { window: ReportSectionWindow; items: ReportProductItem[] }
  zeroResultSearches: {
    window: ReportSectionWindow
    items: Array<{ term: string; searches: number }>
  }
  stockRunway: { window: ReportSectionWindow; items: ReportRunwayItem[] }
}

/** The answer with a `grain`: a row per bucket and currency with figures. */
export interface ReportSeries extends ReportHeader {
  money: { series: ReportMoneySeriesRow[] }
  funnel?: { series: ReportFunnelSeriesRow[] }
}

export type ReportResponse = ReportSummary | ReportSeries
