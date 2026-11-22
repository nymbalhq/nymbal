/** One source's share of a currency's money today. */
export interface TodayMoneyBySource {
  source: string
  currency: string
  capturedMinor: number
  refundedMinor: number
  netCapturedMinor: number
  paidOrders: number
}

/** One currency's money today: captured, refunded and their difference, which can be negative. */
export interface TodayMoney {
  currency: string
  capturedMinor: number
  refundedMinor: number
  netCapturedMinor: number
  paidOrders: number
  bySource: TodayMoneyBySource[]
}

/** The dashboard's figures for the store's own day, in the store's timezone, from the report rollups. */
export interface TodayFigures {
  /** YYYY-MM-DD in `timezone`. */
  day: string
  timezone: string
  /** Paid orders today, every currency and source. */
  paidOrders: number
  /** Units sold on paid orders today. */
  units: number
  /** One row per currency, never converted: the store currency first, zeros when it has no activity; the rest by code. */
  money: TodayMoney[]
}
