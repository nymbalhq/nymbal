import { useState } from 'react'
import { Link } from 'react-router-dom'
import { MessageSquare } from 'lucide-react'
import type { AdminReview, ReviewModerationStatus } from '@nymbalhq/types'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/common/EmptyState'
import { useModerateReview, useReviews, type ReviewDecision } from '@/hooks/useReviews'
import { ApiError } from '@/lib/api'
import { formatDate } from '@/lib/dates'
import { tid } from '@/lib/testid'

const TABS: ReadonlyArray<{ status: ReviewModerationStatus; label: string; empty: string }> = [
  { status: 'pending', label: 'Pending', empty: 'No reviews waiting.' },
  { status: 'approved', label: 'Approved', empty: 'No approved reviews.' },
  { status: 'rejected', label: 'Rejected', empty: 'No rejected reviews.' },
]

/** A decision can be changed but not withdrawn: each tab offers the decisions that move a review off it. */
const OFFERED: Record<ReviewModerationStatus, ReviewDecision[]> = {
  pending: ['approved', 'rejected'],
  approved: ['rejected'],
  rejected: ['approved'],
}

const WORDING: Record<ReviewDecision, { button: string; done: string; failed: string }> = {
  approved: { button: 'Approve', done: 'Approved', failed: 'The review could not be approved.' },
  rejected: { button: 'Reject', done: 'Rejected', failed: 'The review could not be rejected.' },
}

/** Reviews shoppers submitted: none is public until it is approved here. */
export function ReviewsPage() {
  const [tab, setTab] = useState<ReviewModerationStatus>('pending')
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { data: reviews, isLoading, isError } = useReviews(tab)
  const { moderate, deciding } = useModerateReview()

  const changeTab = (status: ReviewModerationStatus) => {
    setTab(status)
    setResult(null)
    setError(null)
  }

  const decide = async (review: AdminReview, decision: ReviewDecision) => {
    const sent = moderate({ id: review.id, status: decision })
    if (sent === null) return
    setResult(null)
    setError(null)
    try {
      await sent
      setResult(
        `${WORDING[decision].done} the review of ${review.productName ?? 'a deleted product'}`,
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : WORDING[decision].failed)
    }
  }

  const empty = TABS.find((t) => t.status === tab)!.empty

  return (
    <div className="min-w-0 space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-zinc-900">Reviews</h1>
        <p className="text-sm text-zinc-500">
          A review is public, and counts in its product&apos;s rating, once it is approved.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(value) => changeTab(value as ReviewModerationStatus)}>
        <TabsList>
          {TABS.map((t) => (
            <TabsTrigger
              key={t.status}
              value={t.status}
              data-testid={tid('reviews', 'tab', t.status)}
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {result !== null && (
        <p role="status" className="text-sm text-zinc-600" data-testid={tid('reviews', 'result')}>
          {result}
        </p>
      )}
      {error !== null && (
        <p role="alert" className="text-sm text-red-600" data-testid={tid('reviews', 'error')}>
          {error}
        </p>
      )}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : isError ? (
        <EmptyState
          icon={<MessageSquare className="h-5 w-5" />}
          title="The reviews could not be loaded"
        />
      ) : !reviews || reviews.length === 0 ? (
        <EmptyState icon={<MessageSquare className="h-5 w-5" />} title={empty} />
      ) : (
        <ul className="space-y-3">
          {reviews.map((review) => (
            <li
              key={review.id}
              data-testid={tid('reviews', 'row', review.id)}
              className="min-w-0 rounded-lg border border-zinc-200 bg-white p-4"
            >
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                {review.productSlug !== null && review.productName !== null ? (
                  <Link
                    to={`/products/${review.productSlug}`}
                    className="font-medium text-blue-600 hover:underline [overflow-wrap:anywhere]"
                  >
                    {review.productName}
                  </Link>
                ) : (
                  <span className="font-medium text-zinc-500">Deleted product</span>
                )}
                <span className="text-zinc-700">{review.rating} of 5</span>
                {review.orderId !== null && (
                  <span className="text-xs font-medium text-emerald-700">Verified purchase</span>
                )}
                <span className="text-xs text-zinc-500">{formatDate(review.submittedAt)}</span>
              </div>
              <p className="mt-2 text-sm font-medium text-zinc-900 [overflow-wrap:anywhere]">
                {review.title}
              </p>
              <p className="mt-1 whitespace-pre-line text-sm text-zinc-700 [overflow-wrap:anywhere]">
                {review.body}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {OFFERED[tab].map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    variant={decision === 'approved' ? 'default' : 'outline'}
                    disabled={deciding.has(review.id)}
                    onClick={() => void decide(review, decision)}
                    data-testid={tid(
                      'reviews',
                      decision === 'approved' ? 'approve' : 'reject',
                      review.id,
                    )}
                  >
                    {WORDING[decision].button}
                  </Button>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export const reviewsHandle = { breadcrumb: () => 'Reviews' }
