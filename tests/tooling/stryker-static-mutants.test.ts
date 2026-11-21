// Reads: stryker.config.mjs, stryker.integration.config.mjs
import { afterEach, describe, expect, it } from 'vitest'
import { scoreByFile } from '../../scripts/mutation-ratchet'
import { cleanupStrykerScratch, strykerUnder } from './stryker-scratch'

// A static mutant (code that runs at module load, or in a factory every test's setup calls) is run by Stryker against
// the whole suite with a reload, last in the run, against an allowance shorter than the suite's cold start: in the
// nightly it was a third of the unit run and three quarters of the integration run, and its Timeouts counted as
// detected. Each config is run here, with every option of its own but the paths it reads, over a module whose constant
// is static and whose function is not: the constant's mutants must not run, the function's must be killed.

const SOURCE = 'src/greet.ts'

const MODULE = `const GREETING = 'hello'

export function greet(name: string): string {
  return name === '' ? GREETING : \`\${GREETING}, \${name}\`
}
`
const TEST = `import { expect, it } from 'vitest'
import { greet } from './greet'

it('greets by name', () => {
  expect(greet('ada')).toBe('hello, ada')
  expect(greet('')).toBe('hello')
})
`

afterEach(cleanupStrykerScratch)

describe('Stryker leaves static mutants out', () => {
  it.each(['stryker.config.mjs', 'stryker.integration.config.mjs'])(
    '%s: the module-level constant’s mutants are not run and the function’s are killed, so the score counts only the mutants a test ran against',
    async (config) => {
      const { code, report, output } = await strykerUnder(config, SOURCE, {
        [SOURCE]: MODULE,
        'src/greet.test.ts': TEST,
      })
      expect(code, output).toBe(0)
      const mutants = report?.files[SOURCE]?.mutants ?? []
      const atLoad = mutants.filter((m) => m.location.start.line === 1)
      const inFunction = mutants.filter((m) => m.location.start.line > 1)
      expect(atLoad.length, output).toBeGreaterThan(0)
      expect(inFunction.length, output).toBeGreaterThan(0)
      expect(
        atLoad.map((m) => [m.mutatorName, m.status]),
        output,
      ).toEqual(atLoad.map((m) => [m.mutatorName, 'Ignored']))
      expect(
        inFunction.map((m) => [m.mutatorName, m.status]),
        output,
      ).toEqual(inFunction.map((m) => [m.mutatorName, 'Killed']))
      // The ratchet's score follows: every mutant a test ran against was killed.
      expect(scoreByFile(report ?? {})[SOURCE]).toBe(100)
    },
    180_000,
  )
})
