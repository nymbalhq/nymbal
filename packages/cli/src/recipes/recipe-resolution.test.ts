import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conventionPackage, loadConfig } from '@nymbalhq/config'
import type { Recipe, Slot } from '@nymbalhq/types'
import { scaffold } from '../../../create-app/src/index.js'
import { applyRecipeToConfig, RECIPE_HOLDERS, readRecipe } from './index.js'
import {
  copyProject,
  linkedProject,
  linkPackages,
  RECIPE_NAMES,
  REPO,
  removeAll,
  tempDir,
} from './fixtures/linked-project.js'

// AC-11: `nymbal add` and the configs the repo ships use the block form. A recipe that sets one provider is held by
// that provider's convention package; a recipe that sets an infrastructure slot sets `<slot>.provider`; each recipe,
// applied to a fresh create-nymbal-app config, leaves a config loadConfig accepts with the recipe's values; the
// generated config and nymbal.config.example.ts load with the values they always had, in the block form. Each
// STORE_SETS entry through the root config is tests/tooling/store-sets.test.ts.

const dirs: string[] = []
let reader = ''
let scaffolded = ''
let recipes: Recipe[] = []

/** The infrastructure the scaffold and the example have always had, written as blocks. */
const DEFAULT_INFRASTRUCTURE = {
  commandStore: 'sqlite',
  documentStore: { provider: 'in-memory' },
  eventBus: { provider: 'in-process' },
  media: { provider: 'local-fs' },
}

beforeAll(async () => {
  reader = linkedProject('recipe-resolution')
  dirs.push(reader)
  scaffolded = tempDir('recipe-resolution-scaffold')
  dirs.push(scaffolded)
  await scaffold(scaffolded, {
    name: 'Resolution Shop',
    directory: 'resolution-shop',
    currency: 'GBP',
    template: 'astro',
    seedDemo: false,
  })
  linkPackages(scaffolded)
  recipes = await Promise.all(RECIPE_NAMES.map((name) => readRecipe(name, reader)))
}, 60_000)

afterAll(() => removeAll(dirs))

const isEnvRef = (v: unknown): v is { env: string } =>
  typeof v === 'object' && v !== null && typeof (v as { env?: unknown }).env === 'string'

/** Every leaf of a recipe's `set` as a full dotted path; an `{ env }` value is a leaf. */
function leaves(recipe: Recipe): Array<[string, unknown]> {
  const walk = (path: string, value: unknown): Array<[string, unknown]> =>
    typeof value === 'object' && value !== null && !isEnvRef(value)
      ? Object.entries(value).flatMap(([k, v]) => walk(`${path}.${k}`, v))
      : [[path, value]]
  return recipe.set.flatMap(({ path, value }) => walk(path, value))
}

/** The slot and provider a leaf chooses, if it chooses one that lives in a package. */
function choiceOf(path: string, value: unknown): { slot: Slot; provider: string } | undefined {
  if (typeof value !== 'string') return undefined
  const slot =
    /^infrastructure\.(documentStore|eventBus|media)\.provider$/.exec(path)?.[1] ??
    /^commerce\.(\w+)\.provider$/.exec(path)?.[1] ??
    (path === 'security.adapter' ? 'security' : undefined)
  return slot === undefined ? undefined : { slot: slot as Slot, provider: value }
}

const getPath = (source: unknown, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], source)

const placeholder = (name: string): string => `recipe-resolution-${name}`

describe('AC-11: recipes name and set providers by the convention', () => {
  it("AC-11: each recipe that sets one provider is held by conventionPackage of that provider's slot", () => {
    const single = recipes
      .map((recipe) => ({
        name: recipe.name,
        choices: leaves(recipe).flatMap(([path, value]) => choiceOf(path, value) ?? []),
      }))
      .filter((r) => r.choices.length === 1)

    expect(single.map((r) => [r.name, RECIPE_HOLDERS[r.name]])).toEqual(
      single.map((r) => [r.name, conventionPackage(r.choices[0]!.slot, r.choices[0]!.provider)]),
    )
    // s3, stripe and cloudflare each choose one provider.
    expect(single.length).toBeGreaterThanOrEqual(3)
  })

  it('AC-11: every recipe that sets documentStore, eventBus or media sets <slot>.provider, never the slot itself', () => {
    const infra = recipes.flatMap((recipe) =>
      leaves(recipe)
        .filter(([path]) => /^infrastructure\.(documentStore|eventBus|media)(\.|$)/.test(path))
        .map(([path]) => `${recipe.name}: ${path}`),
    )

    expect(infra.filter((line) => !/\.provider$/.test(line))).toEqual([])
    // redis sets two such slots and s3 one: a relation over nothing proves nothing.
    expect(infra.length).toBeGreaterThanOrEqual(3)
  })

  it('AC-11: each recipe, applied to a fresh create-nymbal-app config, leaves a config loadConfig accepts holding the recipe’s values', async () => {
    const source = readFileSync(join(scaffolded, 'nymbal.config.ts'), 'utf8')
    const refused: string[] = []
    for (const recipe of recipes) {
      const project = copyProject(scaffolded, `applied-${recipe.name}`)
      dirs.push(project)
      const applied = applyRecipeToConfig(source, recipe, { force: false })
      if ('conflict' in applied) {
        refused.push(`${recipe.name}: conflict at ${applied.conflict.path}`)
        continue
      }
      writeFileSync(join(project, 'nymbal.config.ts'), applied.source)
      const saved = new Map(recipe.env.map((e) => [e.name, process.env[e.name]]))
      for (const e of recipe.env) process.env[e.name] = placeholder(e.name)
      try {
        const { config } = await loadConfig(project)
        const infra = config.infrastructure as unknown as Record<string, unknown>
        for (const slot of ['documentStore', 'eventBus', 'media']) {
          const provider = (infra[slot] as { provider?: unknown } | undefined)?.provider
          if (typeof provider !== 'string')
            refused.push(`${recipe.name}: ${slot} is ${JSON.stringify(infra[slot])}`)
        }
        for (const [path, value] of leaves(recipe)) {
          const want = isEnvRef(value) ? placeholder(value.env) : value
          if (getPath(config, path) !== want)
            refused.push(`${recipe.name}: ${path} is ${JSON.stringify(getPath(config, path))}`)
        }
      } catch (error) {
        refused.push(`${recipe.name}: ${(error as Error).message}`)
      } finally {
        for (const [name, value] of saved) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      }
    }

    expect(refused).toEqual([])
    expect(recipes.length).toBe(RECIPE_NAMES.length)
  }, 60_000)
})

describe('AC-11: the configs the repo ships load in the block form', () => {
  it('AC-11: the generated config loads with the infrastructure it always had, as blocks', async () => {
    const { config } = await loadConfig(scaffolded)
    expect(config.infrastructure).toEqual(DEFAULT_INFRASTRUCTURE)
  })

  it('AC-11: nymbal.config.example.ts loads with the infrastructure it always had, as blocks, and its providers unchanged', async () => {
    const project = copyProject(scaffolded, 'example')
    dirs.push(project)
    writeFileSync(
      join(project, 'nymbal.config.ts'),
      readFileSync(join(REPO, 'nymbal.config.example.ts'), 'utf8'),
    )
    const { config } = await loadConfig(project)

    expect(config.infrastructure).toEqual(DEFAULT_INFRASTRUCTURE)
    expect(config.security.adapter).toBe('middleware')
    expect(config.commerce.payments.provider).toBe('stripe')
    expect(config.commerce.ai.provider).toBe('anthropic')
  })
})
