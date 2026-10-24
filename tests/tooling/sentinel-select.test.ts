import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { plan, selectSentinels, workspaceClosure } from '../../scripts/gate'
import { loadSentinels, type Sentinel, touchedPaths } from '../../scripts/sentinels'
import { cleanupScratch, gateCli, REPO, scratchRepo, STRYKER_CONFIG, write } from './scratch-gate'
import { parseYaml } from './workflow-yaml'

// AC-13 and AC-14: sentinels by impact. selectSentinels(sentinels, changed, closure) is exported by scripts/gate.ts;
// `closure(packageDir)` is the workspace closure of a package, `(dir) => workspaceClosure(root, dir)` in the gate. A
// sentinel is selected when a changed file is a path its patch touches, its `# killed-by` file, or inside the closure
// of the killed-by file's package; scripts/sentinels.ts or tests/sentinels/** selects every one, and a configuration
// file selects none on its own (dev CI runs them all on every push). The plan takes the selection as
// `sentinels: 'all' | Set<string>`; the CLI's `--sentinels all|impacted` defaults to impacted. ci.yml's sentinel job
// passes `all` on a push, and the nightly keeps `all`.

afterEach(cleanupScratch)

const REAL = loadSentinels(join(REPO, 'tests/sentinels'))
const ALL = REAL.map((s) => s.id).sort()
const memo = new Map<string, string[]>()
const closure = (dir: string): string[] => {
  if (!memo.has(dir)) memo.set(dir, workspaceClosure(REPO, dir))
  return memo.get(dir) ?? []
}
const select = (changed: string[], sentinels: Sentinel[] = REAL): string[] =>
  [...selectSentinels(sentinels, changed, closure)].sort()

/** The repository paths a `# killed-by` header names. */
const killedByFiles = (s: Sentinel): string[] =>
  s.killedBy.match(/\b(?:packages|tests|apps|templates)\/[\w./-]+\.test\.ts\b/g) ?? []

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

describe('AC-13: selectSentinels selects by patch target, killed-by file and closure', () => {
  it('AC-13: every real sentinel is selected by a change to each path its patch touches, and to its killed-by file', () => {
    expect(REAL.length).toBeGreaterThan(10)
    for (const s of REAL) {
      const paths = [...touchedPaths(s.patch), ...killedByFiles(s)]
      expect(paths.length, s.id).toBeGreaterThan(0)
      for (const path of paths) expect(select([path]), `${s.id} for ${path}`).toContain(s.id)
    }
  })

  it("AC-13: a change inside the killed-by package's closure selects it; one outside selects nothing", () => {
    const sdk = sentinel('I901', 'packages/sdk/src/b.ts', 'packages/sdk/src/b.test.ts (AC-1)')
    const fake = (dir: string): string[] =>
      dir === 'packages/sdk' ? ['packages/sdk', 'packages/types'] : [dir]
    const pick = (changed: string[]): string[] => [...selectSentinels([sdk], changed, fake)]
    expect(pick(['packages/types/src/index.ts'])).toEqual(['I901'])
    expect(pick(['packages/sdk/src/other.ts'])).toEqual(['I901'])
    expect(pick(['packages/cli/src/commands/dev.ts'])).toEqual([])
  })

  it('AC-13: on the real sentinels, a template page selects none, and a kernel or types change selects all', () => {
    expect(select(['templates/astro/src/pages/index.astro'])).toEqual([])
    expect(select(['packages/platform/src/services/inventory-service.ts'])).toEqual(ALL)
    expect(select(['packages/types/src/index.ts'])).toEqual(ALL)
  })

  it.each(['scripts/sentinels.ts', 'tests/sentinels/S001-sqlite-transaction-passthrough.patch'])(
    'AC-13: %s selects every sentinel',
    (path) => {
      expect(select([path, 'templates/astro/src/pages/index.astro'])).toEqual(ALL)
    },
  )

  it.each([
    'package.json',
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'packages/web-components/package.json',
  ])('audit 2026-10-22: %s, a configuration file, selects no sentinel by itself', (path) => {
    expect(select([path, 'templates/astro/src/pages/index.astro'])).toEqual([])
    expect(select([path, 'packages/types/src/index.ts'])).toEqual(ALL)
  })

  it('AC-13: property: the selection is a subset of all ids, and growing `changed` never removes an id', () => {
    const pool = [
      ...new Set([
        ...REAL.flatMap((s) => [...touchedPaths(s.patch), ...killedByFiles(s)]),
        'templates/astro/src/pages/index.astro',
        'templates/nextjs/app/(catalog)/home/[key]/page.tsx',
        'apps/admin/src/main.tsx',
        'docs/notes.md',
        'packages/sdk/src/client.ts',
        'packages/cli/src/commands/dev.ts',
        'packages/types/src/index.ts',
        'package.json',
        'scripts/sentinels.ts',
      ]),
    ]
    fc.assert(
      fc.property(fc.subarray(pool), fc.subarray(pool), (a, b) => {
        const small = select(a)
        const large = new Set(select([...a, ...b]))
        expect(small.filter((id) => !ALL.includes(id))).toEqual([])
        expect(small.filter((id) => !large.has(id))).toEqual([])
      }),
      { numRuns: 200 },
    )
  })
})

/** The ids a sentinels command passes to --only, or null when it passes none. */
function onlyIds(command: string): string[] | null {
  const m = /--only[= ]+['"]?([\w,-]+)/.exec(command)
  return m?.[1] === undefined ? null : m[1].split(',').sort()
}

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

  it('AC-14: by default the CLI runs only the impacted sentinels, and skips the step when none is', async () => {
    const repo = sentinelRepo()
    write(repo.root, 'packages/sdk/src/b.ts', 'export const v = 3\n')
    const impacted = await gateCli(repo, ARGS)
    expect(sentinelCalls(repo.calls()).map(onlyIds), impacted.output).toEqual([['I901']])

    const quiet = sentinelRepo()
    write(quiet.root, 'templates/astro/src/pages/index.astro', '<h1>home!</h1>\n')
    const none = await gateCli(quiet, ARGS)
    const step = none.steps.find((s) => s.name === 'sentinels')
    expect(step?.status, none.output).toBe('skipped')
    expect((step?.detail ?? '').length).toBeGreaterThan(0)
    expect(sentinelCalls(quiet.calls()), none.output).toEqual([])
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

// CI runs on pushes only, so every CI sentinel run is a push's: all.
describe('AC-4: a push and the nightly run all sentinels', () => {
  it("AC-4: ci.yml's sentinel job passes all on push; nightly.yml's gate:full passes all", () => {
    const ci = (event: string): string[] =>
      sentinelsArgs('.github/workflows/ci.yml', 'sentinels', /scripts\/gate\.ts/, event)
    const nightly = (event: string): string[] =>
      sentinelsArgs('.github/workflows/nightly.yml', 'gate-full', /\bgate:full\b/, event)
    expect({
      'ci push': ci('push'),
      'nightly schedule': nightly('schedule'),
      'nightly workflow_dispatch': nightly('workflow_dispatch'),
    }).toEqual({
      'ci push': ['all'],
      'nightly schedule': ['all'],
      'nightly workflow_dispatch': ['all'],
    })
  })
})
