import { useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import type { InsightSeverity, InsightView } from '@nymbalhq/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useDismissInsight, useInsights } from '@/hooks/useInsights'
import { ApiError } from '@/lib/api'
import { formatStoreDay } from '@/lib/dates'
import { tid } from '@/lib/testid'
import { cn } from '@/lib/utils'

const SEVERITY_LABELS: Record<InsightSeverity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}

const SEVERITY_STYLES: Record<InsightSeverity, string> = {
  critical: 'bg-red-50 text-red-700',
  warning: 'bg-amber-50 text-amber-700',
  info: 'bg-zinc-100 text-zinc-600',
}

const JOB_LABELS = new Map([
  ['stock-runway', 'Stock'],
  ['zero-result-term', 'Search'],
  ['demand', 'Orders'],
  ['refund-rate', 'Refunds'],
  ['operator-health', 'Store health'],
])

function InsightCard({ insight }: { insight: InsightView }) {
  const dismiss = useDismissInsight()
  // Set in the click itself: `isPending` reaches the button only after a render, too late for a double click.
  const dismissing = useRef(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const { id } = insight

  const handleDismiss = async () => {
    if (dismissing.current) return
    dismissing.current = true
    setBusy(true)
    setFailure(null)
    try {
      await dismiss.mutateAsync(id)
    } catch (err) {
      // Another admin dismissed it first: the refetch has taken the card away, which is what this click asked for.
      if (!(err instanceof ApiError && err.code === 'insight.dismissed')) {
        setFailure(err instanceof ApiError ? err.message : 'The insight could not be dismissed.')
      }
    } finally {
      dismissing.current = false
      setBusy(false)
    }
  }

  return (
    <article
      className="min-w-0 space-y-2 rounded-lg border border-zinc-200 bg-white p-4"
      data-testid={tid('inbox', 'insight', id)}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] font-medium',
            SEVERITY_STYLES[insight.severity],
          )}
          data-testid={tid('inbox', 'insight', 'severity', id)}
        >
          {SEVERITY_LABELS[insight.severity]}
        </span>
        <span className="[overflow-wrap:anywhere]">
          {JOB_LABELS.get(insight.job) ?? insight.job}
        </span>
        <span>Night of {formatStoreDay(insight.day)}</span>
      </div>
      <p className="text-sm text-zinc-900 [overflow-wrap:anywhere]">{insight.summary}</p>
      {insight.guidance !== null && (
        <div
          className="space-y-1 rounded-md bg-zinc-50 p-3"
          data-testid={tid('inbox', 'insight', 'guidance', id)}
        >
          <p className="text-xs font-medium text-zinc-500">Suggested next step · written by AI</p>
          <p className="text-sm text-zinc-800 [overflow-wrap:anywhere] whitespace-pre-line">
            {insight.guidance}
          </p>
        </div>
      )}
      {insight.guidanceWithheld && (
        <p
          className="text-xs text-zinc-500"
          data-testid={tid('inbox', 'insight', 'guidance', 'withheld', id)}
        >
          AI guidance was withheld: it did not pass the store's checks.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => void handleDismiss()}
          disabled={busy}
          data-testid={tid('inbox', 'dismiss', id)}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Dismiss
        </Button>
        {failure !== null && <p className="text-xs text-red-600">{failure}</p>}
      </div>
    </article>
  )
}

/** What the night shift found in the store's own figures, each open insight once, in the order the server gives. */
export function InsightBrief() {
  const { data, isLoading, isError } = useInsights()

  return (
    <section className="min-w-0 space-y-3" data-testid={tid('inbox', 'brief')}>
      <div>
        <h2 className="text-sm font-semibold text-zinc-900">Night shift</h2>
        <p className="text-sm text-zinc-500">
          What the store noticed in its own figures. A dismissed item stays quiet for 7 days.
        </p>
      </div>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <p className="text-sm text-red-600">The night shift's brief could not be loaded.</p>
      ) : data!.items.length === 0 ? (
        <p className="text-sm text-zinc-500" data-testid={tid('inbox', 'brief', 'empty')}>
          Nothing to report.
        </p>
      ) : (
        <div className="space-y-3">
          {data!.items.map((insight) => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
        </div>
      )}
    </section>
  )
}
