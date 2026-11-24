import type { TodayFigures } from '@nymbalhq/types'
import { moneyFigures, moneyRows, type ReportDeps } from './report.js'
import { localDayOf } from './time.js'

/** Today's figures for the store's day, from the same rollups and money definition as the reports. */
export async function readToday(
  deps: Pick<ReportDeps, 'store' | 'repo' | 'timeZone' | 'now'>,
  storeCurrency: string,
): Promise<TodayFigures> {
  const { store, repo, timeZone, now } = deps
  const day = localDayOf(now(), timeZone)
  const { sales, products } = await store.read(async (tx) => ({
    sales: await repo.salesTotals(tx, day, day),
    products: await repo.productTotals(tx, day, day),
  }))
  const rows = moneyRows(sales)
  const own = rows.find((row) => row.currency === storeCurrency) ?? {
    currency: storeCurrency,
    ...moneyFigures(0, 0, 0),
    bySource: [],
  }
  const others = rows
    .filter((row) => row.currency !== storeCurrency)
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0))
  return {
    day,
    timezone: timeZone,
    paidOrders: sales.reduce((sum, row) => sum + row.paidOrders, 0),
    units: products.reduce((sum, row) => sum + row.units, 0),
    money: [own, ...others],
  }
}
