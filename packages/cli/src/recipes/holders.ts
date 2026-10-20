import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Recipe } from '@nymbalhq/types'

/**
 * Each recipe `nymbal add` knows, and the package that ships it as `recipes/<name>.json`. The recipe itself is data in
 * that package, so a package brings its own recipe; this table only says where to look.
 */
export const RECIPE_HOLDERS: Readonly<Record<string, string>> = {
  postgres: '@nymbalhq/platform',
  redis: '@nymbalhq/doc-store-redis',
  s3: '@nymbalhq/media-s3',
  stripe: '@nymbalhq/adapter-stripe',
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

/** Where the project resolves `<holder>/recipes/<name>.json`, or null when the holder is not installed there. */
export function recipeFile(name: string, projectRoot: string): string | null {
  const holder = RECIPE_HOLDERS[name]
  if (holder === undefined || !isKnownRecipe(name)) throw unknownRecipe(name)
  const dir = packageDir(holder, projectRoot)
  if (dir === null) return null
  try {
    // From the holder's own manifest the specifier resolves through its `exports`, as from the project.
    return createRequire(join(dir, 'package.json')).resolve(`${holder}/recipes/${name}.json`)
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null
    throw error
  }
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
