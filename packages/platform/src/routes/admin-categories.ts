import type { Category, HttpAdapter } from '@nymbalhq/types'
import type {
  CategoryCreateInput,
  CategoryService,
  CategoryUpdateInput,
} from '../services/category-service.js'
import { ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminCategoriesRoutesDeps {
  category: CategoryService
}

function byDisplayOrder(a: Category, b: Category): number {
  if (a.position !== b.position) return a.position - b.position
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Bodies arrive parsed by their `routeSchemas` entries, so each field here has passed the route's rules. */
export function registerAdminCategoriesRoutes(
  adapter: HttpAdapter,
  deps: RegisterAdminCategoriesRoutesDeps,
): void {
  const { category } = deps

  adapter.registerRoute(
    'GET',
    '/api/admin/categories',
    requireRole('admin', async (ctx) => {
      try {
        return ok((await category.list()).sort(byDisplayOrder))
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/categories',
    requireRole('admin', async (ctx) => {
      try {
        return ok(await category.create(ctx.body as CategoryCreateInput), undefined, 201)
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'POST',
    '/api/admin/categories/reorder',
    requireRole('admin', async (ctx) => {
      try {
        const body = ctx.body as { parentId: string | null; ids: string[] }
        return ok(await category.reorder(body.parentId, body.ids))
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'PATCH',
    '/api/admin/categories/:id',
    requireRole('admin', async (ctx) => {
      try {
        return ok(await category.update(ctx.params.id!, ctx.body as CategoryUpdateInput))
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )

  adapter.registerRoute(
    'DELETE',
    '/api/admin/categories/:id',
    requireRole('admin', async (ctx) => {
      try {
        return ok({ ok: true, ...(await category.delete(ctx.params.id!)) })
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )
}
