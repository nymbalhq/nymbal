import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import { PROVIDER_PACKAGES } from '@nymbalhq/platform'
import { scaffold } from '../../../create-app/src/index.js'
import { readRecipe } from './index.js'
import {
  RECIPE_NAMES,
  SPEC_HOLDERS,
  linkedProject,
  linkPackages,
  removeAll,
  tempDir,
} from './fixtures/linked-project.js'
import type {
  SpecRecipe as Recipe,
  SpecRecipeValue as RecipeValue,
} from './fixtures/linked-project.js'

// AC-1, the unit half: each recipe is data its holder package ships under `./recipes/*`, has the `Recipe` shape,
// leaves the scaffold's config parsing, and installs the package and SDK the loader asks for. The architecture half is
// tests/architecture/recipe-holders.test.ts.

const dirs: string[] = []
let project = ''
let scaffolded: NymbalConfig

beforeAll(async () => {
  project = linkedProject('recipes')
  dirs.push(project)
  const dir = tempDir('scaffold')
  dirs.push(dir)
  await scaffold(dir, {
    name: 'Recipe Shop',
    directory: 'recipe-shop',
    currency: 'GBP',
    template: 'astro',
    seedDemo: false,
  })
  linkPackages(dir)
  scaffolded = (await loadConfig(dir)).config
}, 60_000)

afterAll(() => removeAll(dirs))

/** A `{ env }` value as the config sees it once the variable is set: a stand-in naming the variable. */
const placeholder = (name: string): string => `recipes-placeholder-${name}`

function isEnvRef(v: unknown): v is { env: string; default?: string } {
  return typeof v === 'object' && v !== null && typeof (v as { env?: unknown }).env === 'string'
}

/** Why `v` is not a `RecipeValue`, or nothing. */
function valueProblems(v: unknown, at: string): string[] {
  if (typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return []
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return [`${at}: not a RecipeValue`]
  if ('env' in v) {
    const extra = Object.keys(v).filter((k) => k !== 'env' && k !== 'default')
    const d = (v as { default?: unknown }).default
    return [
      ...(typeof (v as { env: unknown }).env === 'string' ? [] : [`${at}.env: not a string`]),
      ...(d === undefined || typeof d === 'string' ? [] : [`${at}.default: not a string`]),
      ...extra.map((k) => `${at}.${k}: not in an env value`),
    ]
  }
  return Object.entries(v).flatMap(([k, inner]) => valueProblems(inner, `${at}.${k}`))
}

/** Why `r` is not a `Recipe` named `name`, or nothing. */
function recipeProblems(r: unknown, name: string): string[] {
  if (typeof r !== 'object' || r === null) return ['not an object']
  const o = r as Record<string, unknown>
  const problems: string[] = []
  const strings = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === 'string')
  if (o['name'] !== name) problems.push(`name is ${JSON.stringify(o['name'])}, not ${name}`)
  if (typeof o['summary'] !== 'string' || o['summary'] === '') problems.push('summary')
  if (!strings(o['install'])) problems.push('install is not string[]')
  if (!strings(o['next'])) problems.push('next is not string[]')
  if (!Array.isArray(o['set'])) problems.push('set is not an array')
  else
    o['set'].forEach((s: unknown, i) => {
      const e = s as { path?: unknown; value?: unknown }
      if (typeof e?.path !== 'string' || !/^[A-Za-z]\w*(\.[A-Za-z]\w*)*$/.test(e.path))
        problems.push(`set[${i}].path`)
      problems.push(...valueProblems(e?.value, `set[${i}].value`))
    })
  if (!Array.isArray(o['env'])) problems.push('env is not an array')
  else
    o['env'].forEach((v: unknown, i) => {
      const e = v as Record<string, unknown>
      if (typeof e?.['name'] !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(e['name']))
        problems.push(`env[${i}].name`)
      if (typeof e?.['example'] !== 'string') problems.push(`env[${i}].example`)
      if (typeof e?.['required'] !== 'boolean') problems.push(`env[${i}].required`)
      if (typeof e?.['comment'] !== 'string') problems.push(`env[${i}].comment`)
    })
  return problems
}

