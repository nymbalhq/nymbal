import { ConfigError, type AdapterContext } from '@nymbalhq/types'
import { createCloudflareSecurityAdapter, type CloudflareSecurityAdapter } from './adapter.js'
import type { CloudflareConnection } from './client.js'

const ORIGIN_SECRET_ENV = 'NYMBAL_ORIGIN_SECRET'

/** What this package serves: the kernel refuses it on any other slot or provider. */
export const slot = 'security'
export const provider = 'cloudflare'

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
  CREDENTIALS_HINT,
  DEFAULT_API_BASE,
  REQUEST_TIMEOUT_MS,
  type CloudflareConnection,
  type CloudflareIps,
} from './client.js'
export { CLOUDFLARE_IPS } from './ips.js'
export {
  desiredRules,
  hasSingleStar,
  isNymbalRule,
  MANAGED_RULESET_IDS,
  ORIGIN_LOCK_REF,
  PHASES,
  WINDOW_PERIODS,
  type DesiredRules,
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
  // The rule sends the first entry: during a rotation the new secret, which the host already accepts.
  const originSecret = (ctx.env[ORIGIN_SECRET_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .find((entry) => entry !== '')
  return createCloudflareSecurityAdapter({
    connection: ctx.config as CloudflareConnection,
    logger: ctx.logger,
    ...(originSecret !== undefined && { originSecret }),
  })
}
