import { ConfigError, type AdapterContext } from '@nymbalhq/types'
import { createCloudflareSecurityAdapter, type CloudflareSecurityAdapter } from './adapter.js'
import type { CloudflareConnection } from './client.js'

export {
  createCloudflareSecurityAdapter,
  isEmptyPlan,
  PLAN_LIMITS,
  type CloudflareSecurityAdapter,
  type PhasePlan,
  type Plan,
  type SecurityPlan,
} from './adapter.js'
export {
  CloudflareCredentialsError,
  DEFAULT_API_BASE,
  REQUEST_TIMEOUT_MS,
  type CloudflareConnection,
} from './client.js'
export {
  desiredRules,
  hasSingleStar,
  isNymbalRule,
  MANAGED_RULESET_IDS,
  PHASES,
  WINDOW_PERIODS,
  type EdgeRulesConfig,
  type Phase,
  type Rule,
} from './rules.js'

/** The kernel's entry: `security: { adapter: 'cloudflare', cloudflare: CloudflareConnection }`. */
export function createAdapter(ctx: AdapterContext): CloudflareSecurityAdapter {
  if (ctx.slot !== 'security') {
    throw new ConfigError(`@nymbalhq/security-cloudflare serves security, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  return createCloudflareSecurityAdapter({
    connection: ctx.config as CloudflareConnection,
    logger: ctx.logger,
  })
}
