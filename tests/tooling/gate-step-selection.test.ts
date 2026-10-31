// Reads: scripts/gate.ts, scripts/sentinels.ts, scripts/stack.ts, scripts/test-census.ts, package.json
// Reads: vitest.config.ts
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInputsStamp,
  buildIsCurrent,
  checkoutInUse,
  FULL_GATE_HARNESS_PROJECTS,
  HARNESS_PROJECTS,
  markInUse,
  plan,
  releaseInUse,
  STORE_SETS,
  stepModes,
  writeBuildStamp,
  type PlanInput,
  type StepSpec,
} from '../../scripts/gate'
import { loadSentinels } from '../../scripts/sentinels'
import { leftOut, listedProjects, vitestFilters } from './vitest-filters'

// What a local run of the full gate leaves to dev CI, and what it refuses to do: the sentinels, Stryker and the
// script bytes per page run only when asked (`--sentinels`, `--stryker`, `--perf-bytes`, or `--only` naming them),
// and a Stryker run that is asked for blocks on the ratchet; the harness's own projects run only when a harness path
// changed, the plain gate builds when the build output is older than HEAD's package inputs, and no gate runs while
// another process holds the checkout.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const GATE = join(REPO, 'scripts/gate.ts')

function fullPlan(extra: Partial<PlanInput> = {}): StepSpec[] {
  return plan({
    full: true,
    base: 'HEAD',
    changed: ['packages/sdk/src/client.ts'],
    mutated: ['packages/sdk/src/client.ts'],
    services: 'compose',
    ...extra,
  }).steps
}

function plainPlan(changed: string[], extra: Partial<PlanInput> = {}): StepSpec[] {
  return plan({ full: false, base: 'HEAD', changed, mutated: [], ...extra }).steps
}

const step = (steps: StepSpec[], name: string): StepSpec => {
  const found = steps.find((s) => s.name === name)
  if (found === undefined) throw new Error(`no step ${name}`)
  return found
}
const idleSkip = (s: StepSpec): boolean => s.skip !== undefined && s.idle === true

describe('the sentinels step runs only when asked', () => {
  it('sentinels: none is an idle skip that names dev CI and the flags that run them here', () => {
    const s = step(fullPlan({ sentinels: 'none' }), 'sentinels')
    expect(idleSkip(s)).toBe(true)
    expect(s.skip).toMatch(/dev CI/)
    expect(s.skip).toMatch(/--sentinels/)
  })

  it('sentinels: all and a selection still run, as before', () => {
    expect(step(fullPlan({ sentinels: 'all' }), 'sentinels').command).toMatch(/pnpm sentinels$/)
    expect(step(fullPlan({ sentinels: new Set(['S001']) }), 'sentinels').command).toMatch(
      /pnpm sentinels --only S001$/,
    )
    expect(step(fullPlan(), 'sentinels').skip, 'the plan default is every one').toBeUndefined()
  })
})

describe('the stryker step: off locally, blocking when asked and in CI', () => {
  const RATCHET = /pnpm --silent mutation:ratchet check --report reports\/mutation\/mutation\.json/

  it('off is an idle skip that names dev CI and --stryker', () => {
    const s = step(fullPlan({ stryker: 'off' }), 'stryker')
    expect(idleSkip(s)).toBe(true)
    expect(s.skip).toMatch(/dev CI/)
    expect(s.skip).toMatch(/--stryker/)
  })

  it('blocking (the plan default) chains the ratchet check with &&, so a file below its ratchet is red', () => {
    for (const steps of [fullPlan({ stryker: 'blocking' }), fullPlan()]) {
      const { command } = step(steps, 'stryker')
      expect(command).toMatch(new RegExp(`&& ${RATCHET.source}$`))
      expect(command).not.toMatch(/\|\| echo/)
    }
  })

  it('an empty mutate set is an idle skip whatever the mode but off', () => {
    for (const stryker of ['blocking'] as const) {
      const s = step(fullPlan({ stryker, mutated: [] }), 'stryker')
      expect(idleSkip(s)).toBe(true)
      expect(s.skip).toMatch(/mutate set/)
    }
  })
})

