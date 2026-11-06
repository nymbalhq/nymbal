import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { ORIGIN_SECRET_ENV, resolveOriginLock, type NymbalConfig } from '@nymbalhq/config'
import { createLogger, importAdapterModule } from '@nymbalhq/platform'
import {
  ConfigError,
  errorText,
  type DriftReport,
  type OriginLockRule,
  type ResolvedOriginLock,
  type SecurityState,
  type ValidationResult,
} from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'
import { appName } from './deploy.js'
import { originHost } from './deploy-web-server.js'

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

interface EdgeRanges {
  etag: string
  ipv4Cidrs: string[]
  ipv6Cidrs: string[]
}

/** The Cloudflare adapter's commands beside the SecurityAdapter it is; an older adapter lacks the origin lock's. */
interface EdgeSecurityAdapter {
  validate(config: Security): Promise<ValidationResult>
  plan(config: Security): Promise<SecurityPlan>
  apply(config: Security): Promise<SecurityPlan>
  drift(config: Security): Promise<DriftReport>
  inspect(): Promise<SecurityState>
  originLockRule?(lock: ResolvedOriginLock): Promise<OriginLockRule>
  originLockValue?(): Promise<string | undefined>
  ips?(): Promise<EdgeRanges>
  zoneName?(): Promise<string | undefined>
}

interface EdgeModule {
  createAdapter(ctx: unknown): unknown
  hasSingleStar(key: string): boolean
  CLOUDFLARE_IPS?: EdgeRanges & { fetchedAt: string }
}

/** What a command body works with. */
interface Edge {
  adapter: EdgeSecurityAdapter
  security: Security
  config: NymbalConfig
  projectRoot: string
  mod: EdgeModule
  /** The adapter built from `env` in place of the process environment, which is never changed. */
  adapterWith(env: NodeJS.ProcessEnv): Promise<EdgeSecurityAdapter>
  /** Keeps `value` out of everything the command prints. */
  hide(value: string): void
}

/** 0 done or in sync, 1 drift (`security:drift` only), 2 a config, credential or API error. */
type ExitCode = 0 | 1 | 2

interface Outcome {
  code: ExitCode
  stdout: string[]
  stderr: string[]
}

const ORIGIN_LOCK_REF = 'nymbal:origin-lock'
const TRANSFORM_PHASE = 'http_request_late_transform'
const ADOPT = '--adopt-origin-secret'
const RENEW = '--new-origin-secret'

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

