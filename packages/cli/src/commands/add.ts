import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'
import { defineCommand } from 'citty'
import { resolve as resolveFrom } from 'import-meta-resolve'
import pc from 'picocolors'
import {
  ADAPTER_CATALOGUE,
  BUILT_IN,
  PROVIDER_NAME,
  conventionPackage,
  findConfigFile,
  loadConfig,
  slotFolder,
  suggestProvider,
} from '@nymbalhq/config'
import { checkAdapterModule, installLine, missingPackage, resolveChoice } from '@nymbalhq/platform'
import type { AdapterSetting, Recipe, Slot } from '@nymbalhq/types'
import {
  MULTI_SLOT_PAIRS,
  RECIPE_HOLDERS,
  appendRecipeEnv,
  applyRecipeToConfig,
  envCalls,
  isInstalled,
  isKnownRecipe,
  knownRecipes,
  missingEnv,
  multiSlotRecipe,
  packageRecipeFile,
  readRecipe,
  readRecipeFile,
  recipeFile,
  setsOnly,
  settingsEnv,
  slotRecipe,
  slotsSetBy,
} from '../recipes/index.js'
import { slotNamed } from '../slot-names.js'

/** What `nymbal add` adds: a recipe by name, a slot's provider, or a third-party adapter package. */
export type AddTarget =
  | { kind: 'recipe'; name: string }
  | { kind: 'slot'; slot: Slot; provider: string }
  | { kind: 'package'; name: string }

export interface AddOptions {
  target: AddTarget
  install: boolean
  force: boolean
  dryRun: boolean
}

const SLOTS = Object.keys(ADAPTER_CATALOGUE) as Slot[]

/** A scoped npm package name, `@scope/name`: how a third-party adapter is named. */
const PACKAGE_NAME = /^@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*$/

const usageHint = (): string =>
  `nymbal add takes <recipe> (${knownRecipes().join(', ')}), <slot> <provider> or <package> (a scoped npm name, @scope/name)`

/** How the command line's positionals name what to add, or why they name nothing. */
export function parseAddTarget(args: string[]): AddTarget | { error: string } {
  if (args.length === 1) {
    const name = args[0]!
    if (isKnownRecipe(name)) return { kind: 'recipe', name }
    if (PACKAGE_NAME.test(name)) return { kind: 'package', name }
    const slot = slotNamed(name)
    if (slot !== undefined) {
      return {
        error: `name the ${slotFolder(slot)} provider: nymbal add ${slotFolder(slot)} <provider>, one of ${Object.keys(ADAPTER_CATALOGUE[slot]).join(', ')}. ${usageHint()}`,
      }
    }
    return { error: `unknown name '${name}'. ${usageHint()}` }
  }
  if (args.length === 2) {
    const [word, provider] = args as [string, string]
    const slot = slotNamed(word)
    if (slot === undefined)
      return { error: `unknown slot '${word}'; the slots are ${SLOTS.map(slotFolder).join(', ')}` }
    return { kind: 'slot', slot, provider }
  }
  return {
    error: `${args.length === 0 ? 'name what to add' : `nymbal add takes one or two names, not ${args.length}`}. ${usageHint()}`,
  }
}

/** `nymbal add`'s list: its three forms, every slot with the providers Nymbal ships, and the recipes. */
export function addUsage(): string {
  const forms: Array<[string, string]> = [
    ['nymbal add <recipe>', `a service, as in nymbal add redis: ${knownRecipes().join(', ')}`],
    ['nymbal add <slot> <provider>', 'one slot on a provider, as in nymbal add media s3'],
    ['nymbal add <package>', 'a third-party adapter by its npm name, as in nymbal add @acme/x'],
  ]
  const lines = ['Forms:']
  for (const [form, what] of forms) lines.push(`  ${form.padEnd(30)}${what}`)
  lines.push('', 'Slots and the providers Nymbal ships:')
  for (const slot of SLOTS) {
    const providers = Object.entries(ADAPTER_CATALOGUE[slot]).map(([provider, entry]) =>
      entry.builtIn === true ? `${provider} (built in)` : provider,
    )
    lines.push(`  ${slotFolder(slot)}: ${providers.join(', ')}`)
  }
  return lines.join('\n')
}

