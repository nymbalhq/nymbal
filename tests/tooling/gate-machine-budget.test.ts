// Reads: scripts/machine-budget.ts
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { E2E_TIMEOUT_ENV, run, type StepSpec, TIMEOUT_SCALE_ENV } from '../../scripts/gate'
import {
  BACKGROUND_VAR,
  CAP_VARS,
  e2eBaseTimeoutMs,
  LOCAL_DEFAULTS,
  MACHINE_ENV_FILE_VAR,
  type Tool,
} from '../../scripts/machine-budget'
import type { Hold } from '../../scripts/stack'

// The gate hands each step that runs Vitest, Playwright or Stryker its cap in the environment, halves the caps of a
// step that starts while the machine is loaded, and on macOS runs its CPU-heavy steps at background priority. Each
// step here writes what its process saw; the directory is no repository, so no other worktree's gate shares it.

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
    BACKGROUND_VAR,
    E2E_TIMEOUT_ENV,
    TIMEOUT_SCALE_ENV,
    'CI',
    'GITHUB_ACTIONS',
  ])
    delete env[name]
  env[MACHINE_ENV_FILE_VAR] = join(tmpdir(), 'nymbal-no-machine-file.env')
  return { ...env, ...extra }
}

const held = async (): Promise<Hold> => Object.assign(async () => {}, { waitedMs: 0, quiet: true })

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
    acquire: held,
    loadAverage: () => opts.load ?? 0,
    cpus: opts.cpus ?? 12,
    platform: 'linux',
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

describe('a loaded machine halves the caps at the start of a step', () => {
  it('above the core count each cap halves, never below one, and the gate says so once per step', async () => {
    const file = join(scratch(), 'machine.env')
    writeFileSync(file, `${CAP_VARS.vitest}=5\n${CAP_VARS.stryker}=1\n`)
    const { seen, log } = await capsSeen(STEPS, {
      env: { [MACHINE_ENV_FILE_VAR]: file },
      load: 13,
      cpus: 12,
    })
    expect(Number(seen['tests']?.vitest)).toBe(Math.floor(5 / 2))
    expect(Number(seen['e2e astro']?.playwright)).toBe(Math.max(1, LOCAL_DEFAULTS.playwright / 2))
    expect(seen['stryker']?.stryker).toBe('1')
    const said = log.split('\n').filter((line) => line.includes('halved'))
    expect(said.map((line) => line.split(':')[0])).toEqual(['tests', 'e2e astro', 'stryker'])
    expect(said[0]).toContain('load 13.0 over 12 cores')
  })

  it('at or below the core count nothing halves and nothing is said', async () => {
    const { seen, log } = await capsSeen(STEPS, { load: 12, cpus: 12 })
    expect(seen['tests']?.vitest).toBe(String(LOCAL_DEFAULTS.vitest))
    expect(seen['e2e astro']?.playwright).toBe(String(LOCAL_DEFAULTS.playwright))
    expect(log).not.toContain('halved')
  })
})

describe("a halved Vitest step's tests get longer timeouts", () => {
  // Fewer workers on a loaded machine keep each test's 5 s bound: a property test that passes alone timed out at load
  // 382. vitest.config.ts multiplies every project's timeouts by the scale.
  it('above the core count a Vitest step is given scale 3; the E2E and Stryker steps beside it, and lint, none', async () => {
    const { seen } = await capsSeen([...STEPS, 'sentinels'], { load: 13, cpus: 12 })
    expect(seen['tests']?.scale).toBe('3')
    expect(seen['sentinels']?.scale).toBe('3')
    expect(seen['e2e astro']?.scale).toBe('unset')
    expect(seen['stryker']?.scale).toBe('unset')
    expect(seen['lint']?.scale).toBe('unset')
  })

  it('at or below the core count no step is given a scale', async () => {
    const { seen } = await capsSeen(STEPS, { load: 12, cpus: 12 })
    expect(seen['tests']?.scale).toBe('unset')
  })

  it('a scale the caller set is passed through unchanged, halved or not', async () => {
    const loaded = await capsSeen(['tests'], { env: { [TIMEOUT_SCALE_ENV]: '5' }, load: 13 })
    expect(loaded.seen['tests']?.scale).toBe('5')
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
      acquire: held,
      loadAverage: () => opts.load ?? 0,
      cpus: 12,
      platform: 'linux',
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
    const [own, capped, halved] = await Promise.all([
      e2eSeen({ env: { [MACHINE_ENV_FILE_VAR]: file } }),
      e2eSeen(),
      e2eSeen({ load: 13 }),
    ])
    const base = e2eBaseTimeoutMs({})
    expect([own.workers, capped.workers, halved.workers]).toEqual(['6', '2', '1'])
    expect(Number(own.bound)).toBe(base)
    // The same tests over fewer workers: the bound times the workers stays what six workers had.
    for (const seen of [capped, halved]) {
      expect(Number(seen.bound) * Number(seen.workers)).toBe(base * 6)
    }
    expect(Number(halved.bound)).toBeGreaterThan(Number(capped.bound))
  })

  it('a bound set by hand stands, and under CI no bound is handed over', async () => {
    const [byHand, ci] = await Promise.all([
      e2eSeen({ env: { [E2E_TIMEOUT_ENV]: '90000' }, load: 13 }),
      e2eSeen({ env: { CI: 'true' }, load: 13 }),
    ])
    expect(byHand).toEqual({ workers: '1', bound: '90000' })
    expect(ci).toEqual({ workers: 'unset', bound: 'unset' })
  })
})

