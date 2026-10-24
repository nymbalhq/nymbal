import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import {
  censusTrend,
  formatReport,
  HARNESS_PROJECTS,
  isHarnessPath,
  newTestFiles,
  plan,
  run,
  selectTests,
  type StepSpec,
} from '../../scripts/gate'
import { aggregate, type Counts, type FileCensus, type Totals } from '../../scripts/test-census'

// The gate: AC-1 to AC-5, AC-7 and AC-18.
// AC-7 drives the exported runner with fake steps that are real shell commands, so the verdict under test comes
// from real exit codes; running `pnpm gate` itself from here would recurse into this suite.

type Status = 'ok' | 'red' | 'skipped'
type Step = { name: string; status: Status; ms: number; detail?: string }

const ZERO: Counts = { C1: 0, C2: 0, C3: 0, C4: 0, other: 0 }

function census(path: string, counts: Partial<Counts> = {}): FileCensus {
  const assertions = { ...ZERO, ...counts }
  return {
    path,
    package: 'sdk',
    layer: 'unit',
    tests: 1,
    skipped: 0,
    prints: 0,
    assertions,
    otherMatchers: assertions.other > 0 ? ['toBeCustom'] : [],
    hasStrong: assertions.C2 + assertions.C3 > 0,
  }
}

function lastLine(text: string): string {
  const lines = text.trimEnd().split('\n')
  return lines[lines.length - 1] ?? ''
}

const OK_LINE = /^gate: ok in (\d+(?:\.\d+)?) s \(budget (\d+(?:\.\d+)?) s\)(.*)$/
const RED_LINE = /^gate: RED \((.*)\) in (\d+(?:\.\d+)?) s(.*)$/

