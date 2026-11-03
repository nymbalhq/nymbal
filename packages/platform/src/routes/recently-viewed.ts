import { v7 as uuidv7 } from 'uuid'
import {
  type DocumentStoreAdapter,
  type HttpAdapter,
  type RequestContext,
  type ResponseCookie,
  type ResponseEnvelope,
  type ReviewsAdapter,
} from '@nymbalhq/types'
import type { ProductRepository } from '../repositories/product.js'
import {
  readRecentlyViewed,
  RECENT_VIEWS_WINDOW_DAYS,
  viewerKey,
} from '../read-models/recently-viewed.js'
import type { RecentlyViewedService } from '../services/recently-viewed-service.js'
import type { AfterSignIn, SecureCookies } from './auth.js'
import { refuseLapsedBearer } from './auth-middleware.js'
import { ok, renderError } from './envelope.js'
import { withRatings } from './product-ratings.js'

export const VISITOR_COOKIE = 'nymbal.visitor'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BOT = /bot|crawl|spider|slurp/i
const NOT_STORED = { 'Cache-Control': 'private, no-store' }

function visitorCookie(id: string, secure: boolean): ResponseCookie {
  return {
    name: VISITOR_COOKIE,
    value: id,
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: RECENT_VIEWS_WINDOW_DAYS * 86_400,
  }
}

export function expiredVisitorCookie(secure = false): ResponseCookie {
  return { name: VISITOR_COOKIE, value: '', path: '/', maxAge: 0, httpOnly: true, secure }
}

/** The request's visitor id, when its cookie holds one; anything but a UUID is no visitor. */
function visitorOf(ctx: RequestContext): string | undefined {
  const id = ctx.cookies[VISITOR_COOKIE]
  return id !== undefined && UUID.test(id) ? id : undefined
}

/** The sign-in hook that moves the visitor's views to the customer and ends the visitor. */
export function foldViewsOnSignIn(
  recentlyViewed: RecentlyViewedService,
  secure: SecureCookies = () => false,
): AfterSignIn {
  return async (ctx, customerId) => {
    const visitorId = visitorOf(ctx)
    if (visitorId === undefined) return []
    await recentlyViewed.fold(visitorId, customerId)
    return [expiredVisitorCookie(secure())]
  }
}

export interface RegisterRecentlyViewedRoutesDeps {
  recentlyViewed: RecentlyViewedService
  documentStore: DocumentStoreAdapter
  productRepo: ProductRepository
  /** The config's `events.retentionDays`: the list reaches no further back than the log does. */
  retentionDays: number
  /** Where each product's rating comes from; without it every item is served `rating: null`. */
  reviews?: ReviewsAdapter
  now?: () => Date
  secureCookies?: SecureCookies
}

export function registerRecentlyViewedRoutes(
  adapter: HttpAdapter,
  deps: RegisterRecentlyViewedRoutesDeps,
): void {
  const { recentlyViewed, documentStore, productRepo, retentionDays } = deps
  const now = deps.now ?? (() => new Date())
  const secure = deps.secureCookies ?? (() => false)

  adapter.registerRoute('POST', '/api/recently-viewed', async (ctx) => {
    try {
      const refused = refuseLapsedBearer(ctx)
      if (refused !== undefined) return refused
      const agent = ctx.headers['user-agent']
      if (typeof agent === 'string' && BOT.test(agent)) return { status: 204 }
      const { productId } = ctx.body as { productId: string }
      const customerId = ctx.auth?.userId
      if (customerId !== undefined) {
        await recentlyViewed.record({ kind: 'customer', id: customerId }, productId)
        return { status: 204 }
      }
      const visitorId = visitorOf(ctx) ?? uuidv7()
      const recorded = await recentlyViewed.record({ kind: 'visitor', id: visitorId }, productId)
      return recorded
        ? { status: 204, cookies: [visitorCookie(visitorId, secure())] }
        : { status: 204 }
    } catch (err) {
      return renderError(err, ctx.logger)
    }
  })

  adapter.registerRoute('GET', '/api/recently-viewed', async (ctx) => {
    try {
      const refused = refuseLapsedBearer(ctx)
      if (refused !== undefined) return refused
      const visitorId = visitorOf(ctx)
      const customerId = ctx.auth?.userId
      const viewer =
        customerId !== undefined
          ? viewerKey({ kind: 'customer', id: customerId })
          : visitorId !== undefined
            ? viewerKey({ kind: 'visitor', id: visitorId })
            : null
      const viewed = await readRecentlyViewed(
        { documentStore, repos: { product: productRepo }, retentionDays, now },
        viewer,
      )
      const items = await withRatings(deps.reviews, viewed, ctx.logger)
      return { ...ok({ items }), headers: NOT_STORED } as ResponseEnvelope
    } catch (err) {
      return renderError(err, ctx.logger)
    }
  })
}
