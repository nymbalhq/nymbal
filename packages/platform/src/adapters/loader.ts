import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type ProviderPackageModule,
  type Slot,
} from '@nymbalhq/types'

export interface ProviderPackage {
  /** The adapter package, which exports `createAdapter(ctx: AdapterContext)`. */
  package: string
  /** The provider SDK the package peers, which the project installs beside it; none when it talks HTTP itself. */
  sdk?: string
}

type Packages<P extends ProviderPackage> = Readonly<Record<string, P>>

/**
 * The providers that live in their own package, by slot then provider. The kernel imports a package only when the
 * config names its provider; `native`, `none`, `custom` and the kernel's own primitives (`in-memory`, `in-process`,
 * `local-fs`) have no entry. Every package peers its provider's SDK but the security ones, which call an HTTP API.
 */
export const PROVIDER_PACKAGES: Readonly<
  Partial<Record<Exclude<Slot, 'security'>, Packages<Required<ProviderPackage>>>>
> & { readonly security: Packages<ProviderPackage> } = {
  payments: { stripe: { package: '@nymbalhq/adapter-stripe', sdk: 'stripe' } },
  ai: { anthropic: { package: '@nymbalhq/adapter-anthropic', sdk: '@anthropic-ai/sdk' } },
  email: {
    smtp: { package: '@nymbalhq/adapter-smtp', sdk: 'nodemailer' },
    mailgun: { package: '@nymbalhq/adapter-mailgun', sdk: 'nodemailer' },
  },
  documentStore: {
    redis: { package: '@nymbalhq/doc-store-redis', sdk: 'ioredis' },
    'postgres-jsonb': { package: '@nymbalhq/doc-store-postgres-jsonb', sdk: 'pg' },
  },
  eventBus: {
    'redis-streams': { package: '@nymbalhq/event-bus-redis-streams', sdk: 'ioredis' },
  },
  media: { s3: { package: '@nymbalhq/media-s3', sdk: '@aws-sdk/client-s3' } },
  security: { cloudflare: { package: '@nymbalhq/security-cloudflare' } },
}

const INFRASTRUCTURE_SLOTS: ReadonlySet<Slot> = new Set(['documentStore', 'eventBus', 'media'])

/** How the config names a slot's choice, for messages: `payments.provider 'stripe'`, `documentStore 'redis'`. */
function choiceOf(slot: Slot, provider: string): string {
  if (slot === 'security') return `security.adapter '${provider}'`
  return INFRASTRUCTURE_SLOTS.has(slot)
    ? `infrastructure.${slot} '${provider}'`
    : `${slot}.provider '${provider}'`
}

const INSTALL_VERBS = {
  npm: 'npm install',
  pnpm: 'pnpm add',
  yarn: 'yarn add',
  bun: 'bun add',
} as const
type PackageManager = keyof typeof INSTALL_VERBS

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

/** The package manager the process runs under: its user agent, then the project's lockfile, then npm. */
function packageManager(env: NodeJS.ProcessEnv, cwd: string): PackageManager {
  const agent = env['npm_config_user_agent']?.split('/')[0]
  if (agent !== undefined && agent in INSTALL_VERBS) return agent as PackageManager
  for (const [file, pm] of LOCKFILES) {
    if (existsSync(join(cwd, file))) return pm
  }
  return 'npm'
}

/** The command that installs `packages` with the project's package manager, as `packageManager` picks it. */
export function installLine(
  packages: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): string {
  return [INSTALL_VERBS[packageManager(env, cwd)], ...packages].join(' ')
}

/** The package a bare specifier names: `@scope/name` or `name`, without any subpath. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** The specifier Node could not find, when `error` is a missing package and not some other failure. */
function missingPackage(error: unknown): string | null {
  if ((error as { code?: unknown } | null)?.code !== 'ERR_MODULE_NOT_FOUND') return null
  const match = /Cannot find (?:package|module) '([^']+)'/.exec(String((error as Error).message))
  return match?.[1] === undefined ? null : packageOf(match[1])
}

interface AdapterModule {
  createAdapter?: (ctx: AdapterContext) => unknown
  settings?: unknown
}

export type ProviderModule = ProviderPackageModule

function isSetting(value: unknown): value is AdapterSetting {
  const s = value as Partial<AdapterSetting> | null
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.path === 'string' &&
    s.path !== '' &&
    typeof s.label === 'string' &&
    typeof s.secret === 'boolean' &&
    (s.env === undefined || typeof s.env === 'string')
  )
}

/**
 * The module of a provider that lives in its own package, imported from the kernel as `loadProviderAdapter` imports
 * it, or `undefined` when the provider is built in. A missing package or SDK is a `ConfigError`
 * (`adapter.package_missing`) carrying the install line, a module with no `createAdapter` is `adapter.package_invalid`,
 * and any other load error is rethrown as it is.
 */
export async function importProviderPackage(
  slot: Slot,
  provider: string,
  env: NodeJS.ProcessEnv,
): Promise<ProviderModule | undefined> {
  const entry = PROVIDER_PACKAGES[slot]?.[provider]
  if (entry === undefined) return undefined
  let mod: AdapterModule
  try {
    mod = (await import(entry.package)) as AdapterModule
  } catch (error) {
    const missing = missingPackage(error)
    if (missing !== entry.package && missing !== entry.sdk) throw error
    const packages = entry.sdk === undefined ? [entry.package] : [entry.package, entry.sdk]
    const install = installLine(packages, env, process.cwd())
    throw new ConfigError(`${choiceOf(slot, provider)} needs ${entry.package}: ${install}`, {
      code: 'adapter.package_missing',
      cause: error,
      context: { slot, provider, missing, install },
    })
  }
  if (typeof mod.createAdapter !== 'function') {
    throw new ConfigError(`${entry.package} exports no createAdapter(ctx)`, {
      code: 'adapter.package_invalid',
      context: { slot, provider, package: entry.package },
    })
  }
  if (
    mod.settings !== undefined &&
    !(Array.isArray(mod.settings) && (mod.settings as unknown[]).every(isSetting))
  ) {
    throw new ConfigError(
      `${entry.package} exports \`settings\` that is not an array of { path, label, secret, env? }`,
      { code: 'adapter.package_invalid', context: { slot, provider, package: entry.package } },
    )
  }
  return mod as ProviderModule
}

/** The fields a provider package lets Settings fill: its `settings` export, or none. */
export function declaredSettings(mod: ProviderModule | undefined): readonly AdapterSetting[] {
  return mod?.settings ?? []
}

/**
 * The adapter for a provider that lives in its own package, or `undefined` when the provider is built in; it fails as
 * `importProviderPackage` does.
 */
export async function loadProviderAdapter(
  slot: Slot,
  provider: string,
  ctx: Omit<AdapterContext, 'slot'>,
): Promise<unknown> {
  const mod = await importProviderPackage(slot, provider, ctx.env)
  if (mod === undefined) return undefined
  return await mod.createAdapter({ ...ctx, slot })
}
