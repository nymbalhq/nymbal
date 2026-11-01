import {
  AuthError,
  type MiddlewareHandler,
  type RequestContext,
  type ResponseEnvelope,
} from '@nymbalhq/types'
import type { AuthService } from '../services/auth-service.js'
import { renderError } from './envelope.js'

/**
 * Non-blocking: decodes a bearer token if present and populates ctx.auth.
 * Downstream routes that require auth should use `requireAuth` or `requireRole`.
 */
export function createAuthMiddleware(auth: AuthService): MiddlewareHandler {
  return async (ctx) => {
    const raw = ctx.headers.authorization
    const header = Array.isArray(raw) ? raw[0] : raw
    if (!header || !header.toLowerCase().startsWith('bearer ')) return
    const token = header.slice('bearer '.length).trim()
    try {
      const payload = await auth.verifyAccessToken(token)
      ctx.auth = {
        userId: payload.sub,
        roles: payload.roles,
        token,
      }
    } catch {
      // silently ignore — endpoints may still succeed for anonymous users
    }
    return
  }
}

/**
 * A bearer the auth middleware could not verify (expired, or signed with another secret), refused rather than read as
 * a guest: the client refreshes and retries as the customer, so a signed-in shopper never acts as a visitor.
 */
export function refuseLapsedBearer(ctx: RequestContext): ResponseEnvelope | undefined {
  if (ctx.headers.authorization === undefined || ctx.auth?.userId !== undefined) return undefined
  return renderError(new AuthError('token_invalid', 'the access token is not valid'))
}
