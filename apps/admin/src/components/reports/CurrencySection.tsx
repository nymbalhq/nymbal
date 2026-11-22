import type { ReportMoneySeriesRow, ReportMoneyTotal } from '@nymbalhq/types'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatStoreDay } from '@/lib/dates'
import { formatMoney } from '@/lib/money'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'
import { sourceLabel, windowLabel } from './format'

interface CurrencySectionProps {
  total: ReportMoneyTotal
  /** The currency's series rows; a listed day with none had no sales. */
  rows: readonly ReportMoneySeriesRow[]
  /** Every store day to list, newest first. */
  days: readonly string[]
  today: string
}

const ZERO = { capturedMinor: 0, refundedMinor: 0, netCapturedMinor: 0, paidOrders: 0 }

export function CurrencySection({ total, rows, days, today }: CurrencySectionProps) {
  const c = total.currency
  const byDay = new Map(rows.map((r) => [r.bucket, r]))
  const tiles = [
    ['captured', 'Captured', formatMoney(total.capturedMinor, c)],
    ['refunded', 'Refunded', formatMoney(total.refundedMinor, c)],
    ['net', 'Net', formatMoney(total.netCapturedMinor, c)],
    ['paid', 'Paid orders', String(total.paidOrders)],
  ] as const

  return (
    <section
      data-testid={tid('reports', 'currency', c)}
      className="min-w-0 space-y-4 rounded-lg border border-zinc-200 bg-white p-5"
    >
      <div>
        <h2 className="text-sm font-semibold text-zinc-900">{c}</h2>
        <p data-testid={tid('reports', 'total', c, 'window')} className="text-xs text-zinc-500">
          {windowLabel(total.window)}
          {total.partial ? ' (so far)' : ''}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {tiles.map(([cell, name, value]) => (
          <div key={cell} data-testid={tid('reports', 'total', c, cell)}>
            <dt className="text-xs text-zinc-500">{name}</dt>
            <dd className="text-base font-semibold text-zinc-900">{value}</dd>
          </div>
        ))}
      </dl>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Captured</TableHead>
            <TableHead className="text-right">Refunded</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Paid orders</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {total.bySource.map((s) => (
            <TableRow key={s.source} data-testid={tid('reports', 'source', c, s.source)}>
              <TableCell>{sourceLabel(s.source)}</TableCell>
              <TableCell className="text-right">{formatMoney(s.capturedMinor, c)}</TableCell>
              <TableCell className="text-right">{formatMoney(s.refundedMinor, c)}</TableCell>
              <TableCell className="text-right">{formatMoney(s.netCapturedMinor, c)}</TableCell>
              <TableCell className="text-right">{String(s.paidOrders)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Day</TableHead>
            <TableHead className="text-right">Captured</TableHead>
            <TableHead className="text-right">Refunded</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Paid orders</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {days.map((day) => {
            const row = byDay.get(day) ?? ZERO
            const id = tid('reports', 'day', c, day)
            const isToday = day === today
            return (
              <TableRow
                key={day}
                data-testid={id}
                data-partial={isToday ? 'true' : undefined}
                className={cn(isToday && 'bg-zinc-50')}
              >
                <TableCell className="whitespace-nowrap">
                  {formatStoreDay(day)}
                  {isToday && <span className="ml-2 text-xs text-zinc-500">Today (so far)</span>}
                </TableCell>
                <TableCell data-testid={`${id}-captured`} className="text-right">
                  {formatMoney(row.capturedMinor, c)}
                </TableCell>
                <TableCell data-testid={`${id}-refunded`} className="text-right">
                  {formatMoney(row.refundedMinor, c)}
                </TableCell>
                <TableCell data-testid={`${id}-net`} className="text-right">
                  {formatMoney(row.netCapturedMinor, c)}
                </TableCell>
                <TableCell data-testid={`${id}-paid`} className="text-right">
                  {String(row.paidOrders)}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </section>
  )
}
