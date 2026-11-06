// Reads: scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts, tests/sentinels/**
// Reads: .github/workflows/ci.yml, packages/*/package.json
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { plan } from '../../scripts/gate'
import { loadSentinels, type Sentinel } from '../../scripts/sentinels'
import { cleanupScratch, gateCli, REPO, scratchRepo, STRYKER_CONFIG, write } from './scratch-gate'
import { parseYaml } from './workflow-yaml'

// Sentinels by id. The plan takes `sentinels: 'all' | 'none' | Set<string>`: a set runs `pnpm sentinels --only` with
// exactly its ids, and the empty set skips as `none` does. The CLI's `--sentinels all|none|<id>[,<id>…]` runs the ids
// as given, whatever changed; `--only sentinels` alone runs every one; an id that is not in tests/sentinels/ is refused
// before any step runs, naming it and every known id. ci.yml's sentinel job passes `all` on a push and on a dispatch.

afterEach(cleanupScratch)

const REAL = loadSentinels(join(REPO, 'tests/sentinels'))
const ALL = REAL.map((s) => s.id).sort()

const sentinel = (id: string, target: string, killedBy: string): Sentinel => ({
  id,
  kind: 'injected',
  defect: `${id} breaks ${target}`,
  where: `${target}:1`,
  killedBy,
  patch: [
    `diff --git a/${target} b/${target}`,
    `--- a/${target}`,
    `+++ b/${target}`,
    '@@ -1 +1 @@',
    '-export const v = 1',
    '+export const v = 2',
    '',
  ].join('\n'),
})

