import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'

// AC-1, AC-2, AC-3, AC-5 and AC-5b: the mutation ratchet.
// The module is imported by URL so that its absence fails these tests at run time, not the typecheck. Scores are
// percent with two decimals; every generated score is a whole number of hundredths built as `cents / 100`, the value
// JSON gives back for that text, so nothing drifts through a file.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SCRIPT = join(REPO, 'scripts/mutation-ratchet.ts')
const RATCHET_FILE = join(REPO, 'mutation-ratchet.json')
const BASELINE = 42.17

type Scores = Record<string, number>
type Ratchet = { measuredAt: string; command: string; total: number; files: Scores }
type Change = { file: string; ratchet: number; score: number; by: number }
type RatchetModule = {
  scoreByFile: (report: unknown) => Scores
  compare: (ratchet: Scores, scores: Scores) => { lower: Change[]; rose: Change[] }
  raise: (ratchet: Scores, scores: Scores) => Scores
  raiseWithin: (ratchet: Scores, scores: Scores, changed: Iterable<string>) => Scores
}

async function ratchetModule(): Promise<RatchetModule> {
  return (await import(pathToFileURL(SCRIPT).href)) as RatchetModule
}

const exec = promisify(execFile)

async function cli(args: string[]): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(TSX, [SCRIPT, ...args], { cwd: REPO, encoding: 'utf8' })
    return { code: 0, output: `${stdout}\n${stderr}`.trim() }
  } catch (error) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      output: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim(),
    }
  }
}

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-ratchet-')))
  created.push(dir)
  return dir
}

// ---------------------------------------------------------------------------------------------------------------
// Stryker reports
// ---------------------------------------------------------------------------------------------------------------

const VALID = ['Killed', 'Timeout', 'Survived', 'NoCoverage'] as const
const OTHER = ['CompileError', 'RuntimeError', 'Ignored', 'Pending'] as const
type Status = (typeof VALID)[number] | (typeof OTHER)[number]

function mutant(status: Status, id: number): Record<string, unknown> {
  return {
    id: String(id),
    mutatorName: 'BlockStatement',
    replacement: '{}',
    status,
    location: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
  }
}

/** A report in Stryker's mutation-testing-report-schema shape, files keyed by repo-relative path. */
function report(files: Record<string, Status[]>): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    thresholds: { high: 80, low: 60 },
    projectRoot: REPO,
    files: Object.fromEntries(
      Object.entries(files).map(([path, statuses]) => [
        path,
        { language: 'typescript', source: '', mutants: statuses.map((s, i) => mutant(s, i)) },
      ]),
    ),
  }
}

const count = (statuses: Status[], ...of: Status[]): number =>
  statuses.filter((s) => of.includes(s)).length

const pathOf = (i: number): string => `packages/platform/src/services/s${i}-service.ts`

/** Denominators that divide 10000, so `killed / n × 100` has at most two decimals and no rounding is in question. */
const EXACT_DENOMINATORS = [1, 2, 4, 5, 8, 10, 16, 20, 25, 40, 50]

/** Mutants for a file scoring exactly `killed / n`, padded with statuses the score must ignore. */
function exactFile(killed: number, n: number, ignored: number): Status[] {
  return [
    ...Array.from({ length: killed }, (_, i): Status => (i % 2 === 0 ? 'Killed' : 'Timeout')),
    ...Array.from(
      { length: n - killed },
      (_, i): Status => (i % 2 === 0 ? 'Survived' : 'NoCoverage'),
    ),
    ...Array.from({ length: ignored }, (_, i): Status => OTHER[i % OTHER.length]!),
  ]
}

/** `killed / n × 100` in hundredths, an integer because n divides 10000. */
const centsOf = (killed: number, n: number): number => (killed * 10000) / n

const exactScore = fc
  .tuple(fc.constantFrom(...EXACT_DENOMINATORS), fc.nat(), fc.nat({ max: 3 }))
  .map(([n, k, ignored]) => ({ n, killed: k % (n + 1), ignored }))

