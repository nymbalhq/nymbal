import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig, type NymbalConfig } from '@nymbalhq/config'
import { scaffold } from '../../../create-app/src/index.js'
import { applyRecipeToConfig, readRecipe } from './index.js'
import {
  RECIPE_NAMES,
  linkedProject,
  linkPackages,
  removeAll,
  tempDir,
} from './fixtures/linked-project.js'
import type {
  SpecRecipe as Recipe,
  SpecRecipeValue as RecipeValue,
} from './fixtures/linked-project.js'

// Acceptance tests for P2-03 AC-2 (spec P2-03-nymbal-add-recipe, decision 4): applyRecipeToConfig on the config the
// exported scaffold(dir, answers) writes for generated answers, varied with extra keys, comments, reordered properties,
// a plain-object default export and an `env` import already in use, each with LF, CRLF and mixed line endings. For
// every recipe the edit leaves every line outside the edited properties in place (line endings included), sets exactly
// the recipe's paths (the loaded result is the loaded original with those paths changed), is idempotent, imports `env`
// only when an env() call is written, and loads through loadConfig. A path holding a value that is neither the
// scaffold default nor the recipe's is a conflict, and `force` writes the recipe's value; a config that is not an
// object literal, or that binds `env` to something else, is refused by a recipe that writes env().
// Kills: an edit that loses user content, duplicates on re-run, breaks the import, or overwrites a user's choice.

type Answers = Parameters<typeof scaffold>[1]
type Applied = ReturnType<typeof applyRecipeToConfig>

const SCAFFOLD_DEFAULTS = ['sqlite', 'in-memory', 'in-process', 'local-fs', 'native']
const STORE_NAME_VAR = 'P2_03_STORE_NAME'

const dirs: string[] = []
const recipes: Recipe[] = []
const savedEnv = new Map<string, string | undefined>()

beforeAll(async () => {
  const project = linkedProject('apply')
  dirs.push(project)
  for (const name of RECIPE_NAMES) recipes.push(await readRecipe(name, project))
  // Every env() the recipes write is set while their results load, as decision 6's placeholders are.
  const written = [...new Set(envNames(...recipes))]
  for (const name of [...written, STORE_NAME_VAR]) savedEnv.set(name, process.env[name])
  for (const name of written) process.env[name] = placeholder(name)
  delete process.env[STORE_NAME_VAR]
}, 60_000)

afterAll(() => {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  removeAll(dirs)
})

const placeholder = (name: string): string => `p2-03-placeholder-${name}`

function isEnvRef(v: unknown): v is { env: string; default?: string } {
  return typeof v === 'object' && v !== null && typeof (v as { env?: unknown }).env === 'string'
}

function leaves(recipe: Recipe): Array<[string, RecipeValue]> {
  const walk = (path: string, value: RecipeValue): Array<[string, RecipeValue]> =>
    typeof value === 'object' && !isEnvRef(value)
      ? Object.entries(value).flatMap(([k, v]) => walk(`${path}.${k}`, v as RecipeValue))
      : [[path, value]]
  return recipe.set.flatMap(({ path, value }) => walk(path, value))
}

function envNames(...rs: Recipe[]): string[] {
  return rs.flatMap((r) => leaves(r).flatMap(([, v]) => (isEnvRef(v) ? [v.env] : [])))
}

const resolved = (v: RecipeValue): unknown => (isEnvRef(v) ? placeholder(v.env) : v)

function getPath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], source)
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let at = target
  for (const key of keys.slice(0, -1)) at = at[key] as Record<string, unknown>
  at[keys[keys.length - 1]!] = value
}

/** Loads `source` as nymbal.config.ts from a directory of its own (jiti caches a module by path). */
async function load(source: string): Promise<NymbalConfig> {
  const dir = tempDir('load')
  dirs.push(dir)
  linkPackages(dir)
  writeFileSync(join(dir, 'nymbal.config.ts'), source)
  return (await loadConfig(dir)).config
}

async function scaffoldConfig(answers: Answers): Promise<string> {
  const dir = tempDir('scaffold')
  dirs.push(dir)
  await scaffold(dir, answers)
  return readFileSync(join(dir, 'nymbal.config.ts'), 'utf8')
}

const answersArb: fc.Arbitrary<Answers> = fc.record({
  name: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 '&.-]{0,23}$/),
  directory: fc.constant('shop'),
  currency: fc.constantFrom('GBP' as const, 'USD' as const, 'EUR' as const),
  template: fc.constantFrom('astro' as const, 'nextjs' as const),
  seedDemo: fc.boolean(),
})

