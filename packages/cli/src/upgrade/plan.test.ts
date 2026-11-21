import fc from 'fast-check'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import type { Matrix, MatrixAdapter, MatrixRow } from './matrix.js'
import { applyEdits, type Blocked, planUpgrade, type ProjectManifest } from './plan.js'

// The compatibility decision over generated matrices, compared against an oracle written from the rule itself: rows
// above the installed version, highest first, the first one no adapter of the project fails.

const THIRD = '@acme/nymbal-search'
const LINE = `not certified ${THIRD} (search): 2 of 30 cases failed`
const CURRENT = '1.8.0'

const version = fc
  .tuple(fc.nat(3), fc.nat(5), fc.nat(5))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`)

const ADAPTERS = ['@acme/a', '@acme/b', '@acme/c', '@nymbalhq/search-typesense']
const STATUSES: MatrixAdapter['status'][] = [
  'passing',
  'failing',
  'suspended',
  'no-suite',
  'first-party',
]

const adapter = (statuses: MatrixAdapter['status'][]) =>
  fc.constantFrom(...statuses).chain((status) =>
    fc.record({
      status: fc.constant(status),
      line: fc.constantFrom(LINE, 'a reason'),
      version:
        status === 'failing' || status === 'suspended'
          ? fc.option(version, { nil: null })
          : version,
    }),
  )

function rowFor(stack: string, adapters: Record<string, MatrixAdapter>): MatrixRow {
  return {
    packages: {
      nymbal: stack,
      '@nymbalhq/platform': stack,
      '@nymbalhq/sdk': stack,
    },
    adapters,
  }
}

const matrixOf = (stacks: Record<string, MatrixRow>): Matrix => ({
  schema: 1,
  generatedAt: '2026-11-09T03:00:00.000Z',
  stacks,
})

const rowsOf = (statuses: MatrixAdapter['status'][]) =>
  fc.dictionary(
    version,
    fc.dictionary(fc.constantFrom(...ADAPTERS), adapter(statuses), {
      maxKeys: ADAPTERS.length,
      noNullPrototype: true,
    }),
    { maxKeys: 6, noNullPrototype: true },
  )

const matrices = rowsOf(STATUSES).map((rows) =>
  matrixOf(
    Object.fromEntries(
      Object.entries(rows).map(([stack, adapters]) => [stack, rowFor(stack, adapters)]),
    ),
  ),
)

const blocks = (entry: MatrixAdapter | undefined) =>
  entry?.status === 'failing' || entry?.status === 'suspended'

/** What the rule says should happen, written independently of the planner. */
function oracle(current: string, declared: string[], matrix: Matrix) {
  const above = Object.keys(matrix.stacks)
    .filter((stack) => semver.gt(stack, current))
    .sort(semver.rcompare)
  const target = above.find(
    (stack) => !declared.some((name) => blocks(matrix.stacks[stack]!.adapters[name])),
  )
  return { above, target }
}

const input = (current: string, declared: string[], matrix: Matrix) => ({
  current,
  matrix,
  manifest: {
    dependencies: {
      nymbal: current,
      ...Object.fromEntries(declared.map((name) => [name, '1.0.0'])),
    },
  },
  installed: Object.fromEntries(declared.map((name) => [name, '1.0.0'])),
})

describe('AC-1: the plan targets the highest compatible row above the installed version', () => {
  it('AC-1: over generated matrices the target is the oracle row, and refused exactly when rows above exist and none qualifies', () => {
    fc.assert(
      fc.property(version, fc.subarray(ADAPTERS), matrices, (current, declared, matrix) => {
        const plan = planUpgrade(input(current, declared, matrix))
        const { above, target } = oracle(current, declared, matrix)

        const expected =
          above.length === 0
            ? { kind: 'current' }
            : target === undefined
              ? { kind: 'refused' }
              : { kind: 'upgrade', target }
        expect(plan).toMatchObject(expected)
      }),
    )
  })
})

describe.each(['failing', 'suspended'] as const)('AC-2: an adapter at %s', (status) => {
  const matrix = matrixOf({
    '1.9.0': rowFor('1.9.0', { [THIRD]: { version: '2.0.0', status, line: LINE } }),
  })

  it(`AC-2: a row with an adapter at ${status} is refused for a project declaring it and open to one that does not`, () => {
    const declaring = planUpgrade(input(CURRENT, [THIRD], matrix))
    const other = planUpgrade(input(CURRENT, ['@acme/a'], matrix))

    expect(declaring).toEqual({
      kind: 'refused',
      current: CURRENT,
      blocked: [{ stack: '1.9.0', adapter: THIRD, version: '2.0.0', status, line: LINE }],
    })
    expect(other).toMatchObject({ kind: 'upgrade', target: '1.9.0' })
  })
})

describe('AC-3: a blocked newest row falls back to a lower compatible one and says so', () => {
  const failing = { version: '2.0.0', status: 'failing' as const, line: LINE }
  const passing = { version: '1.1.0', status: 'passing' as const }

  it('AC-3: the plan upgrades to the lower row and lists each row it passed over with adapter, status and line', () => {
    const matrix = matrixOf({
      '1.10.0': rowFor('1.10.0', { [THIRD]: failing }),
      '1.9.0': rowFor('1.9.0', {
        [THIRD]: { version: null, status: 'suspended', line: 'install failed' },
      }),
      '1.8.5': rowFor('1.8.5', { [THIRD]: passing }),
    })

    const plan = planUpgrade(input(CURRENT, [THIRD], matrix))

    expect(plan).toMatchObject({ kind: 'upgrade', target: '1.8.5' })
    if (plan.kind !== 'upgrade') return
    expect([...plan.held].sort((a, b) => semver.rcompare(a.stack, b.stack))).toEqual([
      { stack: '1.10.0', adapter: THIRD, version: '2.0.0', status: 'failing', line: LINE },
      {
        stack: '1.9.0',
        adapter: THIRD,
        version: null,
        status: 'suspended',
        line: 'install failed',
      },
    ])
  })

  it('AC-3: a blocked row below the target is not reported as passed over', () => {
    const matrix = matrixOf({
      '1.9.0': rowFor('1.9.0', { [THIRD]: passing }),
      '1.8.5': rowFor('1.8.5', { [THIRD]: failing }),
    })

    const plan = planUpgrade(input(CURRENT, [THIRD], matrix))

    expect(plan).toMatchObject({ kind: 'upgrade', target: '1.9.0', held: [] })
  })

  it('AC-3: over generated matrices, held names exactly the rows above the target', () => {
    fc.assert(
      fc.property(version, fc.subarray(ADAPTERS), matrices, (current, declared, matrix) => {
        const plan = planUpgrade(input(current, declared, matrix))
        const { above, target } = oracle(current, declared, matrix)
        if (target === undefined || plan.kind !== 'upgrade') return

        const passedOver = above.filter((stack) => semver.gt(stack, target))
        expect([...new Set(plan.held.map((h: Blocked) => h.stack))].sort()).toEqual(
          [...passedOver].sort(),
        )
      }),
    )
  })
})

describe('AC-4: what the matrix cannot vouch for is neither blocked nor moved', () => {
  it('AC-4: a no-suite adapter does not block or bump and is unchecked; an unlisted dependency is not named at all', () => {
    const unlisted = '@acme/our-own-adapter'
    const matrix = matrixOf({
      '1.9.0': rowFor('1.9.0', {
        [THIRD]: { version: '9.0.0', status: 'no-suite', line: 'no contract suite for kind x' },
        '@acme/undeclared': { version: '9.0.0', status: 'no-suite' },
      }),
    })

    const plan = planUpgrade(input(CURRENT, [THIRD, unlisted], matrix))

    expect(plan).toMatchObject({ kind: 'upgrade', target: '1.9.0', unchecked: [THIRD] })
    if (plan.kind !== 'upgrade') return
    expect(Object.keys(plan.edits)).not.toContain(THIRD)
    expect(JSON.stringify(plan)).not.toContain(unlisted)
  })
})

const SECTIONS = ['dependencies', 'devDependencies', 'pnpmOverrides', 'overrides'] as const
type Section = (typeof SECTIONS)[number]

/** A manifest with `name` and `scripts` beside the four dependency sections, and the sections as a flat view of it. */
function manifestOf(
  current: string,
  nymbalNames: Record<string, Section[]>,
  adapterRanges: Record<string, { range: string; sections: Section[] }>,
) {
  const sections: Record<Section, Record<string, string>> = {
    dependencies: {},
    devDependencies: {},
    pnpmOverrides: {},
    overrides: {},
  }
  for (const [name, into] of Object.entries(nymbalNames)) {
    for (const section of into) sections[section][name] = current
  }
  for (const [name, { range, sections: into }] of Object.entries(adapterRanges)) {
    sections.dependencies[name] = range
    for (const section of into) sections[section][name] = range
  }
  const manifest: ProjectManifest & { name: string; scripts: Record<string, string> } = {
    name: 'shop',
    scripts: { build: 'nymbal build' },
    dependencies: sections.dependencies,
    devDependencies: sections.devDependencies,
    pnpm: { overrides: sections.pnpmOverrides },
    overrides: sections.overrides,
  }
  return manifest
}

const sectionOf = (manifest: ProjectManifest, section: Section): Record<string, string> =>
  (section === 'pnpmOverrides' ? manifest.pnpm?.overrides : manifest[section]) ?? {}

describe('AC-5: edits only ever move a declared package upward, and reach every section', () => {
  const unblocked = rowsOf(['passing', 'first-party', 'no-suite'])
  const declaredNymbal = fc.constantFrom('nymbal', '@nymbalhq/platform', '@nymbalhq/sdk')
  const range = version.chain((v) => fc.constantFrom(v, `^${v}`))

  it('AC-5: every edit is valid semver above the installed version of a declared name, and applyEdits touches only those keys, in all four sections', () => {
    fc.assert(
      fc.property(
        version,
        rowsOf(['passing', 'first-party', 'no-suite']),
        unblocked,
        fc.dictionary(declaredNymbal, fc.subarray([...SECTIONS], { minLength: 1 }), {
          noNullPrototype: true,
        }),
        fc.dictionary(
          fc.constantFrom(...ADAPTERS),
          fc.record({ range, sections: fc.subarray([...SECTIONS]) }),
          { noNullPrototype: true },
        ),
        fc.subarray(ADAPTERS),
        (current, rowsAbove, rowsAny, nymbal, adapters, absent) => {
          // One row is always above `current`, so every run plans an upgrade.
          const above = semver.inc(current, 'minor')!
          const stacks: Record<string, MatrixRow> = {}
          for (const [stack, listed] of Object.entries({ ...rowsAny, ...rowsAbove })) {
            stacks[stack] = rowFor(stack, listed)
          }
          stacks[above] = rowFor(above, rowsAbove[above] ?? {})
          const matrix = matrixOf(stacks)
          const manifest = manifestOf(current, nymbal, adapters)
          const installed = Object.fromEntries(
            Object.entries(adapters)
              .filter(([name]) => !absent.includes(name))
              .map(([name]) => [name, semver.minVersion(adapters[name]!.range)!.version]),
          )
          const declared = new Set(SECTIONS.flatMap((s) => Object.keys(sectionOf(manifest, s))))
          const installedOf = (name: string): string =>
            installed[name] ??
            (Object.keys(adapters).includes(name)
              ? semver.minVersion(adapters[name]!.range)!.version
              : current)

          const plan = planUpgrade({ current, manifest, installed, matrix })

          expect(plan.kind).toBe('upgrade')
          if (plan.kind !== 'upgrade') return
          for (const [name, value] of Object.entries<string>(plan.edits)) {
            expect(semver.valid(value)).toBe(value)
            expect(semver.gt(value, installedOf(name))).toBe(true)
            expect(declared.has(name)).toBe(true)
          }

          const row = matrix.stacks[plan.target]!
          const expectedEdits: Record<string, string> = {}
          for (const [name, value] of Object.entries<string>(row.packages)) {
            if (declared.has(name)) expectedEdits[name] = value
          }
          for (const [name, entry] of Object.entries<MatrixAdapter>(row.adapters)) {
            if (
              declared.has(name) &&
              (entry.status === 'passing' || entry.status === 'first-party') &&
              semver.gt(entry.version!, installedOf(name))
            ) {
              expectedEdits[name] = entry.version!
            }
          }
          expect(plan.edits).toEqual(expectedEdits)

          const applied = applyEdits(manifest, plan.edits)
          const moved = (section: Record<string, string>) =>
            Object.fromEntries(
              Object.entries(section).map(([name, value]) => [name, plan.edits[name] ?? value]),
            )
          expect(applied).toEqual({
            ...manifest,
            dependencies: moved(sectionOf(manifest, 'dependencies')),
            devDependencies: moved(sectionOf(manifest, 'devDependencies')),
            pnpm: { overrides: moved(sectionOf(manifest, 'pnpmOverrides')) },
            overrides: moved(sectionOf(manifest, 'overrides')),
          })
        },
      ),
    )
  })
})
