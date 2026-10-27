// Reads: pnpm-workspace.yaml, **/package.json, packages/*/recipes/*.json, packages/*/src/index.ts
import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  RECIPE_HOLDERS as HOLDERS,
  readRecipe as read,
} from '../../packages/cli/src/recipes/index.js'
import {
  RECIPE_NAMES,
  SPEC_HOLDERS,
  linkedProject,
  removeAll,
} from '../../packages/cli/src/recipes/fixtures/linked-project.js'
import type {
  SpecRecipe as Recipe,
  SpecRecipeValue as RecipeValue,
} from '../../packages/cli/src/recipes/fixtures/linked-project.js'
import { REPO_ROOT, workspaceMembers, type Manifest } from './workspace-manifests'

// AC-1, the architecture half: RECIPE_HOLDERS names only packages whose recipes/ holds that recipe, and every recipe a
// package ships is in it; each holder lists recipes/ in `files` and exports `./recipes/*`; the packed tarball carries
// the same JSON readRecipe reads; no recipe sets a credential or `prefix: ''`, and every key or secret it sets is an
// `env()` value.

interface HolderManifest extends Manifest {
  exports?: Record<string, unknown>
}

const RECIPE_HOLDERS: Readonly<Record<string, string>> = HOLDERS
const exec = promisify(execFile)
const readRecipe = (name: string, root: string): Promise<Recipe> => read(name, root)

const dirs: string[] = []
let project = ''

beforeAll(() => {
  project = linkedProject('holders')
  dirs.push(project)
})
afterAll(() => removeAll(dirs))

const members = workspaceMembers()
const dirOf = (pkg: string): string | undefined => members.find((m) => m.manifest.name === pkg)?.dir

/** Every `<member>/recipes/<name>.json` on disk, as `name -> package`, sorted by name. */
function shippedRecipes(): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const { dir, manifest } of members) {
    const recipes = join(REPO_ROOT, dir, 'recipes')
    if (dir === '' || !existsSync(recipes)) continue
    for (const file of readdirSync(recipes)) {
      if (file.endsWith('.json')) out.push([file.slice(0, -'.json'.length), manifest.name ?? dir])
    }
  }
  return out.sort(([a], [b]) => a.localeCompare(b))
}

/** Every file under `dir`, but node_modules and dist, relative to the repository. */
function filesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      if (entry === 'node_modules' || entry === 'dist') continue
      const full = join(at, entry)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(relative(REPO_ROOT, full))
    }
  }
  walk(dir)
  return out
}

function isEnvRef(v: unknown): v is { env: string } {
  return typeof v === 'object' && v !== null && typeof (v as { env?: unknown }).env === 'string'
}

function leaves(recipe: Recipe): Array<[string, RecipeValue]> {
  const walk = (path: string, value: RecipeValue): Array<[string, RecipeValue]> =>
    typeof value === 'object' && !isEnvRef(value)
      ? Object.entries(value).flatMap(([k, v]) => walk(`${path}.${k}`, v as RecipeValue))
      : [[path, value]]
  return recipe.set.flatMap(({ path, value }) => walk(path, value))
}

const last = (path: string): string => path.split('.').pop()!

/** The recipe's leaves, each path prefixed with the recipe's name. */
function labelled(recipe: Recipe): Array<[string, RecipeValue]> {
  return leaves(recipe).map(([path, value]): [string, RecipeValue] => [
    `${recipe.name}: ${path}`,
    value,
  ])
}

/** The key or secret leaves whose value is not an env() call. */
function literalSecrets(all: Array<[string, RecipeValue]>): string[] {
  return all
    .filter(([path, value]) => /key|secret|password|token/i.test(last(path)) && !isEnvRef(value))
    .map(([path]) => path)
}

/** What a workspace package exports as `settings`, read from its source entry; none when it exports none. */
async function declaredSettings(pkg: string): Promise<Array<{ path: string }>> {
  const dir = dirOf(pkg)
  expect(dir, `${pkg} is a workspace member`).toBeDefined()
  const mod = (await import(join(REPO_ROOT, dir!, 'src/index.ts'))) as { settings?: unknown }
  return Array.isArray(mod.settings) ? (mod.settings as Array<{ path: string }>) : []
}

/** The leaves at `commerce.<slot>.config.<p>` where `p` is a declared path or inside one. */
function declaredSet(
  all: Array<[string, RecipeValue]>,
  declared: Array<{ path: string }>,
): string[] {
  return all
    .filter(([path]) => {
      const inConfig = /^[^:]+: commerce\.[^.]+\.config\.(.+)$/.exec(path)?.[1]
      return (
        inConfig !== undefined &&
        declared.some((d) => inConfig === d.path || inConfig.startsWith(`${d.path}.`))
      )
    })
    .map(([path]) => path)
}