/** A recipe that writes one env() call, as no shipped recipe does since P3-07: what the `binds env` guard refuses. */
const envWriterArb: fc.Arbitrary<Recipe> = fc
  .record({
    name: fc.stringMatching(/^generated-[a-z]{1,8}$/),
    envName: fc.stringMatching(/^P3_07_[A-Z][A-Z0-9_]{0,10}$/),
    fallback: fc.option(fc.stringMatching(/^[a-z][a-z0-9-]{0,11}$/), { nil: undefined }),
    at: fc.constantFrom('infrastructure.redis', 'commerce.email', 'commerce.payments'),
  })
  .map(({ name, envName, fallback, at }) => {
    const ref: RecipeValue = { env: envName, ...(fallback !== undefined && { default: fallback }) }
    const value: RecipeValue =
      at === 'infrastructure.redis'
        ? { url: ref }
        : at === 'commerce.email'
          ? { provider: 'smtp', config: { smtp: { host: ref } } }
          : { provider: 'stripe', config: { secretKey: ref } }
    return {
      name,
      summary: 'A generated recipe that writes env()',
      install: [],
      set: [{ path: at, value }],
      env: [{ name: envName, example: '', required: fallback === undefined, comment: '' }],
      next: [],
    }
  })

interface Variation {
  order: number[]
  comments: boolean[]
  commentText: string
  headerComment: boolean
  extraTopLevel: boolean
  extraHost: boolean
  extraOrders: boolean
  explicitMedia: boolean
  envInUse: boolean
  plainObject: boolean
  /** For mixed endings, which line breaks are CRLF. */
  crlfBreaks: boolean[]
}

type Endings = 'lf' | 'crlf' | 'mixed'
const ENDINGS: Endings[] = ['lf', 'crlf', 'mixed']

const variationArb: fc.Arbitrary<Variation> = fc.record({
  order: fc.array(fc.integer({ min: 0, max: 1000 }), { minLength: 16, maxLength: 16 }),
  comments: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
  commentText: fc.stringMatching(/^[a-z][a-z0-9 ]{0,20}$/),
  headerComment: fc.boolean(),
  extraTopLevel: fc.boolean(),
  extraHost: fc.boolean(),
  extraOrders: fc.boolean(),
  explicitMedia: fc.boolean(),
  envInUse: fc.boolean(),
  plainObject: fc.boolean(),
  crlfBreaks: fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }),
})

const OPEN = 'export default defineConfig({\n'
const CLOSE = '\n})\n'

/** Sorts `items` by the generated keys, stably: a permutation the generator controls. */
function permute<T>(items: T[], keys: number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i % keys.length]!, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map(({ item }) => item)
}

/** The scaffold's config with the variation applied: still a config the schema accepts. */
function vary(source: string, v: Variation): string {
  const open = source.indexOf(OPEN)
  const close = source.lastIndexOf(CLOSE)
  if (open < 0 || close < open)
    throw new Error(`the scaffold config is not defineConfig({...}):\n${source}`)
  let head = source.slice(0, open)
  let blocks = source.slice(open + OPEN.length, close).split('\n\n')
  if (!blocks.every((b) => /^ {2}\w+: /.test(b)))
    throw new Error(`the scaffold config's properties are not blank-line separated:\n${source}`)

  const edit = (key: string, fn: (lines: string[]) => string[]): void => {
    blocks = blocks.map((b) => (b.startsWith(`  ${key}: `) ? fn(b.split('\n')).join('\n') : b))
  }
  const beforeClose = (line: string) => (lines: string[]) => [
    ...lines.slice(0, -1),
    line,
    lines[lines.length - 1]!,
  ]
  let c = 0
  const comment = (indent: string): string[] =>
    v.comments[c++ % v.comments.length] ? [`${indent}// ${v.commentText} ${c}`] : []

  edit('infrastructure', (lines) => {
    const inner = [...lines.slice(1, -1), ...(v.explicitMedia ? ["    media: 'local-fs',"] : [])]
    return [
      lines[0]!,
      ...permute(inner, v.order).flatMap((l) => [...comment('    '), l]),
      lines[lines.length - 1]!,
    ]
  })
  if (v.extraHost) edit('http', beforeClose("    host: '127.0.0.1',"))
  if (v.extraOrders) edit('commerce', beforeClose("    orders: { numberPrefix: 'SHOP' },"))
  if (v.envInUse) {
    edit('store', (lines) =>
      lines.map((l) =>
        l.replace(/^( {4}name: )('(?:[^'\\]|\\.)*'),$/, `$1env('${STORE_NAME_VAR}', $2),`),
      ),
    )
    head = head.replace(
      "import { defineConfig } from '@nymbalhq/config'",
      "import { defineConfig, env } from '@nymbalhq/config'",
    )
  }
  if (v.extraTopLevel)
    blocks.push("  // not a schema key: the schema strips it\n  meta: {\n    owner: 'p2-03',\n  },")
  blocks = permute(blocks, v.order.slice(3)).map((b) => [...comment('  '), b].join('\n'))
  const header = v.headerComment ? '/* the shop config, kept by hand */\n' : ''
  return v.plainObject
    ? `${head}${header}export default {\n${blocks.join('\n\n')}\n}\n`
    : `${head}${header}${OPEN}${blocks.join('\n\n')}${CLOSE}`
}

