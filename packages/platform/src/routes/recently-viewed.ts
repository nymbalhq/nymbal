import { v7 as uuidv7 } from 'uuid'
import {
  AuthError,
  type DocumentStoreAdapter,
  type HttpAdapter,
  type RequestContext,
  type ResponseCookie,
  type ResponseEnvelope,
} from '@nymbalhq/types'
import type { ProductRepository } from '../repositories/product.js'
import {
  readRecentlyViewed,
  RECENT_VIEWS_WINDOW_DAYS,
  viewerKey,
} from '../read-models/recently-viewed.js'
import type { RecentlyViewedService } from '../services/recently-viewed-service.js'
import type { AfterSignIn } from './auth.js'
import { ok, renderError } from './envelope.js'

export const VISITOR_COOKIE = 'nymbal.visitor'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BOT = /bot|crawl|spider|slurp/i
const NOT_STORED = { 'Cache-Control': 'private, no-store' }

function visitorCookie(id: string): ResponseCookie {
  return {
    name: VISITOR_COOKIE,
    value: id,
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: RECENT_VIEWS_WINDOW_DAYS * 86_400,
  }
}

export function expiredVisitorCookie(): ResponseCookie {
  return { name: VISITOR_COOKIE, value: '', path: '/', maxAge: 0, httpOnly: true }
}

/** The request's visitor id, when its cookie holds one; anything but a UUID is no visitor. */
function visitorOf(ctx: RequestContext): string | undefined {
  const id = ctx.cookies[VISITOR_COOKIE]
  return id !== undefined && UUID.test(id) ? id : undefined
}

/**
 * A bearer the auth middleware could not verify (expired, or signed with another secret) is refused rather than read
 * as a guest: the client refreshes and retries as the customer, so a signed-in shopper's views never go to a visitor.
 */
function lapsedBearer(ctx: RequestContext): ResponseEnvelope | undefined {
  if (ctx.headers.authorization === undefined || ctx.auth?.userId !== undefined) return undefined
  return renderError(new AuthError('token_invalid', 'the access token is not valid'))
}

/** The sign-in hook that moves the visitor's views to the customer and ends the visitor. */
export function foldViewsOnSignIn(recentlyViewed: RecentlyViewedService): AfterSignIn {
  return async (ctx, customerId) => {
    const visitorId = visitorOf(ctx)
    if (visitorId === undefined) return []
    await recentlyViewed.fold(visitorId, customerId)
    return [expiredVisitorCookie()]
  }
}

export interface RegisterRecentlyViewedRoutesDeps {
  recentlyViewed: RecentlyViewedService
  documentStore: DocumentStoreAdapter
  productRepo: ProductRepository
  /** The config's `events.retentionDays`: the list reaches no further back than the log does. */
  retentionDays: number
  now?: () => Date
}

export function registerRecentlyViewedRoutes(
  adapter: HttpAdapter,
  deps: RegisterRecentlyViewedRoutesDeps,
): void {
  const { recentlyViewed, documentStore, productRepo, retentionDays } = deps
  const now = deps.now ?? (() => new Date())

  adapter.registerRoute('POST', '/api/recently-viewed', async (ctx) => {
    try {
      const refused = lapsedBearer(ctx)
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
      return recorded ? { status: 204, cookies: [visitorCookie(visitorId)] } : { status: 204 }
    } catch (err) {
      return renderError(err)
    }
  })

  adapter.registerRoute('GET', '/api/recently-viewed', async (ctx) => {
    try {
      const refused = lapsedBearer(ctx)
      if (refused !== undefined) return refused
      const visitorId = visitorOf(ctx)
      const customerId = ctx.auth?.userId
      const viewer =
        customerId !== undefined
          ? viewerKey({ kind: 'customer', id: customerId })
          : visitorId !== undefined
            ? viewerKey({ kind: 'visitor', id: visitorId })
            : null
      const items = await readRecentlyViewed(
        { documentStore, repos: { product: productRepo }, retentionDays, now },
        viewer,
      )
      return { ...ok({ items }), headers: NOT_STORED } as ResponseEnvelope
    } catch (err) {
      return renderError(err)
    }
  })
}
