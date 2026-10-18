import { describe, expect, it } from 'vitest'
import { plan, type StepSpec } from '../../scripts/gate'

// Acceptance tests for P1-17 (spec P1-17-loop-asks-what-user-sees), AC-16, review round finding 5: Playwright's
// `--last-failed` reads `<output dir>/.last-run.json`, and the three E2E steps shared one output dir, so after a
// three-project gate an earlier red project re-ran nothing. Each E2E step passes `--output test-results/<target>`,
// and `--rerun-red` re-runs a step with `--last-failed` in that same dir. Plan level: the commands are the contract.

const TARGETS = ['astro', 'nextjs', 'admin']
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

  it('AC-16: the rerun plan runs a red e2e astro with --last-failed in astro’s own output dir', () => {
    const gate = e2eStep(plan(INPUT).steps, 'astro')
    const rerun = e2eStep(plan({ ...INPUT, rerun: { tests: [] } }).steps, 'astro')
    expect(playwrightOf(rerun)).toMatch(/\s--last-failed\b/)
    expect(outputDir(rerun)).toBe(outputDir(gate))
    expect(outputDir(rerun)).toBe('test-results/astro')
  })
})
