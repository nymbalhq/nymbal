import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appendRecipeEnv, readRecipe } from './index.js'
import { REPO, RECIPE_NAMES, linkedProject, removeAll } from './fixtures/linked-project.js'
import type { SpecRecipe as Recipe } from './fixtures/linked-project.js'

// Acceptance tests for P2-03 AC-3 (spec P2-03-nymbal-add-recipe, decision 5): appendRecipeEnv on generated
// .env.example text (variables, comments, blank lines, a recipe's variables already there as NAME= or # NAME=, and
// names that only start or end like one) adds each missing variable exactly once under the recipe's header, with its
// comment above it, commented out when optional; it never removes or reorders a line; a second application changes
// nothing. Kills: duplicated env lines, lost or reordered ones, a prefix match taken for a present variable, and an
// optional variable written live.

const dirs: string[] = []
const real: Recipe[] = []

beforeAll(async () => {
  const project = linkedProject('env')
  dirs.push(project)
  for (const name of RECIPE_NAMES) real.push(await readRecipe(name, project))
}, 60_000)
afterAll(() => removeAll(dirs))

const POOL = [
  'REDIS_URL',
  'NYMBAL_REDIS_PREFIX',
  'DATABASE_URL',
  'S3_BUCKET',
  'AWS_REGION',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'P2_03_ALPHA',
  'P2_03_BETA',
]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** NAME= or # NAME=, the two forms decision 5 counts as present. */
const declares = (name: string) => (line: string) =>
  new RegExp(`^(#\\s*)?${escapeRe(name)}=`).test(line.trim())

// Built once: a stringMatching arbitrary is costly to build, and the recipe generator needs one per variable.
const exampleValueArb = fc.stringMatching(/^[a-z0-9:/._-]{0,20}$/)
const commentArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ,.()-]{0,30}$/)

const envVarArb = (name: string) =>
  fc.record({
    name: fc.constant(name),
    example: exampleValueArb,
    required: fc.boolean(),
    comment: commentArb,
  })

const generatedRecipeArb: fc.Arbitrary<Recipe> = fc
  .tuple(
    fc.constantFrom('redis', 's3', 'stripe', 'postgres', 'p2-03-extra'),
    fc.shuffledSubarray(POOL, { minLength: 1, maxLength: 5 }),
  )
  .chain(([name, names]) =>
    fc.tuple(...names.map(envVarArb)).map(
      (env): Recipe => ({
        name,
        summary: `the ${name} recipe`,
        install: [],
        set: [],
        env,
        next: [],
      }),
    ),
  )

const lineArb = fc.oneof(
  fc.stringMatching(/^FILLER_[A-Z]{1,6}=[a-z0-9]{0,8}$/),
  fc.stringMatching(/^# [a-z][a-z ]{0,24}$/),
  fc.constant(''),
  fc.constantFrom(...POOL).map((n) => `${n}=present`),
  fc.constantFrom(...POOL).map((n) => `# ${n}=`),
  fc.constantFrom(...POOL).map((n) => `${n}_OLD=1`),
  fc.constantFrom(...POOL).map((n) => `MY_${n}=1`),
)

const exampleArb = fc
  .tuple(fc.array(lineArb, { maxLength: 14 }), fc.boolean())
  .map(([lines, trailingNewline]) =>
    lines.length === 0 ? '' : lines.join('\n') + (trailingNewline ? '\n' : ''),
  )

/** The lines of a file, without the empty string a final newline leaves. */
function linesOf(text: string): string[] {
  const lines = text.split('\n')
  return lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
}

function isSubsequence(small: string[], big: string[]): boolean {
  let j = 0
  for (const line of big) if (j < small.length && line === small[j]) j++
  return j === small.length
}

let checked = 0

/** AC-3's property over the inputs given; counts the cases it ran, so a test can show it ran them all. */
const envAppended = (examples: fc.Arbitrary<string>, recipes: fc.Arbitrary<Recipe>) =>
  fc.property(examples, recipes, (example, recipe) => {
    checked += 1
    const out = appendRecipeEnv(example, recipe)
    const before = linesOf(example)
    const after = linesOf(out)

    expect(isSubsequence(before, after), 'every line kept, in order').toBe(true)
    expect(appendRecipeEnv(out, recipe), 'a second application').toBe(out)

    const missing = recipe.env.filter((v) => !before.some(declares(v.name)))
    for (const v of recipe.env) {
      const count = after.filter(declares(v.name)).length
      const had = before.filter(declares(v.name)).length
      expect(count, v.name).toBe(had > 0 ? had : 1)
    }
    for (const v of missing) {
      const at = after.findIndex(declares(v.name))
      const line = after[at]!
      const form = v.required
        ? `^${escapeRe(v.name)}=${escapeRe(v.example)}$`
        : `^#\\s*${escapeRe(v.name)}=${escapeRe(v.example)}$`
      expect(line, `${v.name} required=${v.required}`).toMatch(new RegExp(form))
      expect(after[at - 1] ?? '', `${v.name}'s comment`).toContain(v.comment)
    }
    const header = `# ${recipe.name} (nymbal add ${recipe.name})`
    expect(after.filter((l) => l.trim() === header).length).toBe(
      before.filter((l) => l.trim() === header).length + (missing.length > 0 ? 1 : 0),
    )
    if (missing.length === 0) expect(out).toBe(example)
  })

describe('P2-03 AC-3: appendRecipeEnv', () => {
  it('AC-3: on generated .env.example text and generated recipes, adds each missing variable once, keeps every line, and is idempotent', () => {
    const start = checked
    fc.assert(envAppended(exampleArb, generatedRecipeArb), { numRuns: 300 })
    expect(checked - start).toBe(300)
  })

  it('AC-3: the same holds for the four shipped recipes, the scaffold .env.example among the inputs', () => {
    const scaffoldExample = readFileSync(
      join(REPO, 'packages/create-app/scaffold/templates/astro/_dot.env.example'),
      'utf8',
    )
    const start = checked
    fc.assert(
      envAppended(fc.oneof(exampleArb, fc.constant(scaffoldExample)), fc.constantFrom(...real)),
      { numRuns: 200 },
    )
    expect(checked - start).toBe(200)
  })

  it('AC-3: on the scaffold .env.example, stripe adds STRIPE_PUBLISHABLE_KEY and leaves the commented secrets as they are', () => {
    const scaffoldExample = readFileSync(
      join(REPO, 'packages/create-app/scaffold/templates/astro/_dot.env.example'),
      'utf8',
    )
    const stripe = real.find((r) => r.name === 'stripe')!
    const after = linesOf(appendRecipeEnv(scaffoldExample, stripe))
    const before = linesOf(scaffoldExample)
    expect(after.filter(declares('STRIPE_SECRET_KEY'))).toEqual(
      before.filter(declares('STRIPE_SECRET_KEY')),
    )
    expect(after.filter(declares('STRIPE_PUBLISHABLE_KEY')).length).toBe(
      before.filter(declares('STRIPE_PUBLISHABLE_KEY')).length + 1,
    )
  })
})
