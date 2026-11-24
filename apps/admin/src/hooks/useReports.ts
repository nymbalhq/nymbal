import { useQuery } from '@tanstack/react-query'
import type { ReportSeries, ReportSummary } from '@nymbalhq/types'
import { api } from '@/lib/api'
import { addStoreDays } from '@/lib/dates'

export type ReportRange = 7 | 30

/**
 * The report for the last `days` closed days and today. Today is the store's, from the series answer's `window.to`,
 * never the browser's clock; the summary names `to` so the server counts today's zero-result searches.
 */
export function useReports(days: ReportRange) {
  const series = useQuery({
    queryKey: ['reports', 'series'],
    queryFn: () => api.get<ReportSeries>('/api/admin/reports', { grain: 'day' }),
  })
  const today = series.data?.window.to
  const from = today === undefined ? undefined : addStoreDays(today, -days)
  const summary = useQuery({
    queryKey: ['reports', 'summary', from, today],
    queryFn: () => api.get<ReportSummary>('/api/admin/reports', { from, to: today }),
    enabled: today !== undefined,
  })
  return {
    series: series.data,
    summary: summary.data,
    today,
    from,
    isLoading: series.isLoading || summary.isLoading,
    error: series.error ?? summary.error,
  }
}
