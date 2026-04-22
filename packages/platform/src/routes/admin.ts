import { type HttpAdapter } from '@nymbal/types'
import type { ProductService } from '../services/product-service.js'
import type { OrderService } from '../services/order-service.js'
import type { ReviewsAdapter } from '@nymbal/types'
import type { ReviewRepository } from '../repositories/review.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminRoutesDeps {
  product: ProductService
  order: OrderService
  reviewsAdapter: ReviewsAdapter
  reviewRepo: ReviewRepository
}

export function registerAdminRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminRoutesDeps,
): void {
  const { product, order, reviewRepo } = deps

  // --- Admin products ---

  adapter.registerRoute(
    'POST',
    '/api/admin/products',
    requireRole('admin', async (ctx) => {
      try {
        const snap = await product.create(ctx.body as Parameters<ProductService['create']>[0])
        return ok(snap, undefined, 201)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'PATCH',
    '/api/admin/products/:id',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const snap = await product.update(
          id,
          ctx.body as Parameters<ProductService['update']>[1],
        )
        return ok(snap)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'DELETE',
    '/api/admin/products/:id',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        await product.delete(id)
        return ok({ ok: true })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/products/:id/publish',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        await product.publish(id)
        return ok({ ok: true })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/products/:id/unpublish',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        await product.unpublish(id)
        return ok({ ok: true })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // --- Admin orders ---

  adapter.registerRoute(
    'GET',
    '/api/admin/orders',
    requireRole('admin', async () => {
      try {
        return ok([]) // list by doc store — handled by future list route
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/ship',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as { trackingNumber?: string; carrier?: string } | undefined
        if (!body?.trackingNumber || !body.carrier) {
          return fail('orders.invalid', 'trackingNumber and carrier required', 400)
        }
        const fresh = await order.markShipped(id, body.trackingNumber, body.carrier, `admin:${ctx.auth!.userId}`)
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/orders/:id/refund',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as { amountMinor?: number; reason?: string } | undefined
        if (!body?.amountMinor) return fail('orders.invalid', 'amountMinor required', 400)
        const fresh = await order.refund(
          id,
          body.amountMinor,
          body.reason ?? 'admin refund',
          `admin:${ctx.auth!.userId}`,
        )
        return ok(fresh)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // --- Admin reviews ---

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
