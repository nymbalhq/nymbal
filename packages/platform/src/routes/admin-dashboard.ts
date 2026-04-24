import type { HttpAdapter } from '@nymbal/types'
import type { NymbalConfig } from '@nymbal/config'
import type { Repositories } from '../repositories/index.js'
import { ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface InventoryRow {
  variantId: string
  productId: string
  productName: string
  sku: string
  stock: number
  threshold: number
  status: 'low_stock' | 'out_of_stock'
}

export interface RegisterAdminDashboardRouteDeps {
  repos: Repositories
  config: NymbalConfig
}

export function registerAdminDashboardRoute(
  adapter: HttpAdapter,
  deps: RegisterAdminDashboardRouteDeps,
): void {
  const { repos } = deps

  adapter.registerRoute(
    'GET',
    '/api/admin/dashboard',
    requireRole('admin', async () => {
      try {
        const startOfToday = new Date(new Date().setHours(0, 0, 0, 0))

        // Fetch recent orders (last 200 to compute today's stats)
        const allOrders = await repos.order.list({ limit: 200 })

        const todayOrders = allOrders.filter(
          (o) => new Date(o.createdAt) >= startOfToday,
        )

        const paidStatuses = new Set(['confirmed', 'processing', 'shipped', 'delivered'])
        const shippedStatuses = new Set(['shipped', 'delivered'])

        const todayOrderCount = todayOrders.length
        const todayRevenueMinor = todayOrders
          .filter((o) => paidStatuses.has(o.status))
          .reduce((sum, o) => sum + o.totalMinor, 0)
        const todayItemsShipped = todayOrders.filter((o) =>
          shippedStatuses.has(o.status),
        ).length

        // Recent orders — last 10 overall
        const recentOrders = allOrders.slice(0, 10)

        // Low stock: get all products and check variants
        const allProducts = await repos.product.list({ limit: 1000 })
        const lowStock: InventoryRow[] = []

        for (const product of allProducts) {
          const variants = await repos.variant.findByProduct(product.id)
          for (const variant of variants) {
            if (variant.stock <= variant.lowStockThreshold) {
              lowStock.push({
                variantId: variant.id,
                productId: product.id,
                productName: product.name,
                sku: variant.sku,
                stock: variant.stock,
                threshold: variant.lowStockThreshold,
                status: variant.stock <= 0 ? 'out_of_stock' : 'low_stock',
              })
            }
          }
        }

        return ok({
          today: {
            orderCount: todayOrderCount,
            revenueMinor: todayRevenueMinor,
            itemsShipped: todayItemsShipped,
          },
          recentOrders,
          lowStock,
        })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