describe('AC-1: the command line decides the sentinels, stryker and perf bytes modes', () => {
  const KNOWN = loadSentinels(join(REPO, 'tests/sentinels')).map((s) => s.id)

  it('AC-1: no flag runs no sentinel, --only sentinels alone runs every one, a list runs as given, and an empty list throws', () => {
    expect(stepModes({}).sentinels).toBe('none')
    expect(stepModes({ only: ['sentinels'] }).sentinels).toBe('all')
    expect(stepModes({ sentinels: 'S001,I101' }).sentinels).toEqual(['S001', 'I101'])
    expect(() => stepModes({ sentinels: ',' })).toThrow()
  })

  it('AC-1: --stryker blocks with or without --only, --only stryker blocks, and neither leaves it off', () => {
    expect(stepModes({ stryker: true }).stryker).toBe('blocking')
    expect(stepModes({ stryker: true, only: ['stryker'] }).stryker).toBe('blocking')
    expect(stepModes({ only: ['stryker'] }).stryker).toBe('blocking')
    expect(stepModes({}).stryker).toBe('off')
    expect(stepModes({ stryker: false, only: ['tests'] }).stryker).toBe('off')
  })

  it('AC-1: perf bytes is on exactly for --perf-bytes or --only perf-bytes', () => {
    const cases = [false, true].flatMap((flag) =>
      [undefined, ['tests'], ['perf-bytes'], ['tests', 'perf-bytes']].map((only) => ({
        flag,
        only,
      })),
    )
    for (const { flag, only } of cases) {
      expect(stepModes({ perfBytes: flag, only }).perfBytes, `${flag} ${only}`).toBe(
        flag || (only?.includes('perf-bytes') ?? false),
      )
    }
  })

  it('AC-1: property: stryker is off or blocking, sentinels is all, none or the non-empty list given, perf bytes follows its flags', () => {
    const names = ['tests', 'sentinels', 'stryker', 'perf-bytes', 'e2e astro']
    fc.assert(
      fc.property(
        fc.option(fc.subarray(names), { nil: undefined }),
        fc.option(
          fc.oneof(
            fc.constantFrom('all', 'none'),
            fc.uniqueArray(fc.constantFrom(...KNOWN), { minLength: 1, maxLength: 4 }),
          ),
          { nil: undefined },
        ),
        fc.option(fc.boolean(), { nil: undefined }),
        fc.option(fc.boolean(), { nil: undefined }),
        (only, sentinels, stryker, perfBytes) => {
          const flag = Array.isArray(sentinels) ? sentinels.join(',') : sentinels
          const modes = stepModes({ only, sentinels: flag, stryker, perfBytes })
          expect(modes.stryker).toBe(
            stryker === true || only?.includes('stryker') === true ? 'blocking' : 'off',
          )
          expect(modes.perfBytes).toBe(perfBytes === true || only?.includes('perf-bytes') === true)
          const expected =
            sentinels === undefined
              ? only?.includes('sentinels') === true
                ? 'all'
                : 'none'
              : sentinels
          expect(modes.sentinels).toEqual(expected)
          const kind = Array.isArray(modes.sentinels)
            ? modes.sentinels.length > 0
              ? 'list'
              : 'empty list'
            : modes.sentinels
          expect(['all', 'none', 'list']).toContain(kind)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('AC-4: the perf-bytes step of gate:full', () => {
  const STORES = Object.keys(STORE_SETS) as Array<keyof typeof STORE_SETS>
  const COMMAND = /^(?:\S+=\S+ )*pnpm perf:budgets --bytes$/

  it('AC-4: off, it is an idle skip naming dev CI and --perf-bytes; not asked for, it is off', () => {
    for (const steps of [fullPlan({ perfBytes: false }), fullPlan()]) {
      const s = step(steps, 'perf-bytes')
      expect(idleSkip(s)).toBe(true)
      expect(s.skip).toMatch(/dev CI/)
      expect(s.skip).toMatch(/--perf-bytes/)
    }
  })

  it('AC-4: on, it runs pnpm perf:budgets --bytes after the build under a shared hold, after every e2e step of each store set; the plain gate has none', () => {
    for (const stores of STORES) {
      const steps = fullPlan({ perfBytes: true, stores })
      const names = steps.map((s) => s.name)
      const s = step(steps, 'perf-bytes')
      expect(s.skip, stores).toBeUndefined()
      expect(s.command, stores).toMatch(COMMAND)
      expect(s.needs ?? [], stores).toContain('build')
      expect(s.hold, stores).toBe('shared')
      const lastE2e = Math.max(...names.flatMap((n, i) => (n.startsWith('e2e ') ? [i] : [])))
      expect(lastE2e, `${stores} has e2e steps`).toBeGreaterThan(names.indexOf('build'))
      expect(names.indexOf('perf-bytes'), stores).toBeGreaterThan(lastE2e)
    }
    for (const perfBytes of [true, false]) {
      const plain = plainPlan(['packages/sdk/src/client.ts'], { perfBytes }).map((s) => s.name)
      expect(plain.filter((n) => n === 'perf-bytes')).toEqual([])
    }
  })

  it('AC-4: property: turning perf bytes on changes the perf-bytes step alone', () => {
    const others = (steps: StepSpec[]): StepSpec[] => steps.filter((s) => s.name !== 'perf-bytes')
    fc.assert(
      fc.property(
        fc.record({
          stores: fc.constantFrom(...STORES),
          services: fc.constantFrom('compose' as const, 'external' as const),
          sentinels: fc.oneof(
            fc.constantFrom('all' as const, 'none' as const),
            fc.uniqueArray(fc.constantFrom('S001', 'I101', 'I102')).map((ids) => new Set(ids)),
          ),
          stryker: fc.constantFrom('off' as const, 'blocking' as const),
          mutated: fc.subarray(['packages/sdk/src/client.ts']),
          changed: fc.subarray([
            'packages/sdk/src/client.ts',
            'templates/astro/src/pages/index.astro',
            'scripts/gate.ts',
          ]),
          noBase: fc.boolean(),
        }),
        (input) => {
          const extra: Partial<PlanInput> = {
            ...input,
            ...(input.services === 'external'
              ? {
                  postgresUrl: 'postgres://ci@localhost:5432/ci',
                  mailpitUrl: 'http://localhost:8025',
                }
              : {}),
          }
          const off = fullPlan({ ...extra, perfBytes: false })
          const on = fullPlan({ ...extra, perfBytes: true })
          expect(others(on)).toEqual(others(off))
          expect(idleSkip(step(off, 'perf-bytes'))).toBe(true)
          expect(step(on, 'perf-bytes').skip).toBeUndefined()
        },
      ),
      { numRuns: 100 },
    )
  })

  it('AC-4: --perf-bytes without --full exits 1, naming --full, before any step runs', () => {
    const dir = scratch()
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    const r = spawnSync(TSX, [GATE, '--perf-bytes', '--base', 'HEAD', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env,
      timeout: 60_000,
    })
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1)
    expect(r.stderr).toMatch(/--perf-bytes/)
    expect(r.stderr).toMatch(/--full/)
    expect(r.stdout, 'no step ran').not.toContain('"steps"')
  })
})

describe('the harness projects run only when a harness path or an input one of their tests declares changed; gate:full runs architecture always', () => {
  /** The harness projects a tests command leaves out (`leftOut`). */
  const negated = (command: string): string[] => leftOut(command, HARNESS_PROJECTS)
  const KERNEL = 'packages/platform/src/services/cart-service.ts'
  // Every kind of path the harness projects read besides their own files and scripts/.
  const HARNESS_INPUTS = [
    '.github/workflows/ci.yml',
    '.github/workflows/nightly.yml',
    'tests/e2e/playwright.config.ts',
    'package.json',
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'vitest.stryker.config.ts',
    'tsconfig.json',
    'packages/platform/tsconfig.json',
    'packages/platform/package.json',
  ]

  it('the plain gate leaves both out for a kernel change and keeps them for a scripts/ change', () => {
    expect(negated(step(plainPlan([KERNEL]), 'tests').command)).toEqual(
      [...HARNESS_PROJECTS].sort(),
    )
    expect(negated(step(plainPlan(['scripts/gate.ts']), 'tests').command)).toEqual([])
  })

  it('gate:full leaves out only tooling for a kernel change, so the architecture guard runs; a scripts/ change keeps both', () => {
    expect(negated(step(fullPlan({ changed: [KERNEL] }), 'tests').command)).toEqual(['tooling'])
    expect(negated(step(fullPlan({ changed: ['scripts/gate.ts'] }), 'tests').command)).toEqual([])
  })

  it.each(HARNESS_INPUTS.flatMap((path) => [false, true].map((full) => ({ path, full }))))(
    'a change to $path keeps every harness project (full: $full)',
    ({ path, full }) => {
      const steps = full ? fullPlan({ changed: [KERNEL, path] }) : plainPlan([KERNEL, path])
      expect(negated(step(steps, 'tests').command)).toEqual([])
    },
  )

  it('harness: all (dev CI) keeps them whatever changed; no base (a root commit) too', () => {
    const ci = fullPlan({
      changed: ['packages/platform/src/services/cart-service.ts'],
      harness: 'all',
    })
    expect(negated(step(ci, 'tests').command)).toEqual([])
    const root = fullPlan({ changed: [], noBase: true })
    expect(negated(step(root, 'tests').command)).toEqual([])
  })

  it('property: every harness project runs iff harness is all, there is no base, or a harness path changed; else the plain gate leaves both out and gate:full tooling', () => {
    const harnessPaths = [
      'scripts/gate.ts',
      'tests/tooling/gate.test.ts',
      'tests/architecture/architecture-guard.test.ts',
      '.github/workflows/ci.yml',
      'tests/e2e/playwright.config.ts',
      'package.json',
    ]
    const paths = fc.constantFrom(
      KERNEL,
      'docs/x.md',
      'apps/admin/src/App.tsx',
      'tests/e2e/journeys/cart.spec.ts',
      ...harnessPaths,
    )
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.uniqueArray(paths, { minLength: 1, maxLength: 4 }),
        (full, all, noBase, changed) => {
          const steps = plan({
            full,
            base: 'HEAD',
            noBase,
            changed,
            mutated: [],
            ...(full ? { services: 'compose' as const } : {}),
            harness: all ? 'all' : 'changed',
          }).steps
          const tests = step(steps, 'tests')
          if (tests.skip !== undefined) return
          const every = all || noBase || changed.some((p) => harnessPaths.includes(p))
          const expected = every ? [] : full ? ['tooling'] : [...HARNESS_PROJECTS].sort()
          expect(negated(tests.command)).toEqual(expected)
        },
      ),
    )
  })
})

describe('the tests step runs the projects it means, as Vitest resolves its filters', () => {
  const KERNEL = 'packages/platform/src/services/cart-service.ts'
  const withServices = (name: string): boolean =>
    name.startsWith('integration-') || name === 'proof-kit-services'

  it('a product change runs every project but the service-backed ones and the harness projects each gate leaves out, in the plain gate and gate:full; a configuration change (the whole suite) leaves out only the service-backed ones, and in the plain gate tooling-slow', async () => {
    const cases = [
      {
        label: 'plain gate, product change',
        steps: plainPlan([KERNEL]),
        apart: [...HARNESS_PROJECTS, 'tooling-slow'],
      },
      {
        label: 'gate:full, product change',
        steps: fullPlan({ changed: [KERNEL] }),
        apart: FULL_GATE_HARNESS_PROJECTS,
      },
      {
        label: 'plain gate, configuration change',
        steps: plainPlan(['vitest.config.ts']),
        apart: ['tooling-slow'],
      },
      {
        label: 'gate:full, configuration change',
        steps: fullPlan({ changed: ['vitest.config.ts'] }),
        apart: [],
      },
    ]
    const every = await listedProjects([])
    expect(every).toEqual(
      expect.arrayContaining([...HARNESS_PROJECTS, 'integration-postgres', 'proof-kit-services']),
    )
    const runs = await Promise.all(
      cases.map(async ({ label, steps, apart }) => {
        const { env, projects, excludes } = vitestFilters(step(steps, 'tests').command)
        const excluded = excludes.flatMap((path) => ['--exclude', path])
        const [selected, reachable] = await Promise.all([
          listedProjects([...projects.flatMap((name) => ['--project', name]), ...excluded], env),
          listedProjects(excluded),
        ])
        const expected = reachable.filter((name) => !withServices(name) && !apart.includes(name))
        return { label, selected, expected }
      }),
    )
    for (const { label, selected, expected } of runs) {
      expect(expected.length, label).toBeGreaterThan(0)
      expect(selected, label).toEqual(expected)
    }
  }, 60_000)
})

describe('the plain gate builds when the build output is older than HEAD, and every build stamps', () => {
  it('buildStale builds without a changed input, and tests need that build', () => {
    const steps = plainPlan(['packages/platform/src/services/cart-service.test.ts'], {
      buildStale: true,
    })
    expect(step(steps, 'build').skip).toBeUndefined()
    expect(step(steps, 'build').command).toMatch(/^pnpm build && .*gate\.ts build-stamp$/)
    expect(step(steps, 'tests').needs ?? []).toContain('build')
  })

  it('a current build output and no changed input is the idle skip that says so', () => {
    const build = step(
      plainPlan(['packages/platform/src/services/cart-service.test.ts'], { buildStale: false }),
      'build',
    )
    expect(idleSkip(build)).toBe(true)
    expect(build.skip).toMatch(/matches HEAD/)
  })

  it("gate:full's build stamps too", () => {
    expect(step(fullPlan(), 'build').command).toMatch(/gate\.ts build-stamp$/)
  })
})

// A scratch repository: two packages, one with a build script, committed; the stamp functions read it through git.
const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

function git(cwd: string, args: string[]): string {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
  return execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env, encoding: 'utf8' },
  ).trim()
}

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-stamp-')))
  created.push(dir)
  write(dir, 'package.json', JSON.stringify({ name: 'scratch', private: true, scripts: {} }))
  write(
    dir,
    'packages/lib/package.json',
    JSON.stringify({ name: 'lib', scripts: { build: 'tsup' } }),
  )
  write(dir, 'packages/lib/src/index.ts', 'export const a = 1\n')
  write(dir, 'packages/lib/src/index.test.ts', 'export {}\n')
  write(dir, 'packages/docs-only/package.json', JSON.stringify({ name: 'docs-only' }))
  write(dir, '.gitignore', 'dist\nreports\n')
  git(dir, ['init', '-q'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

describe('the build stamp names the package build inputs the work tree holds', () => {
  it('changes with a build input, not with a test file; a dirty input stamps as the commit of those bytes will', () => {
    const dir = scratch()
    const before = buildInputsStamp(dir)
    expect(before).toMatch(/^[0-9a-f]{64}$/)
    write(dir, 'packages/lib/src/index.test.ts', 'export const t = 1\n')
    git(dir, ['commit', '-q', '-am', 'test only'])
    expect(buildInputsStamp(dir), 'a test file is not a build input').toBe(before)
    write(dir, 'packages/lib/src/index.ts', 'export const a = 2\n')
    const modified = buildInputsStamp(dir)
    expect(modified, 'a modified input moves the stamp').not.toBe(before)
    git(dir, ['commit', '-q', '-am', 'source'])
    expect(buildInputsStamp(dir), 'committing the same bytes keeps it').toBe(modified)
    write(dir, 'packages/lib/src/new.ts', 'export {}\n')
    const untracked = buildInputsStamp(dir)
    expect(untracked, 'an untracked input moves it').not.toBe(modified)
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'new input'])
    expect(buildInputsStamp(dir), 'and committing it keeps it').toBe(untracked)
    rmSync(join(dir, 'packages/lib/src/new.ts'))
    expect(buildInputsStamp(dir), 'a deleted input is gone from the stamp').toBe(modified)
  })

  it('built while dirty, then committed → current; a later edit is stale again', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'packages/lib/dist'), { recursive: true })
    write(dir, 'packages/lib/src/index.ts', 'export const a = 4\n')
    write(dir, 'packages/lib/src/extra.ts', 'export const b = 1\n')
    writeBuildStamp(dir)
    expect(buildIsCurrent(dir), 'built from the dirty tree it still holds').toBe(true)
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-q', '-m', 'the bytes that were built'])
    expect(buildIsCurrent(dir), 'the commit of those bytes').toBe(true)
    write(dir, 'packages/lib/src/index.ts', 'export const a = 5\n')
    expect(buildIsCurrent(dir), 'an edit after the build').toBe(false)
  })

  it('buildIsCurrent: false without dist or without a stamp, true once built and stamped at HEAD, false after a new input commit', () => {
    const dir = scratch()
    expect(buildIsCurrent(dir), 'no dist').toBe(false)
    mkdirSync(join(dir, 'packages/lib/dist'), { recursive: true })
    expect(buildIsCurrent(dir), 'dist but no stamp').toBe(false)
    writeBuildStamp(dir)
    expect(existsSync(join(dir, 'reports/build-stamp.json'))).toBe(true)
    expect(buildIsCurrent(dir), 'built and stamped at HEAD').toBe(true)
    write(dir, 'packages/lib/src/index.ts', 'export const a = 3\n')
    expect(buildIsCurrent(dir), 'a dirty input').toBe(false)
    git(dir, ['commit', '-q', '-am', 'source'])
    expect(buildIsCurrent(dir), 'a merge or commit that moved an input').toBe(false)
    writeBuildStamp(dir)
    expect(buildIsCurrent(dir)).toBe(true)
  })

  it('gate.ts build-stamp --check exits 0 when current and 1 when stale, saying which', () => {
    const dir = scratch()
    mkdirSync(join(dir, 'packages/lib/dist'), { recursive: true })
    const stale = spawnSync(TSX, [GATE, 'build-stamp', '--check'], { cwd: dir, encoding: 'utf8' })
    expect(stale.status, stale.stderr).toBe(1)
    expect(stale.stdout).toMatch(/stale or unstamped; run pnpm build/)
    expect(spawnSync(TSX, [GATE, 'build-stamp'], { cwd: dir, encoding: 'utf8' }).status).toBe(0)
    const current = spawnSync(TSX, [GATE, 'build-stamp', '--check'], { cwd: dir, encoding: 'utf8' })
    expect(current.status, current.stderr).toBe(0)
    expect(current.stdout).toMatch(/matches HEAD/)
  })
})

