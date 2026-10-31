// Reads: scripts/mutation-ratchet.ts, stryker.config.mjs, stryker.integration.config.mjs, vitest.config.ts
import { execFile, execFileSync } from 'node:child_process'
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { mutateSet } from '../../scripts/gate'
import { raise, scoreByFile, totalScore } from '../../scripts/mutation-ratchet'
import type { Ratchet, Scores } from '../../scripts/mutation-ratchet'
// @ts-expect-error -- a JavaScript config with no declaration file, as stryker.config.mjs
import strykerIntegration from '../../stryker.integration.config.mjs'
import vitestIntegration from '../../vitest.stryker.integration.config'
import integrationRatchet from '../../mutation-ratchet.integration.json' with { type: 'json' }

// The second mutation run: the files only the platform integration tests reach, mutated under a narrowed integration
// test set and held by a ratchet of their own. The three files are imported here, not only read from disk, so that a
// change to any of them selects this file in a changed-tests run. The CLI runs from this checkout's scripts, in
// scratch git repositories that hold copies of both Stryker configs and both ratchets, so nothing here writes the
// checkout's own files.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SCRIPT = join(REPO, 'scripts/mutation-ratchet.ts')

const INTEGRATION_CONFIG = 'stryker.integration.config.mjs'
const INTEGRATION_VITEST = 'vitest.stryker.integration.config.ts'
const INTEGRATION_RATCHET = 'mutation-ratchet.integration.json'
const UNIT_RATCHET = 'mutation-ratchet.json'
const INTEGRATION = ['--config', INTEGRATION_CONFIG, '--ratchet', INTEGRATION_RATCHET]

/** The kernel files whose behaviour only the integration tests reach. */
const INTEGRATION_FILES = [
  'packages/platform/src/events/publisher.ts',
  'packages/platform/src/events/relay.ts',
  'packages/platform/src/repositories/alert-subscription.ts',
  'packages/platform/src/repositories/email-suppression.ts',
  'packages/platform/src/repositories/order-access-key.ts',
  'packages/platform/src/repositories/processed-event.ts',
  'packages/platform/src/repositories/order-sequence.ts',
  'packages/platform/src/services/alert-service.ts',
  'packages/platform/src/services/recently-viewed-service.ts',
]

/** Integration tests that fail in Stryker's sandbox, or import from outside it. */
const SANDBOX_UNSAFE = ['adapter-graph', 'security-adapter-selection', 'capabilities-route']

type StrykerConfig = {
  mutate: string[]
  vitest?: { configFile?: string }
  jsonReporter?: { fileName?: string }
}
type VitestTest = { include?: string[]; projects?: Array<{ test?: VitestTest }> }

const STRYKER = strykerIntegration as StrykerConfig
const SET = STRYKER.mutate.filter((glob) => !glob.startsWith('!')).sort()
const REPORT_PATH = STRYKER.jsonReporter?.fileName ?? '(no jsonReporter.fileName)'

/** The include globs of the one project the integration Vitest config defines, as a plain or a projects config. */
function includeGlobs(): string[] {
  const test = (vitestIntegration as unknown as { test?: VitestTest }).test
  return test?.projects?.[0]?.test?.include ?? test?.include ?? []
}

const exec = promisify(execFile)

async function cli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(TSX, [SCRIPT, ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GATE_BASE: '', ...env },
    })
    return { code: 0, output: `${stdout}\n${stderr}`.trim() }
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim(),
    }
  }
}

/** The test files `vitest list` collects with these arguments, relative to the checkout. */
async function vitestFiles(args: string[]): Promise<string[]> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_')) env[key] = value
  }
  const { stdout } = await exec(
    join(REPO, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json', ...args],
    { cwd: REPO, env, maxBuffer: 64 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{ file: string }>
  return rows.map((row) => relative(REPO, row.file)).sort()
}

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------------------------------------------
// Stryker reports and ratchets
// ---------------------------------------------------------------------------------------------------------------

type Status = 'Killed' | 'Timeout' | 'Survived' | 'NoCoverage' | 'Ignored'

/** A report in Stryker's schema, files keyed by repo-relative path. */
function report(files: Record<string, Status[]>): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    files: Object.fromEntries(
      Object.entries(files).map(([path, statuses]) => [
        path,
        {
          language: 'typescript',
          source: '',
          mutants: statuses.map((status, i) => ({
            id: String(i),
            mutatorName: 'BlockStatement',
            replacement: '{}',
            status,
            location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
          })),
        },
      ]),
    ),
  }
}

