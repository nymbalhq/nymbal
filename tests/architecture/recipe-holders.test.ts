import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
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
  tempDir,
} from '../../packages/cli/src/recipes/fixtures/linked-project.js'
import type {
  SpecRecipe as Recipe,
  SpecRecipeValue as RecipeValue,
} from '../../packages/cli/src/recipes/fixtures/linked-project.js'
import { REPO_ROOT, workspaceMembers, type Manifest } from './workspace-manifests'

// Acceptance tests for P2-03 AC-1, the architecture half (spec P2-03-nymbal-add-recipe, decision 1 and the
// invariants): RECIPE_HOLDERS names only packages whose recipes/ holds that recipe, and every recipe a package ships is
// in it; each holder lists recipes/ in `files` and exports `./recipes/*`; the packed tarball carries the same JSON
// readRecipe reads; no recipe sets a credential or `prefix: ''`, and every key or secret it sets is an `env()` value.
// Kills: a recipe kept in the CLI, one a holder does not publish or export, and a recipe that writes a secret.

interface HolderManifest extends Manifest {
  exports?: Record<string, unknown>
}

const RECIPE_HOLDERS: Readonly<Record<string, string>> = HOLDERS
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

describe('P2-03 AC-1: recipe holders', () => {
  it('AC-1 (and P2-04 AC-9): RECIPE_HOLDERS maps the five recipes to the packages decision 1 and P2-04 name', () => {
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
    for (const [name, pkg] of Object.entries(RECIPE_HOLDERS)) {
      const out = tempDir(`pack-${name}`)
      dirs.push(out)
      const printed = execFileSync(
        'npm',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', out],
        {
          cwd: join(REPO_ROOT, dirOf(pkg)!),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
      const [packed] = JSON.parse(printed) as Array<{
        filename: string
        files: Array<{ path: string }>
      }>
      expect(
        packed!.files.map((f) => f.path).filter((p) => p === `recipes/${name}.json`),
        `${pkg} tarball`,
      ).toHaveLength(1)
      execFileSync('tar', [
        '-xzf',
        join(out, packed!.filename),
        '-C',
        out,
        `package/recipes/${name}.json`,
      ])
      const inTarball = JSON.parse(
        readFileSync(join(out, 'package/recipes', `${name}.json`), 'utf8'),
      ) as unknown
      expect(inTarball, name).toEqual(await readRecipe(name, project))
    }
  }, 60_000)

  it("AC-1: no recipe sets a credential or prefix: '', and every key or secret it sets is an env() value", async () => {
    const all: Array<[string, RecipeValue]> = []
    for (const name of RECIPE_NAMES) {
      const recipe = await readRecipe(name, project)
      all.push(
        ...leaves(recipe).map(([path, value]): [string, RecipeValue] => [
          `${name}: ${path}`,
          value,
        ]),
      )
    }
    const last = (path: string): string => path.split('.').pop()!
    expect(
      all.filter(([path]) => /(^|\.| )s3\.[^.]*key|accessKeyId$|secretAccessKey$/i.test(path)),
    ).toEqual([])
    expect(all.filter(([path, value]) => last(path) === 'prefix' && value === '')).toEqual([])
    const secrets = all.filter(([path]) => /key|secret|password|token/i.test(last(path)))
    expect(secrets.filter(([, value]) => !isEnvRef(value))).toEqual([])
    // The stripe recipe's secretKey and webhookSecret: the check above ran on something.
    expect(secrets.length).toBeGreaterThanOrEqual(2)
  })
})
