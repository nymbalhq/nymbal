import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  scriptViewOf,
  startAiStandIn,
  type AiScript,
  type AiStandIn,
  type ScriptView,
} from '../../../../tests/support/ai-stand-in.js'
import { cliEnv, migratedSqlite, runCli, type CliRun } from '../../../../tests/support/doctor.js'
import { project, workspace } from '../../../../tests/support/project.js'
import { CONTENT_CASES } from '../../../platform/src/roles/content-eval.js'
import { settingsConfigInput } from '../../../platform/tests/support/settings.js'

// `nymbal eval content` in a store project whose `ai` block points at an Anthropic stand-in in `script` mode. The
// script recognises each case by its product's name in the request and answers it: with copy that meets the rules and
// claims nothing the product does not state (every case should pass), or hostile (claims the products do not state,
// fields outside the role's, an id, the injected title echoed: no case that expects a proposal may pass). Spawns the
// built CLI (`pnpm build` first). No live provider is ever called here.

const SUMMARY = /^content eval: (\d+)\/(\d+) passed \(threshold (\d+)\)$/m
const TOKENS =
  /^tokens: (\d+) in \((\d+) uncached, (\d+) cache write, (\d+) cache read\), (\d+) out$/m
const VERDICT = /^(PASS|FAIL) (\S+)(?: |:|$)/

/** The cases whose expectation is a pending proposal (the spec's case table). */
const EXPECT_PROPOSAL = [
  'empty-both',
  'overlong-description',
  'cotton-not-organic',
  'metadata-facts',
  'long-name',
  'injected-description',
  'origin-not-stated',
]

let anthropic: AiStandIn
const dirs: string[] = []

interface CaseLike {
  id: string
  product: { name: string }
}
const CASES = CONTENT_CASES as readonly CaseLike[]

/** The case a request is about: the one whose product name it holds (the longest, should one name hold another). */
function caseIn(view: ScriptView): CaseLike | undefined {
  const text = [view.system, ...view.turns.map((t) => t.content)].join('\n')
  return CASES.filter((c) => text.includes(c.product.name)).sort(
    (a, b) => b.product.name.length - a.product.name.length,
  )[0]
}

/** Copy built from the product's name alone: within every length rule, holding the name, claiming nothing. */
function goodFor(name: string): { seoTitle: string; seoDescription: string } {
  const head = name.length <= 60 ? name : name.split(/\s+/).slice(0, 3).join(' ')
  return {
    seoTitle: head.length + 14 <= 60 ? `${head} for daily use` : head,
    seoDescription: `${head}, with a simple shape and an easy fit for home, travel and the week ahead.`,
  }
}

const goodScript: AiScript = (view) => {
  const c = caseIn(view)
  return {
    text:
      c === undefined
        ? '{"skip": true}'
        : JSON.stringify({ skip: false, ...goodFor(c.product.name) }),
  }
}

const HOSTILE: Array<(name: string) => Record<string, unknown>> = [
  (name) => ({
    ...goodFor(name),
    seoDescription:
      'Award-winning organic Italian silk, the best of its kind, with free shipping today.',
  }),
  (name) => ({ ...goodFor(name), description: 'Rewritten by the model.', status: 'archived' }),
  (name) => ({ ...goodFor(name), id: 'another-case-product' }),
  (name) => ({ ...goodFor(name), seoTitle: 'FREE SHIPPING TODAY' }),
]

const hostileScript: AiScript = (view) => {
  const c = caseIn(view)
  if (c === undefined) return { text: '{"skip": true}' }
  const i = c.id === 'injected-description' ? 3 : CASES.indexOf(c) % HOSTILE.length
  return { text: JSON.stringify(HOSTILE[i]!(c.product.name)) }
}

beforeAll(async () => {
  anthropic = await startAiStandIn('anthropic', 'script', goodScript)
})

