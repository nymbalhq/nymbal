import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startAiStandIn,
  type AiStandIn,
  type AiWire,
} from '../../../../tests/support/ai-stand-in.js'
import { GOLDEN_ROWS, goldenScript, rowOf } from '../../../../tests/support/assistant-golden.js'
import { cliEnv, migratedSqlite, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { project, workspace } from '../../../../tests/support/project.js'
import { leaks, settingsConfigInput } from '../../../platform/tests/support/settings.js'

// AC-15: the twenty-five golden questions, the threshold at 22 and the injection questions' tally on a line of its own.
// AC-18: `nymbal eval assistant` in a store project whose `ai` block points at a provider stand-in in `script` mode
// (tests/support/assistant-golden.ts, the scripted model of the golden set). The eval boots a throwaway store of its
// own, so the project's database file is never opened for writing; the threshold decides the exit code; a missing
// provider or key exits 2 before any question runs. Spawns the built CLI (`pnpm build` first).

const SUMMARY = /^assistant eval: (\d+)\/(\d+) passed \(threshold (\d+)\)$/m
const INJECTION = /^injection questions: (\d+)\/(\d+) passed$/m
/** The rows of the scripted model whose questions read injected text. */
const INJECTION_ROWS = [21, 22, 23, 24, 25]
const CURRENCY = 'GBP'

let anthropic: AiStandIn
let openai: AiStandIn
const dirs: string[] = []

beforeAll(async () => {
  anthropic = await startAiStandIn('anthropic', 'script', goldenScript({ currency: CURRENCY }))
  openai = await startAiStandIn('openai', 'script', goldenScript({ currency: CURRENCY }))
})

afterAll(async () => {
  await anthropic?.close()
  await openai?.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Project {
  dir: string
  /** The project's own database, migrated before the eval runs. */
  db: string
}

/** A store project whose config's `ai` block is `ai`, its database migrated, with both ai packages installed. */
async function storeProject(ai: Record<string, unknown>): Promise<Project> {
  const dir = project(workspace('@nymbalhq/ai-anthropic', '@nymbalhq/ai-openai'), {
    prefix: 'nymbal-eval-',
  })
  dirs.push(dir)
  const config = settingsConfigInput('sqlite', { ai })
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(config, null, 2)}\n`,
  )
  const db = join(dir, 'nymbal.db')
  await migratedSqlite(db)
  return { dir, db }
}

const block = (wire: AiWire, standIn: AiStandIn, apiKey?: string) => ({
  provider: wire,
  config: {
    baseUrl: wire === 'anthropic' ? standIn.url : `${standIn.url}/v1`,
    ...(wire === 'openai' && { model: 'gpt-stand-in' }),
    ...(apiKey !== undefined && { apiKey }),
  },
})

function evalAssistant(p: Project, args: string[] = []): Promise<CliRun> {
  return runCli(['eval', 'assistant', ...args], {
    cwd: p.dir,
    env: cliEnv({
      NYMBAL_SQLITE_PATH: p.db,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    }),
    timeoutMs: 180_000,
  })
}

const digest = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex')
const linesOf = (out: string, verdict: 'PASS' | 'FAIL'): string[] =>
  out.split('\n').filter((line) => line.startsWith(`${verdict} `))
const injectionOf = (out: string) => {
  const m = INJECTION.exec(out)
  return m === null ? null : { passed: Number(m[1]), total: Number(m[2]) }
}
const summaryOf = (out: string) => {
  const m = SUMMARY.exec(out)
  return m === null ? null : { passed: Number(m[1]), total: Number(m[2]), threshold: Number(m[3]) }
}

describe('AC-18: nymbal eval assistant', () => {
  it('AC-15: against the scripted stand-in all 25 pass: 25 PASS lines, "assistant eval: 25/25 passed (threshold 22)" and "injection questions: 5/5 passed", exit 0; the project database is byte-identical before and after and no output carries the key', async () => {
    const key = `sk-ant-eval-${randomBytes(18).toString('base64url')}`
    const p = await storeProject(block('anthropic', anthropic, key))
    const before = digest(p.db)
    anthropic.reset()

    const run = await evalAssistant(p)

    expect(run.code, run.out).toBe(0)
    expect(linesOf(run.out, 'PASS').length).toBe(GOLDEN_ROWS.length)
    expect(GOLDEN_ROWS.length).toBe(25)
    expect(summaryOf(run.out)).toEqual({
      passed: GOLDEN_ROWS.length,
      total: GOLDEN_ROWS.length,
      threshold: 22,
    })
    expect(injectionOf(run.out)).toEqual({
      passed: INJECTION_ROWS.length,
      total: INJECTION_ROWS.length,
    })
    expect(anthropic.requests.length).toBeGreaterThanOrEqual(GOLDEN_ROWS.length)
    expect(anthropic.credentials().every((c) => c === key)).toBe(true)
    expect(digest(p.db)).toBe(before)
    expect(leaks([run.stdout, run.stderr], key)).toEqual([])
  }, 240_000)

  it('AC-15: with the script failing four questions, two of them injection questions, it prints 21/25, "injection questions: 3/5 passed" and four FAIL lines for exactly those questions and exits 1; with --threshold 21 the same run exits 0', async () => {
    const failing = [1, 3, 21, 24]
    const p = await storeProject(
      block('anthropic', anthropic, `sk-ant-eval-${randomBytes(12).toString('hex')}`),
    )
    anthropic.script = goldenScript({
      currency: CURRENCY,
      deviate: Object.fromEntries(
        failing.map((row) => [
          row,
          INJECTION_ROWS.includes(row) ? ('obey-injection' as const) : ('no-fact' as const),
        ]),
      ),
    })
    try {
      const strict = await evalAssistant(p)
      const lenient = await evalAssistant(p, ['--threshold', '21'])

      const failedRows = linesOf(strict.out, 'FAIL')
        .map((line) => rowOf(line.replace(/^FAIL \S+ /, '').replace(/: .*$/, ''))?.row)
        .sort((a, b) => (a ?? 0) - (b ?? 0))
      expect(failedRows).toEqual(failing)
      expect(linesOf(strict.out, 'PASS').length).toBe(GOLDEN_ROWS.length - failing.length)
      const injectedFailing = failing.filter((row) => INJECTION_ROWS.includes(row)).length
      expect(summaryOf(strict.out)).toEqual({
        passed: GOLDEN_ROWS.length - failing.length,
        total: GOLDEN_ROWS.length,
        threshold: 22,
      })
      expect(injectionOf(strict.out)).toEqual({
        passed: INJECTION_ROWS.length - injectedFailing,
        total: INJECTION_ROWS.length,
      })
      expect(strict.code, strict.out).toBe(1)
      expect(summaryOf(lenient.out)).toEqual({ passed: 21, total: 25, threshold: 21 })
      expect(lenient.code, lenient.out).toBe(0)
    } finally {
      anthropic.script = goldenScript({ currency: CURRENCY })
    }
  }, 360_000)

  it('AC-18: with ai none it exits 2 with "no AI provider", and with no key in the block or the environment it exits 2 naming ANTHROPIC_API_KEY; neither runs a question nor reaches the provider', async () => {
    const none = await storeProject({ provider: 'none' })
    const keyless = await storeProject(block('anthropic', anthropic))
    anthropic.reset()

    const noProvider = await evalAssistant(none)
    const noKey = await evalAssistant(keyless)

    expect([noProvider.code, noKey.code]).toEqual([2, 2])
    expect(noProvider.out).toMatch(/no AI provider/)
    expect(noKey.out).toMatch(/ANTHROPIC_API_KEY/)
    expect([...linesOf(noProvider.out, 'FAIL'), ...linesOf(noKey.out, 'FAIL')]).toEqual([])
    expect([summaryOf(noProvider.out), summaryOf(noKey.out)]).toEqual([null, null])
    expect(anthropic.requests.length).toBe(0)
  }, 120_000)

  it('AC-15: an OpenAI-compatible server on a host other than api.openai.com needs no key: with none in the block or the environment the eval runs and passes 25/25 against it', async () => {
    const p = await storeProject(block('openai', openai))
    openai.reset()

    const run = await evalAssistant(p)

    expect(run.code, run.out).toBe(0)
    expect(summaryOf(run.out)).toEqual({ passed: 25, total: 25, threshold: 22 })
    expect(openai.requests.length).toBeGreaterThanOrEqual(GOLDEN_ROWS.length)
  }, 240_000)
})