/** Mutants scoring exactly `detected / n` (a Killed first, so never all Timeout), with one ignored mutant. */
function exactFile(detected: number, n: number): Status[] {
  return [
    ...Array.from({ length: detected }, (_, i): Status => (i % 2 === 0 ? 'Killed' : 'Timeout')),
    ...Array.from(
      { length: n - detected },
      (_, i): Status => (i % 2 === 0 ? 'Survived' : 'NoCoverage'),
    ),
    'Ignored',
  ]
}

const ratchetText = (files: Scores): string =>
  `${JSON.stringify({ measuredAt: '2026-10-01T00:00:00.000Z', command: 'fixture', total: 40, files }, null, 2)}\n`

const readRatchet = (path: string): Ratchet => JSON.parse(readFileSync(path, 'utf8')) as Ratchet

const hasTwoDecimals = (x: number): boolean => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The paths of `candidates` that `output` names as a whole path, not as part of a longer one. */
const named = (output: string, candidates: string[]): string[] =>
  candidates.filter((p) => new RegExp(`(?<![\\w./-])${escape(p)}(?![\\w./-])`).test(output)).sort()

/** Shell words of a printed command, plain or quoted. */
const words = (line: string): string[] =>
  [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)

function flagValue(args: string[], name: string): string | undefined {
  const at = args.findIndex((a) => a === name || a.startsWith(`${name}=`))
  if (at === -1) return undefined
  const arg = args[at]!
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[at + 1]
}

/** The printed remedies: each line that tells the reader to run an `update` of the ratchet. */
const remedies = (output: string): string[] =>
  output.split('\n').filter((line) => /mutation:ratchet update\b/.test(line))

/** The remedies whose `update` would not read the integration config, ratchet and report. */
function aimedElsewhere(lines: string[]): string[] {
  return lines.filter((line) => {
    const update = words(line.slice(line.indexOf('mutation:ratchet update')).split('&&')[0] ?? '')
    return (
      flagValue(update, '--config') !== INTEGRATION_CONFIG ||
      flagValue(update, '--ratchet') !== INTEGRATION_RATCHET ||
      flagValue(update, '--report') !== REPORT_PATH
    )
  })
}

/** Mutate-set files of the unit config only: in the scratch they stand for the other 35. */
const UNIT_ONLY = [
  'packages/platform/src/repositories/cart.ts',
  'packages/platform/src/services/cart-service.ts',
]
const STALE = 'packages/platform/src/services/gone-service.ts'

/** Unit entries for every mutate-set file in the scratch, distinct and two-decimal. */
const UNIT_ENTRIES: Scores = Object.fromEntries(
  [...SET, ...UNIT_ONLY].map((path, i) => [path, (1234 + i * 1717) / 100]),
)

/**
 * A git repository holding both Stryker configs (copies of this checkout's), the integration-set sources and two
 * unit-only ones, the unit ratchet and an integration ratchet holding `integration`.
 */
function gitScratch(integration: Scores, unit: Scores = UNIT_ENTRIES): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-ratchet-integration-')))
  created.push(dir)
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  write('stryker.config.mjs', readFileSync(join(REPO, 'stryker.config.mjs'), 'utf8'))
  write(INTEGRATION_CONFIG, readFileSync(join(REPO, INTEGRATION_CONFIG), 'utf8'))
  ;[...SET, ...UNIT_ONLY].forEach((path, i) => write(path, `export const n${i} = ${i}\n`))
  write(UNIT_RATCHET, ratchetText(unit))
  write(INTEGRATION_RATCHET, ratchetText(integration))
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=f', '-c', 'user.email=f@x', '-c', 'commit.gpgsign=false', ...args],
      { cwd: dir, stdio: 'ignore' },
    )
  }
  git('init', '--quiet')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')
  return dir
}

const writeReport = (dir: string, files: Record<string, Status[]>): string => {
  const path = join(dir, 'fixture-report.json')
  writeFileSync(path, JSON.stringify(report(files)))
  return path
}

// ---------------------------------------------------------------------------------------------------------------

