import { OrderStatusBadge } from '@/components/orders/OrderStatusBadge'
import { formatDate, formatRelative } from '@/lib/dates'
import { tid } from '@/lib/testid'
import type { OrderHistoryEntry } from '@/types'

interface OrderTimelineProps {
  entries: OrderHistoryEntry[]
}

export function OrderTimeline({ entries }: OrderTimelineProps) {
  const sorted = [...entries].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )

  return (
    <div className="flow-root">
      <ul className="-mb-8">
        {sorted.map((entry, idx) => (
          <li key={entry.id} data-testid={tid('order', 'timeline-entry', entry.toStatus)}>
            <div className="relative pb-8">
              {idx < sorted.length - 1 && (
                <span
                  className="absolute left-4 top-5 -ml-px h-full w-0.5 bg-zinc-200"
                  aria-hidden="true"
                />
              )}
              <div className="relative flex gap-3">
                {/* Status dot */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 border-zinc-200 bg-white">
                  <div className="h-2 w-2 rounded-full bg-blue-500" />
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1 pt-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {entry.fromStatus && (
                      <>
                        <OrderStatusBadge status={entry.fromStatus} size="sm" />
                        <span className="text-zinc-400 text-xs">→</span>
                      </>
                    )}
                    <OrderStatusBadge status={entry.toStatus} size="sm" />
                  </div>
                  {entry.note && (
                    <p className="mt-1 text-sm text-zinc-600">{entry.note}</p>
                  )}
                  <div className="mt-1 flex items-center gap-2 text-xs text-zinc-400">
                    <span>{entry.actor}</span>
                    <span>·</span>
                    <time
                      dateTime={entry.timestamp}
                      title={formatDate(entry.timestamp)}
                    >
                      {formatRelative(entry.timestamp)}
                    </time>
                  </div>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
