import type { HttpAdapter, Review, ReviewsAdapter } from '@nymbalhq/types'
import type { ProductRepository } from '../repositories/product.js'
import type { ReviewRepository } from '../repositories/review.js'
import { ok, fail, renderError } from './envelope.js'
import { audit } from '../audit/audit.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminReviewsRoutesDeps {
  reviewsAdapter: ReviewsAdapter
  reviewRepo: ReviewRepository
  productRepo: ProductRepository
}

/** A pending review with its product as it is now; both null when the product was deleted. */
export interface PendingReview extends Review {
  productName: string | null
  productSlug: string | null
}

export function registerAdminReviewsRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminReviewsRoutesDeps,
): void {
  const { reviewRepo, productRepo } = deps

  // GET /api/admin/reviews — list pending reviews
  adapter.registerRoute(
    'GET',
    '/api/admin/reviews',
    requireRole('admin', async (ctx) => {
      try {
        const pending = await reviewRepo.store.read(async (tx): Promise<PendingReview[]> => {
          const reviews = await reviewRepo.listByStatus(tx, 'pending')
          const products = new Map<string, { name: string; slug: string } | null>()
          for (const id of new Set(reviews.map((r) => r.productId))) {
            products.set(id, await productRepo.findById(tx, id))
          }
          return reviews.map((review) => {
            const product = products.get(review.productId)
            return {
              ...review,
              productName: product?.name ?? null,
              productSlug: product?.slug ?? null,
            }
          })
        })
        return ok(pending)
      } catch (err) {
        return renderError(err, ctx.logger)
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
        const status = body.status
        await reviewRepo.store.transaction((tx) => {
          audit.note('review.moderate', [{ type: 'review', id }])
          return reviewRepo.setModerationStatus(
            tx,
            id,
            status,
            `admin:${ctx.auth!.userId}`,
            new Date(),
          )
        })
        return ok({ ok: true })
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )
}
