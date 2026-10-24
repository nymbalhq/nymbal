import { useState } from 'react'
import { Download, History, Loader2 } from 'lucide-react'
import type { AuditEntry } from '@nymbalhq/types'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { exportActivity, useActivity, type ActivityFilters } from '@/hooks/useActivity'
import { formatDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

const OUTCOME_STYLES: Record<AuditEntry['outcome'], string> = {
  applied: 'bg-green-50 text-green-700',
  refused: 'bg-red-50 text-red-700',
  replayed: 'bg-zinc-100 text-zinc-600',
}

/** A `datetime-local` value as the instant it names in this browser's zone, or nothing. */
function instant(local: string): string | undefined {
  if (local === '') return undefined
  const at = new Date(local)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

function filtersOf(form: Record<keyof ActivityFilters, string>): ActivityFilters {
  const filters: ActivityFilters = {}
  for (const name of ['actor', 'command', 'subject', 'correlation', 'outcome'] as const) {
    const value = form[name].trim()
    if (value !== '') filters[name] = value
  }
  const since = instant(form.since)
  const until = instant(form.until)
  if (since !== undefined) filters.since = since
  if (until !== undefined) filters.until = until
  return filters
}

function download(text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `activity-${new Date().toISOString().slice(0, 10)}.ndjson`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

const EMPTY = {
  actor: '',
  command: '',
  subject: '',
  correlation: '',
  outcome: '',
  since: '',
  until: '',
}

export function ActivityPage() {
  const [form, setForm] = useState(EMPTY)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const filters = filtersOf(form)
  const { data, isLoading, isError, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useActivity(filters)
  const entries = data?.pages.flatMap((page) => page.data) ?? []

  const set = (name: keyof typeof EMPTY) => (value: string) =>
    setForm((prev) => ({ ...prev, [name]: value }))

  const handleExport = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const { since, until, correlation } = filters
      download(
        await exportActivity({
          ...(since !== undefined && { since }),
          ...(until !== undefined && { until }),
          ...(correlation !== undefined && { correlation }),
        }),
      )
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold text-zinc-900">Activity</h1>
          <p className="text-sm text-zinc-500">
            Who changed what, newest first. The export covers the time and correlation filters.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void handleExport()}
          disabled={exporting}
          data-testid="activity-export"
        >
          {exporting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
          Export
        </Button>
      </div>
      {exportError && <p className="text-sm text-red-600">Export failed: {exportError}</p>}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Input
          placeholder="Actor (admin:<id>, system, …)"
          value={form.actor}
          onChange={(e) => set('actor')(e.target.value)}
          className="h-8 text-sm"
          aria-label="Actor"
          data-testid="activity-filter-actor"
        />
        <Input
          placeholder="Command (inventory.adjust, …)"
          value={form.command}
          onChange={(e) => set('command')(e.target.value)}
          className="h-8 text-sm"
          aria-label="Command"
          data-testid="activity-filter-command"
        />
        <Input
          placeholder="Subject id"
          value={form.subject}
          onChange={(e) => set('subject')(e.target.value)}
          className="h-8 text-sm"
          aria-label="Subject"
          data-testid="activity-filter-subject"
        />
        <Input
          placeholder="Correlation id"
          value={form.correlation}
          onChange={(e) => set('correlation')(e.target.value)}
          className="h-8 text-sm"
          aria-label="Correlation id"
          data-testid="activity-filter-correlation"
        />
        <select
          value={form.outcome}
          onChange={(e) => set('outcome')(e.target.value)}
          className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-sm"
          aria-label="Outcome"
          data-testid="activity-filter-outcome"
        >
          <option value="">Any outcome</option>
          <option value="applied">Applied</option>
          <option value="refused">Refused</option>
          <option value="replayed">Replayed</option>
        </select>
        <Input
          type="datetime-local"
          value={form.since}
          onChange={(e) => set('since')(e.target.value)}
          className="h-8 text-sm"
          aria-label="From"
          data-testid="activity-filter-since"
        />
        <Input
          type="datetime-local"
          value={form.until}
          onChange={(e) => set('until')(e.target.value)}
          className="h-8 text-sm"
          aria-label="Until"
          data-testid="activity-filter-until"
        />
      </div>

      <div className="rounded-lg border border-zinc-200 bg-white overflow-x-auto">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : isError ? (
          <EmptyState icon={<History className="h-5 w-5" />} title="Activity could not be loaded" />
        ) : entries.length === 0 ? (
          <EmptyState
            icon={<History className="h-5 w-5" />}
            title="No activity found"
            description="Changes to the store appear here as they are made."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Command</TableHead>
                <TableHead>Subjects</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Correlation id</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id} data-testid={`activity-row-${entry.id}`}>
                  <TableCell className="whitespace-nowrap text-xs text-zinc-500">
                    {formatDate(entry.at)}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {entry.actor.kind}:{entry.actor.id}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{entry.command}</TableCell>
                  <TableCell className="font-mono text-xs text-zinc-600">
                    {entry.subjects.map((s) => (
                      <div key={`${s.type}:${s.id}`}>
                        {s.type}:{s.id}
                      </div>
                    ))}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-medium',
                        OUTCOME_STYLES[entry.outcome],
                      )}
                    >
                      {entry.outcome}
                      {entry.responseStatus !== null && ` ${entry.responseStatus}`}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-zinc-500">
                    {entry.correlationId ?? ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {hasNextPage && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}

export const activityHandle = {
  breadcrumb: () => 'Activity',
}
