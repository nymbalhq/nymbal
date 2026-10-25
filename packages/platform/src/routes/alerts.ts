import type { AlertKind, HttpAdapter } from '@nymbalhq/types'
import type { AlertService } from '../services/alert-service.js'
import { ok, renderError } from './envelope.js'

export interface RegisterAlertRoutesDeps {
  alerts: AlertService
}

function originOf(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? undefined : header
}

export function registerAlertRoutes(adapter: HttpAdapter, deps: RegisterAlertRoutesDeps): void {
  const { alerts } = deps

  adapter.registerRoute('POST', '/api/alerts/subscribe', async (ctx) => {
    try {
      const body = ctx.body as { email: string; variantId: string; kind: AlertKind }
      const answer = await alerts.subscribe({ ...body, origin: originOf(ctx.headers['origin']) })
      return ok(answer, undefined, 202)
    } catch (err) {
      return renderError(err)
    }
  })

  // The token in the body is the credential, and the storefront pages post it from their servers, which hold no CSRF
  // cookie.
  adapter.registerRoute(
    'POST',
    '/api/alerts/confirm',
    async (ctx) => {
      try {
        return ok(await alerts.confirm((ctx.body as { token: string }).token))
      } catch (err) {
        return renderError(err)
      }
    },
    { csrf: false },
  )

  adapter.registerRoute(
    'POST',
    '/api/alerts/unsubscribe',
    async (ctx) => {
      try {
        return ok(await alerts.unsubscribe((ctx.body as { token: string }).token))
      } catch (err) {
        return renderError(err)
      }
    },
    { csrf: false },
  )
}