/** The ids a sentinels command passes to --only, or null when it passes none. */
function onlyIds(command: string): string[] | null {
  const m = /--only[= ]+['"]?([\w,-]+)/.exec(command)
  return m?.[1] === undefined ? null : m[1].split(',').sort()
}

// The CLI on a scratch repository: two sentinels, one per package; pnpm is a stand-in that logs its calls.
const PATCH = (id: string, target: string, killedBy: string): string =>
  [
    `# id: ${id}`,
    '# kind: injected',
    `# defect: ${id} breaks ${target}`,
    `# where: ${target}:1`,
    `# killed-by: ${killedBy}`,
    sentinel(id, target, killedBy).patch,
  ].join('\n')

function sentinelRepo(): ReturnType<typeof scratchRepo> {
  return scratchRepo({
    'package.json': JSON.stringify({ name: 'gate-scratch', private: true }),
    'stryker.config.mjs': STRYKER_CONFIG,
    'packages/sdk/package.json': JSON.stringify({ name: '@nymbalhq/sdk' }),
    'packages/sdk/src/b.ts': 'export const v = 1\n',
    'packages/platform/package.json': JSON.stringify({ name: '@nymbalhq/platform' }),
    'packages/platform/src/a.ts': 'export const v = 1\n',
    'templates/astro/src/pages/index.astro': '<h1>home</h1>\n',
    'tests/sentinels/I901-sdk.patch': PATCH(
      'I901',
      'packages/sdk/src/b.ts',
      'packages/sdk/src/b.test.ts',
    ),
    'tests/sentinels/S901-platform.patch': PATCH(
      'S901',
      'packages/platform/src/a.ts',
      'packages/platform/src/a.test.ts',
    ),
  })
}
const ARGS = ['--full', '--only', 'sentinels', '--base', 'HEAD', '--json']
const sentinelCalls = (calls: string[]): string[] =>
  calls.filter((c) => /^pnpm .*\bsentinels\b/.test(c))

describe('AC-14: the gate:full plan and the CLI run the selection', () => {
  const sentinelsStep = (sentinels: 'all' | Set<string>): { command: string; skip?: string } => {
    const steps = plan({ full: true, base: 'HEAD', changed: [], mutated: [], sentinels }).steps
    const found = steps.find((s) => s.name === 'sentinels')
    expect(found, 'gate:full has a sentinels step').toBeTruthy()
    return found ?? { command: '' }
  }

  it('AC-14: property: a selection runs `pnpm sentinels --only` with exactly its ids', () => {
    fc.assert(
      fc.property(fc.subarray(ALL, { minLength: 1 }), (ids) => {
        const step = sentinelsStep(new Set(ids))
        expect(step.skip).toBeUndefined()
        expect(step.command).toMatch(/\bpnpm sentinels\b/)
        expect(onlyIds(step.command)).toEqual([...ids].sort())
      }),
      { numRuns: 100 },
    )
  })

  it('AC-14: an empty selection skips the step with a reason; `all` runs every sentinel', () => {
    const empty = sentinelsStep(new Set())
    expect((empty.skip ?? '').length).toBeGreaterThan(0)
    const all = sentinelsStep('all')
    expect(all.skip).toBeUndefined()
    expect(all.command).toMatch(/\bpnpm sentinels\b/)
    expect(onlyIds(all.command)).toBeNull()
  })

  it('AC-14: --sentinels all runs every sentinel whatever changed', async () => {
    const repo = sentinelRepo()
    write(repo.root, 'templates/astro/src/pages/index.astro', '<h1>home!</h1>\n')
    const run = await gateCli(repo, [...ARGS, '--sentinels', 'all'])
    const calls = sentinelCalls(repo.calls())
    expect(calls.length, run.output).toBe(1)
    expect(onlyIds(calls[0] ?? '--only none')).toBeNull()
  })
})

describe('AC-2: the CLI runs the sentinels it is given, whatever changed', () => {
  /** The scratch with only a template file changed: nothing a sentinel guards. */
  function templateOnly(): ReturnType<typeof scratchRepo> {
    const repo = sentinelRepo()
    write(repo.root, 'templates/astro/src/pages/index.astro', '<h1>home!</h1>\n')
    return repo
  }

  it('AC-2: --sentinels I901 runs I901 alone, and I901,S901 runs both in one call, on a template-only change', async () => {
    const one = templateOnly()
    const both = templateOnly()
    const [a, b] = await Promise.all([
      gateCli(one, [...ARGS, '--sentinels', 'I901']),
      gateCli(both, [...ARGS, '--sentinels', 'I901,S901']),
    ])
    expect(sentinelCalls(one.calls()).map(onlyIds), a.output).toEqual([['I901']])
    expect(sentinelCalls(both.calls()).map(onlyIds), b.output).toEqual([['I901', 'S901']])
  })

  it.each(['X999', 'impacted'])(
    'AC-2: --sentinels %s is refused before any step runs, naming it and every known id',
    async (value) => {
      const repo = templateOnly()
      const run = await gateCli(repo, [...ARGS, '--sentinels', value])
      expect(run.code, run.output).not.toBe(0)
      expect(sentinelCalls(repo.calls()), run.output).toEqual([])
      expect(run.steps, run.output).toEqual([])
      expect(
        [value, 'I901', 'S901'].filter((word) => !run.output.includes(word)),
        run.output,
      ).toEqual([])
    },
  )

  it('AC-2: --only sentinels alone runs every sentinel on a template-only change', async () => {
    const repo = templateOnly()
    const run = await gateCli(repo, ARGS)
    expect(sentinelCalls(repo.calls()).map(onlyIds), run.output).toEqual([null])
  })
})

// A GitHub Actions expression, the subset a workflow here could use to pick an argument by event: string and boolean
// literals, `github.event_name`, `env.<NAME>`, the status functions, `!`, `==`, `!=`, `&&`, `||` and parentheses.
// Anything else throws, so a form this reader does not know fails loudly instead of reading as the wrong event.
type Ctx = { event: string; env: Record<string, string> }
type Value = string | boolean | null

function evaluate(source: string, ctx: Ctx): Value {
  const tokens =
    source.match(/'(?:[^']|'')*'|==|!=|&&|\|\||[!()]|[A-Za-z_][\w.-]*\(\)|[A-Za-z_][\w.-]*|\S/g) ??
    []
  let i = 0
  const truthy = (v: Value): boolean => v !== null && v !== false && v !== ''
  const peek = (): string | undefined => tokens[i]
  const take = (): string => {
    const t = tokens[i]
    if (t === undefined) throw new Error(`expression ended early: ${source}`)
    i += 1
    return t
  }
  function primary(): Value {
    const t = take()
    if (t === '(') {
      const v = or()
      if (take() !== ')') throw new Error(`unbalanced parentheses: ${source}`)
      return v
    }
    if (t === '!') return !truthy(primary())
    if (t.startsWith("'")) return t.slice(1, -1).replaceAll("''", "'")
    if (t === 'true' || t === 'false') return t === 'true'
    if (t === 'always()' || t === 'success()') return true
    if (t === 'failure()' || t === 'cancelled()') return false
    if (t === 'github.event_name') return ctx.event
    if (t.startsWith('env.')) {
      const raw = ctx.env[t.slice(4)]
      return raw === undefined ? '' : interpolate(raw, ctx)
    }
    throw new Error(`unsupported expression term "${t}" in: ${source}`)
  }
  function compare(): Value {
    let left = primary()
    while (peek() === '==' || peek() === '!=') {
      const op = take()
      const right = primary()
      left = op === '==' ? left === right : left !== right
    }
    return left
  }
  function and(): Value {
    let left = compare()
    while (peek() === '&&') {
      take()
      const right = compare()
      left = truthy(left) ? right : left
    }
    return left
  }
  function or(): Value {
    let left = and()
    while (peek() === '||') {
      take()
      const right = and()
      left = truthy(left) ? left : right
    }
    return left
  }
  const value = or()
  if (i !== tokens.length) throw new Error(`unparsed "${tokens.slice(i).join(' ')}" in: ${source}`)
  return value
}