/** `source` (LF) with the line endings asked for: mixed starts CRLF then LF, then follows the generated pattern. */
function withEndings(source: string, endings: Endings, crlfBreaks: boolean[]): string {
  if (endings === 'lf') return source
  const pattern = [true, false, ...crlfBreaks]
  let i = 0
  return source.replace(/\n/g, () =>
    endings === 'crlf' || pattern[i++ % pattern.length] ? '\r\n' : '\n',
  )
}

/** The kinds of line break `source` uses. */
const lineEndings = (source: string): string[] =>
  [...new Set(source.match(/\r?\n/g))].map((e) => JSON.stringify(e)).sort()

/** Which lines of `a` and `b` a longest common subsequence keeps. */
function common(a: string[], b: string[]): { inA: boolean[]; inB: boolean[] } {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      t[i]![j] = a[i] === b[j] ? t[i + 1]![j + 1]! + 1 : Math.max(t[i + 1]![j]!, t[i]![j + 1]!)
  const inA = a.map(() => false)
  const inB = b.map(() => false)
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inA[i++] = true
      inB[j++] = true
    } else if (t[i + 1]![j]! >= t[i]![j + 1]!) i++
    else j++
  }
  return { inA, inB }
}

const PUNCTUATION_ONLY = /^[\s{}[\](),;]*$/
const CONFIG_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*['"]@nymbalhq\/config['"]/

/** The names every `import { ... } from '@nymbalhq/config'` in `source` brings in, in order. */
function importedNames(source: string): string[] {
  return [...source.matchAll(new RegExp(CONFIG_IMPORT.source, 'gm'))].flatMap((m) =>
    m[1]!
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
  )
}

/** Every line `original` had outside the edited properties is still there, in order; every new line is the edit's. */
function outsideUntouched(original: string, edited: string, recipe: Recipe): string[] {
  const a = original.split('\n')
  const b = edited.split('\n')
  const { inA, inB } = common(a, b)
  const leafKeys = recipe.set.map(({ path }) => path.split('.').pop()!)
  const owned = (line: string): boolean =>
    CONFIG_IMPORT.test(line) || leafKeys.some((k) => line.trim().startsWith(`${k}:`))
  const tokens = [
    'import',
    'env(',
    ...leaves(recipe).flatMap(([path, value]) => [
      ...path.split('.'),
      ...(typeof value === 'string' ? [value] : []),
    ]),
  ]
  const lost = a.filter((line, i) => !inA[i] && !owned(line) && !PUNCTUATION_ONLY.test(line))
  const foreign = b.filter(
    (line, j) => !inB[j] && !PUNCTUATION_ONLY.test(line) && !tokens.some((t) => line.includes(t)),
  )
  return [...lost.map((l) => `lost: ${l}`), ...foreign.map((l) => `not the edit's: ${l}`)]
}

/** `source`'s lines, each with the break that ends it. */
const linesWithBreaks = (source: string): string[] => source.match(/[^\n]*\n|[^\n]+$/g) ?? []

const breakOf = (line: string): string =>
  line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''

/**
 * Every line the edit added that does not end like the original line it went into. Lines are aligned by a longest
 * common subsequence, so each run of new lines sits between two kept lines. A run that replaces as many lines as it
 * has ends line for line like them; one that replaces fewer ends like one of those; a pure insertion lands on the
 * break between the kept lines either side, so its lines all end like one of the two.
 */
function foreignBreaks(original: string, edited: string): string[] {
  const a = linesWithBreaks(original)
  const b = linesWithBreaks(edited)
  const { inA, inB } = common(a, b)
  const keptA = [-1, ...a.flatMap((_, i) => (inA[i] ? [i] : [])), a.length]
  const keptB = [-1, ...b.flatMap((_, j) => (inB[j] ? [j] : [])), b.length]
  const wrong: string[] = []
  for (let k = 0; k + 1 < keptA.length; k++) {
    const replaced = a.slice(keptA[k]! + 1, keptA[k + 1]!)
    const added = b.slice(keptB[k]! + 1, keptB[k + 1]!)
    if (added.length === 0) continue
    const around = [a[keptA[k]!], a[keptA[k + 1]!]].filter((l): l is string => l !== undefined)
    added.forEach((line, n) => {
      const into =
        added.length === replaced.length ? [replaced[n]!] : replaced.length > 0 ? replaced : around
      if (!into.some((l) => breakOf(l) === breakOf(line)))
        wrong.push(`${JSON.stringify(line)} went into ${JSON.stringify(into)}`)
    })
    if (replaced.length === 0 && new Set(added.map(breakOf)).size > 1)
      wrong.push(`one insertion with mixed breaks: ${JSON.stringify(added)}`)
  }
  return wrong
}

function sourceOf(result: Applied, label: string): { source: string; changed: string[] } {
  if (!('source' in result)) throw new Error(`${label}: conflict ${JSON.stringify(result)}`)
  return result
}

describe('P2-03 AC-2: applyRecipeToConfig on generated scaffold configs', () => {
  it('AC-2: for every recipe and line ending the edit keeps every other line, sets exactly the set paths, is idempotent, imports env only when it writes env(), and loads', async () => {
    await fc.assert(
      fc.asyncProperty(answersArb, variationArb, async (answers, variation) => {
        const lf = vary(await scaffoldConfig(answers), variation)
        for (const endings of ENDINGS) {
          const original = withEndings(lf, endings, variation.crlfBreaks)
          const before = await load(original)
          for (const recipe of recipes) {
            const once = sourceOf(
              applyRecipeToConfig(original, recipe, { force: false }),
              `${recipe.name} ${endings}`,
            )
            expect(outsideUntouched(original, once.source, recipe), recipe.name).toEqual([])
            expect(lineEndings(once.source), `${recipe.name} ${endings} endings`).toEqual(
              lineEndings(original),
            )
            expect(
              foreignBreaks(original, once.source),
              `${recipe.name} ${endings}: each added line ends like the line it went into`,
            ).toEqual([])

            const twice = sourceOf(
              applyRecipeToConfig(once.source, recipe, { force: false }),
              `${recipe.name} again`,
            )
            expect(twice.source, `${recipe.name} twice`).toBe(once.source)
            expect(twice.changed, `${recipe.name} twice`).toHaveLength(0)
            expect(once.changed.length, recipe.name).toBeGreaterThan(0)

            const names = importedNames(once.source)
            const writesEnv = /\benv\(/.test(once.source)
            expect(names.includes('env'), `${recipe.name}: env imported iff env() is written`).toBe(
              writesEnv,
            )
            expect(names.filter((n) => n === 'env').length).toBeLessThanOrEqual(1)
            expect(names.filter((n) => importedNames(original).includes(n))).toEqual(
              importedNames(original),
            )
            expect(writesEnv, recipe.name).toBe(
              importedNames(original).includes('env') || envNames(recipe).length > 0,
            )

            const after = await load(once.source)
            for (const [path, value] of leaves(recipe)) {
              expect(getPath(after, path), `${recipe.name} ${path}`).toBe(resolved(value))
            }
            const restored = structuredClone(after) as unknown as Record<string, unknown>
            for (const { path } of recipe.set) setPath(restored, path, getPath(before, path))
            expect(restored, `${recipe.name} changed only its paths`).toEqual(before)
          }
        }
      }),
      { numRuns: 10 },
    )
  }, 180_000)

  it("AC-2: a set path holding another non-default value is a conflict naming it; with force the recipe's value is written", async () => {
    const plain = await scaffoldConfig({
      name: 'Conflict Shop',
      directory: 'shop',
      currency: 'GBP',
      template: 'astro',
      seedDemo: false,
    })
    const targets = recipes.flatMap((recipe) => recipe.set.map((entry) => ({ recipe, entry })))
    const otherArb = fc.oneof(
      fc.constantFrom('postgres-jsonb', 'custom', 'redis', 'sqlite-wal', 'gcs'),
      fc.stringMatching(/^[a-z][a-z0-9-]{1,12}$/),
    )
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...targets), otherArb, async ({ recipe, entry }, other) => {
        const wanted = entry.value
        const wantedLeaf =
          typeof wanted === 'object' && !isEnvRef(wanted)
            ? (wanted as { provider?: unknown }).provider
            : wanted
        fc.pre(!SCAFFOLD_DEFAULTS.includes(other) && other !== wantedLeaf)
        const key = entry.path.split('.').pop()!
        const held =
          key === 'payments'
            ? plain.replace(
                /payments: \{ provider: 'native' \}/,
                `payments: { provider: '${other}' }`,
              )
            : new RegExp(`^ {4}${key}: '`, 'm').test(plain)
              ? plain.replace(new RegExp(`^( {4}${key}: )'[^']*'`, 'm'), `$1'${other}'`)
              : plain.replace(
                  '  infrastructure: {\n',
                  `  infrastructure: {\n    ${key}: '${other}',\n`,
                )
        expect(held, 'the generator placed the other value').not.toBe(plain)

        const refused = applyRecipeToConfig(held, recipe, { force: false })
        if (!('conflict' in refused)) throw new Error(`${recipe.name} ${entry.path}: no conflict`)
        expect(refused.conflict.path).toBe(entry.path)
        expect(JSON.stringify(refused.conflict.current)).toContain(other)
        expect(JSON.stringify(refused.conflict.wanted)).toContain(JSON.stringify(wantedLeaf))

        const forced = sourceOf(applyRecipeToConfig(held, recipe, { force: true }), 'forced')
        const after = await load(forced.source)
        for (const [path, value] of leaves(recipe)) {
          expect(getPath(after, path), `${recipe.name} ${path} forced`).toBe(resolved(value))
        }
      }),
      { numRuns: 25 },
    )
  }, 120_000)

  it('AC-2: a config that is not an object literal is refused, "edit by hand", with the set paths', () => {
    const generated = [
      "import { defineConfig } from '@nymbalhq/config'\nimport { build } from './config-parts'\n\nexport default defineConfig(build())\n",
      "import { makeConfig } from './config-parts'\n\nexport default makeConfig(process.env)\n",
    ]
    for (const source of generated) {
      for (const recipe of recipes) {
        for (const force of [false, true]) {
          let message = ''
          try {
            applyRecipeToConfig(source, recipe, { force })
          } catch (error) {
            message = (error as Error).message
          }
          expect(message, `${recipe.name} force=${force}`).toMatch(/edit by hand/i)
          for (const { path } of recipe.set) expect(message).toContain(path)
        }
      }
    }
    expect(recipes.map((r) => r.name)).toEqual(RECIPE_NAMES)
  })

  it('AC-2: a config that binds `env` to something other than @nymbalhq/config\'s is refused, "edit by hand", by a recipe that writes env()', async () => {
    const plain = await scaffoldConfig({
      name: 'Foreign Env Shop',
      directory: 'shop',
      currency: 'GBP',
      template: 'astro',
      seedDemo: false,
    })
    const head = "import { defineConfig } from '@nymbalhq/config'\n"
    expect(plain.startsWith(head), 'the scaffold config starts with its config import').toBe(true)
    const foreign = [
      plain.replace(head, `${head}import { env } from './env'\n`),
      plain.replace(head, `${head}import env from './env'\n`),
      plain.replace(head, `${head}const env = (name: string) => process.env[name] ?? ''\n`),
    ]
    // P3-07 Decision 1: no shipped recipe writes env() any more (Stripe's declared fields left `set`), so the guard is
    // exercised by generated recipes that do, at slot and infrastructure paths the scaffold leaves at their defaults,
    // with and without a default.
    fc.assert(
      fc.property(envWriterArb, (recipe) => {
        expect(envNames(recipe).length).toBeGreaterThan(0)
        for (const source of foreign) {
          let message = ''
          try {
            applyRecipeToConfig(source, recipe, { force: false })
          } catch (error) {
            message = (error as Error).message
          }
          expect(message, `${recipe.name} on:\n${source.split('\n', 3).join('\n')}`).toMatch(
            /edit by hand/i,
          )
          expect(message).toContain('binds `env`')
          for (const { path } of recipe.set) expect(message).toContain(path)
        }
      }),
      { numRuns: 50 },
    )
    const writers = recipes.filter((r) => envNames(r).length > 0)
    for (const source of foreign) {
      for (const recipe of recipes.filter((r) => !writers.includes(r))) {
        const applied = sourceOf(applyRecipeToConfig(source, recipe, { force: false }), recipe.name)
        expect(applied.changed.length, recipe.name).toBeGreaterThan(0)
      }
    }
  })
})
