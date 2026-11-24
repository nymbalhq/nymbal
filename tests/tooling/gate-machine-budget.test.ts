// Reads: scripts/machine-budget.ts
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { E2E_TIMEOUT_ENV, run, type StepSpec, TIMEOUT_SCALE_ENV } from '../../scripts/gate'
import {
  CAP_VARS,
  e2eBaseTimeoutMs,
  LOCAL_DEFAULTS,
  MACHINE_ENV_FILE_VAR,
  type Tool,
} from '../../scripts/machine-budget'

// The gate hands each step that runs Vitest, Playwright or Stryker its fixed cap in the environment, whatever the
// load, and every local Vitest step its tests' longer timeouts. Each step here writes what its process saw.

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-budget-')))
  created.push(dir)
  return dir
}

function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of [
    ...Object.values(CAP_VARS),
    E2E_TIMEOUT_ENV,
    TIMEOUT_SCALE_ENV,
    'CI',
    'GITHUB_ACTIONS',
  ])
    delete env[name]
  env[MACHINE_ENV_FILE_VAR] = join(tmpdir(), 'nymbal-no-machine-file.env')
  return { ...env, ...extra }
}

/** The caps, and the test timeout scale (`scale`), a step's process saw; `unset` for one it was not given. */
type Seen = Record<Tool | 'scale', string>

/** The caps each named step's process saw, and the gate's log, at `load` on `cpus` cores. */
async function capsSeen(
  names: string[],
  opts: { env?: NodeJS.ProcessEnv; load?: number; cpus?: number } = {},
): Promise<{ seen: Record<string, Seen>; log: string }> {
  const cwd = scratch()
  const print = [...Object.values(CAP_VARS), TIMEOUT_SCALE_ENV]
    .map((name) => `"\${${name}-unset}"`)
    .join(' ')
  const steps: StepSpec[] = names.map((name, i) => ({
    name,
    command: `printf '%s %s %s %s' ${print} > '${join(cwd, `${i}.caps`)}'`,
  }))
  let log = ''
  const result = await run(steps, {
    cwd,
    budgetMs: 60_000,
    env: cleanEnv(opts.env),
    loadAverage: () => opts.load ?? 0,
    cpus: opts.cpus ?? 12,
    log: (text) => {
      log += text
    },
  })
  expect(result.exitCode).toBe(0)
  const seen = Object.fromEntries(
    names.map((name, i) => {
      const [vitest = '', playwright = '', stryker = '', scale = ''] = readFileSync(
        join(cwd, `${i}.caps`),
        'utf8',
      ).split(' ')
      return [name, { vitest, playwright, stryker, scale }]
    }),
  )
  return { seen, log }
}

const STEPS = ['tests', 'e2e astro', 'stryker', 'lint']

describe("each step runs under its tool's cap", () => {
  it("a Vitest, an E2E and the Stryker step each get their tool's cap, and a lint step none", async () => {
    const { seen } = await capsSeen(STEPS)
    expect(seen['tests']?.vitest).toBe(String(LOCAL_DEFAULTS.vitest))
    expect(seen['e2e astro']?.playwright).toBe(String(LOCAL_DEFAULTS.playwright))
    expect(seen['stryker']?.stryker).toBe(String(LOCAL_DEFAULTS.stryker))
    expect(seen['lint']).toEqual({
      vitest: 'unset',
      playwright: 'unset',
      stryker: 'unset',
      scale: 'unset',
    })
  })

  it("the machine file's numbers reach the steps in place of the defaults", async () => {
    const file = join(scratch(), 'machine.env')
    writeFileSync(file, `${CAP_VARS.vitest}=6\n${CAP_VARS.playwright}=3\n${CAP_VARS.stryker}=1\n`)
    const { seen } = await capsSeen(STEPS, { env: { [MACHINE_ENV_FILE_VAR]: file } })
    expect(seen['tests']?.vitest).toBe('6')
    expect(seen['e2e astro']?.playwright).toBe('3')
    expect(seen['stryker']?.stryker).toBe('1')
  })

  it('under CI no step is given a cap, so each tool keeps its own sizing', async () => {
    const { seen } = await capsSeen(STEPS, { env: { CI: 'true' }, load: 99 })
    for (const name of STEPS) {
      expect(seen[name]).toEqual({
        vitest: 'unset',
        playwright: 'unset',
        stryker: 'unset',
        scale: 'unset',
      })
    }
  })
})

