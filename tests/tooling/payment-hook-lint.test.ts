// Reads: eslint.config.js, tests/tooling/fixtures/lint/payment-hook.ts.fixture
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

// AC-11: E2E and scaffold tests reach the store through its own surface. The repository's eslint.config.js reports,
// as errors, an import of `finaliseStubPayment` or `stubPaymentWebhook` from @nymbalhq/proof-kit
// (no-restricted-imports) and a string or template literal holding `/api/webhooks/` (no-restricted-syntax) in
// tests/e2e/** and tests/scaffold/**, and neither in the kernel's tests or the contract suites, which drive the hook
// on purpose. The fixture is linted at virtual paths, as test-lint-rules.test.ts does; lines marked `lint: <rule>`
// are where each rule must report, and only there.

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/lint/payment-hook.ts.fixture', import.meta.url))
const RULES = ['no-restricted-imports', 'no-restricted-syntax']
const ERROR = 2

const BANNED = [
  'tests/e2e/journeys/__lint-fixture__.spec.ts',
  'tests/e2e/journeys/admin/__lint-fixture__.spec.ts',
  'tests/e2e/support/__lint-fixture__.ts',
  'tests/scaffold/__lint-fixture__.test.ts',
]
const ALLOWED = [
  'packages/platform/tests/integration/__lint-fixture__.test.ts',
  'packages/proof-kit/tests/__lint-fixture__.test.ts',
  'tests/contracts/__lint-fixture__.test.ts',
]

const source = readFileSync(FIXTURE, 'utf8')
const marked = new Map<string, number[]>()
source.split('\n').forEach((line, i) => {
  const m = /\/\/ lint: (\S+)\s*$/.exec(line)
  if (m?.[1]) marked.set(m[1], [...(marked.get(m[1]) ?? []), i + 1])
})

const eslint = new ESLint({ cwd: REPO_ROOT })

async function reported(path: string): Promise<Map<string, number[]>> {
  const [result] = await eslint.lintText(source, {
    filePath: join(REPO_ROOT, path),
    warnIgnored: true,
  })
  const fatal = result!.messages.filter((m) => m.fatal)
  if (fatal.length > 0) throw new Error(`${path}: ${fatal.map((m) => m.message).join('; ')}`)
  const lines = new Map<string, number[]>()
  for (const m of result!.messages) {
    if (m.ruleId === null || !RULES.includes(m.ruleId) || m.severity !== ERROR) continue
    lines.set(m.ruleId, [...(lines.get(m.ruleId) ?? []), m.line])
  }
  return lines
}

const sorted = (map: Map<string, number[]>): Record<string, number[]> =>
  Object.fromEntries(
    [...map.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, [...v].sort((x, y) => x - y)]),
  )

describe('AC-11: lint keeps the payment hook out of E2E and scaffold tests', () => {
  it.each(BANNED)(
    'AC-11: in %s, both hook imports and every /api/webhooks/ literal are errors, at exactly the marked lines',
    async (path) => {
      const got = await reported(path)
      expect(sorted(got)).toEqual(sorted(marked))
      // The allowed proof-kit import and the /api/orders literal stay silent: each rule reports only marked lines.
      const reports = [...got.values()].flat().length
      const marks = [...marked.values()].flat().length
      expect(reports).toBe(marks)
      expect(marks).toBeGreaterThan(marked.size)
    },
  )

  it.each(ALLOWED)('AC-11: in %s the same file reports neither rule', async (path) => {
    // The banned paths above report; here the same source is silent, so the rules are scoped, not absent.
    const banned = await reported(BANNED[0]!)
    const here = await reported(path)
    expect([...banned.values()].flat().length).toBeGreaterThan(0)
    expect(sorted(here)).toEqual({})
  })
})
