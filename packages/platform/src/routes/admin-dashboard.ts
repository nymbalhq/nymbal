import type { HttpAdapter } from '@nymbalhq/types'
import type { NymbalConfig } from '@nymbalhq/config'
import { UCP_PROFILE_PATH } from '../agents/profile.js'
import { ACP_CAPABILITIES } from '../agents/acp/constants.js'
import { UCP_CAPABILITIES } from '../agents/ucp-surface.js'
import type { Repositories } from '../repositories/index.js'
import { readToday } from '../reports/today.js'
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

/** The agents tile's window, and how many agents it lists by name. */
const AGENT_WINDOW_MS = 30 * 86_400_000
const AGENT_SOURCES_SHOWN = 5

export interface RegisterAdminDashboardRouteDeps {
  repos: Repositories
  config: NymbalConfig
}

export function registerAdminDashboardRoute(
  adapter: HttpAdapter,
  deps: RegisterAdminDashboardRouteDeps,
): void {
  const { repos, config } = deps
  const { store } = repos.order

  adapter.registerRoute(
    'GET',
    '/api/admin/dashboard',
    requireRole('admin', async (ctx) => {
      try {
        const today = await readToday(
          {
            store: repos.reportRollup.store,
            repo: repos.reportRollup,
            timeZone: config.store.timezone,
            now: () => new Date(),
          },
          config.store.currency,
        )
        const recentOrders = await store.read((tx) => repos.order.list(tx, { limit: 10 }))

        // Low stock: get all products and check variants
        const productVariants = await store.read(async (tx) => {
          const products = await repos.product.list(tx, { limit: 1000 })
          const out = []
          for (const product of products) {
            out.push({ product, variants: await repos.variant.findByProduct(tx, product.id) })
          }
          return out
        })
        const lowStock: InventoryRow[] = []

        for (const { product, variants } of productVariants) {
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

        // From config, not `app.agents`: routes are registered before the agent surfaces exist.
        const ucpOn = config.agents.ucp.enabled
        const since = new Date(Date.now() - AGENT_WINDOW_MS)
        const agentOrders = await store.read((tx) =>
          repos.order.agentTotals(tx, since, AGENT_SOURCES_SHOWN),
        )

        return ok({
          today,
          recentOrders,
          lowStock,
          agents: {
            since: since.toISOString(),
            currency: config.store.currency,
            surfaces: [
              ...(ucpOn ? [{ name: 'ucp', capabilities: { ...UCP_CAPABILITIES } }] : []),
              ...(config.agents.acp.enabled
                ? [{ name: 'acp', capabilities: { ...ACP_CAPABILITIES } }]
                : []),
            ],
            mcp: { enabled: config.agents.mcp.enabled, writes: config.agents.mcp.writes },
            profilePath: ucpOn ? UCP_PROFILE_PATH : null,
            orders: { count: agentOrders.count, revenueMinor: agentOrders.revenueMinor },
            bySource: agentOrders.bySource,
          },
        })
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )
}
