import type { HttpAdapter, StockAdjustmentReason, VariantOption } from '@nymbal/types'
import type { InventoryService } from '../services/inventory-service.js'
import type { ProductService } from '../services/product-service.js'
import type { Repositories } from '../repositories/index.js'
import { ok, fail, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface InventoryRow {
  variantId: string
  productId: string
  productName: string
  sku: string
  options: VariantOption[]
  stock: number
  threshold: number
  status: 'in_stock' | 'low_stock' | 'out_of_stock'
  updatedAt: string
}

export interface RegisterAdminInventoryRoutesDeps {
  inventory: InventoryService
  product: ProductService
  repos: Repositories
}

function stockStatus(stock: number, threshold: number): 'in_stock' | 'low_stock' | 'out_of_stock' {
  if (stock <= 0) return 'out_of_stock'
  if (stock <= threshold) return 'low_stock'
  return 'in_stock'
}

function urgencyOrder(status: InventoryRow['status']): number {
  if (status === 'out_of_stock') return 0
  if (status === 'low_stock') return 1
  return 2
}

export function registerAdminInventoryRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminInventoryRoutesDeps,
): void {
  const { inventory, product, repos } = deps

  // GET /api/admin/inventory
  adapter.registerRoute(
    'GET',
    '/api/admin/inventory',
    requireRole('admin', async (ctx) => {
      try {
        const q = ctx.query
        const statusFilter = Array.isArray(q.status) ? q.status[0] : q.status
        const search = Array.isArray(q.q) ? q.q[0] : q.q
        const limitRaw = Array.isArray(q.limit) ? q.limit[0] : q.limit
        const offsetRaw = Array.isArray(q.offset) ? q.offset[0] : q.offset

        const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 500) : 100
        const offset = offsetRaw ? parseInt(offsetRaw, 10) || 0 : 0

        // Build inventory rows from all products
        const allProducts = await product.list({ limit: 1000 })
        let rows: InventoryRow[] = []

        for (const p of allProducts) {
          for (const variant of p.variants) {
            rows.push({
              variantId: variant.id,
              productId: p.id,
              productName: p.name,
              sku: variant.sku,
              options: variant.options,
              stock: variant.stock,
              threshold: variant.lowStockThreshold,
              status: stockStatus(variant.stock, variant.lowStockThreshold),
              updatedAt: variant.updatedAt,
            })
          }
        }

        // Filters
        if (statusFilter) {
          rows = rows.filter((r) => r.status === statusFilter)
        }
        if (search) {
          const lc = search.toLowerCase()
          rows = rows.filter(
            (r) =>
              r.sku.toLowerCase().includes(lc) ||
              r.productName.toLowerCase().includes(lc),
          )
        }

        // Sort by urgency
        rows.sort((a, b) => {
          const urgencyDiff = urgencyOrder(a.status) - urgencyOrder(b.status)
          if (urgencyDiff !== 0) return urgencyDiff
          // Within same urgency: low_stock sorted ascending by stock
          return a.stock - b.stock
        })

        const page = rows.slice(offset, offset + limit)
        return ok(page)
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // POST /api/admin/inventory/:variantId/adjust
  adapter.registerRoute(
    'POST',
    '/api/admin/inventory/:variantId/adjust',
    requireRole('admin', async (ctx) => {
      try {
        const variantId = ctx.params.variantId
        if (!variantId) return fail('admin.invalid', 'variantId required', 400)
        const body = ctx.body as { delta?: number; reason?: StockAdjustmentReason } | undefined
        if (body?.delta == null) return fail('inventory.invalid', 'delta required', 400)
        if (!body.reason) return fail('inventory.invalid', 'reason required', 400)

        const result = await inventory.adjustStock(
          variantId,
          body.delta,
          body.reason,
          `admin:${ctx.auth!.userId}`,
        )
        return ok({ newQty: result.newQty, variantId })
      } catch (err) {
        return renderError(err)
      }
    }),
  )

  // GET /api/admin/inventory/:variantId/history
  adapter.registerRoute(
    'GET',
    '/api/admin/inventory/:variantId/history',
    requireRole('admin', async (ctx) => {
      try {
        const variantId = ctx.params.variantId
        if (!variantId) return fail('admin.invalid', 'variantId required', 400)
        const history = await repos.stockAdjustment.listByVariant(variantId, 100)
        return ok(history)
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
