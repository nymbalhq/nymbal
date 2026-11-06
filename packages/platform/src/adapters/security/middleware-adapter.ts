import type {
  HttpAdapter,
  Logger,
  SecurityAdapter,
  SecurityConfigLike,
  ValidationResult,
} from '@nymbalhq/types'
import { buildSecurityHeaders } from './headers.js'
import { noopInitialize, okHealth } from '../base.js'

/**
 * v0.1 security adapter.
 *
 * Rate limiting and CSRF verification need the request before any middleware, so the
 * HTTP adapter runs them itself on every route (`FastifyHttpAdapter`'s guard); only
 * `GET /api/csrf` mints the CSRF cookie. This adapter only asserts
 * static security headers via `HttpAdapter.setDefaultHeaders(...)`. A future
 * WAF-native adapter will replace both layers.
 */
export function createMiddlewareSecurityAdapter(deps: { logger: Logger }): SecurityAdapter {
  const { logger } = deps
  let lastAppliedAt = ''
  return {
    capabilities: () => ['headers'],
    producesEvents: [],
    consumesEvents: [],
    initialize: noopInitialize,
    healthCheck: () => okHealth(),

    async applyMiddleware(app: HttpAdapter, config: SecurityConfigLike): Promise<void> {
      app.setDefaultHeaders(buildSecurityHeaders(config))
      lastAppliedAt = new Date().toISOString()
      logger.debug({ at: lastAppliedAt }, 'security headers attached')
    },

    async validate(_config): Promise<ValidationResult> {
      return { valid: true, errors: [] }
    },

    async inspect() {
      return {
        rulesApplied: ['headers'],
        lastValidatedAt: lastAppliedAt,
      }
    },
  }
}
