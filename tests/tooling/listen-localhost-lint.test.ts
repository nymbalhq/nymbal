import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// A test server bound to `localhost` listens on ::1 or 127.0.0.1 by the resolver's answer, and a client told
// `localhost` may take the other one: a doctor test went red at two shas in two checkouts over this and was rerun
// green each time. The repository's eslint.config.js reports, as an error, a `listen(…)` call given the literal
// 'localhost' as an argument or as the `host` of an options object, in every test path (a *.test.ts, *.spec.ts or
// *.test-d.ts file, anything under tests/, fixtures/, __tests__/, journeys/ or sentinels/), and not in product code,
// which may bind what its configuration says. The fixture is linted at virtual paths, as payment-hook-lint.test.ts
// does; lines marked `lint: <rule>` are where the rule must report, and only there.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE = fileURLToPath(
  new URL('./fixtures/lint/listen-localhost.ts.fixture', import.meta.url),
)
const RULE = 'no-restricted-syntax'
const ERROR = 2

const TEST_PATHS = [
  'packages/cli/src/commands/__lint-fixture__.test.ts',
  'packages/platform/tests/integration/__lint-fixture__.test.ts',
  'tests/support/__lint-fixture__.ts',
  'tests/contracts/__lint-fixture__.test.ts',
  'tests/e2e/support/__lint-fixture__.ts',
  'tests/e2e/journeys/__lint-fixture__.spec.ts',
  'tests/e2e/fixtures/custom-providers/__lint-fixture__.ts',
  'tests/scaffold/__lint-fixture__.test.ts',
]
const PRODUCT_PATHS = [
  'packages/platform/src/services/__lint-fixture__.ts',
  'packages/cli/src/commands/__lint-fixture__.ts',
  'packages/http/src/__lint-fixture__.ts',
]

const source = readFileSync(FIXTURE, 'utf8')
const marked = source
  .split('\n')
  .flatMap((line, i) => (new RegExp(`// lint: ${RULE}\\s*$`).test(line) ? [i + 1] : []))

const eslint = new ESLint({ cwd: REPO_ROOT })

async function reported(path: string): Promise<number[]> {
  const [result] = await eslint.lintText(source, {
    filePath: join(REPO_ROOT, path),
    warnIgnored: true,
  })
  const fatal = result!.messages.filter((m) => m.fatal)
  if (fatal.length > 0) throw new Error(`${path}: ${fatal.map((m) => m.message).join('; ')}`)
  return result!.messages
    .filter((m) => m.ruleId === RULE && m.severity === ERROR && /localhost/.test(m.message))
    .map((m) => m.line)
    .sort((a, b) => a - b)
}

describe('lint keeps test servers off `localhost`', () => {
  it.each(TEST_PATHS)(
    'in %s every listen(…, "localhost") and listen({ host: "localhost" }) is an error, at exactly the marked lines',
    async (path) => {
      expect(marked.length).toBeGreaterThanOrEqual(3)
      expect(await reported(path)).toEqual(marked)
    },
  )

  it.each(PRODUCT_PATHS)(
    'in %s the same source reports nothing: the rule is scoped to test paths',
    async (path) => {
      expect(await reported(TEST_PATHS[0]!)).toEqual(marked)
      expect(await reported(path)).toEqual([])
    },
  )
})
