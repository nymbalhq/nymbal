import type {
  HttpAdapter,
  Logger,
  SecurityAdapter,
  SecurityConfigLike,
  ValidationResult,
} from '@nymbal/types'
import { buildSecurityHeaders } from './headers.js'
import { noopInitialize, okHealth } from '../base.js'

/**
 * v0.1 security adapter.
 *
 * CSRF cookie minting requires response-phase mutation, which
 * `HttpAdapter.registerMiddleware` does not currently support. To keep behaviour
 * identical to Prompt 1, the `@nymbal/http` server facade (`createHttpServer`)
 * continues to wrap each route handler with a `SecurityGuard` that handles
 * rate-limit + CSRF verification + header injection + cookie minting.
 *
 * This adapter therefore only asserts static security headers via
 * `HttpAdapter.setDefaultHeaders(...)`. Request-side rate-limit and CSRF
 * are still applied by the server facade. A future v1.0 WAF-native adapter
 * will replace both layers.
 */
export function createMiddlewareSecurityAdapter(deps: { logger: Logger }): SecurityAdapter {
  const { logger } = deps
  let lastAppliedAt = ''
  return {
    capabilities: ['headers'],
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
