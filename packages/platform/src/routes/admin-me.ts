import type { HttpAdapter } from '@nymbal/types'
import type { NymbalConfig } from '@nymbal/config'
import { ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

export interface RegisterAdminMeRouteDeps {
  config: NymbalConfig
}

export function registerAdminMeRoute(
  adapter: HttpAdapter,
  deps: RegisterAdminMeRouteDeps,
): void {
  const { config } = deps

  adapter.registerRoute(
    'GET',
    '/api/admin/me',
    requireRole('admin', async (ctx) => {
      try {
        return ok({
          userId: ctx.auth!.userId,
          roles: ctx.auth!.roles,
          storeName: config.store.name,
          environment: process.env['NODE_ENV'] ?? 'development',
        })
      } catch (err) {
        return renderError(err)
      }
    }),
  )
}
