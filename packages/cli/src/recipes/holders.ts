import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { conventionPackage } from '@nymbalhq/config'
import type { Recipe } from '@nymbalhq/types'

/**
 * Each recipe `nymbal add` knows, and the package that ships it as `recipes/<name>.json`: the package of the provider a
 * one-provider recipe sets. The recipe itself is data in that package, so a package brings its own recipe; this table
 * only says where to look.
 */
export const RECIPE_HOLDERS: Readonly<Record<string, string>> = {
  algolia: conventionPackage('search', 'algolia'),
  cloudflare: conventionPackage('security', 'cloudflare'),
  postgres: '@nymbalhq/platform',
  // Sets the document store and the bus; the document store's package ships it.
  redis: conventionPackage('documentStore', 'redis'),
  s3: conventionPackage('media', 's3'),
  stripe: conventionPackage('payments', 'stripe'),
}

/**
 * The `<slot>/<provider>` pairs a recipe that sets several slots owns: `nymbal add <slot> <provider>` refuses them
 * toward the recipe, since adding one slot alone would leave the other where it was.
 */
export const MULTI_SLOT_PAIRS: Readonly<Record<string, readonly string[]>> = {
  redis: ['documentStore/redis', 'eventBus/redis-streams'],
}

/** The multi-slot recipe that owns `slot` on `provider`, if one does. */
export function multiSlotRecipe(slot: string, provider: string): string | undefined {
  const pair = `${slot}/${provider}`
  return Object.keys(MULTI_SLOT_PAIRS).find((name) => MULTI_SLOT_PAIRS[name]!.includes(pair))
}

export function knownRecipes(): string[] {
  return Object.keys(RECIPE_HOLDERS).sort()
}

export function isKnownRecipe(name: string): boolean {
  return Object.hasOwn(RECIPE_HOLDERS, name)
}

function unknownRecipe(name: string): Error {
  return new Error(`unknown recipe '${name}': the recipes are ${knownRecipes().join(', ')}`)
}

/**
 * The directory of `pkg` in the `node_modules` of the project or a directory above it, as Node looks for it, or null.
 * Node's global fallbacks are left out: pnpm's shims put its whole store on NODE_PATH, which is no install.
 */
function packageDir(pkg: string, projectRoot: string): string | null {
  let dir = resolve(projectRoot)
  while (true) {
    const candidate = join(dir, 'node_modules', pkg)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Where the project resolves `<pkg>/recipes/<name>.json`, or null when `pkg` is not installed there or ships none. */
export function packageRecipeFile(pkg: string, name: string, projectRoot: string): string | null {
  const dir = packageDir(pkg, projectRoot)
  if (dir === null) return null
  try {
    // From the package's own manifest the specifier resolves through its `exports`, as from the project.
    return createRequire(join(dir, 'package.json')).resolve(`${pkg}/recipes/${name}.json`)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null
    throw error
  }
}

/** Where the project resolves `<holder>/recipes/<name>.json`, or null when the holder is not installed there. */
export function recipeFile(name: string, projectRoot: string): string | null {
  const holder = RECIPE_HOLDERS[name]
  if (holder === undefined || !isKnownRecipe(name)) throw unknownRecipe(name)
  return packageRecipeFile(holder, name, projectRoot)
}

export function isInstalled(pkg: string, projectRoot: string): boolean {
  return packageDir(pkg, projectRoot) !== null
}

/** The recipe the holder installed in the project ships, read through Node resolution from the project root. */
export async function readRecipe(name: string, projectRoot: string): Promise<Recipe> {
  const file = recipeFile(name, projectRoot)
  if (file === null) {
    throw new Error(
      `${RECIPE_HOLDERS[name]} is not installed in ${projectRoot}, so its ${name} recipe cannot be read`,
    )
  }
  return readRecipeFile(file, name)
}

/** The recipe `name` in `file`, checked for the shape `nymbal add` applies. */
export async function readRecipeFile(file: string, name: string): Promise<Recipe> {
  const recipe = JSON.parse(await readFile(file, 'utf8')) as Recipe
  const malformed =
    recipe === null ||
    typeof recipe !== 'object' ||
    recipe.name !== name ||
    !Array.isArray(recipe.install) ||
    !Array.isArray(recipe.set) ||
    !Array.isArray(recipe.env) ||
    !Array.isArray(recipe.next)
  if (malformed) throw new Error(`${file} is not a ${name} recipe`)
  return recipe
}

/** The ESM entry of a package directory: its `exports['.']` import condition, else `module`, else `main`. */
function entryOf(dir: string, manifest: Record<string, unknown>): string | null {
  const exportsField = manifest['exports'] as Record<string, unknown> | string | undefined
  const root = typeof exportsField === 'object' ? exportsField['.'] : exportsField
  const entry =
    typeof root === 'string'
      ? root
      : typeof root === 'object' && root !== null
        ? ((root as Record<string, unknown>)['import'] ??
          (root as Record<string, unknown>)['default'])
        : (manifest['module'] ?? manifest['main'])
  return typeof entry === 'string' ? join(dir, entry) : null
}

/**
 * The environment variables the packages in `packages` declare as settings (their `settings` export), as the project
 * has them installed: a variable the admin's Settings can fill as well as `.env`. A package that is not installed, or
 * whose SDK is not yet, declares nothing here.
 */
export async function settingsEnv(
  packages: readonly string[],
  projectRoot: string,
): Promise<Set<string>> {
  const names = new Set<string>()
  for (const pkg of packages) {
    const dir = packageDir(pkg, projectRoot)
    if (dir === null) continue
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const entry = entryOf(dir, manifest)
    if (entry === null || !existsSync(entry)) continue
    let mod: { settings?: unknown }
    try {
      mod = (await import(pathToFileURL(entry).href)) as { settings?: unknown }
    } catch {
      // Only a hint is built from this, after the files are written: a module that fails to load (an SDK left out by
      // `--no-install`, or one that throws on import) leaves the hint naming `.env` alone.
      continue
    }
    if (!Array.isArray(mod.settings)) continue
    for (const setting of mod.settings as Array<{ env?: unknown }>) {
      if (typeof setting?.env === 'string') names.add(setting.env)
    }
  }
  return names
}
