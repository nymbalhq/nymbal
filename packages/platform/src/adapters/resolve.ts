import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ADAPTER_CATALOGUE, BUILT_IN, conventionPackage, suggestProvider } from '@nymbalhq/config'
import {
  ConfigError,
  type AdapterContext,
  type AdapterSetting,
  type ProviderPackageModule,
  type Slot,
} from '@nymbalhq/types'
import { resolve as resolveFrom } from 'import-meta-resolve'

/** What the config names for a slot: its provider, and the package the adapter comes from when it says. */
export interface Choice {
  provider: string
  package?: string | undefined
}

/**
 * Where a slot's adapter comes from: the one passed to `createApp` (`custom`), the kernel's own (`built-in`), or a
 * package, named by the config's `package` or by the convention, `@nymbalhq/<slot>-<provider>`.
 */
export type Resolution =
  | { kind: 'custom' }
  | { kind: 'built-in' }
  | { kind: 'package'; package: string; sdk?: string; named: 'package' | 'convention' }

/** The catalogue's entry for a provider the slot ships, or undefined for a name the catalogue does not know. */
function catalogued(slot: Slot, provider: string) {
  const entries = ADAPTER_CATALOGUE[slot]
  return Object.hasOwn(entries, provider) ? entries[provider] : undefined
}

/** The rule every caller shares: `custom`, then a built-in, then `package`, then the convention name. */
export function resolveChoice(slot: Slot, choice: Choice): Resolution {
  if (choice.provider === 'custom') return { kind: 'custom' }
  if (BUILT_IN[slot].includes(choice.provider)) return { kind: 'built-in' }
  if (choice.package !== undefined) {
    return { kind: 'package', package: choice.package, named: 'package' }
  }
  const sdk = catalogued(slot, choice.provider)?.sdk
  return {
    kind: 'package',
    package: conventionPackage(slot, choice.provider),
    named: 'convention',
    ...(sdk !== undefined && { sdk }),
  }
}

const INFRASTRUCTURE_SLOTS: ReadonlySet<Slot> = new Set(['documentStore', 'eventBus', 'media'])

/** How the config names a slot's choice, for messages: `payments.provider 'stripe'`, `infrastructure.media 's3'`. */
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

const DEDUPE_LINES: Record<PackageManager, string> = {
  npm: 'npm dedupe',
  pnpm: 'pnpm dedupe',
  yarn: 'yarn dedupe',
  bun: 'bun install --force',
}

const TYPES = '@nymbalhq/types'
const TYPES_DUPLICATE = 'adapter.types_duplicate'

/** The package a bare specifier names: `@scope/name` or `name`, without any subpath. */
function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/**
 * The package Node could not find, when `error` is a missing package and not some other failure. A path (an installed
 * package's own missing file) is not a package to install, so it is `null` and the error stays as Node threw it.
 */
export function missingPackage(error: unknown): string | null {
  if ((error as { code?: unknown } | null)?.code !== 'ERR_MODULE_NOT_FOUND') return null
  const match = /Cannot find (?:package|module) '([^']+)'/.exec(String((error as Error).message))
  const specifier = match?.[1]
  if (specifier === undefined || /^(?:[/.]|file:)/.test(specifier)) return null
  return packageOf(specifier)
}

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

const shown = (value: unknown): string =>
  typeof value === 'string' ? `'${value}'` : value === undefined ? 'missing' : String(value)

/**
 * `mod` as the adapter module of `slot` and `provider`, from `pkg`: it must export `createAdapter`, `slot` equal to the
 * slot and, for any provider but `custom`, `provider` equal to it. A module for another slot is `adapter.wrong_slot`,
 * anything else wrong `adapter.package_invalid`, each naming the package, the export, the expected and actual value.
 */
export function checkAdapterModule(
  mod: unknown,
  slot: Slot,
  provider: string,
  pkg: string,
): ProviderPackageModule {
  const m = (typeof mod === 'object' && mod !== null ? mod : {}) as Record<string, unknown>
  const context = { slot, provider, package: pkg }
  if (typeof m['createAdapter'] !== 'function') {
    throw new ConfigError(
      `${pkg} exports no createAdapter(ctx) function (its createAdapter export is ${typeof m['createAdapter']})`,
      { code: 'adapter.package_invalid', context: { ...context, export: 'createAdapter' } },
    )
  }
  if (m['slot'] !== slot) {
    throw new ConfigError(
      `${pkg} is loaded for the '${slot}' slot, but its slot export is ${shown(m['slot'])}: it must export slot = '${slot}'`,
      {
        code: 'adapter.wrong_slot',
        context: { ...context, export: 'slot', expected: slot, actual: m['slot'] },
      },
    )
  }
  if (provider !== 'custom' && m['provider'] !== provider) {
    throw new ConfigError(
      `${pkg} is loaded for ${choiceOf(slot, provider)}, but its provider export is ${shown(m['provider'])}: it must export provider = '${provider}'`,
      {
        code: 'adapter.package_invalid',
        context: { ...context, export: 'provider', expected: provider, actual: m['provider'] },
      },
    )
  }
  const settings = m['settings']
  if (settings !== undefined && !(Array.isArray(settings) && settings.every(isSetting))) {
    throw new ConfigError(
      `${pkg} exports \`settings\` that is not an array of { path, label, secret, env? }`,
      { code: 'adapter.package_invalid', context: { ...context, export: 'settings' } },
    )
  }
  return m as unknown as ProviderPackageModule
}