const out = (line = ''): void => void process.stdout.write(`${line}\n`)
const err = (line: string): void => void process.stderr.write(`${line}\n`)

function fail(message: string): number {
  err(pc.red(`✗ ${message}`))
  return 1
}

/** Runs an install line in the project, its output passed through; whether it succeeded. */
function runInstall(line: string, root: string): boolean {
  out(pc.dim(`$ ${line}`))
  const [command, ...args] = line.split(' ')
  const result = spawnSync(command!, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return result.status === 0
}

/** The variables `.env` sets to something, which `nymbal dev` loads before the config. */
function dotEnv(root: string): Record<string, string> {
  const file = join(root, '.env')
  return existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Record<string, string>) : {}
}

const isSet = (name: string, fromFile: Record<string, string>): boolean =>
  (process.env[name] ?? '') !== '' || (fromFile[name] ?? '') !== ''

/**
 * Why the candidate config would not run, without connecting to anything: a recipe package the project does not
 * resolve, or a config `loadConfig` refuses (the schema and its cross-slot rules). The candidate is loaded as
 * `nymbal.config.ts` from a temp directory under the project, so `@nymbalhq/config` resolves as the real one does. For
 * that load only, every variable `.env` sets applies as `nymbal dev` loads it, whatever reads it (`env()`,
 * `envNumber()`, `process.env`), and a variable an `env()` call names that is still unset gets a placeholder unless
 * its calls have a default, which is what runs.
 */
async function problemsWith(
  candidate: string,
  recipe: Recipe,
  root: string,
  fromFile: Record<string, string>,
): Promise<string[]> {
  const problems: string[] = []
  const missing = recipe.install.filter((pkg) => !isInstalled(pkg, root))
  if (missing.length > 0) {
    problems.push(
      `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed: ${installLine(missing, process.env, root)}`,
    )
  }
  const saved = new Map<string, string | undefined>()
  const assign = (name: string, value: string): void => {
    if (!saved.has(name)) saved.set(name, process.env[name])
    process.env[name] = value
  }
  for (const [name, value] of Object.entries(fromFile)) {
    if ((process.env[name] ?? '') === '' && value !== '') assign(name, value)
  }
  for (const { name, defaulted } of envCalls(candidate)) {
    if ((process.env[name] ?? '') === '' && !defaulted)
      assign(name, `nymbal-add-placeholder-${name}`)
  }
  const dir = mkdtempSync(join(root, '.nymbal-add-'))
  try {
    writeFileSync(join(dir, 'nymbal.config.ts'), candidate)
    await loadConfig(dir)
  } catch (error) {
    problems.push((error as Error).message)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  return problems
}

/** The lines of `after` that `before` lacks (`+`) and the reverse (`-`), by a longest common subsequence. */
function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!)
  const lines: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (j < b.length && (i === a.length || t[i]![j + 1]! >= t[i + 1]![j]!)) {
      lines.push(pc.green(`+ ${b[j++]}`))
    } else {
      lines.push(pc.red(`- ${a[i++]}`))
    }
  }
  return lines
}

const show = (value: unknown): string =>
  typeof value === 'string' ? `'${value}'` : JSON.stringify(value)