describe('a checkout in use refuses the gate; a stale record never does', () => {
  it('a record bound to a live process is the use; one bound to a dead process is removed', () => {
    const dir = scratch()
    write(
      dir,
      'reports/in-use.json',
      JSON.stringify({ pid: process.pid, what: 'this test', since: 'now' }),
    )
    expect(checkoutInUse(dir)).toMatchObject({ pid: process.pid, what: 'this test' })
    const gone = spawnSync(process.execPath, ['-e', '0'])
    expect(gone.status).toBe(0)
    write(
      dir,
      'reports/in-use.json',
      JSON.stringify({ pid: gone.pid, what: 'finished', since: 'then' }),
    )
    expect(checkoutInUse(dir)).toBeUndefined()
    expect(existsSync(join(dir, 'reports/in-use.json')), 'the stale record is removed').toBe(false)
    write(dir, 'reports/in-use.json', 'not json')
    expect(checkoutInUse(dir)).toBeUndefined()
  })

  it('markInUse holds through a detached process that releaseInUse stops', async () => {
    const dir = scratch()
    const held = markInUse(dir, 'servers for a walkthrough')
    try {
      expect(checkoutInUse(dir)).toMatchObject({ pid: held.pid, what: 'servers for a walkthrough' })
      expect(held.pid).not.toBe(process.pid)
    } finally {
      expect(releaseInUse(dir)?.pid).toBe(held.pid)
    }
    expect(checkoutInUse(dir)).toBeUndefined()
    // The holder is this process's child: it is gone once the event loop has reaped it.
    const deadline = Date.now() + 5000
    let alive = true
    while (alive && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      alive = spawnSync('kill', ['-0', String(held.pid)]).status === 0
    }
    expect(alive, 'the holder is stopped').toBe(false)
  })

  it('the gate CLI refuses while the checkout is held, naming the pid and the way out, and runs once released', () => {
    const dir = scratch()
    write(
      dir,
      'package.json',
      JSON.stringify({
        name: 'scratch',
        private: true,
        scripts: { lint: 'true', typecheck: 'true', 'mutation:ratchet': 'true', test: 'true' },
      }),
    )
    git(dir, ['commit', '-q', '-am', 'scripts'])
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    const start = spawnSync(TSX, [GATE, 'in-use', 'start', 'servers', 'for', 'a', 'walkthrough'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    })
    expect(start.status, start.stderr).toBe(0)
    const pid = Number(/pid (\d+)/.exec(start.stdout)?.[1])
    try {
      const refused = spawnSync(TSX, [GATE, '--base', 'HEAD', '--json'], {
        cwd: dir,
        encoding: 'utf8',
        env,
      })
      expect(refused.status).toBe(1)
      expect(refused.stderr).toContain(`in use by pid ${pid} (servers for a walkthrough`)
      expect(refused.stderr).toMatch(/gate\.ts in-use status/)
      expect(refused.stdout, 'no step ran').not.toContain('"steps"')
    } finally {
      const stop = spawnSync(TSX, [GATE, 'in-use', 'stop'], { cwd: dir, encoding: 'utf8', env })
      expect(stop.stdout).toContain(`released pid ${pid}`)
    }
    const status = spawnSync(TSX, [GATE, 'in-use', 'status'], { cwd: dir, encoding: 'utf8', env })
    expect(status.stdout.trim()).toBe('in-use: free')
    const ran = spawnSync(TSX, [GATE, '--base', 'HEAD', '--json'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    })
    expect(ran.stdout, ran.stderr).toContain('"steps"')
  })
})
