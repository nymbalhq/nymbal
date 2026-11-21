import { readFileSync, statSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The machine budget: how much of a shared machine a test run may take. Vitest's workers (vitest.config.ts), the
// Playwright workers (tests/e2e/playwright.config.ts) and Stryker's concurrency (stryker.config.mjs,
// stryker.integration.config.mjs) each come from a variable, and each has a low default here, since the tools'
// own defaults (a worker per core, half the cores, the cores less one) starve whatever else the machine runs:
//
//   NYMBAL_VITEST_MAX_WORKERS    4
//   NYMBAL_PLAYWRIGHT_WORKERS    2
//   NYMBAL_STRYKER_CONCURRENCY   2
//   NYMBAL_BACKGROUND            0; 1 runs the gate's CPU-heavy steps at background priority on macOS (scripts/gate.ts).
//                                Off by default: on a loaded machine a background step is starved into timeouts
//                                (a plain gate's tests step took 50 minutes, 27 tests red, beside three other gates)
//
// A machine sets its own in `.nymbal-machine.env` at the root of the main checkout (gitignored; every linked worktree
// reads the main checkout's), one `NAME=value` per line, `#` comments; NYMBAL_MACHINE_ENV_FILE names another file. A
// variable in the environment wins over the file. With `CI` set the defaults do not apply: a CI runner keeps each
// tool's own sizing unless a variable or the file names a number. The gate (scripts/gate.ts) divides and halves these
// caps for a step; it never raises them.
//
// An E2E run's whole-run bound (tests/e2e/playwright.config.ts) was sized for Playwright's own workers, half the cores;
// under a lower cap the same tests take longer, so the bound grows by the cut (e2eGlobalTimeoutMs).

export const CAP_VARS = {
  vitest: 'NYMBAL_VITEST_MAX_WORKERS',
  playwright: 'NYMBAL_PLAYWRIGHT_WORKERS',
  stryker: 'NYMBAL_STRYKER_CONCURRENCY',
} as const

export type Tool = keyof typeof CAP_VARS

export type Budget = Record<Tool, number | undefined>

export const LOCAL_DEFAULTS: Record<Tool, number> = { vitest: 4, playwright: 2, stryker: 2 }

export const BACKGROUND_VAR = 'NYMBAL_BACKGROUND'

export const MACHINE_ENV_FILE = '.nymbal-machine.env'

export const MACHINE_ENV_FILE_VAR = 'NYMBAL_MACHINE_ENV_FILE'

const KNOWN = new Set<string>([...Object.values(CAP_VARS), BACKGROUND_VAR])

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The main checkout of the checkout at `dir`: a linked worktree's `.git` file names its git dir, whose `commondir` names the main one's. */
function mainCheckout(dir: string): string {
  const dotGit = join(dir, '.git')
  try {
    if (statSync(dotGit).isDirectory()) return dir
    const gitDir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim()
    if (gitDir === undefined) return dir
    const absolute = resolve(dir, gitDir)
    return dirname(resolve(absolute, readFileSync(join(absolute, 'commondir'), 'utf8').trim()))
  } catch {
    return dir
  }
}

/** The machine's env file for the checkout at `checkout`, whether or not it exists. */
export function machineEnvFile(env: NodeJS.ProcessEnv = process.env, checkout = REPO): string {
  const named = env[MACHINE_ENV_FILE_VAR]
  return named !== undefined && named !== ''
    ? resolve(checkout, named)
    : join(mainCheckout(checkout), MACHINE_ENV_FILE)
}

function readEnvFile(path: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const values: Record<string, string> = {}
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    const name = match?.[1]
    if (name === undefined || !KNOWN.has(name)) {
      throw new Error(`${path}:${index + 1}: takes ${[...KNOWN].join(', ')}; got "${line}"`)
    }
    values[name] = (match?.[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

/** The budget's variables as set: the environment's, else the machine file's. */
export function machineSettings(
  env: NodeJS.ProcessEnv = process.env,
  checkout = REPO,
): Record<string, string | undefined> {
  const file = readEnvFile(machineEnvFile(env, checkout))
  const settings: Record<string, string | undefined> = {}
  for (const name of KNOWN) {
    const value = env[name]
    settings[name] = value !== undefined && value !== '' ? value : file[name]
  }
  return settings
}

const underCI = (env: NodeJS.ProcessEnv): boolean =>
  env['CI'] !== undefined && env['CI'] !== '' && env['CI'] !== 'false'

/** Each tool's cap: the variable as set, else the local default, else (under CI) none, leaving the tool's own. */
export function machineBudget(env: NodeJS.ProcessEnv = process.env, checkout = REPO): Budget {
  const settings = machineSettings(env, checkout)
  const ci = underCI(env)
  const cap = (tool: Tool): number | undefined => {
    const name = CAP_VARS[tool]
    const value = settings[name]
    if (value === undefined) return ci ? undefined : LOCAL_DEFAULTS[tool]
    if (!/^[1-9]\d*$/.test(value))
      throw new Error(`${name} must be a positive integer; got "${value}"`)
    return Number(value)
  }
  return { vitest: cap('vitest'), playwright: cap('playwright'), stryker: cap('stryker') }
}

/** Whether the gate runs its CPU-heavy steps at background priority: only when NYMBAL_BACKGROUND is 1, never under CI. */
export function backgroundWanted(env: NodeJS.ProcessEnv = process.env, checkout = REPO): boolean {
  return !underCI(env) && machineSettings(env, checkout)[BACKGROUND_VAR] === '1'
}

/** The workers Playwright takes when none are set: half the cores, at least one. */
export const playwrightOwnWorkers = (cpus: number): number => Math.max(1, Math.floor(cpus / 2))

/** The whole-run E2E bound under CI: five minutes locally, ten on GitHub's runners, at Playwright's own workers. */
export const e2eBaseTimeoutMs = (env: NodeJS.ProcessEnv = process.env): number =>
  env['GITHUB_ACTIONS'] !== undefined && env['GITHUB_ACTIONS'] !== '' ? 10 * 60_000 : 5 * 60_000

/**
 * The whole-run E2E bound at `workers` on `cpus` cores: the base bound grown by the cut from Playwright's own workers,
 * so a run at a third of them gets three times as long. Never below the base.
 */
export function e2eGlobalTimeoutMs(
  env: NodeJS.ProcessEnv,
  workers: number | undefined,
  cpus: number = availableParallelism(),
): number {
  const base = e2eBaseTimeoutMs(env)
  const own = playwrightOwnWorkers(cpus)
  return workers === undefined || workers >= own ? base : Math.ceil((base * own) / workers)
}