describe('AC-1: the integration Stryker config and its test set', () => {
  it('AC-1: the integration config mutates exactly its nine files, each tracked and each in the unit mutate set, and runs its own Vitest config', async () => {
    expect(SET).toEqual([...INTEGRATION_FILES].sort())
    const tracked = execFileSync('git', ['ls-files', '--', ...SET], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort()
    expect(tracked, 'tracked in git').toEqual(SET)
    expect((await mutateSet(REPO, SET)).sort(), 'inside the unit mutate set').toEqual(SET)
    const everyTracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    expect(
      (await mutateSet(REPO, everyTracked, INTEGRATION_CONFIG)).sort(),
      "the gate's mutate set under the integration config",
    ).toEqual(SET)
    expect(STRYKER.vitest?.configFile).toBe(INTEGRATION_VITEST)
  })

  it('AC-1: property: of any set of paths, the integration config mutates exactly those in its set, and the unit config mutates each of them too', async () => {
    const tracked = execFileSync('git', ['ls-files', 'packages/platform/src'], {
      cwd: REPO,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
    // The integration set, every path beside it in services and repositories, and paths outside both.
    const sample = [
      ...new Set([
        ...SET,
        ...tracked.filter((p) => /\/(?:services|repositories)\//.test(p)).slice(0, 40),
        ...tracked.filter((p) => !/\/(?:services|repositories)\//.test(p)).slice(0, 10),
      ]),
    ]
    await fc.assert(
      fc.asyncProperty(fc.subarray(sample), async (paths) => {
        const integration = await mutateSet(REPO, paths, INTEGRATION_CONFIG)
        const unit = new Set(await mutateSet(REPO, paths))
        expect(integration.filter((p) => !unit.has(p))).toEqual([])
        expect(integration.length).toBeLessThanOrEqual(unit.size)
        expect([...integration].sort()).toEqual(paths.filter((p) => SET.includes(p)).sort())
      }),
      { numRuns: 100, examples: [[SET]] },
    )
  })

  it('AC-1: Vitest collects under the integration config exactly what its globs match: each glob matches a file under the integration tests, and none matches a test that fails in the sandbox', async () => {
    const globs = includeGlobs()
    expect(globs.length, 'the config has include globs').toBeGreaterThanOrEqual(1)
    const matched = new Map(globs.map((glob) => [glob, globSync(glob, { cwd: REPO }).sort()]))
    expect(
      globs.filter((glob) => matched.get(glob)!.length === 0),
      'globs that match no file',
    ).toEqual([])
    const union = [...new Set([...matched.values()].flat())].sort()
    expect(
      union.filter((p) => !p.startsWith('packages/platform/tests/integration/')),
      'matched outside the integration tests',
    ).toEqual([])
    const collected = await vitestFiles(['--config', INTEGRATION_VITEST])
    expect(collected, 'what Vitest itself collects').toEqual(union)
    expect(collected.filter((p) => SANDBOX_UNSAFE.some((name) => p.includes(name)))).toEqual([])
  })
})

describe('AC-2: check --static against the integration config and ratchet', () => {
  it('AC-2: the committed integration ratchet passes the static check, one entry per file of the integration set, with no unit-test line', async () => {
    const { code, output } = await cli(REPO, ['check', '--static', ...INTEGRATION])
    expect(code, output).toBe(0)
    expect(output).toContain(`${SET.length} entries, one per file in the mutate set`)
    expect(output.split('\n').filter((l) => l.startsWith('no unit test file'))).toEqual([])
  })

  it('AC-2: in a scratch repo it exits 1 naming exactly the integration file with no entry and the entry naming no file, and every remedy names the integration config, ratchet and report', async () => {
    const missing = SET[1]!
    const entries: Scores = Object.fromEntries(
      SET.filter((p) => p !== missing).map((p, i) => [p, 60 + i]),
    )
    entries[STALE] = 50
    const dir = gitScratch(entries)
    const unitBefore = readFileSync(join(dir, UNIT_RATCHET), 'utf8')
    const { code, output } = await cli(dir, ['check', '--static', ...INTEGRATION])
    expect(code, output).toBe(1)
    expect(named(output, [...SET, ...UNIT_ONLY, STALE]), output).toEqual([missing, STALE].sort())
    const printed = remedies(output)
    expect(printed.length, output).toBeGreaterThanOrEqual(1)
    expect(aimedElsewhere(printed), `report at ${REPORT_PATH}`).toEqual([])
    expect(output.split('\n').filter((l) => l.startsWith('no unit test file'))).toEqual([])
    expect(readFileSync(join(dir, UNIT_RATCHET), 'utf8')).toBe(unitBefore)
  })

  it('AC-2: GATE_BASE in the env is not a base for the integration check: with one that resolves nowhere it exits 0 and prints what it prints with none', async () => {
    const dir = gitScratch(Object.fromEntries(SET.map((p, i) => [p, 60 + i])))
    const unset = await cli(dir, ['check', '--static', ...INTEGRATION])
    const unresolvable = await cli(dir, ['check', '--static', ...INTEGRATION], {
      GATE_BASE: '0000000000000000000000000000000000000000',
    })
    expect(unset.code, unset.output).toBe(0)
    expect(unresolvable.code, unresolvable.output).toBe(0)
    expect(unresolvable.output).not.toMatch(/--base .* does not resolve/)
    // Node's own warnings carry the process id.
    const own = (output: string): string[] =>
      output.split('\n').filter((l) => !/^\((node:\d+|Use `node)/.test(l))
    expect(own(unresolvable.output)).toEqual(own(unset.output))
  })
})

describe('AC-3: update and check with the integration config and ratchet', () => {
  const held = fc.option(fc.integer({ min: 0, max: 10000 }), { nil: undefined })
  const fileCase = fc.record({
    n: fc.constantFrom(1, 2, 4, 5, 8, 10),
    k: fc.nat(),
    held,
  })

  it('AC-3: property: update --total accepts a report covering the integration set alone and writes measuredAt, command, total and raise of the entries for those files', async () => {
    const dir = gitScratch({})
    const ratchetPath = join(dir, INTEGRATION_RATCHET)
    await fc.assert(
      fc.asyncProperty(fc.tuple(...SET.map(() => fileCase)), async (cases) => {
        const files: Record<string, Status[]> = {}
        const before: Scores = {}
        cases.forEach((c, i) => {
          files[SET[i]!] = exactFile(c.k % (c.n + 1), c.n)
          if (c.held !== undefined) before[SET[i]!] = c.held / 100
        })
        writeFileSync(ratchetPath, ratchetText(before))
        const reportPath = writeReport(dir, files)
        const started = Date.now()
        const { code, output } = await cli(dir, [
          'update',
          '--total',
          ...INTEGRATION,
          '--report',
          reportPath,
          '--command',
          'pnpm mutation:integration',
        ])
        expect(code, output).toBe(0)
        const after = readRatchet(ratchetPath)
        expect(Object.keys(after).sort()).toEqual(['command', 'files', 'measuredAt', 'total'])
        expect(after.files).toEqual(raise(before, scoreByFile(report(files))))
        for (const [path, was] of Object.entries(before)) {
          expect(after.files[path]!, `${path} never falls`).toBeGreaterThanOrEqual(was)
        }
        expect(after.total).toBe(totalScore(report(files)))
        expect(after.command).toBe('pnpm mutation:integration')
        expect(Date.parse(after.measuredAt)).toBeGreaterThanOrEqual(started - 1000)
      }),
      // Each run spawns the CLI: no shrinking, the first counterexample is the report.
      { numRuns: 5, endOnFailure: true },
    )
  })

  it('AC-3: check exits 1 on a file a hundredth below its integration entry, naming it, 0 at the entry, and on a file that rose its remedy names the integration config, ratchet and report', async () => {
    const file = SET[0]!
    // 2 of 4 detected: 50.00. The unit ratchet holds the file at 0, so a check against it never fails.
    const unit: Scores = { ...UNIT_ENTRIES, [file]: 0 }
    const others = Object.fromEntries(SET.filter((p) => p !== file).map((p) => [p, 10]))
    const CASES = [
      { name: 'below', entry: 50.01 },
      { name: 'equal', entry: 50 },
      { name: 'rose', entry: 49.99 },
    ]
    const [below, equal, rose] = await Promise.all(
      CASES.map(async (c) => {
        const dir = gitScratch({ ...others, [file]: c.entry }, unit)
        const reportPath = writeReport(dir, { [file]: exactFile(2, 4) })
        return cli(dir, ['check', ...INTEGRATION, '--report', reportPath])
      }),
    )
    expect(below!.code, below!.output).toBe(1)
    const line = below!.output.split('\n').find((l) => named(l, [file]).length === 1) ?? ''
    expect(line, below!.output).toContain('0.01')
    expect(equal!.code, equal!.output).toBe(0)
    expect(rose!.code, rose!.output).toBe(0)
    const upToDate = remedies(rose!.output).filter((l) =>
      l.includes('bring the ratchet up to date'),
    )
    expect(upToDate.length, rose!.output).toBe(1)
    expect(aimedElsewhere(upToDate), `report at ${REPORT_PATH}`).toEqual([])
  })
})

describe('AC-4: an integration score never lands on a unit entry', () => {
  it('AC-4: update, update --total and check with the integration config and ratchet leave mutation-ratchet.json byte-identical while the integration entry rises', async () => {
    const file = SET[0]!
    const unit: Scores = { ...UNIT_ENTRIES, [file]: 0 }
    const dir = gitScratch(Object.fromEntries(SET.map((p) => [p, 10])), unit)
    const unitPath = join(dir, UNIT_RATCHET)
    const integrationPath = join(dir, INTEGRATION_RATCHET)
    const unitBefore = readFileSync(unitPath, 'utf8')
    const integrationBefore = readRatchet(integrationPath).files[file]!

    const one = writeReport(dir, { [file]: exactFile(3, 4) })
    const updated = await cli(dir, ['update', ...INTEGRATION, '--report', one, '--files', file])
    expect(updated.code, updated.output).toBe(0)
    expect(readFileSync(unitPath, 'utf8'), 'after update').toBe(unitBefore)
    expect(readRatchet(integrationPath).files[file]!).toBeGreaterThan(integrationBefore)

    const checked = await cli(dir, ['check', ...INTEGRATION, '--report', one])
    expect(checked.code, checked.output).toBe(0)
    expect(readFileSync(unitPath, 'utf8'), 'after check').toBe(unitBefore)

    const whole = writeReport(dir, Object.fromEntries(SET.map((p, i) => [p, exactFile(i + 1, 5)])))
    const total = await cli(dir, ['update', '--total', ...INTEGRATION, '--report', whole])
    expect(total.code, total.output).toBe(0)
    expect(readFileSync(unitPath, 'utf8'), 'after update --total').toBe(unitBefore)
    expect(readRatchet(integrationPath).total).toBe(
      totalScore(report(Object.fromEntries(SET.map((p, i) => [p, exactFile(i + 1, 5)])))),
    )
  })

  it('AC-4: update, update --total and check with the integration config and no --ratchet refuse with exit 2, naming the flag and the paired ratchet, and write neither ratchet', async () => {
    const file = SET[0]!
    const dir = gitScratch(Object.fromEntries(SET.map((p) => [p, 10])), {
      ...UNIT_ENTRIES,
      [file]: 0,
    })
    const unitPath = join(dir, UNIT_RATCHET)
    const integrationPath = join(dir, INTEGRATION_RATCHET)
    const unitBefore = readFileSync(unitPath, 'utf8')
    const integrationBefore = readFileSync(integrationPath, 'utf8')
    const one = writeReport(dir, { [file]: exactFile(3, 4) })
    const whole = writeReport(dir, Object.fromEntries(SET.map((p, i) => [p, exactFile(i + 1, 5)])))
    const runs: Array<[string, string[]]> = [
      ['update', ['update', '--config', INTEGRATION_CONFIG, '--report', one, '--files', file]],
      ['update --total', ['update', '--total', '--config', INTEGRATION_CONFIG, '--report', whole]],
      ['check', ['check', '--config', INTEGRATION_CONFIG, '--report', one]],
    ]
    for (const [name, args] of runs) {
      const { code, output } = await cli(dir, args)
      expect(code, `${name}: ${output}`).toBe(2)
      expect(output, name).toContain('--ratchet')
      expect(output, name).toContain(INTEGRATION_RATCHET)
      expect(readFileSync(unitPath, 'utf8'), `${name}: unit ratchet`).toBe(unitBefore)
      expect(readFileSync(integrationPath, 'utf8'), `${name}: integration ratchet`).toBe(
        integrationBefore,
      )
    }
  })
})

describe('AC-5: the committed integration ratchet holds measured, non-zero entries', () => {
  const committed = integrationRatchet as unknown as Ratchet

  it('AC-5: one entry per file of the integration mutate set, each above 0 with two decimals', () => {
    expect(Object.keys(committed.files).sort()).toEqual(SET)
    const notMeasured = Object.entries(committed.files).filter(
      ([, score]) => !(score > 0 && score <= 100 && hasTwoDecimals(score)),
    )
    expect(notMeasured).toEqual([])
  })

  it('AC-5: its command is the script that runs Stryker on the integration config, and its total lies within the file scores', () => {
    expect(committed.command).toBe('pnpm mutation:integration')
    const scripts = (
      JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>
      }
    ).scripts
    const script = scripts[committed.command.replace(/^pnpm /, '')] ?? ''
    expect(words(script)).toEqual(['stryker', 'run', INTEGRATION_CONFIG])
    const values = Object.values(committed.files)
    expect(committed.total).toBeGreaterThan(0)
    expect(committed.total).toBeGreaterThanOrEqual(Math.min(...values) - 0.01)
    expect(committed.total).toBeLessThanOrEqual(Math.max(...values) + 0.01)
    expect(hasTwoDecimals(committed.total), `${committed.total} has two decimals`).toBe(true)
    expect(Date.parse(committed.measuredAt)).toBeLessThanOrEqual(Date.now())
  })
})