/** What one run applies: the recipe, the arguments as given, how messages name it, and whose settings to read. */
interface Plan {
  recipe: Recipe
  /** The arguments as typed: `payments stripe`, `@acme/nymbal-search-x`, `stripe`. */
  label: string
  /** The subject of a refusal: `the stripe recipe`, `nymbal add ai anthropic`. */
  what: string
  /** The packages whose `settings` say which variables the admin's Settings can fill. */
  adapters: string[]
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The command that uninstalls `pkg` with the package manager `installLine` picks. */
function removeLine(pkg: string, root: string): string {
  return installLine([pkg], process.env, root).replace(
    /^(\S+) \S+/,
    (_, pm: string) => `${pm} ${pm === 'npm' ? 'uninstall' : 'remove'}`,
  )
}

/**
 * Installs `packages` when `pkg` is not installed in the project; the exit code of a refusal or a failed install, else
 * null. A dry run and `--no-install` install nothing, so they need `pkg` installed already.
 */
function ensureInstalled(
  pkg: string,
  packages: string[],
  notInstalled: string,
  root: string,
  opts: AddOptions,
  installed: string[],
): number | null {
  if (isInstalled(pkg, root)) return null
  const line = installLine(packages, process.env, root)
  if (!opts.install || opts.dryRun) return fail(`${notInstalled}. Install it: ${line}`)
  if (!runInstall(line, root)) return fail(`${line} failed`)
  installed.push(...packages)
  return null
}

/** `pkg` imported as the project resolves it, from the config's directory. */
async function importFromProject(pkg: string, root: string): Promise<Record<string, unknown>> {
  const mod = (await import(resolveFrom(pkg, pathToFileURL(join(root, 'package.json')).href))) as
    | Record<string, unknown>
    | undefined
  return mod ?? {}
}

/** Why `pkg` did not load, with the install line of a package it imports that is not installed. */
function loadFailure(pkg: string, error: unknown, root: string): string {
  const missing = missingPackage(error)
  const install =
    missing === null || missing === pkg ? '' : `: ${installLine([missing], process.env, root)}`
  return `${pkg} could not be loaded: ${messageOf(error)}${install}`
}

/** The recipe a package ships for `slot`, refused toward its own name when it sets any other slot as well. */
async function packageRecipe(file: string, provider: string, slot: Slot): Promise<Recipe | number> {
  const recipe = await readRecipeFile(file, provider)
  if (!setsOnly(recipe, slot)) {
    return fail(
      `${recipe.name} sets ${slotsSetBy(recipe).join(' and ')} together: run nymbal add ${recipe.name}`,
    )
  }
  return recipe
}

async function recipePlan(
  name: string,
  root: string,
  opts: AddOptions,
  installed: string[],
): Promise<Plan | number> {
  const holder = RECIPE_HOLDERS[name]!
  if (recipeFile(name, root) === null) {
    const failed = ensureInstalled(
      holder,
      [holder],
      `the ${name} recipe ships in ${holder}, which is not installed`,
      root,
      opts,
      installed,
    )
    if (failed !== null) return failed
  }
  const recipe = await readRecipe(name, root)
  return { recipe, label: name, what: `the ${name} recipe`, adapters: recipe.install }
}

async function slotPlan(
  slot: Slot,
  provider: string,
  root: string,
  opts: AddOptions,
  installed: string[],
): Promise<Plan | number> {
  const label = `${slotFolder(slot)} ${provider}`
  const kind = slot === 'security' ? 'security adapter' : `${slotFolder(slot)} provider`
  if (!PROVIDER_NAME.test(provider)) {
    return fail(`'${provider}' is no provider name: lower-case letters, digits and hyphens`)
  }
  if (provider === 'custom') {
    return fail('custom is an adapter you pass to createApp: there is no package to add')
  }
  if (!Object.hasOwn(ADAPTER_CATALOGUE[slot], provider)) {
    const suggestion = suggestProvider(slot, provider)
    return fail(
      suggestion === undefined
        ? `unknown ${kind} '${provider}': no first-party adapter is named that; a third-party one: nymbal add <package>`
        : `unknown ${kind} '${provider}'; did you mean '${suggestion}'?`,
    )
  }
  const owner = multiSlotRecipe(slot, provider)
  if (owner !== undefined) {
    const slots = MULTI_SLOT_PAIRS[owner]!.map((pair) => slotFolder(pair.split('/')[0] as Slot))
    return fail(`${owner} sets ${slots.join(' and ')} together: run nymbal add ${owner}`)
  }

  const what = `nymbal add ${label}`
  const resolution = resolveChoice(slot, { provider })
  if (resolution.kind !== 'package') {
    const recipe = slotRecipe({ name: label, slot, provider, install: [], settings: [] })
    return { recipe, label, what, adapters: [] }
  }
  const pkg = resolution.package
  const packages = [pkg, ...(resolution.sdk === undefined ? [] : [resolution.sdk])]
  const failed = ensureInstalled(
    pkg,
    packages,
    `${label} is ${pkg}, which is not installed`,
    root,
    opts,
    installed,
  )
  if (failed !== null) return failed

  const file = packageRecipeFile(pkg, provider, root)
  if (file !== null) {
    const recipe = await packageRecipe(file, provider, slot)
    if (typeof recipe === 'number') return recipe
    return { recipe, label, what: `the ${recipe.name} recipe`, adapters: recipe.install }
  }
  let settings: readonly AdapterSetting[]
  try {
    settings =
      checkAdapterModule(await importFromProject(pkg, root), slot, provider, pkg).settings ?? []
  } catch (error) {
    return fail(
      (error as { code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
        ? loadFailure(pkg, error, root)
        : messageOf(error),
    )
  }
  const recipe = slotRecipe({ name: label, slot, provider, install: packages, settings })
  return { recipe, label, what, adapters: [pkg] }
}

async function packagePlan(
  name: string,
  root: string,
  opts: AddOptions,
  installed: string[],
): Promise<Plan | number> {
  const failed = ensureInstalled(name, [name], `${name} is not installed`, root, opts, installed)
  if (failed !== null) return failed
  // A package this run installed stays installed when it is refused: the refusal says how to remove it.
  const refuse = (why: string): number =>
    fail(
      installed.includes(name)
        ? `${why}\n  ${name} stays installed; ${removeLine(name, root)} removes it`
        : why,
    )

  let mod: Record<string, unknown>
  try {
    mod = await importFromProject(name, root)
  } catch (error) {
    return refuse(loadFailure(name, error, root))
  }
  const { slot, provider } = mod
  if (slot === undefined) return refuse(`${name} exports no slot`)
  if (typeof slot !== 'string' || !(SLOTS as string[]).includes(slot)) {
    return refuse(
      `${name} exports slot ${show(slot)}, which is no slot; the slots are ${SLOTS.join(', ')}`,
    )
  }
  const at = slot as Slot
  if (provider === undefined) return refuse(`${name} exports no provider`)
  if (typeof provider !== 'string' || !PROVIDER_NAME.test(provider)) {
    return refuse(
      `${name} exports provider ${show(provider)}, which is no provider name: lower-case letters, digits and hyphens`,
    )
  }
  if (provider === 'custom') {
    return refuse(`${name} exports provider 'custom', the name of an adapter passed to createApp`)
  }
  if (BUILT_IN[at].includes(provider)) {
    return refuse(
      `${name} exports provider '${provider}', the name of the built-in ${slotFolder(at)} provider`,
    )
  }
  let settings: readonly AdapterSetting[]
  try {
    settings = checkAdapterModule(mod, at, provider, name).settings ?? []
  } catch (error) {
    return refuse(messageOf(error))
  }

  const file = packageRecipeFile(name, provider, root)
  if (file !== null) {
    const recipe = await packageRecipe(file, provider, at)
    if (typeof recipe === 'number') return recipe
    return { recipe, label: name, what: `the ${recipe.name} recipe`, adapters: recipe.install }
  }
  const convention = conventionPackage(at, provider) === name
  const sdk = convention ? ADAPTER_CATALOGUE[at][provider]?.sdk : undefined
  const recipe = slotRecipe({
    name,
    slot: at,
    provider,
    package: convention ? undefined : name,
    install: [name, ...(sdk === undefined ? [] : [sdk])],
    settings,
  })
  return { recipe, label: name, what: `nymbal add ${name}`, adapters: [name] }
}

export async function add(opts: AddOptions, cwd: string = process.cwd()): Promise<number> {
  const { target } = opts
  if (target.kind === 'recipe' && !isKnownRecipe(target.name)) {
    return fail(`unknown recipe '${target.name}'. ${usageHint()}`)
  }
  const configPath = findConfigFile(cwd)
  if (configPath === null) return fail(`no nymbal.config.ts in ${cwd} or any parent directory`)
  const root = dirname(configPath)

  const installed: string[] = []
  const plan =
    target.kind === 'recipe'
      ? await recipePlan(target.name, root, opts, installed)
      : target.kind === 'slot'
        ? await slotPlan(target.slot, target.provider, root, opts, installed)
        : await packagePlan(target.name, root, opts, installed)
  if (typeof plan === 'number') return plan
  const { recipe, label, what } = plan

  const source = readFileSync(configPath, 'utf8')
  let edited: { source: string; changed: string[] }
  try {
    const applied = applyRecipeToConfig(source, recipe, { force: opts.force })
    if ('conflict' in applied) {
      const { path, current, wanted } = applied.conflict
      return fail(
        `${path} is ${show(current)} in nymbal.config.ts, and ${what} sets it to ${show(wanted)}. ` +
          'nymbal.config.ts is unchanged: edit it by hand, or re-run with --force to overwrite it.',
      )
    }
    edited = applied
  } catch (error) {
    return fail((error as Error).message)
  }
  const examplePath = join(root, '.env.example')
  const example = existsSync(examplePath) ? readFileSync(examplePath, 'utf8') : ''
  const nextExample = appendRecipeEnv(example, recipe)

  if (opts.dryRun) {
    out(pc.bold(`nymbal add ${label} --dry-run: nothing is written`))
    out()
    out(
      recipe.install.length > 0
        ? `install: ${installLine(recipe.install, process.env, root)}`
        : 'install: nothing',
    )
    out()
    out('nymbal.config.ts:')
    const diff = lineDiff(source, edited.source)
    for (const line of diff.length > 0 ? diff : ['(already set)']) out(`  ${line}`)
    out()
    out('.env.example:')
    const added = nextExample
      .slice(example.length)
      .split(/\r?\n/)
      .filter((l) => l !== '')
    for (const line of added.length > 0 ? added : ['(every variable already listed)'])
      out(`  ${line}`)
    return 0
  }

  const pending = recipe.install.filter((pkg) => !isInstalled(pkg, root))
  if (pending.length > 0 && opts.install) {
    const line = installLine(pending, process.env, root)
    if (!runInstall(line, root)) return fail(`${line} failed`)
    installed.push(...pending)
  }

  const fromFile = dotEnv(root)
  const problems = await problemsWith(edited.source, recipe, root, fromFile)
  if (problems.length > 0) {
    return fail(
      `${what} would leave a config that does not load, so nymbal.config.ts is unchanged:\n  ${problems.join('\n  ')}`,
    )
  }

  const written: string[] = []
  if (installed.length > 0) written.push(`package.json and its lockfile (${installed.join(', ')})`)
  if (edited.source !== source) {
    writeFileSync(configPath, edited.source)
    written.push(`nymbal.config.ts (${edited.changed.join(', ')})`)
  }
  if (nextExample !== example) {
    writeFileSync(examplePath, nextExample)
    written.push(
      `.env.example (${missingEnv(example, recipe)
        .map((v) => v.name)
        .join(', ')})`,
    )
  }

  out(pc.green(`✓ ${label}: ${recipe.summary}`))
  out(written.length > 0 ? `  changed ${written.join(', ')}` : '  already added: nothing changed')
  const unset = recipe.env.filter((v) => v.required && !isSet(v.name, fromFile))
  if (unset.length > 0 || recipe.next.length > 0) {
    out()
    out('Next:')
    const fromSettings = unset.length > 0 ? await settingsEnv(plan.adapters, root) : new Set()
    for (const v of unset) {
      out(
        fromSettings.has(v.name)
          ? `  - set ${v.name} in .env or in the admin's Settings`
          : `  - set ${v.name} in .env`,
      )
    }
    for (const line of recipe.next) out(`  - ${line}`)
  }
  return 0
}

export const addCommand = defineCommand({
  meta: {
    name: 'add',
    description:
      'Add a provider by slot, a third-party adapter by package, or a service by recipe (nymbal add lists them)',
  },
  args: {
    name: {
      type: 'positional',
      required: false,
      description: '<recipe>, <slot> or <package>',
    },
    provider: {
      type: 'positional',
      required: false,
      description: "after <slot>: the slot's provider",
    },
    install: {
      type: 'boolean',
      default: true,
      description: 'Install the packages (--no-install: they must already be installed)',
    },
    force: {
      type: 'boolean',
      default: false,
      description: 'Overwrite a config value the addition conflicts with',
    },
    'dry-run': {
      type: 'boolean',
      default: false,
      description:
        'Print the config change, the .env.example lines and the install line, and write nothing',
    },
  },
  async run({ args }) {
    const positionals = args._.map(String)
    if (positionals.length === 0) {
      out(addUsage())
      process.exitCode = 1
      return
    }
    const target = parseAddTarget(positionals)
    if ('error' in target) {
      process.exitCode = fail(target.error)
      return
    }
    process.exitCode = await add({
      target,
      install: args.install,
      force: args.force,
      dryRun: args['dry-run'],
    })
  },
})
