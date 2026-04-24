import type { HttpAdapter, ReviewsAdapter } from '@nymbal/types'
import type { ReviewRepository } from '../repositories/review.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminReviewsRoutesDeps {
  reviewsAdapter: ReviewsAdapter
  reviewRepo: ReviewRepository
}

export function registerAdminReviewsRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminReviewsRoutesDeps,
): void {
  const { reviewRepo } = deps

  // GET /api/admin/reviews — list pending reviews
  adapter.registerRoute(
    'GET',
    '/api/admin/reviews',
    requireRole('admin', async () => {
      try {
        const pending = await reviewRepo.listByStatus('pending')
        return ok(pending)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/reviews/:id/moderate — approve or reject
  adapter.registerRoute(
    'POST',
    '/api/admin/reviews/:id/moderate',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as { status?: 'approved' | 'rejected' } | undefined
        if (!body?.status || !['approved', 'rejected'].includes(body.status)) {
          return fail('reviews.invalid', 'status must be approved|rejected', 400)
        }
        await reviewRepo.setModerationStatus(
          id,
          body.status,
          `admin:${ctx.auth!.userId}`,
          new Date(),
        )
        return ok({ ok: true })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
