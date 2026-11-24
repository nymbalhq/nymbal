// Reads: scripts/machine-budget.ts, vitest.config.ts, tests/e2e/playwright.config.ts, stryker.config.mjs, stryker.integration.config.mjs
// Reads: tests/e2e/playwright.prod.config.ts, vitest.stryker.config.ts, vitest.stryker.integration.config.ts
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CAP_VARS,
  e2eBaseTimeoutMs,
  LOCAL_DEFAULTS,
  MACHINE_ENV_FILE,
  MACHINE_ENV_FILE_VAR,
  machineBudget,
  playwrightOwnWorkers,
} from '../../scripts/machine-budget'

// The machine is shared with other projects: Vitest, Playwright and Stryker each take the machine budget's cap, a
// low default a machine file or a variable overrides, while CI keeps each tool's own sizing. Each config is loaded in a
// child process with the environment a run would have, and read as the tool reads it.

const exec = promisify(execFile)

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-budget-')))
  created.push(dir)
  return dir
}

/** A machine file holding `lines`. */
function machineFile(lines: string[]): string {
  const path = join(scratch(), MACHINE_ENV_FILE)
  writeFileSync(path, `${lines.join('\n')}\n`)
  return path
}

/** The environment of a run on a machine with no file and none of the budget's variables, plus `env`. */
function runEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const name of [...Object.values(CAP_VARS), 'CI', 'GITHUB_ACTIONS']) delete base[name]
  base[MACHINE_ENV_FILE_VAR] = join(tmpdir(), 'nymbal-no-machine-file.env')
  return { ...base, ...env }
}

/** The last line a child printed, as JSON. */
const lastJson = (stdout: string): unknown =>
  JSON.parse(stdout.trimEnd().split('\n').pop() ?? 'null')

/** `test.maxWorkers` as Vitest resolves vitest.config.ts (or `config`); null when it is left to Vitest. */
async function vitestMaxWorkers(
  env: Record<string, string>,
  config?: string,
): Promise<number | null> {
  const options = { watch: false, ...(config === undefined ? {} : { config }) }
  const script = `const { resolveConfig } = await import('vitest/node')
const { vitestConfig } = await resolveConfig(${JSON.stringify(options)})
process.stdout.write('\\n' + JSON.stringify(vitestConfig.maxWorkers ?? null) + '\\n')`
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    env: runEnv(env),
  })
  return lastJson(stdout) as number | null
}

/** The Playwright config's `workers` (or another key); null when it is left to Playwright. */
async function playwrightWorkers(
  env: Record<string, string>,
  key: 'workers' | 'globalTimeout' = 'workers',
  config = 'tests/e2e/playwright.config.ts',
): Promise<number | null> {
  const script = `import(process.env.NYMBAL_TEST_CONFIG_URL).then((m) => {
  process.stdout.write('\\n' + JSON.stringify(m.default[${JSON.stringify(key)}] ?? null) + '\\n')
})`
  const url = pathToFileURL(join(REPO, config)).href
  const { stdout } = await exec(TSX, ['--eval', script], {
    cwd: join(REPO, 'tests/e2e'),
    env: runEnv({ ...env, NYMBAL_TEST_CONFIG_URL: url }),
  })
  return lastJson(stdout) as number | null
}

/** A Stryker config's `concurrency`, imported by Node as the Stryker CLI imports it; null when left to Stryker. */
async function strykerConcurrency(
  config: string,
  env: Record<string, string>,
): Promise<number | null> {
  const script = `const m = await import(${JSON.stringify(pathToFileURL(join(REPO, config)).href)})
process.stdout.write('\\n' + JSON.stringify(m.default.concurrency ?? null) + '\\n')`
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    env: runEnv(env),
  })
  return lastJson(stdout) as number | null
}