/**
 * What a failed import becomes: a second copy of @nymbalhq/types with the slot and the remedy added, a missing package
 * named for what it is, any other error as it is.
 */
function importFailure(
  slot: Slot,
  provider: string,
  resolution: Extract<Resolution, { kind: 'package' }>,
  error: unknown,
  env: NodeJS.ProcessEnv,
): unknown {
  if (error instanceof ConfigError && error.code === TYPES_DUPLICATE) {
    return typesDuplicate(slot, provider, resolution.package, error, env)
  }
  const missing = missingPackage(error)
  if (missing === null) return error
  const pkg = resolution.package
  const context = { slot, provider, package: pkg }
  if (
    resolution.named === 'convention' &&
    missing === pkg &&
    catalogued(slot, provider) === undefined
  ) {
    // No first-party package has this name, so an install line would name nothing that can be installed.
    const suggestion = suggestProvider(slot, provider)
    const unknown = `unknown ${slot === 'security' ? 'security adapter' : `${slot} provider`} '${provider}'`
    return new ConfigError(
      suggestion === undefined
        ? `${unknown}: no first-party adapter is named that; a third-party adapter is named with \`package:\``
        : `${unknown}; did you mean '${suggestion}'?`,
      {
        code: 'adapter.provider_unknown',
        cause: error,
        context: { ...context, ...(suggestion !== undefined && { suggestion }) },
      },
    )
  }
  const own = missing === pkg || missing === resolution.sdk
  const packages = own
    ? [pkg, ...(resolution.sdk === undefined ? [] : [resolution.sdk])]
    : [missing]
  const install = installLine(packages, env, process.cwd())
  return new ConfigError(
    own
      ? `${choiceOf(slot, provider)} needs ${pkg}: ${install}`
      : `${choiceOf(slot, provider)} needs ${missing}, which ${pkg} imports: ${install}`,
    { code: 'adapter.package_missing', cause: error, context: { ...context, missing, install } },
  )
}

/** A copy of @nymbalhq/types on disk: the realpath of its package directory, and its version. */
interface TypesCopy {
  dir: string
  version: string
}

/** The copy of @nymbalhq/types whose entry is `entryUrl`: the nearest package.json above it that is named so. */
function typesCopyAt(entryUrl: string): TypesCopy {
  const entry = realpathSync(fileURLToPath(entryUrl))
  for (let dir = dirname(entry); dirname(dir) !== dir; dir = dirname(dir)) {
    const path = join(dir, 'package.json')
    if (!existsSync(path)) continue
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name === TYPES) return { dir, version: String(manifest.version) }
  }
  throw new Error(`${entry} lies in no ${TYPES} package`)
}

const kernelCopies = new Map<string, TypesCopy>()

/**
 * The copy of @nymbalhq/types the module at `adapterUrl` resolves and the one the module at `kernelUrl` resolves, as
 * realpath'd package directories with their versions; equal directories are one copy. An adapter that resolves no
 * @nymbalhq/types has `adapterTypes` and `adapterVersion` null. The kernel's side is read once per URL.
 */
export function sameTypesCopy(
  adapterUrl: string,
  kernelUrl: string,
): {
  adapterTypes: string | null
  kernelTypes: string
  adapterVersion: string | null
  kernelVersion: string
} {
  let kernel = kernelCopies.get(kernelUrl)
  if (kernel === undefined) {
    kernel = typesCopyAt(resolveFrom(TYPES, kernelUrl))
    kernelCopies.set(kernelUrl, kernel)
  }
  let adapter: TypesCopy | null
  try {
    adapter = typesCopyAt(resolveFrom(TYPES, adapterUrl))
  } catch (error) {
    // A copy whose exports target is missing resolves (import-meta-resolve does not check the file) but has no
    // realpath: the adapter's own import then fails with Node's error, naming the package.
    const code = (error as { code?: unknown } | null)?.code
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'ENOENT') throw error
    adapter = null
  }
  return {
    adapterTypes: adapter?.dir ?? null,
    kernelTypes: kernel.dir,
    adapterVersion: adapter?.version ?? null,
    kernelVersion: kernel.version,
  }
}

