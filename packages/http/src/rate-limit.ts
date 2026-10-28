import type { RateLimitAction } from '@nymbalhq/types'

export interface ParsedRule {
  pattern: string
  regex: RegExp
  requests: number
  windowMs: number
  action: RateLimitAction
}

export interface RateLimitDecision {
  allowed: boolean
  action: RateLimitAction
  retryAfter?: number
}

type RateLimitRules = Record<string, { requests: number; window: string; action: RateLimitAction }>

/**
 * Applied under the configured rules: a configured key with the same pattern replaces its default, and the defaults
 * stay when other keys are configured.
 */
export const BUILT_IN_RATE_LIMITS: RateLimitRules = {
  '/api/auth/login': { requests: 10, window: '15m', action: 'block' },
  '/api/auth/register': { requests: 10, window: '1h', action: 'block' },
  // A record and a list per page view: 300 page views a minute, so shoppers behind one NAT keep their views.
  '/api/recently-viewed': { requests: 600, window: '1m', action: 'block' },
  // Each accepted subscribe mails a confirmation: the bound on how much mail one IP can make the store send.
  '/api/alerts/subscribe': { requests: 10, window: '1h', action: 'block' },
}

interface Bucket {
  count: number
  resetAt: number
}

/** The map size that triggers the first sweep of expired buckets. */
const PRUNE_THRESHOLD = 1024

export class RateLimiter {
  readonly #rules: ParsedRule[]
  readonly #buckets = new Map<string, Bucket>()
  #pruneAt = PRUNE_THRESHOLD

  constructor(rules: RateLimitRules) {
    this.#rules = Object.entries(rules).map(([pattern, rule]) => ({
      pattern,
      regex: compilePathPattern(pattern),
      requests: rule.requests,
      windowMs: parseWindow(rule.window),
      action: rule.action,
    }))
  }

  check(ip: string, path: string): RateLimitDecision | null {
    const rule = this.#ruleFor(path)
    if (!rule) return null
    const key = `${rule.pattern}|${ip}`
    const now = Date.now()
    const bucket = this.#buckets.get(key)
    if (!bucket || bucket.resetAt <= now) {
      this.#open(key, now, rule.windowMs)
      return { allowed: true, action: rule.action }
    }
    bucket.count += 1
    if (bucket.count > rule.requests) {
      return { allowed: false, action: rule.action, retryAfter: retryAfter(bucket, now) }
    }
    return { allowed: true, action: rule.action }
  }

  /**
   * For a route that counts failures only: refuses when any of `keys` (an IP, an account) already holds the rule's
   * full count, without counting this request. `hit` and `clear` record the outcome once the handler has answered.
   */
  full(path: string, keys: string[]): RateLimitDecision | null {
    const rule = this.#ruleFor(path)
    if (!rule) return null
    const now = Date.now()
    for (const key of keys) {
      const bucket = this.#buckets.get(`${rule.pattern}|${key}`)
      if (bucket && bucket.resetAt > now && bucket.count >= rule.requests) {
        return { allowed: false, action: rule.action, retryAfter: retryAfter(bucket, now) }
      }
    }
    return { allowed: true, action: rule.action }
  }

  hit(path: string, keys: string[]): void {
    const rule = this.#ruleFor(path)
    if (!rule) return
    const now = Date.now()
    for (const key of keys) {
      const bucketKey = `${rule.pattern}|${key}`
      const bucket = this.#buckets.get(bucketKey)
      if (!bucket || bucket.resetAt <= now) {
        this.#open(bucketKey, now, rule.windowMs)
      } else {
        bucket.count += 1
      }
    }
  }

  clear(path: string, keys: string[]): void {
    const rule = this.#ruleFor(path)
    if (!rule) return
    for (const key of keys) this.#buckets.delete(`${rule.pattern}|${key}`)
  }

  reset(): void {
    this.#buckets.clear()
    this.#pruneAt = PRUNE_THRESHOLD
  }

  /**
   * Starts a bucket. Keys include caller-chosen values (an account email), so expired buckets are swept once the map
   * reaches `#pruneAt`; the next sweep waits until the map doubles past what survived, which keeps the cost amortised
   * constant per insert even when every bucket is live.
   */
  #open(key: string, now: number, windowMs: number): void {
    if (this.#buckets.size >= this.#pruneAt) {
      for (const [k, b] of this.#buckets) if (b.resetAt <= now) this.#buckets.delete(k)
      this.#pruneAt = Math.max(PRUNE_THRESHOLD, this.#buckets.size * 2)
    }
    this.#buckets.set(key, { count: 1, resetAt: now + windowMs })
  }

  #ruleFor(path: string): ParsedRule | undefined {
    return this.#rules.find((r) => r.regex.test(path))
  }
}

function retryAfter(bucket: Bucket, now: number): number {
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
}

function parseWindow(window: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(window)
  if (!match) throw new Error(`Invalid rate-limit window: ${window}`)
  const n = Number(match[1])
  switch (match[2]) {
    case 'ms':
      return n
    case 's':
      return n * 1000
    case 'm':
      return n * 60_000
    case 'h':
      return n * 3_600_000
    default:
      throw new Error(`Unreachable unit: ${match[2]}`)
  }
}

function compilePathPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]+')
    .replace(/__DOUBLESTAR__/g, '.*')
  return new RegExp(`^${escaped}$`)
}
