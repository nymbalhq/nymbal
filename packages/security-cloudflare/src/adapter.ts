import {
  AdapterError,
  boundedHealthCheck,
  buildSecurityHeaders,
  errorText,
  type DriftReport,
  type HttpAdapter,
  type Logger,
  type SecurityAdapter,
  type SecurityConfigLike,
  type SecurityState,
  type ValidationResult,
} from '@nymbalhq/types'
import {
  CloudflareCredentialsError,
  createClient,
  hasCredentials,
  type CloudflareClient,
  type CloudflareConnection,
} from './client.js'
import {
  PHASES,
  WINDOW_PERIODS,
  desiredRules,
  isEdgePath,
  isNymbalRule,
  type EdgeRulesConfig,
  type Phase,
  type Rule,
} from './rules.js'

export type Plan = 'free' | 'pro' | 'business' | 'enterprise'

/** What each plan allows; every limit counts every rule in the phase, the zone owner's included. */
export const PLAN_LIMITS: Readonly<
  Record<
    Plan,
    {
      rateLimitRules: number
      periods: readonly number[]
      customRules: number
      managedRulesets: boolean
    }
  >
> = {
  free: { rateLimitRules: 1, periods: [10], customRules: 5, managedRulesets: false },
  pro: { rateLimitRules: 2, periods: [10, 60], customRules: 20, managedRulesets: true },
  business: {
    rateLimitRules: 5,
    periods: [10, 60, 120, 300, 600],
    customRules: 100,
    managedRulesets: true,
  },
  enterprise: {
    rateLimitRules: 100,
    periods: [10, 60, 120, 300, 600, 3600],
    customRules: 1000,
    managedRulesets: true,
  },
}

const isPlan = (value: unknown): value is Plan =>
  typeof value === 'string' && Object.hasOwn(PLAN_LIMITS, value)

export interface PhasePlan {
  phase: Phase
  add: Rule[]
  change: Array<{ ref: string; from: Rule; to: Rule }>
  remove: Rule[]
}

/** What `apply` would change (from `plan`) or changed (from `apply`), phase by phase. */
export interface SecurityPlan {
  phases: PhasePlan[]
}

export const isEmptyPlan = (plan: SecurityPlan): boolean =>
  plan.phases.every((p) => p.add.length + p.change.length + p.remove.length === 0)

export interface CloudflareSecurityAdapter extends SecurityAdapter {
  drift(config: SecurityConfigLike): Promise<DriftReport>
  inspect(): Promise<SecurityState>
  plan(config: SecurityConfigLike): Promise<SecurityPlan>
  /** Writes each phase whose Nymbal rules differ, one by one; it rejects at the first refused write. */
  apply(config: SecurityConfigLike): Promise<SecurityPlan>
}

/** `desired` holds in `live`: every field `desired` sets, at any depth, has the same value there. */
function holds(desired: unknown, live: unknown): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(live) &&
      live.length === desired.length &&
      desired.every((d, i) => holds(d, live[i]))
    )
  }
  if (typeof desired === 'object' && desired !== null) {
    if (typeof live !== 'object' || live === null) return false
    return Object.entries(desired).every(([k, v]) => holds(v, (live as Record<string, unknown>)[k]))
  }
  return desired === live
}

/** The fields of `desired` that `live` does not hold. */
const changedFields = (desired: Rule, live: Rule): string[] =>
  Object.keys(desired).filter((field) => !holds(desired[field], live[field]))

function byRef(rules: readonly Rule[]): Map<string, Rule> {
  return new Map(rules.filter(isNymbalRule).map((r) => [r.ref as string, r]))
}

function diffPhase(phase: Phase, live: readonly Rule[], desired: readonly Rule[]): PhasePlan {
  const current = byRef(live)
  const wanted = byRef(desired)
  const plan: PhasePlan = { phase, add: [], change: [], remove: [] }
  for (const [ref, to] of wanted) {
    const from = current.get(ref)
    if (from === undefined) plan.add.push(to)
    else if (changedFields(to, from).length > 0) plan.change.push({ ref, from, to })
  }
  for (const [ref, rule] of current) if (!wanted.has(ref)) plan.remove.push(rule)
  return plan
}

