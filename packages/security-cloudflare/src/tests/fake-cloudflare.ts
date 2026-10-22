import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

// P2-04 (spec P2-04-cloudflare-waf, Interface "Tests' fake"): the Cloudflare v4 API as the adapter uses it, in process
// on 127.0.0.1 and port 0. It holds zones (plan, token) and each zone's per-phase entrypoint rulesets, and serves:
//   GET  /zones/{zone}                                          the zone, with plan.legacy_id
//   GET  /zones/{zone}/rulesets                                 the zone's entrypoints and the managed rulesets
//   POST /zones/{zone}/rulesets                                 creates a phase's entrypoint (the deploy guide's way)
//   GET  /zones/{zone}/rulesets/phases/{phase}/entrypoint       404 for a phase never written
//   PUT  /zones/{zone}/rulesets/phases/{phase}/entrypoint       replaces the phase's rules whole, creating it if absent
// Every write is checked against the spec's plan table over the whole phase (every rule, not only Nymbal's): the rule
// counts, the periods, the managed rulesets, `cf.colo.id` in characteristics and `mitigation_timeout` by action and
// plan. A violation is refused as Cloudflare refuses it: 400 with an `errors` array, and the phase is left as it was.
// A wrong bearer token is 401. Every request is recorded with the status it got. `edit`, `remove` and `add` are the
// dashboard: they change the zone without any check. Where the spec marks a Cloudflare fact unconfirmed, the fake takes
// the reading the spec takes and the live proof checks: PUT creates an absent entrypoint, and a rule keeps its `ref`.

export const PHASES = [
  'http_ratelimit',
  'http_request_firewall_custom',
  'http_request_firewall_managed',
  'http_request_cache_settings',
] as const
export type Phase = (typeof PHASES)[number]

export const PLANS = ['free', 'pro', 'business', 'enterprise'] as const
export type Plan = (typeof PLANS)[number]

/** Cloudflare Managed is confirmed; the OWASP id is the one the live proof reads from GET /zones/{zone}/rulesets. */
export const MANAGED_RULESET_IDS = {
  cloudflare: 'efb7b8c949ac4650a09736fc376e9aee',
  owasp: '4814384a9e5d4991b9815dcfc25d2f1f',
} as const

/** The spec's plan table (Context, "Limits by plan"). */
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

export const API_PREFIX = '/client/v4'

/** A ruleset rule on the wire. Cloudflare adds `id`, `version`, `last_updated` and `enabled` to what it is given. */
export interface CfRule {
  id?: string
  version?: string
  last_updated?: string
  ref?: string
  description?: string
  expression: string
  action: string
  action_parameters?: Record<string, unknown>
  ratelimit?: {
    characteristics?: string[]
    period?: number
    requests_per_period?: number
    mitigation_timeout?: number
    [key: string]: unknown
  }
  enabled?: boolean
  [key: string]: unknown
}

export interface ZoneInit {
  /** Generated when absent. */
  id?: string
  plan: Plan
  /** The API token the zone accepts as `Authorization: Bearer <token>`. */
  token: string
  /** Phases already written, by their owner: each rule gets an id, and a ref equal to its id unless it has one. */
  phases?: Partial<Record<Phase, CfRule[]>>
}

export interface RecordedRequest {
  method: string
  /** The path below the API prefix: `/zones/<zone>/rulesets/phases/<phase>/entrypoint`. */
  path: string
  body: unknown
  status: number
}

export interface FakeCloudflare {
  /** What `security.cloudflare.apiBase` is set to: `http://127.0.0.1:<port>/client/v4`. */
  readonly url: string
  /** Every request so far, in order. */
  readonly requests: RecordedRequest[]
  addZone(init: ZoneInit): string
  /** A phase's live rules (a copy), or undefined for a phase never written. */
  rules(zone: string, phase: Phase): CfRule[] | undefined
  /** The dashboard edit: merges `patch` into the rule with `ref`. */
  edit(zone: string, phase: Phase, ref: string, patch: Partial<CfRule>): void
  /** The dashboard delete of the rule with `ref`. */
  remove(zone: string, phase: Phase, ref: string): void
  /** The dashboard add of a rule (the owner's own, unless its ref says otherwise), last in the phase. */
  add(zone: string, phase: Phase, rule: CfRule): CfRule
  /** The PUT and POST requests so far, for one zone when given. */
  writes(zone?: string): RecordedRequest[]
  close(): Promise<void>
}

