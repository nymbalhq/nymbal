import { AuthError, type RequestContext, type ResponseEnvelope, type Role, type RouteHandler } from '@nymbal/types'
import { fail } from './envelope.js'

export function requireAuth<T = unknown>(handler: RouteHandler<T>): RouteHandler<T> {
  return (ctx) => {
    if (!ctx.auth?.userId) {
      return fail('auth.unauthorized', 'Authentication required', 401)
    }
    return handler(ctx)
  }
}

export function requireRole<T = unknown>(role: Role, handler: RouteHandler<T>): RouteHandler<T> {
  return (ctx) => {
    if (!ctx.auth?.userId) {
      return fail('auth.unauthorized', 'Authentication required', 401)
    }
    if (!ctx.auth.roles?.includes(role)) {
      return fail('auth.forbidden', `Role required: ${role}`, 403)
    }
    return handler(ctx)
  }
}

export function asAuthError(ctx: RequestContext): ResponseEnvelope {
  throw new AuthError('unauthorized', 'Authentication required', { context: { path: ctx.path } })
}
