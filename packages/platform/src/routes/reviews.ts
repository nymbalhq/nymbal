import type { HttpAdapter } from '@nymbalhq/types'
import type { ReviewService } from '../services/review-service.js'
import { ok, renderError } from './envelope.js'
import { requireAuth } from './role-middleware.js'

export interface RegisterReviewRoutesDeps {
  reviews: ReviewService
}

export function registerReviewRoutes(adapter: HttpAdapter, deps: RegisterReviewRoutesDeps): void {
  const { reviews } = deps

  // The reviewer is the session's customer; the body names only the product and the review.
  adapter.registerRoute(
    'POST',
    '/api/reviews',
    requireAuth(async (ctx) => {
      try {
        const body = ctx.body as { productId: string; rating: number; title: string; body: string }
        const review = await reviews.submit({ ...body, customerId: ctx.auth!.userId! })
        return ok({ review })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