function interpolate(text: string, ctx: Ctx): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr: string) =>
    String(evaluate(expr, ctx) ?? ''),
  )
}

function condition(text: string | undefined, ctx: Ctx): boolean {
  if (text === undefined) return true
  const bare = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(text)?.[1] ?? text
  const v = evaluate(bare, ctx)
  return v !== null && v !== false && v !== ''
}

type WorkflowStep = { run?: string; if?: string; env?: Record<string, string> }
type WorkflowJob = { if?: string; env?: Record<string, string>; steps?: WorkflowStep[] }
type Workflow = { env?: Record<string, string>; jobs?: Record<string, WorkflowJob> }

/**
 * The `--sentinels` argument of every step of `job` whose run matches `runs` and that runs on `event`, with its
 * expressions and the shell variable it names (from the step, job or workflow env) resolved.
 */
function sentinelsArgs(file: string, job: string, runs: RegExp, event: string): string[] {
  const wf = parseYaml(readFileSync(join(REPO, file), 'utf8')) as Workflow
  const j = wf.jobs?.[job]
  expect(j, `${file} has a job ${job}`).toBeTruthy()
  if (j === undefined) return []
  const jobCtx: Ctx = { event, env: { ...wf.env, ...j.env } }
  if (!condition(j.if, jobCtx)) return []
  const args: string[] = []
  for (const step of j.steps ?? []) {
    if (step.run === undefined || !runs.test(step.run)) continue
    const ctx: Ctx = { event, env: { ...jobCtx.env, ...step.env } }
    if (!condition(step.if, ctx)) continue
    const at = step.run.search(/--sentinels(?:[= ]|$)/)
    if (at < 0) {
      args.push('(no --sentinels: the gate default)')
      continue
    }
    const rest = step.run.slice(at + '--sentinels'.length).replace(/^[= ]+/, '')
    const word = /^(["']?)(\$\{\{[\s\S]*?\}\}|[^\s"']+)\1/.exec(rest)?.[2] ?? ''
    const shellVar = /^\$\{?(\w+)\}?$/.exec(word)?.[1]
    const value =
      shellVar === undefined
        ? interpolate(word, ctx)
        : ctx.env[shellVar] === undefined
          ? `(unset $${shellVar})`
          : interpolate(ctx.env[shellVar], ctx)
    args.push(value.trim())
  }
  return args
}

// CI runs on a push and on the release's dispatch; each runs every sentinel.
describe('AC-4: a push and a dispatch run all sentinels', () => {
  it("AC-4: ci.yml's sentinel job passes all on a push and on a workflow_dispatch", () => {
    const ci = (event: string): string[] =>
      sentinelsArgs('.github/workflows/ci.yml', 'sentinels', /scripts\/gate\.ts/, event)
    expect({
      push: ci('push'),
      workflow_dispatch: ci('workflow_dispatch'),
    }).toEqual({
      push: ['all'],
      workflow_dispatch: ['all'],
    })
  })
})