/** The verdict line read back: the red steps it lists (none on an ok line), its seconds, its budget (ok only). */
function readVerdict(
  line: string,
): { red: string[]; seconds: number; budget: number | null } | null {
  const r = RED_LINE.exec(line)
  if (r) return { red: r[1]!.split(', '), seconds: Number(r[2]), budget: null }
  const o = OK_LINE.exec(line)
  if (o) return { red: [], seconds: Number(o[1]), budget: Number(o[2]) }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// AC-1: selectTests
// ---------------------------------------------------------------------------------------------------------------

describe('AC-1: selectTests picks all, changed or none', () => {
  const CONFIG_PATHS = [
    'package.json',
    'pnpm-lock.yaml',
    'vitest.config.ts',
    'tsconfig.json',
    'tsconfig.base.json',
    'vitest.stryker.config.ts',
    'packages/platform/package.json',
    'packages/sdk/package.json',
  ]

  it.each(CONFIG_PATHS)('AC-1: a change to %s alone runs all tests', (path) => {
    expect(selectTests([path]).mode).toBe('all')
  })

  it('AC-1: a lockfile change beside source changes runs all tests, not only the changed ones', () => {
    expect(
      selectTests([
        'packages/sdk/src/client.ts',
        'pnpm-lock.yaml',
        'packages/sdk/src/client.test.ts',
      ]).mode,
    ).toBe('all')
  })

  it('AC-1: docs-only changes (*.md anywhere, anything under docs/) run no tests', () => {
    expect(selectTests(['README.md', 'packages/platform/CLAUDE.md', 'docs/HARNESS.md']).mode).toBe(
      'none',
    )
    expect(selectTests(['docs/images/flow.png', 'docs/specs/notes.txt']).mode).toBe('none')
  })

  it('AC-1: source changes, with or without docs, run the changed tests', () => {
    expect(selectTests(['packages/sdk/src/client.ts']).mode).toBe('changed')
    expect(
      selectTests(['packages/platform/src/db/command-store.ts', 'README.md', 'docs/HARNESS.md'])
        .mode,
    ).toBe('changed')
    expect(selectTests(['scripts/gate.ts', 'tests/tooling/gate.test.ts']).mode).toBe('changed')
  })

  const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/)
  const sourcePath = fc
    .tuple(
      fc.constantFrom('packages/sdk/src', 'packages/platform/src', 'apps/admin/src', 'scripts'),
      segment,
    )
    .map(([dir, name]) => `${dir}/${name}.ts`)
  const docsPath = fc.oneof(
    segment.map((name) => `docs/${name}.md`),
    segment.map((name) => `docs/${name}/${name}.png`),
    fc
      .tuple(fc.constantFrom('', 'packages/sdk/', 'templates/astro/'), segment)
      .map(([dir, n]) => `${dir}${n}.md`),
  )

  it('AC-1: property: any change set containing a configuration path selects all', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(sourcePath, docsPath), { maxLength: 6 }),
        fc.constantFrom(...CONFIG_PATHS),
        fc.nat(),
        (others, config, at) => {
          const changed = [...others]
          changed.splice(at % (others.length + 1), 0, config)
          expect(selectTests(changed).mode).toBe('all')
        },
      ),
    )
  })

  it('AC-1: property: docs-only change sets select none; adding one source path selects changed', () => {
    fc.assert(
      fc.property(fc.array(docsPath, { maxLength: 6 }), sourcePath, (docs, source) => {
        expect(selectTests(docs).mode).toBe('none')
        expect(selectTests([...docs, source]).mode).toBe('changed')
      }),
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The plain gate inside 60 s
// ---------------------------------------------------------------------------------------------------------------

describe('the tooling projects run in the plain gate only when the tooling changed; the ratchet is checked statically first', () => {
  const planned = (changed: string[], full = false): StepSpec[] =>
    plan({ full, base: 'abc1234', changed, mutated: [] }).steps
  const testsStep = (changed: string[], full = false): StepSpec =>
    planned(changed, full).find((s) => s.name === 'tests') as StepSpec
  /** The projects a tests command negates (`--project '!name'`). */
  const negated = (command: string): string[] =>
    [...command.matchAll(/--project '!([\w-]+)'/g)].map((m) => m[1] as string).sort()
  const HARNESS = [
    'scripts/gate.ts',
    'tests/tooling/gate.test.ts',
    'tests/architecture/guard.test.ts',
  ]
  const PRODUCT = [
    'packages/sdk/src/client.ts',
    'apps/admin/src/main.tsx',
    'templates/astro/src/pages/index.astro',
  ]

  it('isHarnessPath: scripts/, tests/tooling/ and tests/architecture/ are the harness; product paths are not', () => {
    for (const path of HARNESS) expect(isHarnessPath(path), path).toBe(true)
    for (const path of [...PRODUCT, 'scripts.ts', 'packages/cli/scripts/x.ts']) {
      expect(isHarnessPath(path), path).toBe(false)
    }
  })

  it('a product change, changed or all mode, negates every harness project; a harness change negates none', () => {
    expect(negated(testsStep(PRODUCT).command)).toEqual([...HARNESS_PROJECTS].sort())
    expect(negated(testsStep([...PRODUCT, 'package.json']).command)).toEqual(
      [...HARNESS_PROJECTS].sort(),
    )
    for (const path of HARNESS) expect(negated(testsStep([...PRODUCT, path]).command)).toEqual([])
  })

  it('gate:full never negates them, whatever changed', () => {
    expect(negated(testsStep(PRODUCT, true).command)).toEqual([])
    expect(negated(testsStep([...PRODUCT, 'package.json'], true).command)).toEqual([])
  })

  it('property: the harness projects are negated iff the plain gate has no harness path in its change set', () => {
    const path = fc.oneof(
      fc.constantFrom(...PRODUCT, 'package.json', 'README.md'),
      fc.constantFrom(...HARNESS),
    )
    fc.assert(
      fc.property(fc.array(path, { minLength: 1, maxLength: 6 }), (changed) => {
        const step = testsStep(changed)
        if (step.skip !== undefined) return
        const expected = changed.some(isHarnessPath) ? [] : [...HARNESS_PROJECTS].sort()
        expect(negated(step.command)).toEqual(expected)
      }),
    )
  })

  it('the ratchet step runs the static check after lint and before the build and tests, in gate and gate:full', () => {
    for (const full of [false, true]) {
      const names = planned(PRODUCT, full).map((s) => s.name)
      const at = (name: string): number => names.indexOf(name)
      expect(at('ratchet'), names.join(', ')).toBeGreaterThan(at('lint'))
      expect(at('ratchet')).toBeLessThan(at('build'))
      expect(at('ratchet')).toBeLessThan(at('tests'))
      const step = planned(PRODUCT, full).find((s) => s.name === 'ratchet') as StepSpec
      expect(step.command).toMatch(/mutation:ratchet check --static\b/)
      expect(step.skip).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-2 and AC-3: censusTrend
// ---------------------------------------------------------------------------------------------------------------

describe('AC-2: censusTrend enforces rule 2 on touched test files only', () => {
  const WEAK = 'packages/sdk/src/weak.test.ts'
  const EXACT_ONLY = 'packages/sdk/src/exact.test.ts'
  const OTHER_ONLY = 'packages/sdk/src/custom.test.ts'
  const DELEGATING = 'tests/contracts/delegating.test.ts'
  const OLD_DEBT = 'packages/platform/src/old-debt.test.ts'
  const ONE_C3 = 'packages/sdk/src/relational.test.ts'
  const ONE_C2 = 'packages/sdk/src/property.test.ts'

  const head = [
    census(WEAK, { C1: 3 }),
    census(EXACT_ONLY, { C1: 1, C4: 4 }),
    census(OTHER_ONLY, { other: 2 }),
    census(DELEGATING),
    census(OLD_DEBT, { C1: 5, C4: 2 }),
    census(ONE_C3, { C1: 4, C4: 6, C3: 1 }),
    census(ONE_C2, { C2: 1 }),
  ]
  const base = head.map((f) => census(f.path, f.assertions))

  function violationsFor(touched: string[]): string[] {
    return censusTrend(base, head, touched).violations
  }

  it('AC-2: a touched file with assertions and no C2/C3 is a violation naming the file', () => {
    for (const path of [WEAK, EXACT_ONLY, OTHER_ONLY]) {
      const violations = violationsFor([path])
      expect(violations, path).toHaveLength(1)
      expect(violations[0], path).toContain(path)
    }
  })

  it('AC-2: a touched delegating file (no assertions) is never flagged', () => {
    expect(violationsFor([DELEGATING])).toEqual([])
  })

  it('AC-2: an untouched weak file is never flagged, so old debt does not block a change', () => {
    expect(violationsFor([ONE_C3, 'packages/sdk/src/client.ts'])).toEqual([])
    expect(violationsFor([WEAK]).some((v) => v.includes(OLD_DEBT))).toBe(false)
  })

  it('AC-2: a touched file with one C3 (or one C2) among weak assertions is not flagged', () => {
    expect(violationsFor([ONE_C3, ONE_C2])).toEqual([])
  })

  it('AC-2: a touched file that was strong at base but is weak at head is flagged (head decides)', () => {
    const strongAtBase = [census(WEAK, { C3: 2 })]
    const weakAtHead = [census(WEAK, { C1: 2 })]
    const { violations } = censusTrend(strongAtBase, weakAtHead, [WEAK])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain(WEAK)
  })

  it('AC-2: a touched test file deleted at head is not flagged', () => {
    const { violations } = censusTrend([census(WEAK, { C1: 2 })], [], [WEAK])
    expect(violations).toEqual([])
  })

  const countsArb = fc.record({
    C1: fc.nat(4),
    C2: fc.nat(2),
    C3: fc.nat(2),
    C4: fc.nat(4),
    other: fc.nat(2),
  })

  it('AC-2: property: violations are exactly the touched head files with assertions and C2 + C3 = 0', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(countsArb, fc.boolean()), { maxLength: 12 }),
        fc.array(countsArb, { maxLength: 6 }),
        (rows, baseRows) => {
          const headFiles = rows.map(([c], i) => census(`packages/sdk/src/f${i}.test.ts`, c))
          const touched = headFiles.filter((_, i) => rows[i]![1]).map((f) => f.path)
          const baseFiles = baseRows.map((c, i) => census(`packages/sdk/src/f${i}.test.ts`, c))
          const expected = headFiles.filter((f) => {
            const a = f.assertions
            return (
              touched.includes(f.path) &&
              a.C1 + a.C2 + a.C3 + a.C4 + a.other > 0 &&
              a.C2 + a.C3 === 0
            )
          })
          const { violations } = censusTrend(baseFiles, headFiles, [
            ...touched,
            'packages/sdk/src/x.ts',
          ])
          expect(violations).toHaveLength(expected.length)
          for (const f of expected) {
            expect(violations.filter((v: string) => v.includes(f.path))).toHaveLength(1)
          }
        },
      ),
    )
  })
})

describe('AC-3: censusTrend.delta is head total minus base total', () => {
  const countsArb = fc.record({
    C1: fc.nat(30),
    C2: fc.nat(30),
    C3: fc.nat(30),
    C4: fc.nat(30),
    other: fc.nat(30),
  })
  const fileArb = fc.record({
    package: fc.constantFrom('sdk', 'platform', 'tests/contracts'),
    layer: fc.constantFrom('unit', 'integration', 'contract'),
    tests: fc.nat(40),
    skipped: fc.nat(5),
    prints: fc.nat(5),
    assertions: fc.oneof(countsArb, fc.constant(ZERO)),
  })
  const listArb = (prefix: string) =>
    fc.array(fileArb, { maxLength: 15 }).map((rows) =>
      rows.map(
        (r, i): FileCensus => ({
          ...r,
          path: `${prefix}/f${i}.test.ts`,
          otherMatchers: [],
          hasStrong: r.assertions.C2 + r.assertions.C3 > 0,
        }),
      ),
    )

  it('AC-3: property: for every count, delta[key] = aggregate(head).total[key] - aggregate(base).total[key]', () => {
    fc.assert(
      fc.property(
        listArb('packages/a'),
        listArb('packages/b'),
        fc.array(fc.string(), { maxLength: 4 }),
        (base, head, touched) => {
          const { delta } = censusTrend(base, head, touched)
          const before = aggregate(base).total
          const after = aggregate(head).total
          const keys = Object.keys(after) as Array<keyof Totals>
          expect(Object.keys(delta).sort()).toEqual([...keys].sort())
          for (const key of keys) {
            expect(delta[key], key).toBe(after[key] - before[key])
          }
        },
      ),
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-4: newTestFiles
// ---------------------------------------------------------------------------------------------------------------

describe('AC-4: newTestFiles returns only added test paths', () => {
  it('AC-4: from a git diff --name-status listing, only A lines naming a test file are returned', () => {
    const nameStatus = [
      'A\tpackages/sdk/src/new.test.ts',
      'A\ttests/e2e/journeys/checkout.spec.ts',
      'A\tapps/admin/src/views/orders.test.tsx',
      'A\tpackages/sdk/src/new-module.ts',
      'A\ttests/fixtures/orders.json',
      'M\tpackages/sdk/src/modified.test.ts',
      'D\tpackages/sdk/src/deleted.test.ts',
      'R100\tpackages/sdk/src/renamed-from.test.ts\tpackages/sdk/src/elsewhere/renamed-to.ts',
      'C75\tpackages/sdk/src/copied-from.test.ts\tpackages/sdk/src/copy-target.ts',
      'T\tpackages/sdk/src/typechange.test.ts',
      '',
    ].join('\n')
    expect([...newTestFiles(nameStatus)].sort()).toEqual(
      [
        'apps/admin/src/views/orders.test.tsx',
        'packages/sdk/src/new.test.ts',
        'tests/e2e/journeys/checkout.spec.ts',
      ].sort(),
    )
  })

  it('AC-4: the renamed-from path of a renamed test is never returned as new', () => {
    const result = newTestFiles(
      'R092\tpackages/sdk/src/old.test.ts\tpackages/sdk/src/moved.test.ts\n',
    )
    expect(result).not.toContain('packages/sdk/src/old.test.ts')
  })

  it('AC-4: an empty diff has no new test files', () => {
    expect(newTestFiles('')).toEqual([])
  })

  it('AC-4: property: the result is exactly the A-status test paths, in any mix of statuses', () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/)
    const path = fc
      .tuple(
        fc.constantFrom('packages/sdk/src', 'tests/contracts', 'apps/admin/src'),
        segment,
        fc.constantFrom('.test.ts', '.spec.ts', '.test.tsx', '.ts', '.json', '.md'),
      )
      .map(([dir, name, ext]) => `${dir}/${name}${ext}`)
    const line = fc.tuple(fc.constantFrom('A', 'M', 'D', 'T'), path)
    fc.assert(
      fc.property(fc.uniqueArray(line, { maxLength: 12, selector: ([, p]) => p }), (lines) => {
        const text = lines.map(([s, p]) => `${s}\t${p}`).join('\n')
        const expected = lines
          .filter(([s, p]) => s === 'A' && /\.(test|spec)\.tsx?$/.test(p))
          .map(([, p]) => p)
        expect([...newTestFiles(text)].sort()).toEqual([...expected].sort())
      }),
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-5: formatReport
// ---------------------------------------------------------------------------------------------------------------

describe('AC-5: formatReport ends with a verdict line that cannot hide a red step', () => {
  const steps = (rows: Array<[string, Status, number]>): Step[] =>
    rows.map(([name, status, ms]) => ({ name, status, ms }))

  it('AC-5: all ok ends with "gate: ok in <s> s (budget <b> s)"', () => {
    const report = formatReport(
      steps([
        ['lint', 'ok', 4000],
        ['typecheck', 'ok', 3500],
        ['tests', 'ok', 6500],
      ]),
      60_000,
    )
    const m = OK_LINE.exec(lastLine(report))
    expect(m, lastLine(report)).not.toBeNull()
    expect(Number(m![1])).toBeCloseTo(14, 0)
    expect(Number(m![2])).toBeCloseTo(60, 0)
    expect(report).not.toContain('over budget')
  })

  it('AC-5: a red step makes the verdict RED and names every red step, in order', () => {
    const report = formatReport(
      steps([
        ['lint', 'red', 1000],
        ['typecheck', 'ok', 1000],
        ['tests', 'red', 1000],
        ['census trend', 'skipped', 0],
      ]),
      60_000,
    )
    const m = RED_LINE.exec(lastLine(report))
    expect(m, lastLine(report)).not.toBeNull()
    expect(m![1]!.split(', ')).toEqual(['lint', 'tests'])
  })

  it('AC-5: skipped steps do not make the verdict red', () => {
    const report = formatReport(
      steps([
        ['lint', 'ok', 100],
        ['stryker', 'skipped', 0],
      ]),
      60_000,
    )
    expect(lastLine(report)).toMatch(OK_LINE)
  })

  it('AC-5: "over budget" appears exactly when the total exceeds the budget (boundary)', () => {
    const at = formatReport(
      steps([
        ['lint', 'ok', 30_000],
        ['tests', 'ok', 30_000],
      ]),
      60_000,
    )
    const over = formatReport(
      steps([
        ['lint', 'ok', 30_000],
        ['tests', 'ok', 30_001],
      ]),
      60_000,
    )
    const redOver = formatReport(
      steps([
        ['lint', 'red', 30_000],
        ['tests', 'ok', 30_001],
      ]),
      60_000,
    )
    expect(at).not.toContain('over budget')
    expect(lastLine(over)).toContain('over budget')
    expect(lastLine(redOver)).toMatch(RED_LINE)
    expect(lastLine(redOver)).toContain('over budget')
  })

  const NAMES = [
    'lint',
    'typecheck',
    'tests',
    'census trend',
    'compose up',
    'build',
    'integration-postgres',
    'sentinels',
  ]
  const stepsArb = fc
    .uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: NAMES.length })
    .chain((names) =>
      fc.tuple(
        ...names.map((name) =>
          fc.record({
            name: fc.constant(name),
            status: fc.constantFrom<Status>('ok', 'red', 'skipped'),
            ms: fc.nat(120_000),
          }),
        ),
      ),
    )

  it('AC-5: property: verdict is RED iff a step is red, lists the red steps, and flags over budget iff total > budget', () => {
    fc.assert(
      fc.property(stepsArb, fc.nat(300_000), (generated, budgetMs) => {
        const input: Step[] = [...generated]
        const report = formatReport(input, budgetMs)
        const verdict = lastLine(report)
        const total = input.reduce((sum, s) => sum + s.ms, 0)
        const red = input.filter((s) => s.status === 'red').map((s) => s.name)

        // A RED line lists exactly the red steps; an ok line (no red step) lists none and carries the budget.
        const read = readVerdict(verdict)
        expect(read, verdict).not.toBeNull()
        expect(read!.red, verdict).toEqual(red)
        expect(read!.budget === null, verdict).toBe(red.length > 0)
        expect(Math.abs(read!.seconds - total / 1000)).toBeLessThan(1)
        expect(Math.abs((read!.budget ?? budgetMs / 1000) - budgetMs / 1000)).toBeLessThan(1)
        expect(report.includes('over budget')).toBe(total > budgetMs)
      }),
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-7: the runner's exit code comes from the steps' real exit codes
// ---------------------------------------------------------------------------------------------------------------

describe('AC-7: run exits non-zero iff a step is red, with the step table in its output', () => {
  const created: string[] = []
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-')))
    created.push(dir)
    return dir
  }

  /** The table rows: every line but the verdict. */
  function rowFor(report: string, name: string): string | undefined {
    const lines = report.trimEnd().split('\n')
    return lines.slice(0, -1).find((l) => l.includes(name))
  }

  it('AC-7: a red step in the middle gives a non-zero exit, later steps still run, every step has a row', async () => {
    const cwd = scratch()
    const result = await run(
      [
        { name: 'lint', command: 'exit 0' },
        { name: 'typecheck', command: 'echo "src/x.ts(1,1): error TS2322" >&2; exit 2' },
        { name: 'tests', command: 'echo ran > after-red.txt' },
      ],
      { cwd, budgetMs: 60_000 },
    )
    expect(result.exitCode).not.toBe(0)
    expect(existsSync(join(cwd, 'after-red.txt'))).toBe(true)
    expect(result.steps.map((s: Step) => s.status)).toEqual(['ok', 'red', 'ok'])
    expect(rowFor(result.report, 'typecheck')).toMatch(/\bred\b/i)
    expect(rowFor(result.report, 'lint')).toMatch(/\bok\b/i)
    expect(rowFor(result.report, 'tests')).toMatch(/\bok\b/i)
    const m = RED_LINE.exec(lastLine(result.report))
    expect(m, lastLine(result.report)).not.toBeNull()
    expect(m![1]!.split(', ')).toEqual(['typecheck'])
  })

  it('AC-7: all steps green gives exit 0 and the ok verdict', async () => {
    const result = await run(
      [
        { name: 'lint', command: 'exit 0' },
        { name: 'tests', command: 'true' },
      ],
      { cwd: scratch(), budgetMs: 60_000 },
    )
    expect(result.exitCode).toBe(0)
    expect(lastLine(result.report)).toMatch(OK_LINE)
  })

  it('AC-7: each step reports its own measured time', async () => {
    const result = await run([{ name: 'slow', command: 'sleep 0.2' }], {
      cwd: scratch(),
      budgetMs: 60_000,
    })
    expect(result.steps[0]!.ms).toBeGreaterThanOrEqual(180)
  })

  it('AC-7: property: exit code is non-zero iff some step exits non-zero; each status follows its own exit code', async () => {
    const cwd = scratch()
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(0, 0, 1, 2, 127), { minLength: 1, maxLength: 4 }),
        async (codes) => {
          const result = await run(
            codes.map((code, i) => ({ name: `step-${i}`, command: `exit ${code}` })),
            { cwd, budgetMs: 60_000 },
          )
          expect(result.exitCode === 0).toBe(codes.every((c) => c === 0))
          expect(result.steps.map((s: Step) => s.status)).toEqual(
            codes.map((c) => (c === 0 ? 'ok' : 'red')),
          )
          expect(result.steps.map((s: Step) => s.name)).toEqual(codes.map((_, i) => `step-${i}`))
        },
      ),
      { numRuns: 15 },
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-18: a step that needs others runs only when every one of them is ok
// ---------------------------------------------------------------------------------------------------------------

describe('AC-18: run skips a step whose needs are red or skipped, and names them', () => {
  const created: string[] = []
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function scratch(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-needs-')))
    created.push(dir)
    return dir
  }

  type NeedState = 'ok' | 'red' | 'skipped'

  function needStep(name: string, state: NeedState): StepSpec {
    if (state === 'skipped') return { name, command: 'true', skip: 'nothing to do' }
    return { name, command: state === 'ok' ? 'true' : 'exit 1' }
  }

  it('AC-18: a red need skips the step without running it, with a detail naming that need', async () => {
    const cwd = scratch()
    const result = await run(
      [
        needStep('compose up', 'red'),
        needStep('build', 'ok'),
        { name: 'e2e', command: 'touch e2e-ran', needs: ['build', 'compose up'] },
      ],
      { cwd, budgetMs: 60_000 },
    )
    const e2e = result.steps.find((s) => s.name === 'e2e')
    expect(existsSync(join(cwd, 'e2e-ran'))).toBe(false)
    expect(e2e?.status).toBe('skipped')
    expect(e2e?.detail).toContain('compose up')
    expect(result.exitCode).toBe(1)
    expect(RED_LINE.exec(lastLine(result.report))![1]!.split(', ')).toEqual(['compose up'])
  })

  it('AC-18: a red build skips the step and the detail names build', async () => {
    const cwd = scratch()
    const result = await run(
      [
        needStep('compose up', 'ok'),
        needStep('build', 'red'),
        { name: 'e2e', command: 'touch e2e-ran', needs: ['build', 'compose up'] },
      ],
      { cwd, budgetMs: 60_000 },
    )
    const e2e = result.steps.find((s) => s.name === 'e2e')
    expect(existsSync(join(cwd, 'e2e-ran'))).toBe(false)
    expect(e2e?.status).toBe('skipped')
    expect(e2e?.detail).toContain('build')
  })

  it('AC-18: property: the step runs iff every need is ok; when skipped, the detail names every need that is not ok', async () => {
    const cwd = scratch()
    const state = fc.constantFrom<NeedState>('ok', 'red', 'skipped')
    await fc.assert(
      fc.asyncProperty(state, state, async (compose, build) => {
        rmSync(join(cwd, 'e2e-ran'), { force: true })
        const result = await run(
          [
            needStep('compose up', compose),
            needStep('build', build),
            { name: 'e2e', command: 'touch e2e-ran', needs: ['build', 'compose up'] },
          ],
          { cwd, budgetMs: 60_000 },
        )
        const e2e = result.steps.find((s) => s.name === 'e2e')!
        const runs = compose === 'ok' && build === 'ok'
        expect(existsSync(join(cwd, 'e2e-ran'))).toBe(runs)
        expect(e2e.status).toBe(runs ? 'ok' : 'skipped')
        // When skipped, the detail names every need that is not ok.
        const detail = e2e.detail ?? ''
        expect(build === 'ok' || /\bbuild\b/.test(detail), `build ${build}: "${detail}"`).toBe(true)
        expect(
          compose === 'ok' || detail.includes('compose up'),
          `compose ${compose}: "${detail}"`,
        ).toBe(true)
        // A skipped dependant never turns the verdict red on its own.
        expect(result.exitCode === 0).toBe(compose !== 'red' && build !== 'red')
      }),
      { numRuns: 20 },
    )
  })

  // The E2E journeys run on SQLite and need only the build, so compose does not gate them.
  describe('AC-18: in the gate:full plan the E2E steps need build', () => {
    const fullPlan = plan({
      full: true,
      base: 'abc1234',
      changed: ['packages/sdk/src/client.ts'],
      mutated: [],
    }).steps

    /** The plan with every command replaced: the named steps go red, E2E steps leave a marker, the rest pass. */
    function rehearse(red: string[]): StepSpec[] {
      return fullPlan.map((step, i) => ({
        ...step,
        command: red.includes(step.name)
          ? 'exit 1'
          : step.name.startsWith('e2e')
            ? `touch e2e-ran-${i}`
            : 'true',
      }))
    }

    function e2eSteps(): string[] {
      return fullPlan.filter((s) => s.name.startsWith('e2e')).map((s) => s.name)
    }

    it('AC-18: the E2E steps run iff build is ok, whatever compose up does; a red build skips each, naming build', async () => {
      expect(e2eSteps().length).toBeGreaterThanOrEqual(2)
      for (const red of [[], ['compose up'], ['build'], ['build', 'compose up']]) {
        const cwd = scratch()
        const result = await run(rehearse(red), { cwd, budgetMs: 600_000 })
        const ran = fullPlan.filter((_, i) => existsSync(join(cwd, `e2e-ran-${i}`)))
        const buildOk = !red.includes('build')
        expect(
          ran.map((s) => s.name),
          `red: ${red.join(', ')}`,
        ).toEqual(buildOk ? e2eSteps() : [])
        for (const name of e2eSteps()) {
          const step = result.steps.find((s) => s.name === name)
          expect(step?.status, name).toBe(buildOk ? 'ok' : 'skipped')
          expect(
            buildOk || (step?.detail ?? '').includes('build'),
            `${name}: "${step?.detail}"`,
          ).toBe(true)
        }
      }
    })
  })
})