describe('a loaded machine leaves the caps as they are', () => {
  it('far above the core count each step still gets its whole cap, and nothing is said about the load', async () => {
    const [idle, loaded] = await Promise.all([
      capsSeen(STEPS, { load: 0, cpus: 12 }),
      capsSeen(STEPS, { load: 480, cpus: 12 }),
    ])
    expect(loaded.seen).toEqual(idle.seen)
    expect(loaded.seen['tests']?.vitest).toBe(String(LOCAL_DEFAULTS.vitest))
    expect(loaded.seen['e2e astro']?.playwright).toBe(String(LOCAL_DEFAULTS.playwright))
    expect(loaded.seen['stryker']?.stryker).toBe(String(LOCAL_DEFAULTS.stryker))
    expect(loaded.log).not.toMatch(/load|halved/)
  })
})

describe("every local Vitest step's tests get longer timeouts", () => {
  // Capped workers may share the cores with other capped runs, and each test keeps its 5 s bound: a property test
  // that passes alone timed out beside other gates. vitest.config.ts multiplies every project's timeouts by the scale.
  it('on an idle machine a Vitest step is given scale 3; the E2E and Stryker steps beside it, and lint, none', async () => {
    const { seen } = await capsSeen([...STEPS, 'sentinels'], { load: 0, cpus: 12 })
    expect(seen['tests']?.scale).toBe('3')
    expect(seen['sentinels']?.scale).toBe('3')
    expect(seen['e2e astro']?.scale).toBe('unset')
    expect(seen['stryker']?.scale).toBe('unset')
    expect(seen['lint']?.scale).toBe('unset')
  })

  it('a scale the caller set is passed through unchanged', async () => {
    const { seen } = await capsSeen(['tests'], { env: { [TIMEOUT_SCALE_ENV]: '5' } })
    expect(seen['tests']?.scale).toBe('5')
  })
})

/** The Playwright workers and the whole-run bound an E2E step's process saw, at `load` on 12 cores. */
async function e2eSeen(
  opts: { env?: NodeJS.ProcessEnv; load?: number } = {},
): Promise<{ workers: string; bound: string }> {
  const cwd = scratch()
  const out = join(cwd, 'e2e.seen')
  const result = await run(
    [
      {
        name: 'e2e astro',
        command: `printf '%s %s' "\${${CAP_VARS.playwright}-unset}" "\${${E2E_TIMEOUT_ENV}-unset}" > '${out}'`,
      },
    ],
    {
      cwd,
      budgetMs: 60_000,
      env: cleanEnv(opts.env),
      loadAverage: () => opts.load ?? 0,
      cpus: 12,
      log: () => {},
    },
  )
  expect(result.exitCode).toBe(0)
  const [workers = '', bound = ''] = readFileSync(out, 'utf8').split(' ')
  return { workers, bound }
}

describe("an E2E step's whole-run bound grows as its workers shrink", () => {
  it('fewer workers than Playwright would take (half of 12 cores) get the bound grown by the cut', async () => {
    const file = join(scratch(), 'machine.env')
    writeFileSync(file, `${CAP_VARS.playwright}=6\n`)
    const [own, capped] = await Promise.all([
      e2eSeen({ env: { [MACHINE_ENV_FILE_VAR]: file } }),
      e2eSeen(),
    ])
    const base = e2eBaseTimeoutMs({})
    expect([own.workers, capped.workers]).toEqual(['6', String(LOCAL_DEFAULTS.playwright)])
    expect(Number(own.bound)).toBe(base)
    // The same tests over fewer workers: the bound times the workers stays what six workers had.
    expect(Number(capped.bound) * Number(capped.workers)).toBe(base * 6)
  })

  it('a bound set by hand stands, and under CI no bound is handed over', async () => {
    const [byHand, ci] = await Promise.all([
      e2eSeen({ env: { [E2E_TIMEOUT_ENV]: '90000' }, load: 13 }),
      e2eSeen({ env: { CI: 'true' }, load: 13 }),
    ])
    expect(byHand).toEqual({ workers: String(LOCAL_DEFAULTS.playwright), bound: '90000' })
    expect(ci).toEqual({ workers: 'unset', bound: 'unset' })
  })
})
