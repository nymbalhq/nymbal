// Reads: nothing
import { describe, expect, it } from 'vitest'
import { plan, type StepSpec } from '../../scripts/gate'

// AC-16: E2E steps that shared one output dir would overwrite each other's results. Each E2E step passes
// `--output test-results/<target>`. Plan level: the commands are the contract.

// The custom-providers targets run on the default store set this INPUT plans; the no-search targets
// (tests/e2e/fixtures/no-search) and the project-elements targets (tests/e2e/fixtures/override-elements) are wired the
// same way.
const TARGETS = [
  'astro',
  'nextjs',
  'admin',
  'astro-custom',
  'nextjs-custom',
  'mail-outage',
  'astro-nosearch',
  'nextjs-nosearch',
  'astro-override',
  'nextjs-override',
]
const INPUT = { full: true, base: 'abc1234', changed: ['packages/sdk/src/client.ts'], mutated: [] }

/** The Playwright command of an E2E step: e2eCommand wraps it in existence and shutdown checks. */
function playwrightOf(step: StepSpec | undefined): string {
  return (step?.command ?? '').split(';').find((part) => /playwright test/.test(part)) ?? ''
}

function outputDir(step: StepSpec | undefined): string | undefined {
  return /\s--output[= ]'?([^\s';]+)'?/.exec(playwrightOf(step))?.[1]
}

const e2eStep = (steps: StepSpec[], target: string): StepSpec | undefined =>
  steps.find((s) => s.name === `e2e ${target}`)

describe('AC-16 (review finding 5): each E2E project keeps its own Playwright output dir', () => {
  it('AC-16: every E2E step passes --output test-results/<target>, one dir per step', () => {
    const { steps } = plan(INPUT)
    const dirs = TARGETS.map((target) => outputDir(e2eStep(steps, target)))
    expect(dirs).toEqual(TARGETS.map((target) => `test-results/${target}`))
    expect(new Set(dirs).size).toBe(steps.filter((s) => s.name.startsWith('e2e ')).length)
  })
})
