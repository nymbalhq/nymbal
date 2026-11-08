import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  startAiStandIn,
  type AiScript,
  type AiStandIn,
  type AiWire,
  type ScriptView,
} from '../../../../tests/support/ai-stand-in.js'
import { GOLDEN_ROWS, goldenScript, rowOf } from '../../../../tests/support/assistant-golden.js'
import { cliEnv, migratedSqlite, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { project, workspace } from '../../../../tests/support/project.js'
import { currentAssistantEvalHash } from '../../../platform/tests/support/eval-hash.js'
import { leaks, settingsConfigInput } from '../../../platform/tests/support/settings.js'

// AC-15: the twenty-seven golden questions, the threshold at 24 and the injection questions' tally on a line of its own.
// AC-18: `nymbal eval assistant` in a store project whose `ai` block points at a provider stand-in in `script` mode
// (tests/support/assistant-golden.ts, the scripted model of the golden set). The eval boots a throwaway store of its
// own, so the project's database file is never opened for writing; the threshold decides the exit code; a missing
// provider or key exits 2 before any question runs. Spawns the built CLI (`pnpm build` first).
// AC-9, AC-11, AC-12, AC-14: `--verbose` prints each call with its arguments and outcome; `--runs <n>` asks the set n
// times, each on a fresh throwaway store, and judges each question by majority; a bad `--runs` and a permanent provider
// error exit 2 before any summary.

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
  it('AC-15: against the scripted stand-in all 27 pass: 27 PASS lines, "assistant eval: 27/27 passed (threshold 24)" and "injection questions: 5/5 passed", exit 0; the project database is byte-identical before and after and no output carries the key', async () => {
    const key = `sk-ant-eval-${randomBytes(18).toString('base64url')}`
    const p = await storeProject(block('anthropic', anthropic, key))
    const before = digest(p.db)
    anthropic.reset()

    const run = await evalAssistant(p)

    expect(run.code, run.out).toBe(0)
    expect(linesOf(run.out, 'PASS').length).toBe(GOLDEN_ROWS.length)
    expect(GOLDEN_ROWS.length).toBe(27)
    expect(summaryOf(run.out)).toEqual({
      passed: GOLDEN_ROWS.length,
      total: GOLDEN_ROWS.length,
      threshold: 24,
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

  it('AC-15: with the script failing four questions, two of them injection questions, it prints 23/27, "injection questions: 3/5 passed" and four FAIL lines for exactly those questions and exits 1; with --threshold 23 the same run exits 0', async () => {
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
      const lenient = await evalAssistant(p, ['--threshold', '23'])

      const failedRows = linesOf(strict.out, 'FAIL')
        .map((line) => rowOf(line.replace(/^FAIL \S+ /, '').replace(/: .*$/, ''))?.row)
        .sort((a, b) => (a ?? 0) - (b ?? 0))
      expect(failedRows).toEqual(failing)
      expect(linesOf(strict.out, 'PASS').length).toBe(GOLDEN_ROWS.length - failing.length)
      const injectedFailing = failing.filter((row) => INJECTION_ROWS.includes(row)).length
      expect(summaryOf(strict.out)).toEqual({
        passed: GOLDEN_ROWS.length - failing.length,
        total: GOLDEN_ROWS.length,
        threshold: 24,
      })
      expect(injectionOf(strict.out)).toEqual({
        passed: INJECTION_ROWS.length - injectedFailing,
        total: INJECTION_ROWS.length,
      })
      expect(strict.code, strict.out).toBe(1)
      expect(summaryOf(lenient.out)).toEqual({ passed: 23, total: 27, threshold: 23 })
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

  it('AC-15: an OpenAI-compatible server on a host other than api.openai.com needs no key: with none in the block or the environment the eval runs and passes 27/27 against it', async () => {
    const p = await storeProject(block('openai', openai))
    openai.reset()

    const run = await evalAssistant(p)

    expect(run.code, run.out).toBe(0)
    expect(summaryOf(run.out)).toEqual({ passed: 27, total: 27, threshold: 24 })
    expect(openai.requests.length).toBeGreaterThanOrEqual(GOLDEN_ROWS.length)
  }, 240_000)
})

describe('nymbal eval assistant --stamp', () => {
  it('against the scripted stand-in, on Anthropic’s wire or OpenAI’s, --stamp exits 2 naming the host a stamp needs, asks no question and writes no file', async () => {
    for (const [wire, standIn, host] of [
      ['anthropic', anthropic, 'api.anthropic.com'],
      ['openai', openai, 'api.openai.com'],
    ] as const) {
      const p = await storeProject(
        block(wire, standIn, `sk-eval-${randomBytes(12).toString('hex')}`),
      )
      const stamp = join(p.dir, 'assistant-eval.json')
      standIn.reset()

      const run = await evalAssistant(p, ['--stamp', stamp])

      expect(run.code, run.out).toBe(2)
      expect(run.stderr).toContain(`--stamp records a run against ${host}, not the baseUrl`)
      expect([summaryOf(run.out), existsSync(stamp), standIn.requests.length]).toEqual([
        null,
        false,
        0,
      ])
    }
  }, 120_000)

  it('--json reports the hash of the prompt and tools the run asked with, the hash release:check holds the committed stamp to', async () => {
    const p = await storeProject(
      block('anthropic', anthropic, `sk-ant-eval-${randomBytes(12).toString('hex')}`),
    )
    const current = await currentAssistantEvalHash()

    const run = await evalAssistant(p, ['--only', 'books-count', '--threshold', '1', '--json'])

    expect(run.code, run.out).toBe(0)
    expect(
      (JSON.parse(run.stdout) as { hash: string }).hash,
      'the built CLI hashes what the platform source sends: rebuild',
    ).toBe(current)
  }, 120_000)
})

const TALLY = /^tally (\S+) (\d+)\/(\d+)$/
const TOKENS =
  /^tokens(?: run (\d+)\/(\d+))?: (\d+) in \((\d+) uncached, (\d+) cache write, (\d+) cache read\), (\d+) out$/
const VERDICT = /^(PASS|FAIL) (\S+) /

const linesIn = (text: string): string[] => text.split('\n')
/** The question ids of the PASS and FAIL lines, in order. */
const verdictIds = (lines: readonly string[]): string[] =>
  lines.flatMap((line) => {
    const m = VERDICT.exec(line)
    return m === null ? [] : [m[2]!]
  })

type Rec = Record<string, unknown>

/** The last user turn's text: the golden question a request belongs to. */
const askOf = (view: ScriptView): string =>
  view.turns[view.turns.map((t) => t.role).lastIndexOf('user')]?.content ?? ''

/**
 * `script`, recording the pending proposals each asking of the inbox question (row 9) was shown: the
 * admin_proposals_list result it reads, once per asking.
 */
function watchInbox(script: AiScript): { script: AiScript; seen: Rec[][] } {
  const seen: Rec[][] = []
  return {
    seen,
    script: (view) => {
      const last = view.turns.at(-1)
      if (rowOf(askOf(view))?.row === 9 && last?.role === 'tool') {
        let items: Rec[] = []
        try {
          items = ((JSON.parse(last.content) as Rec)['items'] as Rec[] | undefined) ?? []
        } catch {
          // A result that is not JSON shows no proposal, and the run's count of one fails.
        }
        seen.push(items)
      }
      return script(view)
    },
  }
}

describe('nymbal eval assistant: calls, runs and provider errors', () => {
  it('AC-9: --verbose prints each call under its question: order-customer’s admin_orders_get with its orderNumber -> ok before its answer line, raise-mug-price’s admin_products_update -> proposed; without --verbose no line starts "  call:"', async () => {
    const p = await storeProject(
      block('anthropic', anthropic, `sk-ant-eval-${randomBytes(12).toString('hex')}`),
    )
    const only = ['--only', 'order-customer,raise-mug-price']

    const verbose = await evalAssistant(p, [...only, '--verbose'])
    const quiet = await evalAssistant(p, only)

    const lines = linesIn(verbose.stdout)
    const head = lines.findIndex((l) => VERDICT.exec(l)?.[2] === 'order-customer')
    const number = /#\s*([A-Za-z0-9-]+)/.exec(lines[head] ?? '')?.[1] ?? ''
    const answer = lines.findIndex((l, i) => i > head && l.startsWith('  answer:'))
    const call = new RegExp(`^  call: admin_orders_get \\{.*"orderNumber":"${number}".*\\} -> ok$`)
    const raise = lines.findIndex((l) => VERDICT.exec(l)?.[2] === 'raise-mug-price')
    expect(verdictIds(lines), verbose.out).toEqual(['order-customer', 'raise-mug-price'])
    expect(number).not.toBe('')
    expect(lines.slice(head + 1, answer).filter((l) => call.test(l)).length, verbose.out).toBe(1)
    expect(
      lines.slice(raise + 1).filter((l) => /^  call: admin_products_update .* -> proposed$/.test(l))
        .length,
      verbose.out,
    ).toBe(1)
    expect(verdictIds(linesIn(quiet.stdout))).toEqual(verdictIds(lines))
    expect(linesIn(quiet.stdout).filter((l) => l.startsWith('  call:'))).toEqual([])
  }, 240_000)

  it('AC-11: --runs 3, with books-count answered without its fact on its first asking and pending-orders on its first two, prints run 1/3 to 3/3, a tally per question in golden order (books-count 2/3, pending-orders 1/3, the rest 3/3) and 26/27, and exits 0; each run is on a fresh store: its inbox shows one pending proposal, its answer names it, and each run’s write questions keep a proposal of their own', async () => {
    const p = await storeProject(
      block('anthropic', anthropic, `sk-ant-eval-${randomBytes(12).toString('hex')}`),
    )
    const failing = () =>
      goldenScript({
        currency: CURRENCY,
        deviate: { 1: 'no-fact', 4: 'no-fact' },
        askings: { 1: [1], 4: [1, 2] },
      })
    const expected = (id: string) => (id === 'books-count' ? 2 : id === 'pending-orders' ? 1 : 3)
    try {
      const text = watchInbox(failing())
      anthropic.script = text.script
      const run = await evalAssistant(p, ['--runs', '3'])

      const lines = linesIn(run.stdout)
      const starts = lines.flatMap((l, i) => (/^run \d+\/\d+$/.test(l) ? [i] : []))
      const firstRun = verdictIds(lines.slice(starts[0], starts[1]))
      const tallies = lines.flatMap((l) => {
        const m = TALLY.exec(l)
        return m === null ? [] : [[m[1], Number(m[2]), Number(m[3])]]
      })
      expect(
        starts.map((i) => lines[i]),
        run.out,
      ).toEqual(['run 1/3', 'run 2/3', 'run 3/3'])
      expect(firstRun.length).toBe(GOLDEN_ROWS.length)
      expect(tallies).toEqual(firstRun.map((id) => [id, expected(id), 3]))
      expect(summaryOf(run.out)).toEqual({ passed: 26, total: 27, threshold: 24 })
      expect(run.code, run.out).toBe(0)
      expect(text.seen.map((items) => items.length)).toEqual([1, 1, 1])

      const json = watchInbox(failing())
      anthropic.script = json.script
      const asJson = await evalAssistant(p, ['--runs', '3', '--json'])
      const body = JSON.parse(asJson.stdout) as {
        runs: number
        passed: number
        total: number
        threshold: number
        questions: Array<{ id: string; passed: number; ok: boolean }>
        reports: Array<{
          results: Array<{ id: string; ask: string; answer: string; proposals: string[] }>
        }>
      }
      const kept = body.reports.map((report) =>
        report.results.filter((r) => rowOf(r.ask)?.kind === 'write').map((r) => r.proposals),
      )
      const ids = kept.flat(2)
      expect(asJson.code, asJson.out).toBe(0)
      expect([body.runs, body.passed, body.total, body.threshold]).toEqual([3, 26, 27, 24])
      expect(body.questions).toEqual(
        firstRun.map((id) => ({ id, passed: expected(id), ok: expected(id) * 2 > 3 })),
      )
      expect(kept.map((run) => run.map((proposals) => proposals.length))).toEqual(
        kept.map(() => GOLDEN_ROWS.filter((r) => r.kind === 'write').map(() => 1)),
      )
      expect(new Set(ids).size).toBe(ids.length)
      expect(json.seen.map((items) => items.length)).toEqual([1, 1, 1])
      expect(
        body.reports.map((report, r) =>
          report.results
            .find((x) => x.id === 'inbox')
            ?.answer.includes(String(json.seen[r]?.[0]?.['command'])),
        ),
      ).toEqual([true, true, true])
    } finally {
      anthropic.script = goldenScript({ currency: CURRENCY })
    }
  }, 600_000)

  it('AC-12: with no --runs the output is today’s (27 PASS lines, the summary, the injection line and one token line, no run, tally or per-run token line); --runs 0, two, 3x and 1.5 each exit 2 with "--runs takes a whole number of at least 1" and reach the provider not at all', async () => {
    const p = await storeProject(
      block('anthropic', anthropic, `sk-ant-eval-${randomBytes(12).toString('hex')}`),
    )
    const plain = await evalAssistant(p)

    const lines = linesIn(plain.stdout).filter((l) => l !== '')
    expect(lines.filter((l) => /^(run|tally|tokens run) /.test(l))).toEqual([])
    expect(linesOf(plain.out, 'PASS').length).toBe(GOLDEN_ROWS.length)
    expect(lines.filter((l) => TOKENS.test(l)).length).toBe(1)
    expect(lines.length).toBe(GOLDEN_ROWS.length + 3)
    expect(summaryOf(plain.out)).toEqual({ passed: 27, total: 27, threshold: 24 })
    expect(injectionOf(plain.out)).toEqual({ passed: 5, total: 5 })
    expect(plain.code, plain.out).toBe(0)

    for (const bad of ['0', 'two', '3x', '1.5']) {
      anthropic.reset()
      const run = await evalAssistant(p, ['--runs', bad])
      expect(run.code, `--runs ${bad}: ${run.out}`).toBe(2)
      expect(run.stderr, `--runs ${bad}`).toContain('--runs takes a whole number of at least 1')
      expect(anthropic.requests.length, `--runs ${bad}`).toBe(0)
    }
  }, 360_000)

  it('AC-14: a permanent provider error (400 on latest-order-total’s first request) exits 2 with "the ai provider failed on latest-order-total: adapter.invalid_request" on stderr, no summary, injection or tally line, the key in neither stream and no request after the refused one; with --runs 3 it stops in run 1', async () => {
    const key = `sk-ant-eval-${randomBytes(18).toString('base64url')}`
    const p = await storeProject(block('anthropic', anthropic, key))
    try {
      for (const args of [[], ['--runs', '3']]) {
        const refused: number[] = []
        const inner = goldenScript({ currency: CURRENCY, deviate: { 5: 'provider-refuses' } })
        anthropic.script = async (view) => {
          const reply = await inner(view)
          if (reply.fail !== undefined) refused.push(view.index)
          return reply
        }
        anthropic.reset()

        const run = await evalAssistant(p, args)

        const lines = linesIn(run.out)
        expect(run.code, run.out).toBe(2)
        expect(run.stderr).toContain(
          'the ai provider failed on latest-order-total: adapter.invalid_request',
        )
        expect([summaryOf(run.out), injectionOf(run.out)]).toEqual([null, null])
        expect(lines.filter((l) => TALLY.test(l))).toEqual([])
        expect(lines.filter((l) => /^run \d+\/\d+$/.test(l))).toEqual(
          args.length === 0 ? [] : ['run 1/3'],
        )
        expect(refused).toEqual([anthropic.requests.length - 1])
        expect(leaks([run.stdout, run.stderr], key)).toEqual([])
      }
    } finally {
      anthropic.script = goldenScript({ currency: CURRENCY })
    }
  }, 360_000)
})

interface Usage {
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

/** A token line's run (0 for the total) and its counts, its uncached count checked against the others. */
function tokensOf(line: string): { run: number; usage: Usage } | undefined {
  const m = TOKENS.exec(line)
  if (m === null) return undefined
  const [input, uncached, write, read, out] = [3, 4, 5, 6, 7].map((i) => Number(m[i]))
  expect(uncached, line).toBe(input! - write! - read!)
  return {
    run: m[1] === undefined ? 0 : Number(m[1]),
    usage: {
      inputTokens: input!,
      cacheReadTokens: read!,
      cacheWriteTokens: write!,
      outputTokens: out!,
    },
  }
}

const sumOf = (usages: readonly Usage[]): Usage => ({
  inputTokens: usages.reduce((n, u) => n + u.inputTokens, 0),
  cacheReadTokens: usages.reduce((n, u) => n + u.cacheReadTokens, 0),
  cacheWriteTokens: usages.reduce((n, u) => n + u.cacheWriteTokens, 0),
  outputTokens: usages.reduce((n, u) => n + u.outputTokens, 0),
})

/** What the stand-in reported, summed over every request it answered since its reset. */
const standInUsage = (): Usage =>
  sumOf(
    anthropic.answers.map((a) => ({
      inputTokens: a.inputWords,
      cacheReadTokens: a.cacheReadWords,
      cacheWriteTokens: a.cacheWrittenWords,
      outputTokens: a.outputWords,
    })),
  )

describe('nymbal eval assistant: token usage', () => {
  it('prints a token line per run and one for all of them: input split into uncached, cache write and cache read, and output, the provider’s own counts; --json carries the same per report and in total; each question’s first request after the first reads the shared tools from the cache', async () => {
    const p = await storeProject(
      block('anthropic', anthropic, `sk-ant-eval-${randomBytes(12).toString('hex')}`),
    )
    const args = [
      '--only',
      'books-count,product-price,pending-orders',
      '--threshold',
      '1',
      '--runs',
      '2',
    ]
    anthropic.reset()

    const run = await evalAssistant(p, args)

    const firsts = anthropic.requests.flatMap((r, i) =>
      (r.body as { messages: unknown[] }).messages.length === 1 ? [anthropic.answers[i]!] : [],
    )
    const lines = linesIn(run.stdout).flatMap((l) => tokensOf(l) ?? [])
    expect(run.code, run.out).toBe(0)
    expect(
      lines.map((l) => l.run),
      run.out,
    ).toEqual([1, 2, 0])
    expect(lines[2]!.usage).toEqual(standInUsage())
    expect(sumOf([lines[0]!.usage, lines[1]!.usage])).toEqual(lines[2]!.usage)
    expect(firsts.map((a) => a.cacheReadWords > 0)).toEqual([false, true, true, true, true, true])

    anthropic.reset()
    const asJson = await evalAssistant(p, [...args, '--json'])
    const body = JSON.parse(asJson.stdout) as { usage: Usage; reports: Array<{ usage: Usage }> }
    expect(asJson.code, asJson.out).toBe(0)
    expect(body.usage).toEqual(standInUsage())
    expect(sumOf(body.reports.map((r) => r.usage))).toEqual(body.usage)
    expect(body.reports).toHaveLength(2)
  }, 360_000)
})