interface Ruleset {
  id: string
  version: number
  rules: CfRule[]
}

interface Zone {
  id: string
  plan: Plan
  token: string
  phases: Map<Phase, Ruleset>
}

const hex = (bytes = 16): string => randomBytes(bytes).toString('hex')

function isPhase(value: string): value is Phase {
  return (PHASES as readonly string[]).includes(value)
}

const CHALLENGES = new Set(['managed_challenge', 'js_challenge', 'challenge'])

/** Why Cloudflare would refuse `rules` as the whole of `phase` on `plan`; empty when it accepts them. */
export function violations(plan: Plan, phase: Phase, rules: readonly CfRule[]): string[] {
  const limits = PLAN_LIMITS[plan]
  const out: string[] = []
  const refs = rules.map((r) => r.ref).filter((r): r is string => typeof r === 'string')
  if (new Set(refs).size !== refs.length) out.push('rule refs must be unique within a ruleset')
  rules.forEach((rule, i) => {
    const at = `rules[${i}]`
    if (typeof rule.expression !== 'string' || rule.expression.trim() === '')
      out.push(`${at}: expression is required`)
    if (typeof rule.action !== 'string' || rule.action === '') out.push(`${at}: action is required`)
  })
  if (phase === 'http_ratelimit') {
    if (rules.length > limits.rateLimitRules) {
      out.push(
        `the ${plan} plan allows ${limits.rateLimitRules} rate limiting rules; the ruleset has ${rules.length}`,
      )
    }
    rules.forEach((rule, i) => {
      const at = `rules[${i}]`
      const rl = rule.ratelimit
      if (rl === undefined) {
        out.push(`${at}: ratelimit is required in the http_ratelimit phase`)
        return
      }
      if (!Array.isArray(rl.characteristics) || !rl.characteristics.includes('cf.colo.id'))
        out.push(`${at}: characteristics must include cf.colo.id`)
      if (typeof rl.period !== 'number' || !limits.periods.includes(rl.period))
        out.push(`${at}: period ${String(rl.period)} is not allowed on the ${plan} plan`)
      if (
        typeof rl.requests_per_period !== 'number' ||
        !Number.isInteger(rl.requests_per_period) ||
        rl.requests_per_period < 1
      )
        out.push(`${at}: requests_per_period must be a positive integer`)
      const timeout = rl.mitigation_timeout
      if (plan !== 'enterprise') {
        if (CHALLENGES.has(rule.action) && timeout !== 0)
          out.push(`${at}: ${rule.action} needs mitigation_timeout 0 on the ${plan} plan`)
        if (rule.action === 'block' && timeout === 0)
          out.push(`${at}: throttling (block with mitigation_timeout 0) needs the enterprise plan`)
        if (plan === 'free' && rule.action === 'block' && timeout !== 10)
          out.push(`${at}: the free plan's block mitigation_timeout is 10`)
      }
    })
  }
  if (phase === 'http_request_firewall_custom' && rules.length > limits.customRules) {
    out.push(
      `the ${plan} plan allows ${limits.customRules} custom rules; the ruleset has ${rules.length}`,
    )
  }
  if (phase === 'http_request_firewall_managed' && !limits.managedRulesets) {
    const managed = new Set<string>(Object.values(MANAGED_RULESET_IDS))
    rules.forEach((rule, i) => {
      const id = rule.action_parameters?.['id']
      if (rule.action === 'execute' && typeof id === 'string' && managed.has(id))
        out.push(`rules[${i}]: managed ruleset ${id} is not available on the ${plan} plan`)
    })
  }
  return out
}

function envelope(result: unknown): unknown {
  return { success: true, errors: [], messages: [], result }
}