function writeJson(dir: string, name: string, value: unknown): string {
  const file = join(dir, name)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

function readRatchet(file: string): Ratchet {
  return JSON.parse(readFileSync(file, 'utf8')) as Ratchet
}

// ---------------------------------------------------------------------------------------------------------------
// The mutate set, from stryker.config.mjs
// ---------------------------------------------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else if (c === '{') source += '(?:'
    else if (c === '}') source += ')'
    else if (c === ',') source += '|'
    else source += c.replace(/[.+^$()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Every tracked file Stryker's own `mutate` globs select. */
async function mutateSet(): Promise<string[]> {
  const config = (await import(pathToFileURL(join(REPO, 'stryker.config.mjs')).href)) as {
    default: { mutate: string[] }
  }
  const include = config.default.mutate.filter((g) => !g.startsWith('!')).map(globToRegExp)
  const exclude = config.default.mutate
    .filter((g) => g.startsWith('!'))
    .map((g) => globToRegExp(g.slice(1)))
  return execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((p) => include.some((re) => re.test(p)) && !exclude.some((re) => re.test(p)))
    .sort()
}

const hasTwoDecimals = (x: number): boolean => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6

// ---------------------------------------------------------------------------------------------------------------

describe('AC-1: scoreByFile', () => {
  it('AC-1: property: each file scores (killed+timeout)/(killed+timeout+survived+noCoverage)x100 to two decimals, other statuses ignored, no valid mutants means absent', async () => {
    const { scoreByFile } = await ratchetModule()
    const statuses = fc.array(fc.constantFrom<Status>(...VALID, ...OTHER), { maxLength: 40 })
    fc.assert(
      fc.property(fc.dictionary(fc.nat({ max: 30 }).map(pathOf), statuses), (files) => {
        const scores = scoreByFile(report(files))
        const scored = Object.keys(files).filter((p) => count(files[p]!, ...VALID) > 0)
        expect(Object.keys(scores).sort()).toEqual([...scored].sort())
        for (const path of scored) {
          const s = files[path]!
          const exact = (count(s, 'Killed', 'Timeout') * 100) / count(s, ...VALID)
          const score = scores[path]!
          expect(Number.isFinite(score), path).toBe(true)
          expect(Math.abs(score - exact), `${path}: ${score} vs ${exact}`).toBeLessThanOrEqual(
            0.005 + 1e-9,
          )
          expect(hasTwoDecimals(score), `${path}: ${score} has two decimals`).toBe(true)
        }
      }),
      {
        numRuns: 300,
        examples: [
          [{ [pathOf(1)]: ['Ignored', 'CompileError', 'RuntimeError', 'Pending'] }],
          [{ [pathOf(2)]: ['Killed', 'Survived', 'Survived'] }],
          [{ [pathOf(3)]: ['Timeout', 'NoCoverage', 'Ignored'], [pathOf(4)]: [] }],
        ],
      },
    )
  })
})

describe('AC-2: check exits 1 iff a file in both the ratchet and the report scores lower', () => {
  type FileCase = {
    killed: number
    n: number
    ignored: number
    inReport: boolean
    inRatchet: boolean
    /** Ratchet minus report score, in hundredths. */
    delta: number
  }

  const fileCase = fc.record({
    score: exactScore,
    inReport: fc.boolean(),
    inRatchet: fc.boolean(),
    delta: fc.oneof(fc.constant(0), fc.integer({ min: -500, max: 500 }), fc.constantFrom(-1, 1)),
  })

  function build(cases: FileCase[]): {
    rep: Record<string, Status[]>
    ratchet: Scores
    lower: string[]
    equal: string[]
    rose: string[]
    ratchetOnly: string[]
    drop: Map<string, number>
  } {
    const rep: Record<string, Status[]> = {}
    const ratchet: Scores = {}
    const lower: string[] = []
    const equal: string[] = []
    const rose: string[] = []
    const ratchetOnly: string[] = []
    const drop = new Map<string, number>()
    cases.forEach((c, i) => {
      const path = pathOf(i)
      const cents = centsOf(c.killed, c.n)
      const ratchetCents = Math.min(10000, Math.max(0, cents + c.delta))
      if (c.inReport) rep[path] = exactFile(c.killed, c.n, c.ignored)
      if (c.inRatchet) ratchet[path] = ratchetCents / 100
      if (c.inReport && c.inRatchet) {
        if (cents < ratchetCents) {
          lower.push(path)
          drop.set(path, ratchetCents - cents)
        } else if (cents === ratchetCents) equal.push(path)
        else rose.push(path)
      } else if (c.inRatchet) ratchetOnly.push(path)
    })
    return { rep, ratchet, lower, equal, rose, ratchetOnly, drop }
  }

  /** Runs `check` on the fixture the cases describe; returns what it did beside what the relation predicts. */
  async function observe(
    cases: FileCase[],
  ): Promise<ReturnType<typeof build> & { code: number; output: string }> {
    const dir = scratch()
    const built = build(cases)
    const reportFile = writeJson(dir, 'mutation.json', report(built.rep))
    const ratchetFile = writeJson(dir, 'mutation-ratchet.json', {
      measuredAt: '2026-10-01T00:00:00.000Z',
      command: 'fixture',
      total: 50,
      files: built.ratchet,
    })
    const { code, output } = await cli(['check', '--report', reportFile, '--ratchet', ratchetFile])
    return { ...built, code, output }
  }

  const one = (o: Partial<FileCase>): FileCase => ({
    killed: 1,
    n: 4,
    ignored: 1,
    inReport: true,
    inRatchet: true,
    delta: 0,
    ...o,
  })

  it('AC-2: property: compare names, with by how much, exactly the files in both that scored lower, and exactly those that rose', async () => {
    const { compare, scoreByFile } = await ratchetModule()
    fc.assert(
      fc.property(
        fc
          .array(fileCase, { minLength: 1, maxLength: 8 })
          .map((cs) => cs.map(({ score, ...rest }) => ({ ...score, ...rest }))),
        (cases) => {
          const built = build(cases)
          const { lower, rose } = compare(built.ratchet, scoreByFile(report(built.rep)))
          const byFile = new Map(lower.map((c) => [c.file, c.by]))
          expect([...byFile.keys()].sort()).toEqual([...built.lower].sort())
          for (const path of built.lower) {
            expect(Math.round(byFile.get(path)! * 100), path).toBe(built.drop.get(path))
          }
          expect(rose.map((c) => c.file).sort()).toEqual([...built.rose].sort())
        },
      ),
      {
        numRuns: 300,
        examples: [
          [[one({ delta: 1 }), one({ delta: 0 }), one({ inRatchet: false })]],
          [[one({ delta: 0 }), one({ delta: -250 }), one({ inReport: false, delta: 300 })]],
          [[one({ inRatchet: false, killed: 0 })]],
        ],
      },
    )
  })

  it('AC-2: check, through the CLI, exits 1 on a file a hundredth below its entry and names it with by how much, names the file that rose with the hint to run update, and names neither the equal file nor the one only in the ratchet', async () => {
    const { code, output, lower, equal, rose, ratchetOnly, drop } = await observe([
      one({ delta: 1 }),
      one({ delta: 0 }),
      one({ delta: -250 }),
      one({ inRatchet: false }),
      one({ inReport: false, delta: 300 }),
    ])
    expect([lower.length, equal.length, rose.length, ratchetOnly.length]).toEqual([1, 1, 1, 1])
    expect(code, output).toBe(1)
    const lines = output.split('\n')
    for (const path of lower) {
      const line = lines.find((l) => l.includes(path)) ?? ''
      expect(line, output).toContain((drop.get(path)! / 100).toFixed(2))
    }
    for (const path of [...equal, ...ratchetOnly]) {
      expect(output, `${path} did not fall and must not be named`).not.toContain(path)
    }
    expect(
      rose.filter((p) => output.includes(p)),
      output,
    ).toEqual(rose)
    expect(output, 'the hint to run update').toMatch(/\bupdate\b/)
  })

  it('AC-2: pnpm mutation:ratchet runs the same check: a lowered file fails it, an equal one passes', () => {
    const dir = scratch()
    const path = pathOf(7)
    const reportFile = writeJson(dir, 'mutation.json', report({ [path]: exactFile(1, 2, 0) }))
    const at = (score: number): string =>
      writeJson(dir, `ratchet-${score}.json`, {
        measuredAt: '2026-10-01T00:00:00.000Z',
        command: 'fixture',
        total: 50,
        files: { [path]: score },
      })
    const viaPnpm = (ratchetFile: string): { status: number; output: string } => {
      const res = spawnSync(
        'pnpm',
        ['--silent', 'mutation:ratchet', 'check', '--report', reportFile, '--ratchet', ratchetFile],
        { cwd: REPO, encoding: 'utf8' },
      )
      return { status: res.status ?? -1, output: `${res.stdout}\n${res.stderr}` }
    }
    const lowered = viaPnpm(at(50.01))
    const equal = viaPnpm(at(50))
    expect(equal.status, equal.output).toBe(0)
    expect(lowered.status, lowered.output).toBeGreaterThan(equal.status)
    expect(lowered.output).toContain(path)
  })
})

describe('AC-3: the ratchet only rises', () => {
  const scores = fc.dictionary(
    fc.nat({ max: 12 }).map(pathOf),
    fc.integer({ min: 0, max: 10000 }).map((c) => c / 100),
  )

  it('AC-3: property: raise(r, s)[f] is max(r[f], s[f]) for files in both, s[f] for new files, r[f] for the rest', async () => {
    const { raise } = await ratchetModule()
    fc.assert(
      fc.property(scores, scores, (r, s) => {
        const before = structuredClone(r)
        const raised = raise(r, s)
        const union = [...new Set([...Object.keys(r), ...Object.keys(s)])].sort()
        expect(Object.keys(raised).sort()).toEqual(union)
        for (const f of union) {
          const expected = f in r && f in s ? Math.max(r[f]!, s[f]!) : f in s ? s[f]! : r[f]!
          expect(raised[f], f).toBe(expected)
        }
        for (const f of Object.keys(before)) {
          expect(raised[f]!, `${f} never falls`).toBeGreaterThanOrEqual(before[f]!)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('audit 2026-10-22: property: raiseWithin raises a file iff it is in `changed` or has no entry; every other entry stays as it was', async () => {
    const { raise, raiseWithin } = await ratchetModule()
    fc.assert(
      fc.property(scores, scores, fc.array(fc.nat({ max: 12 }).map(pathOf)), (r, s, changed) => {
        const within = raiseWithin(r, s, changed)
        const all = raise(r, s)
        expect(Object.keys(within).sort()).toEqual(Object.keys(all).sort())
        for (const f of Object.keys(within)) {
          const eligible = changed.includes(f) || !(f in r)
          expect(within[f], `${f} ${eligible ? 'raised' : 'kept'}`).toBe(eligible ? all[f] : r[f])
        }
      }),
      { numRuns: 300 },
    )
  })

  it('AC-3 (audit 2026-10-22): update without --total, through the CLI, writes raiseWithin of the ratchet, the report and --files: a named file rises, an unnamed one is kept and said so, a new file is added, none falls, and total, measuredAt and command stay', async () => {
    const { raiseWithin, scoreByFile } = await ratchetModule()
    // Paths from the real mutate set: update keeps entries only for those (AC-5b).
    const [risen, kept, added, held, absent] = await mutateSet()
    const rep: Record<string, Status[]> = {
      [risen!]: exactFile(4, 4, 0),
      [kept!]: exactFile(4, 4, 1),
      [added!]: exactFile(1, 2, 0),
      [held!]: exactFile(1, 4, 0),
    }
    const before: Ratchet = {
      measuredAt: '2026-10-01T00:00:00.000Z',
      command: 'fixture: an earlier full run',
      total: 47.5,
      files: { [risen!]: 10, [kept!]: 20, [held!]: 90, [absent!]: 30 },
    }
    const changed = [risen!, held!, absent!]
    const dir = scratch()
    const ratchetFile = writeJson(dir, 'mutation-ratchet.json', before)
    const reportFile = writeJson(dir, 'mutation.json', report(rep))
    const { code, output } = await cli([
      'update',
      '--report',
      reportFile,
      '--ratchet',
      ratchetFile,
      '--files',
      changed.join(','),
    ])
    expect(code, output).toBe(0)
    const after = readRatchet(ratchetFile)
    expect(after.files).toEqual(raiseWithin(before.files, scoreByFile(report(rep)), changed))
    expect([
      after.files[risen!],
      after.files[kept!],
      after.files[added!],
      after.files[held!],
    ]).toEqual([100, 20, 50, 90])
    expect({ ...after, files: before.files }).toEqual(before)
    expect(output).toContain(`kept (not changed in the range; --files to raise it): ${kept}`)
  })

  it('audit 2026-10-22: update without --files raises the files changed since --base; a base that does not resolve is refused naming --files', async () => {
    const dir = scratch()
    const set = await mutateSet()
    const ratchetFile = writeJson(dir, 'mutation-ratchet.json', {
      measuredAt: '2026-10-01T00:00:00.000Z',
      command: 'fixture',
      total: 50,
      files: { [set[0]!]: 10 },
    })
    const reportFile = writeJson(dir, 'mutation.json', report({ [set[0]!]: exactFile(4, 4, 0) }))
    const refused = await cli([
      'update',
      '--report',
      reportFile,
      '--ratchet',
      ratchetFile,
      '--base',
      'no-such-ref',
    ])
    expect(refused.code, refused.output).toBe(2)
    expect(refused.output).toMatch(/--files/)
    expect(readRatchet(ratchetFile).files).toEqual({ [set[0]!]: 10 })
    // HEAD as the base: the range holds the work tree's uncommitted changes, never a fixture under tmp.
    const kept = await cli([
      'update',
      '--report',
      reportFile,
      '--ratchet',
      ratchetFile,
      '--base',
      'HEAD',
    ])
    expect(kept.code, kept.output).toBe(0)
    expect(kept.output).toMatch(/kept/)
  })

  it('AC-3: update --total sets total to the whole report score, and measuredAt and command, from a report covering the mutate set', async () => {
    const dir = scratch()
    const set = await mutateSet()
    const rep: Record<string, Status[]> = {}
    let killed = 0
    let valid = 0
    set.forEach((path, i) => {
      const k = i % 5
      rep[path] = exactFile(k, 4 + (i % 3), 1)
      killed += k
      valid += 4 + (i % 3)
    })
    const before: Ratchet = {
      measuredAt: '2026-10-01T00:00:00.000Z',
      command: 'fixture: an earlier full run',
      total: 1,
      files: {},
    }
    const ratchetFile = writeJson(dir, 'mutation-ratchet.json', before)
    const reportFile = writeJson(dir, 'mutation.json', report(rep))
    const started = Date.now()
    const { code, output } = await cli([
      'update',
      '--report',
      reportFile,
      '--ratchet',
      ratchetFile,
      '--total',
    ])
    expect(code, output).toBe(0)
    const after = readRatchet(ratchetFile)
    expect(after.total).toBeCloseTo((killed * 100) / valid, 2)
    expect(Date.parse(after.measuredAt)).toBeGreaterThanOrEqual(started - 1000)
    expect(after.command).not.toBe(before.command)
    expect(Object.keys(after.files).sort()).toEqual(set)
  })
})

describe('AC-5: the Phase 1 score is committed', () => {
  function committed(): Ratchet {
    expect(existsSync(RATCHET_FILE), 'mutation-ratchet.json is committed at the repo root').toBe(
      true,
    )
    return readRatchet(RATCHET_FILE)
  }

  it('AC-5: total comes from a full --force run, is above the 42.17% baseline, and lies within the per-file scores', () => {
    const ratchet = committed()
    expect(ratchet.command).toMatch(/--force/)
    expect(ratchet.command).toMatch(/\bpnpm mutation\b|\bstryker run\b/)
    expect(Date.parse(ratchet.measuredAt)).toBeLessThanOrEqual(Date.now())
    expect(ratchet.total).toBeGreaterThan(BASELINE)
    expect(ratchet.total).toBeLessThanOrEqual(100)
    expect(hasTwoDecimals(ratchet.total), `${ratchet.total} has two decimals`).toBe(true)
    // The total is a mutant-weighted mean of the file scores, so it can lie nowhere outside them.
    const values = Object.values(ratchet.files)
    expect(ratchet.total).toBeGreaterThanOrEqual(Math.min(...values) - 0.01)
    expect(ratchet.total).toBeLessThanOrEqual(Math.max(...values) + 0.01)
  })

  it("AC-5: there is one entry per file in stryker.config.mjs's mutate set, each a two-decimal percentage", async () => {
    const ratchet = committed()
    expect(Object.keys(ratchet.files).sort()).toEqual(await mutateSet())
    for (const [path, score] of Object.entries(ratchet.files)) {
      expect(score, path).toBeGreaterThanOrEqual(0)
      expect(score, path).toBeLessThanOrEqual(100)
      expect(hasTwoDecimals(score), `${path}: ${score} has two decimals`).toBe(true)
    }
  })
})

describe('AC-5b: the ratchet follows the mutate set', () => {
  /** Paths the mutate set no longer selects: a deleted or renamed service, and a file outside the globs. */
  const GONE = [
    'packages/platform/src/services/gone-service.ts',
    'packages/platform/src/repositories/renamed-repository.ts',
    'packages/platform/src/db/not-mutated.ts',
  ]
  const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  /** The paths of `candidates` that `output` names as a whole path, not as part of a longer one. */
  const named = (output: string, candidates: string[]): string[] =>
    candidates.filter((p) => new RegExp(`(?<![\\w./-])${escape(p)}(?![\\w./-])`).test(output))

  it('AC-5b: update, through the CLI, drops every entry outside the mutate set, naming it, and writes raise of the rest: none inside it falls', async () => {
    const { raise, scoreByFile } = await ratchetModule()
    const set = await mutateSet()
    const [rises, falls, unscored, added] = set
    const rep: Record<string, Status[]> = {
      [rises!]: exactFile(4, 4, 0),
      [falls!]: exactFile(1, 4, 1),
      [added!]: exactFile(1, 2, 0),
    }
    const inSet: Scores = { [rises!]: 10, [falls!]: 90, [unscored!]: 33 }
    const before: Ratchet = {
      measuredAt: '2026-10-01T00:00:00.000Z',
      command: 'fixture: an earlier full run',
      total: 47.5,
      files: { ...inSet, ...Object.fromEntries(GONE.map((p) => [p, 77])) },
    }
    const dir = scratch()
    const ratchetFile = writeJson(dir, 'mutation-ratchet.json', before)
    const reportFile = writeJson(dir, 'mutation.json', report(rep))
    // Every path in the range: the drop is what this test is about.
    const { code, output } = await cli([
      'update',
      '--report',
      reportFile,
      '--ratchet',
      ratchetFile,
      '--files',
      set.join(','),
    ])
    expect(code, output).toBe(0)
    const after = readRatchet(ratchetFile)
    expect(after.files).toEqual(raise(inSet, scoreByFile(report(rep))))
    for (const [path, was] of Object.entries(inSet)) {
      expect(after.files[path], `${path} never falls`).toBeGreaterThanOrEqual(was)
    }
    expect(named(output, GONE), output).toEqual(GONE)
    expect({ ...after, files: before.files }).toEqual(before)
  })

  it('audit 2026-10-22: check --static needs no report; through the CLI it exits 1 naming exactly the mutate-set files with no entry and the entry naming no file, with the --files hint', async () => {
    const set = await mutateSet()
    const missing = [set[1]!, set[3]!]
    const stale = GONE[0]!
    const dir = scratch()
    const files: Scores = Object.fromEntries(
      set.filter((p) => !missing.includes(p)).map((p, i) => [p, (i * 37) % 100]),
    )
    files[stale] = 50
    const ratchetFile = writeJson(dir, 'mutation-ratchet.json', {
      measuredAt: '2026-10-01T00:00:00.000Z',
      command: 'fixture',
      total: 50,
      files,
    })
    const { code, output } = await cli(['check', '--static', '--ratchet', ratchetFile])
    expect(code, output).toBe(1)
    expect(named(output, set), output).toEqual(missing)
    expect(named(output, GONE), output).toEqual([stale])
    expect(output, 'the hint names --files when an entry is missing').toMatch(/--files/)
  })

  it('audit 2026-10-22: check --static passes on the committed ratchet', async () => {
    const { code, output } = await cli(['check', '--static'])
    expect(code, output).toBe(0)
    expect(output).toMatch(new RegExp(`\\b${(await mutateSet()).length} entries\\b`))
  })

  it('AC-5b: check, through the CLI, names exactly the mutate-set files with no entry, with the hint to run update', async () => {
    const set = await mutateSet()
    const missing = [set[0]!, set[2]!]
    const dir = scratch()
    const files: Scores = Object.fromEntries(
      set.filter((p) => !missing.includes(p)).map((p, i) => [p, (i * 37) % 100]),
    )
    const ratchetFile = writeJson(dir, 'mutation-ratchet.json', {
      measuredAt: '2026-10-01T00:00:00.000Z',
      command: 'fixture',
      total: 50,
      files,
    })
    // An empty report: no file rises or falls, so whatever check names it names for the missing entries.
    const reportFile = writeJson(dir, 'mutation.json', report({}))
    const { output } = await cli(['check', '--report', reportFile, '--ratchet', ratchetFile])
    expect(named(output, set), output).toEqual(missing)
    expect(output, 'the hint to run update').toMatch(/\bupdate\b/)
  })
})