/** Whether each step ran through the taskpolicy at `policy`: a stand-in that marks the run and executes the rest. */
async function throughPolicy(
  steps: { name: string; hold?: 'shared' | 'exclusive' }[],
  opts: { platform: NodeJS.Platform; policy?: string; env?: NodeJS.ProcessEnv },
): Promise<Record<string, { ran: boolean; wrapped: boolean }>> {
  const cwd = scratch()
  const policy = opts.policy ?? join(cwd, 'taskpolicy')
  writeFileSync(
    join(cwd, 'taskpolicy'),
    '#!/bin/sh\n[ "$1" = -b ] || exit 64\nshift\nNYMBAL_TEST_WRAPPED=yes exec "$@"\n',
  )
  chmodSync(join(cwd, 'taskpolicy'), 0o755)
  const result = await run(
    steps.map((step, i) => ({
      ...step,
      command: `printf '%s' "\${NYMBAL_TEST_WRAPPED-no}" > '${join(cwd, `${i}.out`)}'`,
    })),
    {
      cwd,
      budgetMs: 60_000,
      env: cleanEnv(opts.env),
      acquire: held,
      loadAverage: () => 0,
      platform: opts.platform,
      taskpolicy: policy,
    },
  )
  expect(result.exitCode).toBe(0)
  return Object.fromEntries(
    steps.map((step, i) => {
      const out = join(cwd, `${i}.out`)
      const ran = existsSync(out)
      return [step.name, { ran, wrapped: ran && readFileSync(out, 'utf8') === 'yes' }]
    }),
  )
}

const HEAVY = { name: 'tests', hold: 'shared' as const }
const TIMED = { name: 'perf', hold: 'exclusive' as const }
const PLAIN = { name: 'lint' }
const E2E = { name: 'e2e astro', hold: 'shared' as const }

const ON = { [BACKGROUND_VAR]: '1' }

describe('with NYMBAL_BACKGROUND=1 the CPU-heavy steps run at background priority on macOS', () => {
  it('on darwin a shared-hold step runs under taskpolicy; a timing-bound, E2E or unheld one does not', async () => {
    const r = await throughPolicy([HEAVY, TIMED, E2E, PLAIN], { platform: 'darwin', env: ON })
    expect(r).toEqual({
      tests: { ran: true, wrapped: true },
      perf: { ran: true, wrapped: false },
      'e2e astro': { ran: true, wrapped: false },
      lint: { ran: true, wrapped: false },
    })
  })

  it('by default, off darwin, without the binary or under CI, the step runs as it is', async () => {
    const cases = await Promise.all([
      throughPolicy([HEAVY], { platform: 'darwin' }),
      throughPolicy([HEAVY], { platform: 'linux', env: ON }),
      throughPolicy([HEAVY], {
        platform: 'darwin',
        policy: join(tmpdir(), 'no-such-taskpolicy'),
        env: ON,
      }),
      throughPolicy([HEAVY], { platform: 'darwin', env: { ...ON, CI: 'true' } }),
    ])
    for (const r of cases) expect(r['tests']).toEqual({ ran: true, wrapped: false })
  })
})
