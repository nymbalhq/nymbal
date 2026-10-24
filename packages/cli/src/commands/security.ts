import { defineCommand } from 'citty'
import type { NymbalConfig } from '@nymbalhq/config'
import { createLogger, importProviderPackage } from '@nymbalhq/platform'
import {
  errorText,
  type DriftReport,
  type SecurityState,
  type ValidationResult,
} from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'

type Security = NymbalConfig['security']

interface EdgeRule {
  ref?: string
  expression: string
  action: string
}

/** `@nymbalhq/security-cloudflare`'s SecurityPlan, as far as the CLI prints it. */
interface SecurityPlan {
  phases: Array<{
    phase: string
    add: EdgeRule[]
    change: Array<{ ref: string; from: EdgeRule; to: EdgeRule }>
    remove: EdgeRule[]
  }>
}

/** The Cloudflare adapter's commands beside the SecurityAdapter it is. */
interface EdgeSecurityAdapter {
  validate(config: Security): Promise<ValidationResult>
  plan(config: Security): Promise<SecurityPlan>
  apply(config: Security): Promise<SecurityPlan>
  drift(config: Security): Promise<DriftReport>
  inspect(): Promise<SecurityState>
}

interface EdgeModule {
  createAdapter(ctx: unknown): unknown
  hasSingleStar(key: string): boolean
}

/** 0 done or in sync, 1 drift (`security:drift` only), 2 a config, credential or API error. */
type ExitCode = 0 | 1 | 2

interface Outcome {
  code: ExitCode
  stdout: string[]
  stderr: string[]
}

const failure = (...stderr: string[]): Outcome => ({ code: 2, stdout: [], stderr })

const isEmpty = (plan: SecurityPlan): boolean =>
  plan.phases.every((p) => p.add.length + p.change.length + p.remove.length === 0)

function formatPlan(plan: SecurityPlan): string[] {
  const lines: string[] = []
  for (const { phase, add, change, remove } of plan.phases) {
    if (add.length + change.length + remove.length === 0) continue
    lines.push(
      `${phase}: ${add.length} to add, ${change.length} to change, ${remove.length} to remove`,
    )
    for (const rule of add) lines.push(`  + ${rule.ref}  ${rule.action}  ${rule.expression}`)
    for (const { ref, to } of change) lines.push(`  ~ ${ref}  ${to.action}  ${to.expression}`)
    for (const rule of remove) lines.push(`  - ${rule.ref}`)
  }
  return lines
}

function invalid(result: ValidationResult): Outcome {
  return failure(
    'The security config cannot go onto the zone:',
    ...result.errors.map((e) => `  ${e.code}  ${e.message}`),
  )
}

/** What the edge does differently from the config as the origin reads it. */
function edgeNotes(security: Security, mod: EdgeModule): string[] {
  const notes = Object.keys(security.rateLimit)
    .filter((key) => key.startsWith('/') && mod.hasSingleStar(key))
    .map(
      (key) =>
        `note: '${key}' matches one path segment per * in process, but any number at the edge (Cloudflare's * crosses /)`,
    )
  if (security.botProtection.mode !== 'off') {
    notes.push(
      'note: botProtection is left as the zone has it: Bot Fight Mode is a zone setting, not a ruleset rule',
    )
  }
  return notes
}

/** Writes the outcome with every secret masked, then exits once both streams have flushed. */
function finish(outcome: Outcome, secrets: readonly string[]): void {
  const masked = (lines: string[]): string =>
    lines
      .map((line) => secrets.reduce((text, secret) => text.split(secret).join('***'), line))
      .map((line) => `${line}\n`)
      .join('')
  process.stderr.write(masked(outcome.stderr), () =>
    process.stdout.write(masked(outcome.stdout), () => process.exit(outcome.code)),
  )
}

/**
 * Loads the project, builds the Cloudflare adapter from `security.cloudflare`, and runs `body` on it. A store whose
 * adapter is not `cloudflare` has no edge, and any error is exit 2 with its message.
 */
