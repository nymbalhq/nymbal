import {
  AuthError,
  type RequestContext,
  type ResponseEnvelope,
  type Role,
  type RouteHandler,
} from '@nymbalhq/types'
import { fail } from './envelope.js'

/** The refusal for a caller who fails a route's gate, or null when the caller passes it. */
export type Gate = (ctx: RequestContext) => ResponseEnvelope | null

const GATE = Symbol('nymbal.route-gate')

type Gated<T> = RouteHandler<T> & { [GATE]?: Gate }

/**
 * The gate a `requireAuth` or `requireRole` handler carries. The route adapters run it before they read any input,
 * so a caller who fails it learns nothing of the params, query, body or key the route expects.
 */
export function gateOf<T>(handler: RouteHandler<T>): Gate | undefined {
  return (handler as Gated<T>)[GATE]
}

/** `handler` carrying `gate`, for a wrapper around a gated handler to pass the gate on. */
export function withGate<T>(handler: RouteHandler<T>, gate: Gate | undefined): RouteHandler<T> {
  if (gate !== undefined) (handler as Gated<T>)[GATE] = gate
  return handler
}

const signedIn: Gate = (ctx) =>
  ctx.auth?.userId ? null : fail('auth.unauthorized', 'Authentication required', 401)

function gated<T>(gate: Gate, handler: RouteHandler<T>): RouteHandler<T> {
  return withGate<T>((ctx) => gate(ctx as RequestContext) ?? handler(ctx), gate)
}

export function requireAuth<T = unknown>(handler: RouteHandler<T>): RouteHandler<T> {
  return gated(signedIn, handler)
}

export function requireRole<T = unknown>(role: Role, handler: RouteHandler<T>): RouteHandler<T> {
  const hasRole: Gate = (ctx) =>
    signedIn(ctx) ??
    (ctx.auth?.roles?.includes(role) ? null : fail('auth.forbidden', `Role required: ${role}`, 403))
  return gated(hasRole, handler)
}

export function asAuthError(ctx: RequestContext): ResponseEnvelope {
  throw new AuthError('unauthorized', 'Authentication required', { context: { path: ctx.path } })
}
