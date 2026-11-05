import type { AdapterBase } from './adapter-base.js'
import type { HttpAdapter } from './http.js'

export type RateLimitAction = 'block' | 'challenge' | 'throttle'

export interface RateLimitRule {
  requests: number
  window: string
  action: RateLimitAction
}

export interface RateLimitDecision {
  allowed: boolean
  retryAfterSeconds?: number
  action: RateLimitAction
}

export interface SecurityConfigLike {
  rateLimit: Record<string, RateLimitRule>
  csrf: boolean
  headers: {
    hsts: boolean
    contentSecurityPolicy: string
    referrerPolicy: string
    xFrameOptions: string
  }
  [key: string]: unknown
}

export interface ValidationResult {
  valid: boolean
  errors: Array<{ code: string; message: string; path?: string }>
}

export interface DriftReport {
  drift: boolean
  differences: Array<{ path: string; configured: unknown; actual: unknown }>
}

export interface SecurityState {
  rulesApplied: string[]
  lastValidatedAt: string
}

/**
 * What a security adapter tells the HTTP layer about the network in front of the store. Each value counts only when the
 * store sets neither its variable nor its config key.
 */
export interface SecurityNetwork {
  /** The proxies whose `X-Forwarded-For` (and client-address header) the API believes: presets, addresses or CIDRs. */
  trustedProxies?: string[]
  /** One header a listed proxy sets to the client's address, such as `CF-Connecting-IP`. */
  clientIpHeader?: string
  /** Whether `clientIpHeader` may be honoured only on a request the origin lock admitted. */
  clientIpRequiresLock?: boolean
}

/** Where a resolved network value came from: the variable, the config key, the adapter's name, or `default`. */
export interface NetworkSource {
  kind: 'env' | 'config' | 'adapter' | 'default'
  name: string
}

/** The network block the HTTP server is built from, resolved once at boot. */
export interface ResolvedNetwork {
  trustedProxies: string[]
  trustedProxiesSource: NetworkSource
  clientIpHeader?: string
  clientIpHeaderSource?: NetworkSource
  clientIpRequiresLock: boolean
  /** Present when `NYMBAL_ORIGIN_SECRET` is set: the header the CDN proves itself in, and the secrets it may send. */
  originLock?: ResolvedOriginLock
}

/** The origin lock, resolved once at boot: every entry is accepted, so a secret can be rotated without downtime. */
export interface ResolvedOriginLock {
  header: string
  secrets: readonly string[]
}

/**
 * Whether the CDN sends the origin secret: `missing` when it has no enabled rule; `present` with the header the rule
 * sets and `entry`, the 0-based index of the secret it sends, or null when it sends none of them.
 */
export type OriginLockRule =
  | { state: 'missing' }
  | { state: 'present'; header: string; entry: number | null }

export interface SecurityAdapter extends AdapterBase {
  applyMiddleware(app: HttpAdapter, config: SecurityConfigLike): Promise<void>
  validate(config: SecurityConfigLike): Promise<ValidationResult>
  drift?(config: SecurityConfigLike): Promise<DriftReport>
  inspect?(): Promise<SecurityState>
  /** The adapter's network settings, offered at boot; synchronous and without I/O. */
  network?(): SecurityNetwork
  /** Whether the CDN in front sends one of the lock's secrets, read from the CDN itself. */
  originLockRule?(lock: ResolvedOriginLock): Promise<OriginLockRule>
}

/** The response headers every security adapter sets in process, from the config's `headers` block. */
export function buildSecurityHeaders(security: SecurityConfigLike): Record<string, string> {
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