async function runEdge(
  command: string,
  body: (adapter: EdgeSecurityAdapter, security: Security, mod: EdgeModule) => Promise<Outcome>,
): Promise<void> {
  const secrets = [process.env['CLOUDFLARE_API_TOKEN']]
  let outcome: Outcome
  try {
    const { config } = await loadProject()
    const security = config.security
    secrets.push(security.cloudflare?.apiToken)
    if (security.adapter !== 'cloudflare') {
      outcome = failure(
        `security.adapter is '${security.adapter}', which has no edge rules for nymbal ${command}: ` +
          "set security.adapter to 'cloudflare' (nymbal add cloudflare) to manage them on a Cloudflare zone",
      )
    } else {
      const mod = (await importProviderPackage(
        'security',
        'cloudflare',
        process.env,
      )) as unknown as EdgeModule
      const adapter = (await mod.createAdapter({
        slot: 'security',
        config: security.cloudflare ?? {},
        logger: createLogger({ level: 'silent', pretty: false }),
        env: process.env,
      })) as EdgeSecurityAdapter
      outcome = await body(adapter, security, mod)
    }
  } catch (error) {
    outcome = failure(`nymbal ${command} failed: ${errorText(error)}`)
  }
  finish(
    outcome,
    secrets.filter((s): s is string => typeof s === 'string' && s !== ''),
  )
}

const json = {
  type: 'boolean',
  description: 'Print the result as one JSON document',
  default: false,
} as const

export const securityPlanCommand = defineCommand({
  meta: {
    name: 'security:plan',
    description: 'Show what security:apply would change on the Cloudflare zone',
  },
  args: { json },
  run: ({ args }) =>
    runEdge('security:plan', async (adapter, security, mod) => {
      const check = await adapter.validate(security)
      if (!check.valid) return invalid(check)
      const plan = await adapter.plan(security)
      const notes = edgeNotes(security, mod)
      if (args.json) return { code: 0, stdout: [JSON.stringify(plan, null, 2)], stderr: notes }
      const lines = isEmpty(plan)
        ? ['No changes: the zone holds every Nymbal rule.']
        : formatPlan(plan)
      return { code: 0, stdout: [...lines, ...notes], stderr: [] }
    }),
})

export const securityApplyCommand = defineCommand({
  meta: {
    name: 'security:apply',
    description:
      "Write the store's security rules to the Cloudflare zone, leaving the zone's own rules",
  },
  run: () =>
    runEdge('security:apply', async (adapter, security) => {
      const check = await adapter.validate(security)
      if (!check.valid) return invalid(check)
      const done = await adapter.apply(security)
      const lines = isEmpty(done)
        ? ['Nothing to write: the zone already holds every Nymbal rule.']
        : ['Applied:', ...formatPlan(done)]
      return { code: 0, stdout: lines, stderr: [] }
    }),
})

export const securityDriftCommand = defineCommand({
  meta: {
    name: 'security:drift',
    description: "Report where the zone's Nymbal rules differ from the config (exit 1 on drift)",
  },
  args: { json },
  run: ({ args }) =>
    runEdge('security:drift', async (adapter, security) => {
      const report = await adapter.drift(security)
      const code: ExitCode = report.drift ? 1 : 0
      if (args.json) return { code, stdout: [JSON.stringify(report, null, 2)], stderr: [] }
      if (!report.drift)
        return { code, stdout: ['In sync: the zone holds every Nymbal rule.'], stderr: [] }
      const lines = report.differences.map(
        (d) =>
          `  ${d.path}  configured ${JSON.stringify(d.configured) ?? 'nothing'}, live ${JSON.stringify(d.actual) ?? 'nothing'}`,
      )
      return {
        code,
        stdout: [
          `Drift: ${report.differences.length} difference(s); security:apply restores them`,
          ...lines,
        ],
        stderr: [],
      }
    }),
})

export const securityInspectCommand = defineCommand({
  meta: {
    name: 'security:inspect',
    description: 'List the Nymbal rules live on the Cloudflare zone',
  },
  run: () =>
    runEdge('security:inspect', async (adapter) => {
      const { rulesApplied } = await adapter.inspect()
      const lines =
        rulesApplied.length === 0 ? ['No Nymbal rules are live on the zone.'] : rulesApplied
      return { code: 0, stdout: lines, stderr: [] }
    }),
})