/** The rules to PUT: the zone's own, in their order, then Nymbal's, each keeping the id Cloudflare gave it. */
function nextRules(live: readonly Rule[], desired: readonly Rule[]): Rule[] {
  const ids = new Map(live.filter(isNymbalRule).map((r) => [r.ref as string, r.id] as const))
  const own = live
    .filter((r) => !isNymbalRule(r))
    .map(({ version: _version, last_updated: _updated, ...rule }) => rule as Rule)
  const ours = desired.map((rule) => {
    const id = ids.get(rule.ref as string)
    return id === undefined ? rule : { ...rule, id }
  })
  return [...own, ...ours]
}

export function createCloudflareSecurityAdapter(deps: {
  connection: CloudflareConnection
  logger: Logger
}): CloudflareSecurityAdapter {
  const { connection, logger } = deps
  const client: CloudflareClient = createClient(connection)
  let lastValidatedAt = ''

  const livePhases = async (): Promise<Record<Phase, Rule[]>> => {
    const read = await Promise.all(PHASES.map((phase) => client.entrypoint(phase)))
    return Object.fromEntries(PHASES.map((phase, i) => [phase, read[i] ?? []])) as Record<
      Phase,
      Rule[]
    >
  }

  const desiredOf = (config: SecurityConfigLike) => desiredRules(config as EdgeRulesConfig)

  /** Errors a config has whatever the zone: keys, windows and geo codes. */
  function configErrors(config: EdgeRulesConfig): ValidationResult['errors'] {
    const errors: ValidationResult['errors'] = []
    for (const [key, entry] of Object.entries(config.rateLimit ?? {})) {
      if (!isEdgePath(key)) {
        errors.push({
          code: 'cloudflare.path',
          path: `rateLimit.${key}`,
          message: `rate limit key '${key}' is not a path (it must start with /), so it has no edge rule`,
        })
      }
      if (WINDOW_PERIODS[entry.window] === undefined) {
        errors.push({
          code: 'cloudflare.period',
          path: `rateLimit.${key}.window`,
          message: `window '${entry.window}' has no Cloudflare period; use one of ${Object.keys(WINDOW_PERIODS).join(', ')}`,
        })
      }
    }
    for (const code of config.geo?.block ?? []) {
      if (!/^[A-Z]{2}$/.test(code)) {
        errors.push({
          code: 'cloudflare.geo',
          path: 'geo.block',
          message: `'${code}' is not an ISO 3166 alpha-2 country code (two capital letters)`,
        })
      }
    }
    return errors
  }

  /** Errors the zone's plan and its own rules give the config. */
  function planErrors(
    plan: Plan,
    config: EdgeRulesConfig,
    live: Record<Phase, Rule[]>,
  ): ValidationResult['errors'] {
    const limits = PLAN_LIMITS[plan]
    const errors: ValidationResult['errors'] = []
    for (const [key, entry] of Object.entries(config.rateLimit ?? {})) {
      const period = WINDOW_PERIODS[entry.window]
      if (period !== undefined && !limits.periods.includes(period)) {
        errors.push({
          code: 'cloudflare.period',
          path: `rateLimit.${key}.window`,
          message: `window '${entry.window}' is not allowed on the ${plan} plan; it allows periods of ${limits.periods.join(', ')} s`,
        })
      }
      if (entry.action === 'throttle' && plan !== 'enterprise') {
        errors.push({
          code: 'cloudflare.action',
          path: `rateLimit.${key}.action`,
          message: `throttle needs the enterprise plan; the zone is on the ${plan} plan (use block or challenge)`,
        })
      }
    }
    const desired = desiredRules(config)
    const counted: Array<[Phase, number, string]> = [
      ['http_ratelimit', limits.rateLimitRules, 'rate limiting rules'],
      ['http_request_firewall_custom', limits.customRules, 'custom rules'],
    ]
    for (const [phase, limit, what] of counted) {
      const own = live[phase].filter((r) => !isNymbalRule(r)).length
      const total = own + desired[phase].length
      if (total > limit) {
        errors.push({
          code: 'cloudflare.plan-limit',
          path: phase,
          message: `${phase} would hold ${total} ${what} (${own} of the zone's own, ${desired[phase].length} of Nymbal's); the ${plan} plan allows ${limit}`,
        })
      }
    }
    if (!limits.managedRulesets && desired.http_request_firewall_managed.length > 0) {
      errors.push({
        code: 'cloudflare.plan-limit',
        path: 'managedRulesets',
        message: `managed rulesets need the pro plan or above; the zone is on the ${plan} plan`,
      })
    }
    return errors
  }

  async function plan(config: SecurityConfigLike): Promise<SecurityPlan> {
    const live = await livePhases()
    const desired = desiredOf(config)
    return { phases: PHASES.map((phase) => diffPhase(phase, live[phase], desired[phase])) }
  }

  return {
    capabilities: () => ['headers', 'edge-rules'],
    producesEvents: [],
    consumesEvents: [],

    // Boot makes no request: the zone changes only by `nymbal security:apply`.
    initialize: () => Promise.resolve(),

    healthCheck() {
      return boundedHealthCheck(async () => {
        const zone = await client.zone()
        const plan = zone.plan?.legacy_id ?? 'unknown'
        return { status: 'healthy', detail: `zone ${zone.name ?? zone.id} on the ${plan} plan` }
      })
    },

    async applyMiddleware(app: HttpAdapter, config: SecurityConfigLike): Promise<void> {
      app.setDefaultHeaders(buildSecurityHeaders(config))
      logger.debug({}, 'security headers attached')
    },

    async validate(config: SecurityConfigLike): Promise<ValidationResult> {
      const edge = config as EdgeRulesConfig
      if (!hasCredentials(connection)) {
        const missing = [
          ...(connection.zoneId ? [] : ['zoneId']),
          ...(connection.apiToken ? [] : ['apiToken']),
        ]
        return {
          valid: false,
          errors: [
            {
              code: 'cloudflare.credentials',
              path: 'cloudflare',
              message: `security.cloudflare has no ${missing.join(' or ')} (CLOUDFLARE_ZONE_ID, CLOUDFLARE_API_TOKEN)`,
            },
          ],
        }
      }
      const errors = configErrors(edge)
      try {
        const zone = await client.zone()
        const plan = zone.plan?.legacy_id
        if (!isPlan(plan)) {
          errors.push({
            code: 'cloudflare.plan-limit',
            message: `the zone's plan '${String(plan)}' is not one Nymbal knows the limits of (free, pro, business, enterprise)`,
          })
        } else {
          errors.push(...planErrors(plan, edge, await livePhases()))
        }
      } catch (error) {
        if (!(error instanceof CloudflareCredentialsError)) throw error
        errors.push({ code: 'cloudflare.credentials', message: error.message })
      }
      lastValidatedAt = new Date().toISOString()
      return { valid: errors.length === 0, errors }
    },

    plan,

    async apply(config: SecurityConfigLike): Promise<SecurityPlan> {
      const desired = desiredOf(config)
      const written: PhasePlan[] = []
      for (const phase of PHASES) {
        const live = await client.entrypoint(phase)
        const change = diffPhase(phase, live ?? [], desired[phase])
        if (change.add.length + change.change.length + change.remove.length === 0) continue
        try {
          await client.putEntrypoint(phase, nextRules(live ?? [], desired[phase]))
        } catch (error) {
          const done = written.map((p) => p.phase)
          throw new AdapterError(
            'cloudflare_apply',
            `writing ${phase} failed after ${done.length === 0 ? 'no phase' : done.join(', ')} was written: ${errorText(error)}`,
            { cause: error, context: { failed: phase, written: done } },
          )
        }
        logger.info(
          {
            phase,
            added: change.add.length,
            changed: change.change.length,
            removed: change.remove.length,
          },
          `wrote ${phase}`,
        )
        written.push(change)
      }
      return { phases: written }
    },

    async drift(config: SecurityConfigLike): Promise<DriftReport> {
      const live = await livePhases()
      const desired = desiredOf(config)
      const differences: DriftReport['differences'] = []
      for (const phase of PHASES) {
        const { add, change, remove } = diffPhase(phase, live[phase], desired[phase])
        for (const rule of add) {
          differences.push({ path: `${phase}/${rule.ref}`, configured: rule, actual: undefined })
        }
        for (const { ref, from, to } of change) {
          for (const field of changedFields(to, from)) {
            differences.push({
              path: `${phase}/${ref}/${field}`,
              configured: to[field],
              actual: from[field],
            })
          }
        }
        for (const rule of remove) {
          differences.push({ path: `${phase}/${rule.ref}`, configured: undefined, actual: rule })
        }
      }
      return { drift: differences.length > 0, differences }
    },

    async inspect(): Promise<SecurityState> {
      const live = await livePhases()
      return {
        rulesApplied: PHASES.flatMap((phase) =>
          live[phase].filter(isNymbalRule).map((r) => r.ref as string),
        ),
        lastValidatedAt,
      }
    },
  }
}