/**
 * The order of two versions by their numeric major.minor.patch; at equal numbers a prerelease ranks below its release.
 * Enough to tell which side of a duplicate is older, without a semver dependency.
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): { parts: number[]; pre: boolean } => {
    const core = v.split(/[-+]/, 1)[0] ?? ''
    const parts = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { parts, pre: /^[^+]*-/.test(v) }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (x.parts[i] ?? 0) - (y.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  return Number(y.pre) - Number(x.pre)
}

/**
 * `adapter.types_duplicate` for `slot`, completed with the remedy: a dedupe when both copies are at one version, else a
 * version step, since no dedupe can move the kernel's exact pin. An older adapter copy is the adapter's step alone: the
 * core already has what it asks for.
 */
function typesDuplicate(
  slot: Slot,
  provider: string,
  pkg: string,
  error: ConfigError,
  env: NodeJS.ProcessEnv,
): ConfigError {
  const { adapterVersion, kernelVersion } = error.context
  const cwd = process.cwd()
  const dedupe = adapterVersion === kernelVersion
  const install = dedupe ? DEDUPE_LINES[packageManager(env, cwd)] : installLine([pkg], env, cwd)
  const adapterAt = `${pkg} at a version whose ${TYPES} peer range includes ${String(kernelVersion)}`
  const remedy = dedupe
    ? `Run ${install} so both load one copy.`
    : compareVersions(String(adapterVersion), String(kernelVersion)) < 0
      ? `Install ${adapterAt}.`
      : `Update Nymbal's core (nymbal, @nymbalhq/platform) to a release whose ${TYPES} is at least ${String(adapterVersion)}, or install ${adapterAt}.`
  return new ConfigError(`${error.message} ${remedy}`, {
    code: TYPES_DUPLICATE,
    context: { slot, provider, ...error.context, install },
  })
}

/**
 * Imports `specifier` as the project in `process.cwd()` would, from its own node_modules and the directories above,
 * under the `import` conditions. A store installs its adapters beside its config, not beside the kernel. An adapter
 * that resolves a copy of @nymbalhq/types other than the kernel's is refused before it loads: the kernel's
 * `instanceof` checks would not recognise the errors it throws.
 */
const projectImport = async (specifier: string): Promise<unknown> => {
  const url = resolveFrom(specifier, pathToFileURL(join(process.cwd(), 'package.json')).href)
  const copies = sameTypesCopy(url, import.meta.url)
  if (copies.adapterTypes !== null && copies.adapterTypes !== copies.kernelTypes) {
    throw new ConfigError(
      `${specifier} loads ${TYPES} ${copies.adapterVersion} from ${copies.adapterTypes}, but the kernel loads ${copies.kernelVersion} from ${copies.kernelTypes}: two copies make errors the adapter throws unrecognisable.`,
      { code: TYPES_DUPLICATE, context: { package: specifier, ...copies } },
    )
  }
  return import(url)
}

/**
 * The adapter module the slot's choice resolves to, imported and checked, or `undefined` for `custom` and a built-in.
 * The specifier is imported from the project root, `process.cwd()`. A package that is not installed is
 * `adapter.package_missing` with its install line, or `adapter.provider_unknown` (with a suggestion when one is near)
 * for a convention name no first-party package has; an adapter that resolves another copy of @nymbalhq/types than the
 * kernel's is `adapter.types_duplicate`; any other load error is rethrown as it is.
 */
export async function importAdapterModule(
  slot: Slot,
  choice: Choice,
  env: NodeJS.ProcessEnv,
  importer: (specifier: string) => Promise<unknown> = projectImport,
): Promise<ProviderPackageModule | undefined> {
  const resolution = resolveChoice(slot, choice)
  if (resolution.kind !== 'package') return undefined
  let mod: unknown
  try {
    mod = await importer(resolution.package)
  } catch (error) {
    throw importFailure(slot, choice.provider, resolution, error, env)
  }
  return checkAdapterModule(mod, slot, choice.provider, resolution.package)
}

/** The fields a provider package lets Settings fill: its `settings` export, or none. */
export function declaredSettings(
  mod: ProviderPackageModule | undefined,
): readonly AdapterSetting[] {
  return mod?.settings ?? []
}

/**
 * The adapter the slot's choice resolves to, built from its package, or `undefined` for `custom` and a built-in; it
 * fails as `importAdapterModule` does.
 */
export async function loadProviderAdapter(
  slot: Slot,
  choice: Choice,
  ctx: Omit<AdapterContext, 'slot'>,
): Promise<unknown> {
  const mod = await importAdapterModule(slot, choice, ctx.env)
  if (mod === undefined) return undefined
  return await mod.createAdapter({ ...ctx, slot })
}
