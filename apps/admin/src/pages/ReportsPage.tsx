import { useState } from 'react'
import { BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { CurrencySection } from '@/components/reports/CurrencySection'
import {
  DefinitionsDisclosure,
  FunnelSection,
  RatesSection,
  RunwaySection,
  SearchesSection,
  TopProductsSection,
} from '@/components/reports/ReportSections'
import { useReports, type ReportRange } from '@/hooks/useReports'
import { addStoreDays, formatStoreDay } from '@/lib/dates'
import { tid } from '@/lib/testid'

const RANGES: ReadonlyArray<[ReportRange, string]> = [
  [7, 'Last 7 days'],
  [30, 'Last 30 days'],
]

/** Every store day from `from` to `to`, newest first. */
function daysNewestFirst(from: string, to: string): string[] {
  const days: string[] = []
  for (let day = to; day >= from; day = addStoreDays(day, -1)) days.push(day)
  return days
}

export function ReportsPage() {
  const [range, setRange] = useState<ReportRange>(30)
  const { series, summary, today, from, error } = useReports(range)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Reports</h1>
          <p className="text-sm text-zinc-500">Money, conversion and stock, in the store’s days.</p>
        </div>
        <div className="flex gap-2">
          {RANGES.map(([days, name]) => (
            <Button
              key={days}
              type="button"
              size="sm"
              variant={range === days ? 'default' : 'outline'}
              aria-pressed={range === days}
              data-testid={tid('reports', 'range', String(days))}
              onClick={() => setRange(days)}
            >
              {name}
            </Button>
          ))}
        </div>
      </div>

      <ReportBody error={error} series={series} summary={summary} today={today} from={from} />
    </div>
  )
}

function ReportBody({
  error,
  series,
  summary,
  today,
  from,
}: Pick<ReturnType<typeof useReports>, 'error' | 'series' | 'summary' | 'today' | 'from'>) {
  if (error !== null) {
    return (
      <div
        role="alert"
        data-testid={tid('reports', 'error')}
        className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
      >
        {error.message}
      </div>
    )
  }
  if (series === undefined || summary === undefined || today === undefined || from === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }
  if (summary.since === null) {
    return (
      <div data-testid={tid('reports', 'empty')}>
        <EmptyState
          icon={<BarChart3 className="h-5 w-5" />}
          title="No figures yet"
          description="Figures start with the first sale or visit the store records."
        />
      </div>
    )
  }

  const since = summary.since
  const firstDay = since > from ? since : from
  const days = daysNewestFirst(firstDay, today)

  return (
    <div className="space-y-4">
      {since > from && (
        <p data-testid={tid('reports', 'since')} className="text-sm text-zinc-600">
          Figures start on {formatStoreDay(since)}
        </p>
      )}
      {summary.money.totals.map((total) => (
        <CurrencySection
          key={total.currency}
          total={total}
          rows={series.money.series.filter((r) => r.currency === total.currency)}
          days={days}
          today={today}
        />
      ))}
      <FunnelSection funnel={summary.funnel} />
      <RatesSection rates={summary.rates} />
      <TopProductsSection top={summary.topProducts} />
      <SearchesSection searches={summary.zeroResultSearches} />
      <RunwaySection runway={summary.stockRunway} />
      <DefinitionsDisclosure definitions={summary.definitions} />
    </div>
  )
}

export const reportsHandle = { breadcrumb: () => 'Reports' }
