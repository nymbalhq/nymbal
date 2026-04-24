import type { HttpAdapter, AiAdapter, ProductStatus } from '@nymbal/types'
import type { ProductService } from '../services/product-service.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminProductsRoutesDeps {
  product: ProductService
  ai: AiAdapter | null
}

export function registerAdminProductsRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminProductsRoutesDeps,
): void {
  const { product } = deps

  // GET /api/admin/products
  adapter.registerRoute(
    'GET',
    '/api/admin/products',
    requireRole('admin', async (ctx) => {
      try {
        const q = ctx.query
        const statusRaw = Array.isArray(q.status) ? q.status[0] : q.status
        const search = Array.isArray(q.q) ? q.q[0] : q.q
        const limitRaw = Array.isArray(q.limit) ? q.limit[0] : q.limit
        const offsetRaw = Array.isArray(q.offset) ? q.offset[0] : q.offset

        const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 50, 200) : 50
        const offset = offsetRaw ? parseInt(offsetRaw, 10) || 0 : 0

        const listOpts: { status?: ProductStatus; limit?: number; offset?: number } = {
          limit: limit + offset + 200,
          offset: 0,
        }
        if (statusRaw) listOpts.status = statusRaw as ProductStatus
        let products = await product.list(listOpts)

        // In-memory q filter
        if (search) {
          const lc = search.toLowerCase()
          products = products.filter((p) => p.name.toLowerCase().includes(lc))
        }

        const page = products.slice(offset, offset + limit)
        return ok(page)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/products
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

  // PATCH /api/admin/products/:id
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

  // DELETE /api/admin/products/:id
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

  // POST /api/admin/products/:id/publish
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

  // POST /api/admin/products/:id/unpublish
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

  // POST /api/admin/products/:id/archive
  adapter.registerRoute(
    'POST',
    '/api/admin/products/:id/archive',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const snap = await product.update(id, { status: 'archived' })
        return ok(snap)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/products/:id/duplicate
  adapter.registerRoute(
    'POST',
    '/api/admin/products/:id/duplicate',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const original = await product.getById(id)

        const newSlug = `${original.slug}-copy`
        const snap = await product.create({
          slug: newSlug,
          name: `${original.name} (Copy)`,
          description: original.description,
          shortDescription: original.shortDescription,
          status: 'draft',
          type: original.type,
          seoTitle: original.seoTitle,
          seoDescription: original.seoDescription,
          media: original.media,
          metadata: original.metadata,
          categoryIds: original.categoryIds,
          variants: original.variants.map((v) => ({
            sku: `${v.sku}-COPY`,
            name: v.name,
            priceMinor: v.priceMinor,
            compareAtPriceMinor: v.compareAtPriceMinor,
            weightGrams: v.weightGrams,
            dimensions: v.dimensions,
            stock: v.stock,
            lowStockThreshold: v.lowStockThreshold,
            options: v.options,
            status: v.status,
          })),
        })
        return ok(snap, undefined, 201)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/products/:id/enhance
  adapter.registerRoute(
    'POST',
    '/api/admin/products/:id/enhance',
    requireRole('admin', async (ctx) => {
      try {
        const id = ctx.params.id
        if (!id) return fail('admin.invalid', 'id required', 400)
        const body = ctx.body as {
          field?: 'description' | 'alt' | 'title' | 'seoDescription'
          context?: Record<string, string>
        } | undefined
        if (!body?.field) return fail('admin.invalid', 'field required', 400)
        const validFields = ['description', 'alt', 'title', 'seoDescription']
        if (!validFields.includes(body.field)) {
          return fail('admin.invalid', `field must be one of: ${validFields.join(', ')}`, 400)
        }
        if (!deps.ai) {
          return fail('admin.unavailable', 'AI adapter not configured', 503)
        }

        const context = body.context ?? {}
        let prompt: string
        switch (body.field) {
          case 'description':
            prompt = `Write a compelling product description for: ${context['name'] ?? 'this product'}. Current description: ${context['current'] ?? '(empty)'}. Keep it under 200 words, engaging, and highlight key benefits.`
            break
          case 'seoDescription':
            prompt = `Write an SEO meta description (under 155 chars) for product: ${context['name'] ?? 'this product'}`
            break
          case 'title':
            prompt = `Write an SEO title tag (under 60 chars) for product: ${context['name'] ?? 'this product'}`
            break
          case 'alt':
            prompt = `Write alt text for a product image of: ${context['name'] ?? 'this product'}. Keep it under 100 chars, descriptive.`
            break
          default:
            return fail('admin.invalid', 'unknown field', 400)
        }

        const suggestion = await deps.ai.complete(prompt, { maxTokens: 300 })
        return ok({ suggestion })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