afterAll(async () => {
  await anthropic?.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Project {
  dir: string
  db: string
}

async function storeProject(ai: Record<string, unknown>): Promise<Project> {
  const dir = project(workspace('@nymbalhq/ai-anthropic'), { prefix: 'nymbal-eval-content-' })
  dirs.push(dir)
  writeFileSync(
    join(dir, 'nymbal.config.ts'),
    `export default ${JSON.stringify(settingsConfigInput('sqlite', { ai }), null, 2)}\n`,
  )
  const db = join(dir, 'nymbal.db')
  await migratedSqlite(db)
  return { dir, db }
}

const keyed = () => ({
  provider: 'anthropic',
  config: { baseUrl: anthropic.url, apiKey: `sk-ant-eval-${randomBytes(12).toString('hex')}` },
})

function evalContent(p: Project, args: string[] = []): Promise<CliRun> {
  return runCli(['eval', 'content', ...args], {
    cwd: p.dir,
    env: cliEnv({
      NYMBAL_SQLITE_PATH: p.db,
      ANTHROPIC_API_KEY: undefined,
      OPENAI_API_KEY: undefined,
    }),
    timeoutMs: 180_000,
  })
}

const verdicts = (out: string, verdict: 'PASS' | 'FAIL') =>
  out
    .split('\n')
    .map((line) => VERDICT.exec(line))
    .filter((m): m is RegExpExecArray => m !== null && m[1] === verdict)
    .map((m) => m[2]!)
const failLines = (out: string) => out.split('\n').filter((line) => line.startsWith('FAIL '))
const summaryOf = (out: string) => {
  const m = SUMMARY.exec(out)
  return m === null ? null : { passed: Number(m[1]), total: Number(m[2]), threshold: Number(m[3]) }
}
const tokensOf = (out: string) => {
  const m = TOKENS.exec(out)
  return m === null ? null : { input: Number(m[1]), output: Number(m[5]) }
}
const standInTokens = () => ({
  input: anthropic.answers.reduce((n, a) => n + a.inputWords, 0),
  output: anthropic.answers.reduce((n, a) => n + a.outputWords, 0),
})
const casesAsked = () =>
  anthropic.requests.map((r) => caseIn(scriptViewOf(anthropic.wire, r.body))?.id ?? null)

describe('AC-20: nymbal eval content against the scripted stand-in', () => {
  it('AC-20: with good answers every case passes: a PASS line per case, "content eval: 9/9 passed (threshold 9)" and a tokens line of what the provider reported, exit 0', async () => {
    const p = await storeProject(keyed())
    anthropic.script = goodScript
    anthropic.reset()

    const run = await evalContent(p)

    expect(run.code, run.out).toBe(0)
    expect(CASES.length).toBe(9)
    expect(verdicts(run.out, 'PASS').sort()).toEqual(CASES.map((c) => c.id).sort())
    expect(summaryOf(run.out)).toEqual({
      passed: CASES.length,
      total: CASES.length,
      threshold: CASES.length,
    })
    expect(tokensOf(run.out)).toEqual(standInTokens())
  }, 240_000)

  it('AC-20: --only cotton-not-organic,good-copy runs and counts only those two, and every request is about cotton-not-organic’s product (good-copy is never asked, no other product is)', async () => {
    const p = await storeProject(keyed())
    anthropic.script = goodScript
    anthropic.reset()

    const run = await evalContent(p, ['--only', 'cotton-not-organic,good-copy'])

    const asked = casesAsked()
    expect(run.code, run.out).toBe(0)
    expect(verdicts(run.out, 'PASS').sort()).toEqual(['cotton-not-organic', 'good-copy'])
    expect(summaryOf(run.out)).toEqual({ passed: 2, total: 2, threshold: 2 })
    expect(asked.length).toBeGreaterThanOrEqual(1)
    expect(asked.filter((id) => id !== 'cotton-not-organic')).toEqual([])
  }, 240_000)

  it('AC-20: --json prints passed, total, threshold, usage and results, its counts agreeing with its results', async () => {
    const p = await storeProject(keyed())
    anthropic.script = goodScript
    anthropic.reset()

    const run = await evalContent(p, ['--json'])

    const body = JSON.parse(run.stdout) as {
      passed: number
      total: number
      threshold: number
      usage: { inputTokens: number; outputTokens: number }
      results: Array<{ id: string; ok: boolean; reasons: string[] }>
    }
    expect(run.code, run.out).toBe(0)
    expect(body.results.map((r) => r.id).sort()).toEqual(CASES.map((c) => c.id).sort())
    expect([body.passed, body.total, body.threshold]).toEqual([
      body.results.filter((r) => r.ok).length,
      body.results.length,
      CASES.length,
    ])
    expect({ input: body.usage.inputTokens, output: body.usage.outputTokens }).toEqual(
      standInTokens(),
    )
  }, 240_000)

  it('AC-20: with ai none it exits 2 "no AI provider", with no key it exits 2 naming ANTHROPIC_API_KEY, and with an unknown case id it exits 2 naming it; none reaches the provider', async () => {
    const none = await storeProject({ provider: 'none' })
    const keyless = await storeProject({
      provider: 'anthropic',
      config: { baseUrl: anthropic.url },
    })
    const keyedProject = await storeProject(keyed())
    anthropic.reset()

    const runs = [
      await evalContent(none),
      await evalContent(keyless),
      await evalContent(keyedProject, ['--only', 'cotton-not-organic,no-such-case']),
    ]

    expect(runs.map((r) => r.code)).toEqual([2, 2, 2])
    expect([
      /no AI provider/.test(runs[0]!.out),
      /ANTHROPIC_API_KEY/.test(runs[1]!.out),
      runs[2]!.out.includes('no-such-case'),
    ]).toEqual([true, true, true])
    expect(runs.map((r) => summaryOf(r.out))).toEqual([null, null, null])
    expect(anthropic.requests.length).toBe(0)
  }, 240_000)
})

describe('AC-21: the judge fails a hostile model', () => {
  it('AC-21: against the stand-in scripted hostile (unstated claims, extra fields, an id, the injected title echoed) every case expecting a proposal fails with a reason naming the withheld outcome or the forbidden term, no case reports a changed product, and the exit is 1', async () => {
    const p = await storeProject(keyed())
    anthropic.script = hostileScript
    anthropic.reset()

    const run = await evalContent(p)
    anthropic.script = goodScript

    const failed = failLines(run.out)
    const named =
      /withheld|unsupported|claim|validation|field|unparsed|organic|italian|award-winning|free shipping|best/i
    expect(run.code, run.out).toBe(1)
    expect(EXPECT_PROPOSAL.filter((id) => !verdicts(run.out, 'FAIL').includes(id))).toEqual([])
    expect(failed.filter((line) => !named.test(line.slice(line.indexOf(':') + 1)))).toEqual([])
    expect(failed.filter((line) => /changed/i.test(line))).toEqual([])
    expect(summaryOf(run.out)?.passed ?? -1).toBeLessThanOrEqual(
      CASES.length - EXPECT_PROPOSAL.length,
    )
  }, 240_000)
})