/** `value` with every `{ env }` replaced by what the config would hold once the variable is set. */
function resolveValue(value: RecipeValue): unknown {
  if (typeof value !== 'object') return value
  if (isEnvRef(value)) return placeholder(value.env)
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, resolveValue(v as RecipeValue)]),
  )
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let at = target
  for (const key of keys.slice(0, -1)) {
    if (typeof at[key] !== 'object' || at[key] === null) at[key] = {}
    at = at[key] as Record<string, unknown>
  }
  at[keys[keys.length - 1]!] = value
}

function getPath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], source)
}

/** The recipe's `set` applied to `base` (a deep copy), with env values resolved. */
function applied(base: object, recipe: Recipe): Record<string, unknown> {
  const out = structuredClone(base) as Record<string, unknown>
  for (const { path, value } of recipe.set) setPath(out, path, resolveValue(value))
  return out
}

/** Every leaf of the recipe's `set` as a full dotted path; an `{ env }` value is a leaf. */
function leaves(recipe: Recipe): Array<[string, RecipeValue]> {
  const walk = (path: string, value: RecipeValue): Array<[string, RecipeValue]> =>
    typeof value === 'object' && !isEnvRef(value)
      ? Object.entries(value).flatMap(([k, v]) => walk(`${path}.${k}`, v as RecipeValue))
      : [[path, value]]
  return recipe.set.flatMap(({ path, value }) => walk(path, value))
}

const unique = (xs: string[]): string[] => [...new Set(xs)]

async function allRecipes(): Promise<Recipe[]> {
  return Promise.all(RECIPE_NAMES.map((name) => readRecipe(name, project)))
}