describe('each tool takes the machine budget', () => {
  it('Vitest resolves the cap by default, the variable over it, the machine file, and its own under CI', async () => {
    const file = machineFile([`${CAP_VARS.vitest}=6`])
    const [local, set, fromFile, ci] = await Promise.all([
      vitestMaxWorkers({}),
      vitestMaxWorkers({ [CAP_VARS.vitest]: '3' }),
      vitestMaxWorkers({ [MACHINE_ENV_FILE_VAR]: file }),
      vitestMaxWorkers({ CI: 'true' }),
    ])
    expect(local).toBe(LOCAL_DEFAULTS.vitest)
    expect(set).toBe(3)
    expect(fromFile).toBe(6)
    // What Vitest resolves is what the budget computes for the same environment, whichever source set it.
    expect(fromFile).toBe(machineBudget(runEnv({ [MACHINE_ENV_FILE_VAR]: file }), REPO).vitest)
    expect(local).toBe(machineBudget(runEnv({}), REPO).vitest)
    expect(ci).toBeNull()
  })

  it('Playwright takes the cap by default and its own under CI, unless the gate names a number', async () => {
    const [local, ci, gate] = await Promise.all([
      playwrightWorkers({}),
      playwrightWorkers({ CI: '1', GITHUB_ACTIONS: 'true' }),
      // The gate runs Playwright under CI=1 locally, so it hands the cap over in the variable.
      playwrightWorkers({ CI: '1', [CAP_VARS.playwright]: '1' }),
    ])
    expect(local).toBe(LOCAL_DEFAULTS.playwright)
    expect(ci).toBeNull()
    expect(gate).toBe(1)
  })

  it('the production-build Playwright config takes the same cap, and its own under CI', async () => {
    const prod = 'tests/e2e/playwright.prod.config.ts'
    const [local, ci, dev] = await Promise.all([
      playwrightWorkers({}, 'workers', prod),
      playwrightWorkers({ CI: '1', GITHUB_ACTIONS: 'true' }, 'workers', prod),
      playwrightWorkers({}),
    ])
    expect(local).toBe(dev)
    expect(local).toBe(LOCAL_DEFAULTS.playwright)
    expect(ci).toBeNull()
  })

  it.each(['vitest.stryker.config.ts', 'vitest.stryker.integration.config.ts'])(
    '%s runs one Vitest worker, as Stryker runs it, not one per core',
    async (config) => {
      const [local, ci] = await Promise.all([
        vitestMaxWorkers({}, config),
        vitestMaxWorkers({ CI: 'true' }, config),
      ])
      expect(local).toBe(1)
      expect(ci).toBe(local)
    },
  )

  it("Playwright's whole-run bound grows by the cut when it runs under fewer workers than its own", async () => {
    const own = playwrightOwnWorkers(availableParallelism())
    const [atOwn, atOne] = await Promise.all([
      playwrightWorkers({ CI: '1', [CAP_VARS.playwright]: String(own) }, 'globalTimeout'),
      playwrightWorkers({ CI: '1', [CAP_VARS.playwright]: '1' }, 'globalTimeout'),
    ])
    expect(atOwn).toBe(e2eBaseTimeoutMs({}))
    expect(atOne).toBe(e2eBaseTimeoutMs({}) * own)
  })

  it.each(['stryker.config.mjs', 'stryker.integration.config.mjs'])(
    '%s takes the cap by default, the variable over it, and its own under CI',
    async (config) => {
      const [local, set, ci] = await Promise.all([
        strykerConcurrency(config, {}),
        strykerConcurrency(config, { [CAP_VARS.stryker]: '5' }),
        strykerConcurrency(config, { CI: 'true' }),
      ])
      expect(local).toBe(LOCAL_DEFAULTS.stryker)
      expect(set).toBe(5)
      expect(ci).toBeNull()
      // The option Stryker reads: a cap under another name would leave Stryker at the cores less one.
      const schema = JSON.parse(
        readFileSync(
          join(REPO, 'node_modules/@stryker-mutator/core/schema/stryker-schema.json'),
          'utf8',
        ),
      ) as { properties: Record<string, unknown> }
      expect(Object.keys(schema.properties)).toContain('concurrency')
    },
  )
})

describe('the machine file', () => {
  it('overrides the defaults, a variable overrides it, and under CI it still applies', () => {
    const file = machineFile([
      '# this machine',
      `${CAP_VARS.vitest}=8`,
      `export ${CAP_VARS.playwright}="3"`,
      '',
    ])
    const env = { [MACHINE_ENV_FILE_VAR]: file }
    expect(machineBudget(env, REPO)).toEqual({
      vitest: 8,
      playwright: 3,
      stryker: LOCAL_DEFAULTS.stryker,
    })
    expect(machineBudget({ ...env, [CAP_VARS.vitest]: '2' }, REPO).vitest).toBe(2)
    // Under CI the file's caps stand and only the one it does not set falls back to the tool's own.
    expect(machineBudget({ ...env, CI: 'true' }, REPO)).toEqual({
      vitest: 8,
      playwright: 3,
      stryker: undefined,
    })
  })

  it("a linked worktree reads the main checkout's file", () => {
    const root = scratch()
    const main = join(root, 'main')
    mkdirSync(main)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: main, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
    git('worktree', 'add', '-q', '-b', 'other', join(root, 'other'))
    writeFileSync(join(main, MACHINE_ENV_FILE), `${CAP_VARS.stryker}=7\n`)
    expect(machineBudget({}, join(root, 'other')).stryker).toBe(7)
    expect(machineBudget({}, main).stryker).toBe(7)
  })

  it('refuses a name it does not read and a cap that is not a positive integer', () => {
    const typo = machineFile(['NYMBAL_VITEST_WORKERS=2'])
    expect(() => machineBudget({ [MACHINE_ENV_FILE_VAR]: typo }, REPO)).toThrow(
      /NYMBAL_VITEST_WORKERS=2/,
    )
    const zero = machineFile([`${CAP_VARS.playwright}=0`])
    expect(() => machineBudget({ [MACHINE_ENV_FILE_VAR]: zero }, REPO)).toThrow(
      `${CAP_VARS.playwright} must be a positive integer; got "0"`,
    )
  })

  it('refuses the worktree slots and background priority, which nothing reads any more', () => {
    for (const line of ['NYMBAL_GATE_SLOTS=3', 'NYMBAL_BACKGROUND=1']) {
      const stale = machineFile([line])
      expect(() => machineBudget({ [MACHINE_ENV_FILE_VAR]: stale }, REPO), line).toThrow(
        new RegExp(`takes ${Object.values(CAP_VARS).join(', ')}; got "${line}"`),
      )
    }
  })
})
