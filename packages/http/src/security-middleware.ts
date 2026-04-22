import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { NymbalConfig } from '@nymbal/config'
import type { RequestContext, ResponseEnvelope, RouteHandler } from '@nymbal/types'
import { RateLimiter } from './rate-limit.js'

export const CSRF_COOKIE = 'nymbal.csrf'
export const CSRF_HEADER = 'x-csrf-token'
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function buildSecurityHeaders(
  security: NymbalConfig['security'],
): Record<string, string> {
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
  wrap(handler: RouteHandler): RouteHandler
  reset(): void
}

export function createSecurityGuard(security: NymbalConfig['security']): SecurityGuard {
  const rateLimiter = new RateLimiter(security.rateLimit)
  const baseHeaders = buildSecurityHeaders(security)

  function applyHeaders(envelope: ResponseEnvelope): ResponseEnvelope {
    return {
      ...envelope,
      headers: { ...baseHeaders, ...(envelope.headers ?? {}) },
    }
  }

  function attachCsrfCookie(envelope: ResponseEnvelope, token: string): ResponseEnvelope {
    const cookies = [
      ...(envelope.cookies ?? []),
      {
        name: CSRF_COOKIE,
        value: token,
        path: '/',
        httpOnly: false,
        sameSite: 'lax' as const,
        secure: process.env.NODE_ENV === 'production',
      },
    ]
    return { ...envelope, cookies }
  }

  return {
    wrap(handler) {
      return async (ctx) => {
        const decision = rateLimiter.check(ctx.ip, ctx.path)
        if (decision && !decision.allowed) {
          return applyHeaders(rateLimitResponse(decision, ctx))
        }

        if (security.csrf && UNSAFE_METHODS.has(ctx.method)) {
          if (!verifyCsrf(ctx)) {
            ctx.logger.warn({ method: ctx.method, path: ctx.path }, 'CSRF validation failed')
            return applyHeaders({
              status: 403,
              body: { error: { code: 'csrf.invalid', message: 'Invalid or missing CSRF token' } },
            })
          }
        }

        const envelope = await handler(ctx)
        let finalEnvelope = applyHeaders(envelope)

        if (security.csrf && !ctx.cookies[CSRF_COOKIE]) {
          finalEnvelope = attachCsrfCookie(finalEnvelope, randomBytes(32).toString('hex'))
        }

        return finalEnvelope
      }
    },
    reset() {
      rateLimiter.reset()
    },
  }
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
  ctx.logger.info(
    { ip: ctx.ip, path: ctx.path, action: decision.action },
    'Rate limit triggered',
  )
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
