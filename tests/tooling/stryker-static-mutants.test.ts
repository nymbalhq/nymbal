// Reads: stryker.config.mjs, stryker.integration.config.mjs
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { scoreByFile } from '../../scripts/mutation-ratchet'
import { REPO, write } from './scratch-gate'

// A static mutant (code that runs at module load, or in a factory every test's setup calls) is run by Stryker against
// the whole suite with a reload, last in the run, against an allowance shorter than the suite's cold start: in the
// nightly it was a third of the unit run and three quarters of the integration run, and its Timeouts counted as
// detected. Each config is run here, with every option of its own but the paths it reads, over a module whose constant
// is static and whose function is not: the constant's mutants must not run, the function's must be killed.

const exec = promisify(execFile)
const STRYKER = join(REPO, 'node_modules/.bin/stryker')
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

type Mutant = { mutatorName: string; status: string; location: { start: { line: number } } }
type Report = { files: Record<string, { mutants: Mutant[] }> }

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Runs Stryker under `config`'s options, its paths pointed at a scratch module, and returns the JSON report. */
async function strykerUnder(config: string): Promise<{ report: Report; output: string }> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-static-')))
  created.push(dir)
  symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'))
  write(dir, SOURCE, MODULE)
  write(dir, 'src/greet.test.ts', TEST)
  write(dir, 'vitest.config.mjs', "export default { test: { include: ['src/**/*.test.ts'] } }\n")
  write(
    dir,
    'stryker.config.mjs',
    [
      `import config from ${JSON.stringify(pathToFileURL(join(REPO, config)).href)}`,
      'export default {',
      '  ...config,',
      `  mutate: [${JSON.stringify(SOURCE)}],`,
      "  vitest: { ...config.vitest, configFile: 'vitest.config.mjs' },",
      '  ignorePatterns: [],',
      "  reporters: ['json'],",
      "  jsonReporter: { fileName: 'report.json' },",
      '  incremental: false,',
      '  concurrency: 1,',
      '}',
      '',
    ].join('\n'),
  )
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('VITEST') && !k.startsWith('NYMBAL_') && k !== 'NODE_OPTIONS') env[k] = v
  }
  const { stdout, stderr } = await exec(STRYKER, ['run', 'stryker.config.mjs'], {
    cwd: dir,
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) as Report
  return { report, output: `${stdout}\n${stderr}` }
}

describe('Stryker leaves static mutants out', () => {
  it.each(['stryker.config.mjs', 'stryker.integration.config.mjs'])(
    '%s: the module-level constant’s mutants are not run and the function’s are killed, so the score counts only the mutants a test ran against',
    async (config) => {
      const { report, output } = await strykerUnder(config)
      const mutants = report.files[SOURCE]?.mutants ?? []
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
      expect(scoreByFile(report)[SOURCE]).toBe(100)
    },
    180_000,
  )
})
