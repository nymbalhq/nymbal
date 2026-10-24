import { useState } from 'react'
import { History, X } from 'lucide-react'
import type { HistoryChange, HistoryEntry } from '@nymbalhq/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/common/EmptyState'
import { useAsOf, useHistory, type HistoryCollection } from '@/hooks/useHistory'
import { ApiError } from '@/lib/api'
import { formatDate } from '@/lib/dates'

interface HistoryTabProps {
  collection: HistoryCollection
  /** The record's id, which `…/:id/history` takes. */
  id: string
  /** The admin detail read `?at=` is asked of. */
  detailPath: string
}

function shown(value: unknown): string {
  if (value === null || value === undefined) return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function ChangeRow({ seq, change }: { seq: number; change: HistoryChange }) {
  return (
    <li
      className="font-mono text-xs text-zinc-600 break-all"
      data-testid={`history-change-${seq}-${change.path}`}
    >
      <span className="text-zinc-400">{change.path}: </span>
      <span className="text-red-700">{shown(change.from)}</span>
      <span className="text-zinc-400"> → </span>
      <span className="text-green-700">{shown(change.to)}</span>
    </li>
  )
}

function EntryRow({ entry, onAsOf }: { entry: HistoryEntry; onAsOf: (at: string) => void }) {
  return (
    <li className="py-3 space-y-1.5" data-testid={`history-row-${entry.seq}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <time dateTime={entry.at} className="text-zinc-500">
          {formatDate(entry.at)}
        </time>
        <span className="font-mono text-zinc-800">{entry.type}</span>
        <span className="font-mono text-zinc-500" data-testid={`history-row-${entry.seq}-actor`}>
          {entry.actor === null ? 'system' : `${entry.actor.kind}:${entry.actor.id}`}
        </span>
        <span className="font-mono text-zinc-500" data-testid={`history-row-${entry.seq}-command`}>
          {entry.command ?? ''}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => onAsOf(entry.at)}
          data-testid={`history-as-of-${entry.seq}`}
        >
          View as of
        </Button>
      </div>
      {entry.base ? (
        <p className="text-xs text-zinc-400">The earliest state the event log holds.</p>
      ) : (
        <ul className="space-y-0.5">
          {entry.changes.map((change) => (
            <ChangeRow key={change.path} seq={entry.seq} change={change} />
          ))}
        </ul>
      )}
    </li>
  )
}

/** The record `?at=` answers, read-only: one row per top-level field. */
function AsOfPanel({
  detailPath,
  at,
  onClose,
}: {
  detailPath: string
  at: string
  onClose: () => void
}) {
  const { data, error, isLoading } = useAsOf(detailPath, at)
  return (
    <div
      className="rounded-md border border-zinc-200 bg-zinc-50 p-3 space-y-2"
      data-testid="history-as-of-panel"
    >
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-zinc-700">As of {formatDate(at)}</h4>
        <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : error ? (
        <p className="text-xs text-red-600">
          {error instanceof ApiError ? error.message : 'The record could not be read as of then.'}
        </p>
      ) : data ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
          {Object.entries(data.record).map(([field, value]) => (
            <div key={field} className="contents">
              <dt className="text-zinc-400">{field}</dt>
              <dd
                className="font-mono text-zinc-700 break-all"
                data-testid={`history-as-of-field-${field}`}
              >
                {shown(value)}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  )
}

/** A record's history from the event log: one row per change, newest first, and the record as of any of them. */
export function HistoryTab({ collection, id, detailPath }: HistoryTabProps) {
  const { data, isLoading, isError, hasNextPage, fetchNextPage, isFetchingNextPage } = useHistory(
    collection,
    id,
  )
  const [asOf, setAsOf] = useState<string | null>(null)

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }
  if (isError || !data) {
    return <EmptyState icon={<History className="h-5 w-5" />} title="History could not be loaded" />
  }

  const first = data.pages[0]!
  if (first.historyStartsAt === null) {
    return (
      <p className="py-4 text-center text-sm text-zinc-500" data-testid="history-empty">
        This record predates the event log’s window: the log keeps {first.retentionDays} days of
        changes (events.retentionDays), so its earlier history is no longer held.
      </p>
    )
  }

  const entries = data.pages.flatMap((page) => page.entries)
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        From {formatDate(first.historyStartsAt)}: the event log keeps {first.retentionDays} days of
        changes.
      </p>
      {asOf !== null && (
        <AsOfPanel detailPath={detailPath} at={asOf} onClose={() => setAsOf(null)} />
      )}
      <ul className="divide-y divide-zinc-100">
        {entries.map((entry) => (
          <EntryRow key={entry.seq} entry={entry} onAsOf={setAsOf} />
        ))}
      </ul>
      {hasNextPage && (
        <Button
          type="button"
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