function failure(errors: Array<{ code: number; message: string }>): unknown {
  return { success: false, errors, messages: [], result: null }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

export async function startFakeCloudflare(): Promise<FakeCloudflare> {
  const zones = new Map<string, Zone>()
  const requests: RecordedRequest[] = []

  function zoneOf(id: string): Zone {
    const zone = zones.get(id)
    if (zone === undefined) throw new Error(`fake cloudflare: no zone ${id}`)
    return zone
  }

  /** What the phase holds after `incoming` is written over `previous`: ids, refs and versions as Cloudflare keeps them. */
  function stored(incoming: readonly CfRule[], previous: readonly CfRule[]): CfRule[] {
    const now = new Date().toISOString()
    return incoming.map((rule) => {
      const before =
        previous.find((p) => rule.id !== undefined && p.id === rule.id) ??
        previous.find((p) => rule.ref !== undefined && p.ref === rule.ref)
      const id = before?.id ?? hex()
      const out: CfRule = {
        ...structuredClone(rule),
        id,
        ref: rule.ref ?? before?.ref ?? id,
        enabled: rule.enabled ?? true,
        version: String(Number(before?.version ?? '0') + 1),
        last_updated: now,
      }
      return out
    })
  }

  function rulesetBody(zone: Zone, phase: Phase, ruleset: Ruleset): unknown {
    return {
      id: ruleset.id,
      name: `zone ${zone.id} ${phase}`,
      description: '',
      kind: 'zone',
      version: String(ruleset.version),
      last_updated: new Date().toISOString(),
      phase,
      rules: structuredClone(ruleset.rules),
    }
  }

  /** Writes `rules` as the whole of `phase`, or the 400 Cloudflare answers. */
  function write(zone: Zone, phase: Phase, rules: unknown): { status: number; body: unknown } {
    if (!Array.isArray(rules)) {
      return {
        status: 400,
        body: failure([{ code: 20021, message: 'rules must be an array' }]),
      }
    }
    const incoming = rules as CfRule[]
    const problems = violations(zone.plan, phase, incoming)
    if (problems.length > 0) {
      return {
        status: 400,
        body: failure(problems.map((message) => ({ code: 20217, message }))),
      }
    }
    const existing = zone.phases.get(phase)
    const ruleset: Ruleset = {
      id: existing?.id ?? hex(),
      version: (existing?.version ?? 0) + 1,
      rules: stored(incoming, existing?.rules ?? []),
    }
    zone.phases.set(phase, ruleset)
    return { status: 200, body: envelope(rulesetBody(zone, phase, ruleset)) }
  }

  function route(
    method: string,
    path: string,
    authorization: string | undefined,
    body: unknown,
  ): { status: number; body: unknown } {
    const zoneMatch = /^\/zones\/([^/]+)(\/.*)?$/.exec(path)
    if (zoneMatch === null) {
      return { status: 404, body: failure([{ code: 7000, message: 'No route for that URI' }]) }
    }
    const zone = zones.get(decodeURIComponent(zoneMatch[1]!))
    if (zone === undefined) {
      return {
        status: 404,
        body: failure([{ code: 7003, message: 'Could not route to the zone: invalid identifier' }]),
      }
    }
    if (authorization !== `Bearer ${zone.token}`) {
      return { status: 401, body: failure([{ code: 10000, message: 'Authentication error' }]) }
    }
    const rest = zoneMatch[2] ?? ''

    if (rest === '' && method === 'GET') {
      return {
        status: 200,
        body: envelope({
          id: zone.id,
          name: `${zone.id}.example.com`,
          status: 'active',
          plan: { id: hex(), name: `${zone.plan} plan`, legacy_id: zone.plan },
        }),
      }
    }

    if (rest === '/rulesets' && method === 'GET') {
      const entrypoints = [...zone.phases.entries()].map(([phase, ruleset]) => ({
        id: ruleset.id,
        name: `zone ${zone.id} ${phase}`,
        kind: 'zone',
        phase,
        version: String(ruleset.version),
      }))
      const managed = [
        {
          id: MANAGED_RULESET_IDS.cloudflare,
          name: 'Cloudflare Managed Ruleset',
          kind: 'managed',
          phase: 'http_request_firewall_managed',
          version: '1',
        },
        {
          id: MANAGED_RULESET_IDS.owasp,
          name: 'Cloudflare OWASP Core Ruleset',
          kind: 'managed',
          phase: 'http_request_firewall_managed',
          version: '1',
        },
      ]
      return { status: 200, body: envelope([...entrypoints, ...managed]) }
    }

    if (rest === '/rulesets' && method === 'POST') {
      const b = (body ?? {}) as { kind?: unknown; phase?: unknown; rules?: unknown }
      if (b.kind !== 'zone' || typeof b.phase !== 'string' || !isPhase(b.phase)) {
        return {
          status: 400,
          body: failure([{ code: 20021, message: 'a zone ruleset needs kind zone and a phase' }]),
        }
      }
      if (zone.phases.has(b.phase)) {
        return {
          status: 400,
          body: failure([
            { code: 20217, message: `an entrypoint ruleset already exists in ${b.phase}` },
          ]),
        }
      }
      return write(zone, b.phase, b.rules ?? [])
    }

    const phaseMatch = /^\/rulesets\/phases\/([^/]+)\/entrypoint$/.exec(rest)
    if (phaseMatch !== null) {
      const phase = phaseMatch[1]!
      if (!isPhase(phase)) {
        return { status: 400, body: failure([{ code: 20021, message: `unknown phase ${phase}` }]) }
      }
      if (method === 'GET') {
        const ruleset = zone.phases.get(phase)
        if (ruleset === undefined) {
          return {
            status: 404,
            body: failure([
              {
                code: 10003,
                message: `could not find entrypoint ruleset in the ${phase} phase`,
              },
            ]),
          }
        }
        return { status: 200, body: envelope(rulesetBody(zone, phase, ruleset)) }
      }
      if (method === 'PUT') {
        return write(zone, phase, (body as { rules?: unknown } | null)?.rules)
      }
    }

    return { status: 405, body: failure([{ code: 10405, message: `${method} is not allowed` }]) }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET'
    const full = (req.url ?? '').split('?')[0] ?? ''
    const path = full.startsWith(API_PREFIX) ? full.slice(API_PREFIX.length) : full
    const raw = await readBody(req)
    let body: unknown
    let answer: { status: number; body: unknown }
    try {
      body = raw === '' ? undefined : (JSON.parse(raw) as unknown)
      answer = full.startsWith(API_PREFIX)
        ? route(method, path, req.headers.authorization, body)
        : { status: 404, body: failure([{ code: 7000, message: 'No route for that URI' }]) }
    } catch {
      body = raw
      answer = { status: 400, body: failure([{ code: 10002, message: 'malformed JSON body' }]) }
    }
    requests.push({ method, path, body, status: answer.status })
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer.body))
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify(failure([{ code: 10500, message: String(error) }])))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = server.address() as AddressInfo

  function find(zone: string, phase: Phase, ref: string): { ruleset: Ruleset; index: number } {
    const ruleset = zoneOf(zone).phases.get(phase)
    const index = ruleset?.rules.findIndex((r) => r.ref === ref) ?? -1
    if (ruleset === undefined || index < 0)
      throw new Error(`fake cloudflare: no rule ${ref} in ${zone} ${phase}`)
    return { ruleset, index }
  }

  return {
    url: `http://127.0.0.1:${port}${API_PREFIX}`,
    requests,
    addZone(init) {
      const id = init.id ?? hex()
      const zone: Zone = { id, plan: init.plan, token: init.token, phases: new Map() }
      for (const [phase, rules] of Object.entries(init.phases ?? {}) as Array<[Phase, CfRule[]]>) {
        zone.phases.set(phase, { id: hex(), version: 1, rules: stored(rules, []) })
      }
      zones.set(id, zone)
      return id
    },
    rules(zone, phase) {
      const ruleset = zoneOf(zone).phases.get(phase)
      return ruleset === undefined ? undefined : structuredClone(ruleset.rules)
    },
    edit(zone, phase, ref, patch) {
      const { ruleset, index } = find(zone, phase, ref)
      const before = ruleset.rules[index]!
      ruleset.rules[index] = {
        ...before,
        ...structuredClone(patch),
        version: String(Number(before.version ?? '0') + 1),
        last_updated: new Date().toISOString(),
      }
      ruleset.version += 1
    },
    remove(zone, phase, ref) {
      const { ruleset, index } = find(zone, phase, ref)
      ruleset.rules.splice(index, 1)
      ruleset.version += 1
    },
    add(zone, phase, rule) {
      const z = zoneOf(zone)
      const ruleset = z.phases.get(phase) ?? { id: hex(), version: 0, rules: [] }
      const [added] = stored([rule], [])
      ruleset.rules.push(added!)
      ruleset.version += 1
      z.phases.set(phase, ruleset)
      return structuredClone(added!)
    },
    writes(zone) {
      return requests.filter(
        (r) =>
          (r.method === 'PUT' || r.method === 'POST') &&
          (zone === undefined || r.path.startsWith(`/zones/${zone}/`)),
      )
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