describe('AC-1: recipe holders', () => {
  it('AC-1: RECIPE_HOLDERS maps the five recipes to the packages that ship them', () => {
    expect(RECIPE_HOLDERS).toEqual(SPEC_HOLDERS)
  })

  it('AC-1: the recipes the workspace packages ship are exactly RECIPE_HOLDERS, each in its holder', () => {
    const holders = Object.entries(RECIPE_HOLDERS).sort(([a], [b]) => a.localeCompare(b))
    expect(shippedRecipes()).toEqual(holders)
  })

  it('AC-1: the CLI holds no recipe file', () => {
    const recipeFiles = new Set(RECIPE_NAMES.map((n) => `${n}.json`))
    const inCli = filesUnder(join(REPO_ROOT, 'packages/cli')).filter((f) =>
      recipeFiles.has(f.split('/').pop()!),
    )
    expect(inCli).toEqual([])
  })

  it('AC-1: each holder lists recipes in files and exports ./recipes/*', () => {
    for (const pkg of new Set(Object.values(RECIPE_HOLDERS))) {
      const dir = dirOf(pkg)
      expect(dir, `${pkg} is a workspace member`).toBeDefined()
      const manifest = JSON.parse(
        readFileSync(join(REPO_ROOT, dir!, 'package.json'), 'utf8'),
      ) as HolderManifest
      const files = Array.isArray(manifest.files) ? (manifest.files as string[]) : []
      expect(
        files.filter((f) => f.replace(/^\.\//, '').replace(/\/$/, '') === 'recipes'),
        `${pkg} files`,
      ).toHaveLength(1)
      expect(manifest.exports?.['./recipes/*'], `${pkg} exports`).toBe('./recipes/*')
    }
  })

  it("AC-1: each holder's packed tarball carries recipes/<name>.json, and it is what readRecipe reads", async () => {
    // `--dry-run` lists what the tarball would hold without writing it; npm packs each listed file as it is on disk.
    const packs = await Promise.all(
      Object.entries(RECIPE_HOLDERS).map(async ([name, pkg]) => {
        const { stdout } = await exec('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], {
          cwd: join(REPO_ROOT, dirOf(pkg)!),
          encoding: 'utf8',
        })
        const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>
        return { name, pkg, files: packed!.files.map((f) => f.path) }
      }),
    )
    for (const { name, pkg, files } of packs) {
      expect(
        files.filter((p) => p === `recipes/${name}.json`),
        `${pkg} tarball`,
      ).toHaveLength(1)
      const packed = JSON.parse(
        readFileSync(join(REPO_ROOT, dirOf(pkg)!, 'recipes', `${name}.json`), 'utf8'),
      ) as unknown
      expect(packed, name).toEqual(await readRecipe(name, project))
    }
  }, 60_000)

  it("AC-1: no recipe sets a credential or prefix: '', and every key or secret it sets is an env() value", async () => {
    const all: Array<[string, RecipeValue]> = []
    for (const name of RECIPE_NAMES) {
      const recipe = await readRecipe(name, project)
      all.push(...labelled(recipe))
    }
    expect(
      all.filter(([path]) => /(^|\.| )s3\.[^.]*key|accessKeyId$|secretAccessKey$/i.test(path)),
    ).toEqual([])
    expect(all.filter(([path, value]) => last(path) === 'prefix' && value === '')).toEqual([])
    expect(literalSecrets(all)).toEqual([])
  })

  // A field a provider package declares in `settings` is the admin's or `.env`'s to fill, so the recipe leaves it out
  // of `set` (an env() there throws before Settings are read). No shipped recipe sets a key or secret, so the check
  // above runs on nothing shipped; the property below keeps it live.
  it('AC-1: no shipped recipe sets a field its holder or an installed provider declares in settings', async () => {
    let pairs = 0
    const offending: string[] = []
    for (const name of RECIPE_NAMES) {
      const recipe = await readRecipe(name, project)
      const pkgs = new Set([
        RECIPE_HOLDERS[name]!,
        ...recipe.install.filter((p) => p.startsWith('@nymbalhq/')),
      ])
      for (const pkg of pkgs) {
        const declared = await declaredSettings(pkg)
        pairs += declared.length
        offending.push(
          ...declaredSet(labelled(recipe), declared).map((p) => `${pkg} declares ${p}`),
        )
      }
    }
    expect(offending).toEqual([])
    // The stripe recipe and @nymbalhq/adapter-stripe's three fields: the check above ran on something.
    expect(pairs).toBeGreaterThanOrEqual(3)
  }, 30_000) // imports every holder's src entry: 1 s alone, 5.5 s beside a gate:full (2026-10-22)

  it('AC-1: on a generated recipe that writes env() at a declared key or secret, both checks see it, and a literal in its place is refused', async () => {
    const declared = await declaredSettings(RECIPE_HOLDERS['stripe']!)
    const secretPaths = declared
      .map((d) => d.path)
      .filter((p) => /key|secret|password|token/i.test(last(p)))
    expect(secretPaths.length).toBeGreaterThan(0)
    fc.assert(
      fc.property(
        fc.constantFrom(...secretPaths),
        fc.stringMatching(/^SETTINGS_[A-Z][A-Z0-9_]{0,10}$/),
        fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/),
        fc.boolean(),
        (field, envName, literal, nested) => {
          const at = (value: RecipeValue): Recipe => ({
            name: 'generated',
            summary: 'A generated recipe that writes a declared field',
            install: [],
            set: nested
              ? [
                  {
                    path: 'commerce.payments',
                    value: { provider: 'stripe', config: { [field]: value } },
                  },
                ]
              : [{ path: `commerce.payments.config.${field}`, value }],
            env: [{ name: envName, example: '', required: true, comment: '' }],
            next: [],
          })
          const viaEnv = labelled(at({ env: envName }))
          expect(
            viaEnv.filter(([path]) => /key|secret|password|token/i.test(last(path))).length,
          ).toBeGreaterThan(0)
          expect(literalSecrets(viaEnv)).toEqual([])
          expect(declaredSet(viaEnv, declared)).toEqual([
            `generated: commerce.payments.config.${field}`,
          ])
          const viaLiteral = labelled(at(literal))
          expect(literalSecrets(viaLiteral)).toEqual([
            `generated: commerce.payments.config.${field}`,
          ])
        },
      ),
      { numRuns: 50 },
    )
  }, 30_000) // imports the stripe holder's src entry: the same load as the case above when run alone
})