describe('AC-1: recipes are data in their packages', () => {
  it('AC-1: readRecipe resolves <holder>/recipes/<name>.json from the project through the exports subpath, and returns that file', async () => {
    const require = createRequire(join(project, 'package.json'))
    for (const name of RECIPE_NAMES) {
      const file = require.resolve(`${SPEC_HOLDERS[name]}/recipes/${name}.json`)
      const onDisk = JSON.parse(readFileSync(file, 'utf8')) as unknown
      expect(await readRecipe(name, project), name).toEqual(onDisk)
    }
  })

  it('AC-1: a project that does not have the holder installed cannot read its recipe', async () => {
    const outcomes: string[] = []
    for (const name of RECIPE_NAMES) {
      const without = linkedProject(`no-${name}`, [SPEC_HOLDERS[name]!])
      dirs.push(without)
      const found = await readRecipe(name, without).then(
        () => 'read',
        () => 'refused',
      )
      outcomes.push(`${name}: ${found}`)
    }
    expect(outcomes).toEqual(RECIPE_NAMES.map((name) => `${name}: refused`))
  })

  it('AC-1: every recipe has the Recipe shape', async () => {
    for (const recipe of await allRecipes()) {
      expect(recipeProblems(recipe, recipe.name), recipe.name).toEqual([])
    }
  })

  it('AC-1: each recipe installs, sets and names the env it is given', async () => {
    const byName = new Map((await allRecipes()).map((r) => [r.name, r]))
    const r = (name: string): Recipe => byName.get(name)!

    expect(unique(r('redis').install).sort()).toEqual([
      '@nymbalhq/document-store-redis',
      '@nymbalhq/event-bus-redis-streams',
      'ioredis',
    ])
    expect(applied({}, r('redis'))).toEqual({
      infrastructure: { documentStore: 'redis', eventBus: 'redis-streams' },
    })
    expect(r('redis').env.map((e) => [e.name, e.required])).toEqual([
      ['REDIS_URL', true],
      ['NYMBAL_REDIS_PREFIX', false],
    ])
    expect(r('redis').env.find((e) => e.name === 'REDIS_URL')?.example).toBe(
      'redis://localhost:6379',
    )

    expect(r('postgres').install).toEqual([])
    expect(applied({}, r('postgres'))).toEqual({ infrastructure: { commandStore: 'postgres' } })
    expect(r('postgres').env.map((e) => [e.name, e.required])).toEqual([['DATABASE_URL', true]])
    expect(r('postgres').next.join('\n')).toContain('nymbal migrate')

    expect(unique(r('s3').install).sort()).toEqual(['@aws-sdk/client-s3', '@nymbalhq/media-s3'])
    expect(applied({}, r('s3'))).toEqual({ infrastructure: { media: 's3' } })
    expect(
      r('s3')
        .env.map((e) => e.name)
        .sort(),
    ).toEqual(
      [
        'S3_BUCKET',
        'S3_ENDPOINT',
        'S3_PUBLIC_URL',
        'NYMBAL_S3_PREFIX',
        'AWS_REGION',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
      ].sort(),
    )
    expect(
      r('s3')
        .env.filter((e) => e.required)
        .map((e) => e.name),
    ).toEqual(['S3_BUCKET'])

    expect(unique(r('stripe').install).sort()).toEqual(['@nymbalhq/payments-stripe', 'stripe'])
    // The fields the Stripe package declares as settings are not in `set` (an unset variable would throw at
    // loadConfig before Settings could fill them), so the recipe sets the provider and writes no env() at all; the
    // variables stay in `.env`, required, for a deploy that sets them there.
    const stripe = applied({}, r('stripe'))
    expect(getPath(stripe, 'commerce.payments.provider')).toBe('stripe')
    expect(
      ['secretKey', 'webhookSecret', 'publishableKey'].filter(
        (field) => getPath(stripe, `commerce.payments.config.${field}`) !== undefined,
      ),
    ).toEqual([])
    expect(leaves(r('stripe')).filter(([, value]) => isEnvRef(value))).toEqual([])
    expect(
      r('stripe')
        .env.map((e) => e.name)
        .sort(),
    ).toEqual(['STRIPE_PUBLISHABLE_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'])
    expect(
      r('stripe')
        .env.filter((e) => e.name === 'STRIPE_SECRET_KEY' || e.name === 'STRIPE_WEBHOOK_SECRET')
        .map((e) => e.required),
    ).toEqual([true, true])
    expect(r('stripe').next.join('\n')).toContain('/api/webhooks/stripe')
  })

  it("AC-1: each recipe's set, applied to the scaffold config, parses through nymbalConfigSchema and holds the recipe's values", async () => {
    for (const recipe of await allRecipes()) {
      const parsed = nymbalConfigSchema.safeParse(applied(scaffolded, recipe))
      expect(parsed.error?.issues ?? [], recipe.name).toEqual([])
      for (const [path, value] of leaves(recipe)) {
        expect(getPath(parsed.data, path), `${recipe.name} ${path}`).toBe(resolveValue(value))
      }
    }
  })

  it('AC-1: for every slot provider a recipe sets that PROVIDER_PACKAGES lists, its install holds that package and SDK', async () => {
    let related = 0
    for (const recipe of await allRecipes()) {
      for (const [path, value] of leaves(recipe)) {
        // `security` is a slot too, its choice `security.adapter`, and its package peers no SDK.
        const slot =
          /^infrastructure\.(\w+)$/.exec(path)?.[1] ??
          /^commerce\.(\w+)\.provider$/.exec(path)?.[1] ??
          (path === 'security.adapter' ? 'security' : undefined)
        if (slot === undefined || typeof value !== 'string') continue
        const entry = (
          PROVIDER_PACKAGES as Record<string, Record<string, { package: string; sdk?: string }>>
        )[slot]?.[value]
        if (entry === undefined) continue
        related += 1
        const wanted = [entry.package, ...(entry.sdk === undefined ? [] : [entry.sdk])]
        expect(
          recipe.install.filter((p) => wanted.includes(p)).length,
          `${recipe.name} ${path}=${value} installs ${wanted.join(' and ')}`,
        ).toBe(unique(wanted).length)
      }
    }
    // redis sets two such slots, s3, stripe and cloudflare one each: a relation over nothing proves nothing.
    expect(related).toBeGreaterThanOrEqual(RECIPE_NAMES.length)
  })
})
