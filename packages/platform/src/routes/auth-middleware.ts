import type { MiddlewareHandler } from '@nymbal/types'
import type { AuthService } from '../services/auth-service.js'

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