/** The origin secret's entries, each to be kept out of what a command prints. */
const originSecretEntries = (env: NodeJS.ProcessEnv): string[] =>
  (env[ORIGIN_SECRET_ENV] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

/** Writes the outcome with every secret masked, then exits once both streams have flushed. */
function finish(outcome: Outcome, secrets: readonly string[]): void {
  // Longest first, so a secret that holds another is masked whole.
  const ordered = [...secrets].sort((a, b) => b.length - a.length)
  const masked = (lines: string[]): string =>
    lines
      .map((line) => ordered.reduce((text, secret) => text.split(secret).join('***'), line))
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
async function runEdge(command: string, body: (edge: Edge) => Promise<Outcome>): Promise<void> {
  const secrets = [process.env['CLOUDFLARE_API_TOKEN']]
  let outcome: Outcome
  try {
    const { config, projectRoot } = await loadProject()
    const security = config.security
    secrets.push(security.cloudflare?.apiToken, ...originSecretEntries(process.env))
    if (security.adapter !== 'cloudflare') {
      outcome = failure(
        `security.adapter is '${security.adapter}', which has no edge rules for nymbal ${command}: ` +
          "set security.adapter to 'cloudflare' (nymbal add cloudflare) to manage them on a Cloudflare zone",
      )
    } else {
      const mod = (await importAdapterModule(
        'security',
        {
          provider: 'cloudflare',
          ...(security.package !== undefined && { package: security.package }),
        },
        process.env,
      )) as unknown as EdgeModule
      const adapterWith = async (env: NodeJS.ProcessEnv) =>
        (await mod.createAdapter({
          slot: 'security',
          config: security.cloudflare ?? {},
          logger: createLogger({ level: 'silent', pretty: false }),
          env,
        })) as EdgeSecurityAdapter
      outcome = await body({
        adapter: await adapterWith(process.env),
        security,
        config,
        projectRoot,
        mod,
        adapterWith,
        hide: (value) => secrets.push(value),
      })
    }
  } catch (error) {
    outcome = failure(`nymbal ${command} failed: ${errorText(error)}`)
  }
  finish(
    outcome,
    secrets.filter((s): s is string => typeof s === 'string' && s !== ''),
  )
}

/** What the zone's origin-lock rule sends, and whether writing the rule would replace a lock another machine set. */
async function zoneLock(
  edge: Edge,
  originLockRule: NonNullable<EdgeSecurityAdapter['originLockRule']>,
): Promise<{ lock: ResolvedOriginLock | undefined; rule: OriginLockRule; guarded: boolean }> {
  const lock = resolveOriginLock(edge.config, process.env)
  const rule = await originLockRule.call(edge.adapter, {
    header: edge.security.originLock.header,
    secrets: lock?.secrets ?? [],
  })
  return { lock, rule, guarded: rule.state === 'present' && rule.entry === null }
}

const GUARD = [
  `${ORIGIN_SECRET_ENV} holds no entry the zone's ${ORIGIN_LOCK_REF} rule sends: another machine set the lock, and writing the rule now would lock the host out of every request through Cloudflare.`,
  `  The host already holds the zone's secret: nymbal security:apply ${ADOPT} puts it in .env and writes nothing to the zone.`,
  `  The secret is compromised: nymbal security:apply ${RENEW} makes a new one for the zone and .env; then set it on the host.`,
]

const isOriginLockPath = (path: string): boolean =>
  path === `${TRANSFORM_PHASE}/${ORIGIN_LOCK_REF}` ||
  path.startsWith(`${TRANSFORM_PHASE}/${ORIGIN_LOCK_REF}/`)

/** The plan with the transform phase unchanged: apply would refuse to touch it. */
const withoutTransform = (plan: SecurityPlan): SecurityPlan => ({
  phases: plan.phases.map((p) =>
    p.phase === TRANSFORM_PHASE ? { phase: p.phase, add: [], change: [], remove: [] } : p,
  ),
})

/** Sets the one `NYMBAL_ORIGIN_SECRET` line of the project's .env, keeping every other; a new file is the owner's alone. */
function writeEnvSecret(projectRoot: string, value: string): void {
  const path = join(projectRoot, '.env')
  const line = `${ORIGIN_SECRET_ENV}=${value}`
  if (!existsSync(path)) {
    writeFileSync(path, `${line}\n`, { mode: 0o600 })
    return
  }
  const text = readFileSync(path, 'utf8')
  const ours = new RegExp(`^\\s*(?:export\\s+)?${ORIGIN_SECRET_ENV}\\s*=`)
  if (!text.split('\n').some((l) => ours.test(l))) {
    writeFileSync(path, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`)
    return
  }
  let written = false
  const lines = text.split('\n').flatMap((l) => {
    if (!ours.test(l)) return [l]
    if (written) return []
    written = true
    return [line]
  })
  writeFileSync(path, lines.join('\n'))
}

/** The Railway service `nymbal deploy railway` names, or null when package.json gives no name. */
function railwayService(projectRoot: string): string | null {
  try {
    return appName(projectRoot)
  } catch (error) {
    if (error instanceof Error) return null
    throw error
  }
}

/** How the host gets the secret: Fly's or Railway's command when the project deploys there, else in words. */
function hostCommand(projectRoot: string): string {
  const flyToml = join(projectRoot, 'fly.toml')
  if (existsSync(flyToml)) {
    const app = /^\s*app\s*=\s*["']([^"']+)["']/m.exec(readFileSync(flyToml, 'utf8'))?.[1]
    if (app !== undefined) return `flyctl secrets set ${ORIGIN_SECRET_ENV}=<from .env> --app ${app}`
  }
  const service = existsSync(join(projectRoot, 'railway.json')) ? railwayService(projectRoot) : null
  if (service !== null) {
    return `railway variables --service ${service} --set ${ORIGIN_SECRET_ENV}=<from .env>`
  }
  return `set ${ORIGIN_SECRET_ENV} in the API's environment to the value in .env, then restart`
}

/** A warning when NYMBAL_PUBLIC_URL is not on the zone: requests to it never cross Cloudflare, so the lock refuses them. */
async function publicUrlWarning(adapter: EdgeSecurityAdapter): Promise<string[]> {
  const host = originHost(process.env['NYMBAL_PUBLIC_URL'])?.toLowerCase()
  if (host === undefined || adapter.zoneName === undefined) return []
  const zone = (await adapter.zoneName())?.toLowerCase()
  if (zone === undefined || zone === '' || host === zone || host.endsWith(`.${zone}`)) return []
  return [
    `warning: NYMBAL_PUBLIC_URL's host ${host} is not on the zone ${zone}, so its requests do not cross Cloudflare and the origin lock refuses them: use the store's domain on ${zone}`,
  ]
}

const applied = (done: SecurityPlan): string[] =>
  isEmpty(done)
    ? ['Nothing to write: the zone already holds every Nymbal rule.']
    : ['Applied:', ...formatPlan(done)]

/** Writes the rule with a fresh secret through an adapter that holds it, and only then puts the secret in .env. */
async function applyNewSecret(edge: Edge, renewed: boolean): Promise<Outcome> {
  const secret = randomBytes(32).toString('base64url')
  edge.hide(secret)
  const writer = await edge.adapterWith({ ...process.env, [ORIGIN_SECRET_ENV]: secret })
  const done = await writer.apply(edge.security)
  try {
    writeEnvSecret(edge.projectRoot, secret)
  } catch (error) {
    return failure(
      `Cloudflare now sends a new ${ORIGIN_SECRET_ENV}, but .env could not be written: ${errorText(error)}`,
      `  Once .env is writable, nymbal security:apply ${ADOPT} puts the zone's secret in it.`,
    )
  }
  return {
    code: 0,
    stdout: [
      ...applied(done),
      `${renewed ? 'Replaced' : 'Created'} ${ORIGIN_SECRET_ENV} in .env; Cloudflare now sends it. Set it on the host: ${hostCommand(edge.projectRoot)}`,
    ],
    stderr: [
      ...(renewed
        ? [
            `warning: the host refuses every request through Cloudflare until its ${ORIGIN_SECRET_ENV} is the new value in .env`,
          ]
        : []),
      ...(await publicUrlWarning(edge.adapter)),
    ],
  }
}

/** Puts the secret the zone sends into .env, so this machine joins the lock the host already has. */
async function adoptSecret(edge: Edge, rule: OriginLockRule): Promise<Outcome> {
  const value = rule.state === 'present' ? await edge.adapter.originLockValue?.() : undefined
  if (value === undefined) {
    return failure(
      `The zone has no ${ORIGIN_LOCK_REF} rule sending a secret to adopt: run nymbal security:apply to create one`,
    )
  }
  edge.hide(value)
  const notASecret = failure(
    `The zone's ${ORIGIN_LOCK_REF} rule sends a value that is not an origin secret (32 to 256 characters of A-Z a-z 0-9 + / = _ . ~ -): replace it with nymbal security:apply ${RENEW}`,
  )
  let adopted: readonly string[] | undefined
  try {
    adopted = resolveOriginLock(edge.config, { [ORIGIN_SECRET_ENV]: value })?.secrets
  } catch (error) {
    if (error instanceof ConfigError) return notASecret
    throw error
  }
  if (adopted?.length !== 1 || adopted[0] !== value) return notASecret
  writeEnvSecret(edge.projectRoot, value)
  return {
    code: 0,
    stdout: [
      `${ORIGIN_SECRET_ENV} in .env now holds the secret the zone's ${ORIGIN_LOCK_REF} rule sends; the zone and the host are unchanged.`,
    ],
    stderr: [],
  }
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
    runEdge('security:plan', async (edge) => {
      const { adapter, security, mod } = edge
      const check = await adapter.validate(security)
      if (!check.valid) return invalid(check)
      let plan = await adapter.plan(security)
      const notes = edgeNotes(security, mod)
      if (adapter.originLockRule !== undefined) {
        const { lock, rule, guarded } = await zoneLock(edge, adapter.originLockRule)
        if (guarded) {
          plan = withoutTransform(plan)
          notes.push(...GUARD.map((line, i) => (i === 0 ? `note: ${line}` : line)))
        } else if (lock === undefined && rule.state === 'missing') {
          notes.push(
            `note: apply will create ${ORIGIN_SECRET_ENV} in .env and add ${ORIGIN_LOCK_REF}, which sends it from Cloudflare; then set it on the host`,
          )
        }
      }
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
      "Write the store's security rules to the Cloudflare zone, leaving the zone's own rules; the first creates NYMBAL_ORIGIN_SECRET",
  },
  args: {
    adoptOriginSecret: {
      type: 'boolean',
      alias: 'adopt-origin-secret',
      description:
        'Put the secret the zone already sends into .env, writing nothing to the zone (another machine set the lock)',
      default: false,
    },
    newOriginSecret: {
      type: 'boolean',
      alias: 'new-origin-secret',
      description:
        'Replace the origin secret on the zone and in .env (a compromised one); the host refuses requests until it has the new one',
      default: false,
    },
  },
  run: ({ args }) =>
    runEdge('security:apply', async (edge) => {
      const { adapter, security } = edge
      if (args.adoptOriginSecret && args.newOriginSecret) {
        return failure(`${ADOPT} and ${RENEW} are two different answers: give one`)
      }
      const check = await adapter.validate(security)
      if (!check.valid) return invalid(check)
      if (adapter.originLockRule === undefined) {
        if (args.adoptOriginSecret || args.newOriginSecret) {
          return failure(
            `This version of the Cloudflare adapter has no origin lock, so ${ADOPT} and ${RENEW} have nothing to do: update @nymbalhq/security-cloudflare`,
          )
        }
        return { code: 0, stdout: applied(await adapter.apply(security)), stderr: [] }
      }
      const { lock, rule, guarded } = await zoneLock(edge, adapter.originLockRule)
      if (args.adoptOriginSecret) return adoptSecret(edge, rule)
      if (args.newOriginSecret) return applyNewSecret(edge, true)
      if (guarded) return failure(...GUARD)
      if (lock === undefined) return applyNewSecret(edge, false)
      const done = await adapter.apply(security)
      const replaced = rule.state === 'present' && rule.entry !== null ? rule.entry : 0
      return {
        code: 0,
        stdout: [
          ...applied(done),
          ...(lock.secrets.length > 1 && replaced > 0
            ? [
                `Cloudflare now sends ${ORIGIN_SECRET_ENV} entry 1 in place of entry ${replaced + 1}: the host must already hold both and have restarted; once it has, set it there to entry 1 alone`,
              ]
            : []),
        ],
        stderr: await publicUrlWarning(adapter),
      }
    }),
})

/** Whether Cloudflare's published ranges moved on from the snapshot a web server config admits. */
async function rangesNote(
  edge: Edge,
): Promise<{ notes: string[]; cloudflareIps: { snapshot: string; live: string | null } } | null> {
  const snapshot = edge.mod.CLOUDFLARE_IPS
  if (snapshot === undefined || edge.adapter.ips === undefined) return null
  let live: string
  try {
    live = (await edge.adapter.ips()).etag
  } catch (error) {
    return {
      notes: [`note: could not read Cloudflare's address ranges: ${errorText(error)}`],
      cloudflareIps: { snapshot: snapshot.etag, live: null },
    }
  }
  return {
    notes:
      live === snapshot.etag
        ? []
        : [
            `note: Cloudflare's address ranges changed since this version's snapshot (${snapshot.fetchedAt}, etag ${snapshot.etag}; live etag ${live}): a web server config from nymbal deploy nginx|apache|caddy needs writing again`,
          ],
    cloudflareIps: { snapshot: snapshot.etag, live },
  }
}

export const securityDriftCommand = defineCommand({
  meta: {
    name: 'security:drift',
    description: "Report where the zone's Nymbal rules differ from the config (exit 1 on drift)",
  },
  args: { json },
  run: ({ args }) =>
    runEdge('security:drift', async (edge) => {
      let report = await edge.adapter.drift(edge.security)
      const ranges = await rangesNote(edge)
      const notes = [...(ranges?.notes ?? [])]
      if (edge.adapter.originLockRule !== undefined) {
        const { lock, guarded } = await zoneLock(edge, edge.adapter.originLockRule)
        // Without the variable here apply refuses to touch a lock another machine set, so its rule is not drift.
        if (guarded && lock === undefined) {
          const differences = report.differences.filter((d) => !isOriginLockPath(d.path))
          report = { drift: differences.length > 0, differences }
          notes.unshift(...GUARD.map((line, i) => (i === 0 ? `note: ${line}` : line)))
        }
      }
      const code: ExitCode = report.drift ? 1 : 0
      if (args.json) {
        const document =
          ranges === null ? report : { ...report, cloudflareIps: ranges.cloudflareIps }
        return { code, stdout: [JSON.stringify(document, null, 2)], stderr: notes }
      }
      if (!report.drift) {
        return {
          code,
          stdout: ['In sync: the zone holds every Nymbal rule.', ...notes],
          stderr: [],
        }
      }
      const lines = report.differences.map(
        (d) =>
          `  ${d.path}  configured ${JSON.stringify(d.configured) ?? 'nothing'}, live ${JSON.stringify(d.actual) ?? 'nothing'}`,
      )
      return {
        code,
        stdout: [
          `Drift: ${report.differences.length} difference(s); security:apply restores them`,
          ...lines,
          ...notes,
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
    runEdge('security:inspect', async ({ adapter }) => {
      const { rulesApplied } = await adapter.inspect()
      const lines =
        rulesApplied.length === 0 ? ['No Nymbal rules are live on the zone.'] : rulesApplied
      return { code: 0, stdout: lines, stderr: [] }
    }),
})
