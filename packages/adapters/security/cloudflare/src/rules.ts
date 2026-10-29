/** The entrypoint phases Nymbal writes, in the order `apply` writes them. */
export const PHASES = [
  'http_ratelimit',
  'http_request_firewall_custom',
  'http_request_firewall_managed',
  'http_request_cache_settings',
] as const
export type Phase = (typeof PHASES)[number]

/** A ruleset rule as the Cloudflare v4 API reads and writes it. */
export interface Rule {
  id?: string
  ref?: string
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  ratelimit?: {
    characteristics: string[]
    period: number
    requests_per_period: number
    mitigation_timeout: number
  }
  enabled?: boolean
  [key: string]: unknown
}

export const NYMBAL_REF_PREFIX = 'nymbal:'

export const isNymbalRule = (rule: { ref?: unknown }): boolean =>
  typeof rule.ref === 'string' && rule.ref.startsWith(NYMBAL_REF_PREFIX)

/** Each `rateLimit` window Cloudflare has a period for, in seconds. */
export const WINDOW_PERIODS: Readonly<Record<string, number>> = {
  '10s': 10,
  '1m': 60,
  '2m': 120,
  '5m': 300,
  '10m': 600,
  '1h': 3600,
}

/** Cloudflare's own managed rulesets, by the name `managedRulesets` uses. */
export const MANAGED_RULESET_IDS = {
  cloudflare: 'efb7b8c949ac4650a09736fc376e9aee',
  owasp: '4814384a9e5d4991b9815dcfc25d2f1f',
} as const
export type ManagedRuleset = keyof typeof MANAGED_RULESET_IDS

const MANAGED_NAMES: Readonly<Record<ManagedRuleset, string>> = {
  cloudflare: 'Cloudflare Managed Ruleset',
  owasp: 'Cloudflare OWASP Core Ruleset',
}

export interface RateLimitEntry {
  requests: number
  window: string
  action: 'block' | 'challenge' | 'throttle'
}

export interface CustomRule {
  name: string
  expression: string
  action: 'block' | 'managed_challenge' | 'js_challenge' | 'log'
}

/** The parts of the `security` block the edge rules come from; every one may be absent. */
export interface EdgeRulesConfig {
  rateLimit?: Record<string, RateLimitEntry>
  geo?: { block?: string[] }
  customRules?: CustomRule[]
  managedRulesets?: string[]
}

const quoted = (text: string): string => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * The edge match for an in-process limiter key: exact without `*`, else a wildcard with `**` as `*`. Cloudflare's `*`
 * crosses `/`, so a single `*` matches more at the edge than at the origin (`hasSingleStar`).
 */
export function pathExpression(key: string): string {
  return key.includes('*')
    ? `http.request.uri.path wildcard ${quoted(key.replace(/\*+/g, '*'))}`
    : `http.request.uri.path eq ${quoted(key)}`
}

/** A key with a `*` that is not part of `**`: one segment at the origin, any number at the edge. */
export const hasSingleStar = (key: string): boolean => /(^|[^*])\*([^*]|$)/.test(key)

/** A rate limit key the edge can express: a path. */
export const isEdgePath = (key: string): boolean => key.startsWith('/')

function rateLimitRule(key: string, entry: RateLimitEntry): Rule | undefined {
  const period = WINDOW_PERIODS[entry.window]
  if (!isEdgePath(key) || period === undefined) return undefined
  const [action, mitigationTimeout] =
    entry.action === 'challenge'
      ? ['managed_challenge', 0]
      : entry.action === 'throttle'
        ? ['block', 0]
        : ['block', period]
  return {
    ref: `${NYMBAL_REF_PREFIX}ratelimit:${key}`,
    description: `${NYMBAL_REF_PREFIX} rate limit ${key}`,
    expression: pathExpression(key),
    action,
    ratelimit: {
      characteristics: ['cf.colo.id', 'ip.src'],
      period,
      requests_per_period: entry.requests,
      mitigation_timeout: mitigationTimeout,
    },
    enabled: true,
  }
}

/**
 * The fragment routes' HTML is the same for every shopper and carries its own `s-maxage`, so the edge caches it for
 * the origin's TTLs; Cloudflare caches no HTML without a rule.
 */
const fragmentCacheRule = (): Rule => ({
  ref: `${NYMBAL_REF_PREFIX}cache:fragments`,
  description: `${NYMBAL_REF_PREFIX} cache the fragment routes`,
  expression: 'starts_with(http.request.uri.path, "/fragments/")',
  action: 'set_cache_settings',
  action_parameters: {
    cache: true,
    edge_ttl: { mode: 'respect_origin' },
    browser_ttl: { mode: 'respect_origin' },
  },
  enabled: true,
})

/**
 * The rules the config puts on the zone, by phase, every one carrying a `nymbal:` ref. Rate limits follow their keys'
 * sorted order and custom rules their config order, so the same config always gives the same rules. A key that is not
 * a path, or a window with no Cloudflare period, gives no rule: `validate` reports both.
 */
export function desiredRules(config: EdgeRulesConfig): Record<Phase, Rule[]> {
  const rateLimits = Object.entries(config.rateLimit ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([key, entry]) => rateLimitRule(key, entry) ?? [])

  const custom: Rule[] = []
  const blocked = config.geo?.block ?? []
  if (blocked.length > 0) {
    custom.push({
      ref: `${NYMBAL_REF_PREFIX}geo:block`,
      description: `${NYMBAL_REF_PREFIX} geo block ${blocked.join(' ')}`,
      expression: `ip.src.country in {${blocked.map(quoted).join(' ')}}`,
      action: 'block',
      enabled: true,
    })
  }
  for (const rule of config.customRules ?? []) {
    custom.push({
      ref: `${NYMBAL_REF_PREFIX}custom:${rule.name}`,
      description: `${NYMBAL_REF_PREFIX} ${rule.name}`,
      expression: rule.expression,
      action: rule.action,
      enabled: true,
    })
  }

  const managed = [...new Set(config.managedRulesets ?? [])]
    .filter((name): name is ManagedRuleset => Object.hasOwn(MANAGED_RULESET_IDS, name))
    .map(
      (name): Rule => ({
        ref: `${NYMBAL_REF_PREFIX}managed:${name}`,
        description: `${NYMBAL_REF_PREFIX} ${MANAGED_NAMES[name]}`,
        expression: 'true',
        action: 'execute',
        action_parameters: { id: MANAGED_RULESET_IDS[name] },
        enabled: true,
      }),
    )

  return {
    http_ratelimit: rateLimits,
    http_request_firewall_custom: custom,
    http_request_firewall_managed: managed,
    http_request_cache_settings: [fragmentCacheRule()],
  }
}
