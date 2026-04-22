import type { RequestContext, ResponseEnvelope } from './http.js'

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

export interface SecurityAdapter {
  applyHeaders(ctx: RequestContext, envelope: ResponseEnvelope): ResponseEnvelope
  enforceRateLimit(ctx: RequestContext): Promise<RateLimitDecision>
  issueCsrfToken(ctx: RequestContext): string
  verifyCsrf(ctx: RequestContext): boolean
}
