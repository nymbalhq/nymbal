import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// AC-2: the repository's own eslint config (eslint.config.js) reports, as errors, `vitest/expect-expect` and
// `vitest/no-conditional-expect` (from @vitest/eslint-plugin) on Vitest test files, and
// `playwright/no-wait-for-timeout` and `playwright/prefer-web-first-assertions` (from eslint-plugin-playwright) on
// the E2E journeys, and none of the four on non-test source.
// Each fixture is linted as if it lived at a path the config must cover (ESLint's lintText with a virtual
// filePath), so the test checks the rules and their file scoping together. Lines marked `lint: <rule>` in a
// fixture are where that rule must report.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/lint/', import.meta.url))

const VITEST_RULES = ['vitest/expect-expect', 'vitest/no-conditional-expect']
const PLAYWRIGHT_RULES = [
  'playwright/no-wait-for-timeout',
  'playwright/prefer-web-first-assertions',
]
const ERROR = 2

/** Virtual paths inside the Vitest test globs of vitest.config.ts. */
const VITEST_PATHS = [
  'packages/platform/src/__lint-fixture__.test.ts',
  'packages/importers/tests/__lint-fixture__.test.ts',
  'packages/create-app/test/__lint-fixture__.test.ts',
  'tests/contracts/__lint-fixture__.test.ts',
  'tests/tooling/__lint-fixture__.test.ts',
  'templates/astro/tests/__lint-fixture__.test.ts',
  'apps/admin/src/__lint-fixture__.test.tsx',
]

/** Virtual paths inside the Playwright journeys (storefront and admin). */
const JOURNEY_PATHS = [
  'tests/e2e/journeys/__lint-fixture__.spec.ts',
  'tests/e2e/journeys/admin/__lint-fixture__.spec.ts',
]

/** A non-test source file: none of the four rules may run here. */
const SOURCE_PATH = 'packages/platform/src/__lint-fixture__.ts'

function fixture(name: string): { source: string; marked: Map<string, number[]> } {
  const source = readFileSync(join(FIXTURES, name), 'utf8')
  const marked = new Map<string, number[]>()
  source.split('\n').forEach((line, i) => {
    const m = /\/\/ lint: (\S+)\s*$/.exec(line)
    if (m?.[1]) marked.set(m[1], [...(marked.get(m[1]) ?? []), i + 1])
  })
  return { source, marked }
}

const eslint = new ESLint({ cwd: REPO_ROOT })

/** Lines each rule reported at error severity, for one virtual path. */
async function reported(
  source: string,
  path: string,
  rules: string[],
): Promise<Map<string, number[]>> {
  const [result] = await eslint.lintText(source, {
    filePath: join(REPO_ROOT, path),
    warnIgnored: true,
  })
  const fatal = result!.messages.filter((m) => m.fatal)
  if (fatal.length > 0) throw new Error(`${path}: ${fatal.map((m) => m.message).join('; ')}`)
  const lines = new Map<string, number[]>()
  for (const m of result!.messages) {
    if (m.ruleId === null || !rules.includes(m.ruleId) || m.severity !== ERROR) continue
    lines.set(m.ruleId, [...(lines.get(m.ruleId) ?? []), m.line])
  }
  return lines
}

function sorted(map: Map<string, number[]>): Record<string, number[]> {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

describe('AC-2: lint stops assertion-free, conditional-assertion and sleeping tests', () => {
  const vitestFixture = fixture('vitest-violations.test.ts.fixture')
  const playwrightFixture = fixture('playwright-violations.spec.ts.fixture')

  it.each(VITEST_PATHS)(
    'AC-2: vitest/expect-expect and vitest/no-conditional-expect report as errors, at the marked lines, in %s',
    async (path) => {
      // The fixture marks one site per rule.
      expect([...vitestFixture.marked.keys()].sort()).toEqual(VITEST_RULES)
      const got = await reported(vitestFixture.source, path, VITEST_RULES)
      expect(sorted(got)).toEqual(sorted(vitestFixture.marked))
    },
  )

  it.each(JOURNEY_PATHS)(
    'AC-2: playwright/no-wait-for-timeout and playwright/prefer-web-first-assertions report as errors, at the marked lines, in %s',
    async (path) => {
      expect([...playwrightFixture.marked.keys()].sort()).toEqual(PLAYWRIGHT_RULES)
      const got = await reported(playwrightFixture.source, path, PLAYWRIGHT_RULES)
      expect(sorted(got)).toEqual(sorted(playwrightFixture.marked))
    },
  )

  it('AC-2: the four rules are scoped to tests: a non-test source file reports none of them', async () => {
    const all = [...VITEST_RULES, ...PLAYWRIGHT_RULES]
    // The positive cases above prove the rules exist; here the same violations stay silent outside test globs.
    const vitestHere = await reported(vitestFixture.source, VITEST_PATHS[0]!, all)
    const fromSource = await reported(vitestFixture.source, SOURCE_PATH, all)
    const journeyHere = await reported(playwrightFixture.source, JOURNEY_PATHS[0]!, all)
    const fromSourcePw = await reported(playwrightFixture.source, SOURCE_PATH, all)
    expect(vitestHere.size).toBeGreaterThan(0)
    expect(journeyHere.size).toBeGreaterThan(0)
    expect(sorted(fromSource)).toEqual({})
    expect(sorted(fromSourcePw)).toEqual({})
  })
})
