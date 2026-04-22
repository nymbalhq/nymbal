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

export interface SecurityAdapter extends AdapterBase {
  applyMiddleware(app: HttpAdapter, config: SecurityConfigLike): Promise<void>
  validate(config: SecurityConfigLike): Promise<ValidationResult>
  drift?(config: SecurityConfigLike): Promise<DriftReport>
  inspect?(): Promise<SecurityState>
}
