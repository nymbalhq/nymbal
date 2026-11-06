import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  SHOPPER_ATTESTATION_HEADER,
  type RequestContext,
  type ResponseCookie,
  type ResponseEnvelope,
  type RouteOptions,
} from '@nymbalhq/types'
import { BUILT_IN_RATE_LIMITS, CHECKOUT_ADDRESS_CEILING, RateLimiter } from './rate-limit.js'
import type { ShopperAttestation } from './shopper-attestation.js'

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
  /**
   * Runs on the handler's answer: security headers and the outcome of a failure-counted login. It sets no CSRF
   * cookie: parallel first requests would each mint a different one, and the browser would keep whichever came last.
   */
  finish(ctx: RequestContext, envelope: ResponseEnvelope): ResponseEnvelope
  /** `GET /api/csrf`, the only answer that sets the CSRF cookie: the request's own, or a new one set on the response. */
  issueToken(ctx: RequestContext): ResponseEnvelope
  /** The rate-limit buckets held: what a client's requests can make the guard keep. */
  bucketCount(): number
  reset(): void
}

/**
 * Counts failures only. The address bucket refuses; the account count never does, so failures from elsewhere cannot
 * lock an owner out, and reaching the rule's count logs one warn per window for the operator instead.
 */
const LOGIN_PATH = '/api/auth/login'
const CHECKOUT_PATH = '/api/checkout'
const CART_COOKIE = 'nymbal.cart'

function csrfCookie(token: string, secure: boolean): ResponseCookie {
  return {
    name: CSRF_COOKIE,
    value: token,
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure,
  }
}

/** The lowercased email of a login, or null when the body names none. */
function loginAccount(ctx: RequestContext): string | null {
  const email = (ctx.body as { email?: unknown } | undefined)?.email
  return typeof email === 'string' && email !== '' ? email.toLowerCase() : null
}

/**
 * A checkout's two buckets: the (address, cart) pair at the rule's count and the address at the ceiling. The cart
 * enters the key as a fixed-length digest, so a cookie's length never reaches the limiter.
 */
export function checkoutKeys(
  ctx: RequestContext,
  ip: string = ctx.ip,
): { pair: string; address: string } {
  const cart = ctx.cookies[CART_COOKIE]
  const digest = cart ? createHash('sha256').update(cart).digest('hex').slice(0, 32) : ''
  return { pair: `${ip}|cart:${digest}`, address: ip }
}

function isLogin(ctx: RequestContext): boolean {
  return ctx.method === 'POST' && ctx.path === LOGIN_PATH
}

function isCheckout(ctx: RequestContext): boolean {
  return ctx.method === 'POST' && ctx.path === CHECKOUT_PATH
}

export interface SecurityGuardOptions {
  /** Verifies the storefront forward's `x-nymbal-shopper`: a verified address is the limiter's key for the request. */
  attestation?: ShopperAttestation
  /** Whether the CSRF cookie carries `Secure` (`secureCookies(config, env)` in `@nymbalhq/config`). */
  secureCookies?: boolean
}

export function createSecurityGuard(
  security: NymbalConfig['security'],
  options: SecurityGuardOptions = {},
): SecurityGuard {
  const rateLimiter = new RateLimiter({ ...BUILT_IN_RATE_LIMITS, ...security.rateLimit })
  const { attestation, secureCookies = false } = options

  /** The shopper's address the storefront forward attested, or the request's own; a token that fails is ignored. */
  function clientIp(ctx: RequestContext): string {
    return attestation?.verify(ctx.headers[SHOPPER_ATTESTATION_HEADER]) ?? ctx.ip
  }

  /** The address bucket first: a request it refuses opens no cart bucket. */
  function checkCheckout(ctx: RequestContext, ip: string) {
    const keys = checkoutKeys(ctx, ip)
    const address = rateLimiter.check(keys.address, ctx.path, ctx.headers, CHECKOUT_ADDRESS_CEILING)
    if (address && !address.allowed) return address
    return rateLimiter.check(keys.pair, ctx.path, ctx.headers)
  }

  const baseHeaders = buildSecurityHeaders(security)

  function applyHeaders(envelope: ResponseEnvelope): ResponseEnvelope {
    return {
      ...envelope,
      headers: { ...baseHeaders, ...(envelope.headers ?? {}) },
    }
  }

  return {
    admit(ctx, options = {}) {
      const ip = clientIp(ctx)
      const decision = isLogin(ctx)
        ? rateLimiter.full(ctx.path, [ip])
        : isCheckout(ctx)
          ? checkCheckout(ctx, ip)
          : rateLimiter.check(ip, ctx.path, ctx.headers)
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
        const account = loginAccount(ctx)
        const accountKey = account === null ? [] : [`account:${account}`]
        // Success clears the account only: the address bucket expires with its window, so logging in to one's own
        // account cannot reset a spray across other accounts.
        if (envelope.status >= 200 && envelope.status < 300) {
          rateLimiter.clear(ctx.path, accountKey)
        } else {
          const [, failures] = rateLimiter.hit(ctx.path, [clientIp(ctx), ...accountKey])
          if (failures !== undefined && failures === rateLimiter.requests(ctx.path)) {
            ctx.logger.warn(
              { account, failures, path: ctx.path },
              'Failed logins for one account reached the login limit; it is not locked, each address is',
            )
          }
        }
      }
      return applyHeaders(envelope)
    },

    issueToken(ctx) {
      const existing = ctx.cookies[CSRF_COOKIE]
      if (existing) return { status: 200, body: { data: { token: existing } } }
      const token = newToken()
      return { status: 200, body: { data: { token } }, cookies: [csrfCookie(token, secureCookies)] }
    },

    bucketCount() {
      return rateLimiter.size
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
