import type { HttpAdapter } from '@nymbalhq/types'
import { InsightError, type InsightService } from '../services/insight-service.js'
import { fail, ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminInsightRoutesDeps {
  insights: InsightService
}

export function registerAdminInsightRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminInsightRoutesDeps,
): void {
  const { insights } = deps

  adapter.registerRoute(
    'GET',
    '/api/admin/insights',
    requireRole('admin', async (ctx) => {
      try {
        return ok(await insights.list())
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/insights/:id/dismiss',
    requireRole('admin', async (ctx) => {
      try {
        return ok(await insights.dismiss(String(ctx.params['id'])))
      } catch (err) {
        if (err instanceof InsightError) return fail(err.code, err.message, err.status, err.context)
        return renderError(err, ctx.logger)
      }
    }),
  )
}
