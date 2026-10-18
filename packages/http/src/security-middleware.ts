import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { NymbalConfig } from '@nymbalhq/config'
import type {
  RequestContext,
  ResponseCookie,
  ResponseEnvelope,
  RouteOptions,
} from '@nymbalhq/types'
import { BUILT_IN_RATE_LIMITS, RateLimiter } from './rate-limit.js'

export const CSRF_COOKIE = 'nymbal.csrf'
export const CSRF_HEADER = 'x-csrf-token'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function buildSecurityHeaders(security: NymbalConfig['security']): Record<string, string> {
  const headers: Record<string, string> = {}
  if (security.headers.hsts) {
    headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains'
  }
  const csp = security.headers.contentSecurityPolicy
  const cspValue =
    csp === 'strict'
      ? "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
      : csp === 'relaxed'
        ? "default-src 'self' https:; img-src * data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
        : csp === 'off'
          ? null
          : csp
  if (cspValue) headers['content-security-policy'] = cspValue
  headers['referrer-policy'] = security.headers.referrerPolicy
  headers['x-frame-options'] = security.headers.xFrameOptions === 'deny' ? 'DENY' : 'SAMEORIGIN'
  headers['x-content-type-options'] = 'nosniff'
  return headers
}

export interface SecurityGuard {
  /**
   * Runs before any middleware or handler: the rate limit, then CSRF on unsafe methods unless the route opted out.
   * Returns the refusal, or null when the request may proceed.
   */
  admit(ctx: RequestContext, options?: RouteOptions): ResponseEnvelope | null
  /** Runs on the handler's answer: security headers, the CSRF cookie, and the outcome of a failure-counted login. */
  finish(ctx: RequestContext, envelope: ResponseEnvelope): ResponseEnvelope
  /** `GET /api/csrf`: the request's CSRF cookie, or a new one set on the response. */
  issueToken(ctx: RequestContext): ResponseEnvelope
  reset(): void
}

/** Counts failures only, keyed by IP and by account, so an office behind one NAT is not blocked by its own logins. */
const LOGIN_PATH = '/api/auth/login'

function csrfCookie(token: string): ResponseCookie {
  return {
    name: CSRF_COOKIE,
    value: token,
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  }
}

function loginKeys(ctx: RequestContext): string[] {
  const email = (ctx.body as { email?: unknown } | undefined)?.email
  return typeof email === 'string' && email !== ''
    ? [ctx.ip, `account:${email.toLowerCase()}`]
    : [ctx.ip]
}

function isLogin(ctx: RequestContext): boolean {
  return ctx.method === 'POST' && ctx.path === LOGIN_PATH
}

export function createSecurityGuard(security: NymbalConfig['security']): SecurityGuard {
  const rateLimiter = new RateLimiter({ ...BUILT_IN_RATE_LIMITS, ...security.rateLimit })
  const baseHeaders = buildSecurityHeaders(security)

  function applyHeaders(envelope: ResponseEnvelope): ResponseEnvelope {
    return {
      ...envelope,
      headers: { ...baseHeaders, ...(envelope.headers ?? {}) },
    }
  }

  return {
    admit(ctx, options = {}) {
      const decision = isLogin(ctx)
        ? rateLimiter.full(ctx.path, loginKeys(ctx))
        : rateLimiter.check(ctx.ip, ctx.path)
      if (decision && !decision.allowed) {
        return applyHeaders(rateLimitResponse(decision, ctx))
      }

      if (security.csrf && options.csrf !== false && UNSAFE_METHODS.has(ctx.method)) {
        if (!verifyCsrf(ctx)) {
          ctx.logger.warn({ method: ctx.method, path: ctx.path }, 'CSRF validation failed')
          return applyHeaders({
            status: 403,
            body: { error: { code: 'csrf.invalid', message: 'Invalid or missing CSRF token' } },
          })
        }
      }
      return null
    },

    finish(ctx, envelope) {
      if (isLogin(ctx)) {
        const keys = loginKeys(ctx)
        if (envelope.status >= 200 && envelope.status < 300) rateLimiter.clear(ctx.path, keys)
        else rateLimiter.hit(ctx.path, keys)
      }
      const finished = applyHeaders(envelope)
      const setsCsrf = finished.cookies?.some((cookie) => cookie.name === CSRF_COOKIE) ?? false
      if (security.csrf && !ctx.cookies[CSRF_COOKIE] && !setsCsrf) {
        finished.cookies = [...(finished.cookies ?? []), csrfCookie(newToken())]
      }
      return finished
    },

    issueToken(ctx) {
      const existing = ctx.cookies[CSRF_COOKIE]
      if (existing) return { status: 200, body: { data: { token: existing } } }
      const token = newToken()
      return { status: 200, body: { data: { token } }, cookies: [csrfCookie(token)] }
    },

    reset() {
      rateLimiter.reset()
    },
  }
}

function newToken(): string {
  return randomBytes(32).toString('hex')
}

function verifyCsrf(ctx: RequestContext): boolean {
  const cookieToken = ctx.cookies[CSRF_COOKIE]
  const rawHeader = ctx.headers[CSRF_HEADER]
  const headerToken = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader
  if (!cookieToken || !headerToken) return false
  if (cookieToken.length !== headerToken.length) return false
  try {
    return timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))
  } catch {
    return false
  }
}

function rateLimitResponse(
  decision: { action: string; retryAfter?: number },
  ctx: RequestContext,
): ResponseEnvelope {
  ctx.logger.info({ ip: ctx.ip, path: ctx.path, action: decision.action }, 'Rate limit triggered')
  const status = decision.action === 'challenge' ? 403 : 429
  const headers: Record<string, string> = {}
  if (decision.retryAfter) headers['retry-after'] = String(decision.retryAfter)
  return {
    status,
    headers,
    body: {
      error: {
        code: `rate_limit.${decision.action}`,
        message: 'Too many requests',
        ...(decision.retryAfter !== undefined && { retryAfter: decision.retryAfter }),
      },
    },
  }
}
