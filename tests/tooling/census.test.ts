import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { aggregate, classifySource, layerOf, packageOf } from '../../scripts/test-census'

// Acceptance tests for P0-01 (census): AC-1 to AC-11.
// Types come from the functions the spec names, so the tests do not depend on which types the script exports.
type FileCensus = ReturnType<typeof classifySource>
type Counts = FileCensus['assertions']
type Aggregate = ReturnType<typeof aggregate>
type Totals = Aggregate['total']
type CensusJson = Aggregate & { files: FileCensus[] }

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const FIXTURES = fileURLToPath(new URL('./fixtures/census/', import.meta.url))
const ZERO: Counts = { C1: 0, C2: 0, C3: 0, C4: 0, other: 0 }

/** Classify a fixture as if it were a unit test file in packages/platform. */
function classifyFixture(name: string): FileCensus {
  const source = readFileSync(join(FIXTURES, name), 'utf8')
  return classifySource(source, `packages/platform/src/${name.replace(/\.fixture$/, '')}`)
}

/** Classify a one-assertion test file whose assertion is `expect(subject)<chain>`. */
function classifyOne(chain: string): Counts {
  const source = [
    "import { expect, test } from 'vitest'",
    '',
    "test('one assertion', () => {",
    `  expect(subject)${chain}`,
    '})',
    '',
  ].join('\n')
  return classifySource(source, 'packages/sdk/src/one.test.ts').assertions
}

function assertionSum(c: Counts): number {
  return c.C1 + c.C2 + c.C3 + c.C4 + c.other
}

describe('AC-1: presence checks are C1', () => {
  const C1_CALLS = [
    '.toBeDefined()',
    '.toBeUndefined()',
    '.toBeTruthy()',
    '.toBeFalsy()',
    '.toBeNull()',
    '.toBeInstanceOf(Order)',
    '.toBeVisible()',
    '.toBeHidden()',
    '.toBeEnabled()',
    '.toHaveBeenCalled()',
    '.toBeOK()',
    '.toThrow()',
  ]

  it.each(C1_CALLS)('AC-1: expect(subject)%s is one C1', (chain) => {
    expect(classifyOne(chain)).toEqual({ ...ZERO, C1: 1 })
  })

  it('AC-1: a file of 12 presence checks counts 12 C1 and has no strong assertion', () => {
    const file = classifyFixture('c1-sanity.test.ts.fixture')
    expect(file.assertions).toEqual({ ...ZERO, C1: 12 })
    expect(file.hasStrong).toBe(false)
  })
})

describe('AC-2: exact matchers with a literal or plain reference are C4', () => {
  const C4_CALLS = [
    '.toBe(3)',
    ".toEqual({ status: 'pending' })",
    '.toStrictEqual([1, 2])',
    ".toMatchObject({ currency: 'USD' })",
    '.toHaveLength(2)',
    ".toContain('sale')",
    '.toMatch(/^SKU-/)',
    ".toHaveText('Pending')",
    ".toHaveURL('/cart')",
    ".toHaveBeenCalledWith('order.paid')",
    '.toHaveBeenCalledTimes(1)',
    '.toMatchSnapshot()',
    ".toThrow('boom')",
    '.toThrow(AuthError)',
    '.toThrow(errors.NotFound)',
    '.toBe(expected)',
    '.toBe(fixture.priceMinor)',
  ]

  it.each(C4_CALLS)('AC-2: expect(subject)%s is one C4', (chain) => {
    expect(classifyOne(chain)).toEqual({ ...ZERO, C4: 1 })
  })

  it('AC-2: a file of 17 exact assertions counts 17 C4 and has no strong assertion', () => {
    const file = classifyFixture('c4-exact.test.ts.fixture')
    expect(file.assertions).toEqual({ ...ZERO, C4: 17 })
    expect(file.hasStrong).toBe(false)
  })
})

describe('AC-3: ordering matchers and computed expectations are C3', () => {
  const C3_CALLS = [
    '.toBeGreaterThan(0)',
    '.toBeGreaterThanOrEqual(1)',
    '.toBeLessThan(10)',
    '.toBeLessThanOrEqual(10)',
    '.toBeCloseTo(0.3, 5)',
    '.toBe(before - qty)',
    '.toEqual(a + b)',
    '.toBe(lhs >= rhs)',
    '.toBe(sumOf(lines))',
    '.toEqual({ totalMinor: priceMinor * qty })',
    '.toHaveLength(items.length - 1)',
  ]

  it.each(C3_CALLS)('AC-3: expect(subject)%s is one C3', (chain) => {
    expect(classifyOne(chain)).toEqual({ ...ZERO, C3: 1 })
  })

  it.each([
    ".toEqual(expect.objectContaining({ status: 'paid' }))",
    '.toEqual(expect.any(String))',
  ])(
    'AC-3: an expect.* argument is not a call that makes it relational: expect(subject)%s is one C4',
    (chain) => {
      expect(classifyOne(chain)).toEqual({ ...ZERO, C4: 1 })
    },
  )

  it('AC-3: a file of 11 relational and 2 expect.* assertions counts 11 C3, 2 C4 and has a strong assertion', () => {
    const file = classifyFixture('c3-relational.test.ts.fixture')
    expect(file.assertions).toEqual({ ...ZERO, C3: 11, C4: 2 })
    expect(file.hasStrong).toBe(true)
  })
})

describe('AC-4: assertions inside a property are C2', () => {
  it('AC-4: inner expects of fc.property, fc.asyncProperty, test.prop and it.prop are C2, a bare fc.assert is one C2', () => {
    const file = classifyFixture('c2-property.test.ts.fixture')
    // 2 in fc.property + 1 in fc.asyncProperty + 1 bare fc.assert + 1 test.prop + 1 it.prop; 1 exact outside.
    expect(file.assertions).toEqual({ ...ZERO, C2: 6, C4: 1 })
    expect(file.tests).toBe(6)
    expect(file.hasStrong).toBe(true)
  })
})

describe('AC-5: chains are classified by their final matcher and counted once', () => {
  it('AC-5: .not, .resolves, .rejects, expect.soft, await expect(locator) and a multi-line chain count once each', () => {
    const file = classifyFixture('chains.test.ts.fixture')
    expect(assertionSum(file.assertions)).toBe(8)
    expect(file.assertions).toEqual({ ...ZERO, C1: 3, C3: 3, C4: 2 })
  })
})

describe('AC-6: unknown matchers are other and named', () => {
  it('AC-6: three custom matchers count as other and each name is listed in otherMatchers', () => {
    const file = classifyFixture('custom-matchers.test.ts.fixture')
    expect(file.assertions).toEqual({ ...ZERO, C4: 1, other: 3 })
    expect([...new Set(file.otherMatchers)].sort()).toEqual([
      'toBeValidOrder',
      'toHaveStatus',
      'toSatisfyAll',
    ])
  })
})

describe('AC-7: test call sites', () => {
  it('AC-7: it/test with every modifier count as tests, describe does not, .skip and .todo are skipped', () => {
    const file = classifyFixture('test-sites.test.ts.fixture')
    expect(file.tests).toBe(10)
    expect(file.skipped).toBe(4)
  })
})

describe('AC-8: print-style observation', () => {
  it('AC-8: console.log, console.info and console.debug are prints; warn and error are not', () => {
    const file = classifyFixture('prints.test.ts.fixture')
    expect(file.prints).toBe(4)
  })
})

describe('AC-9: package and layer of a path', () => {
  const ROWS: Array<[path: string, pkg: string, layer: string]> = [
    ['packages/sdk/src/x.test.ts', 'sdk', 'unit'],
    ['packages/platform/tests/integration/a.test.ts', 'platform', 'integration'],
    ['tests/contracts/a.test.ts', 'tests/contracts', 'contract'],
    ['tests/e2e/journeys/cart.spec.ts', 'tests/e2e', 'e2e'],
    ['apps/admin/src/a.test.tsx', 'apps/admin', 'unit'],
    ['templates/astro/tests/a.test.ts', 'templates/astro', 'unit'],
    ['tests/architecture/a.test.ts', 'tests/architecture', 'architecture'],
  ]

  it.each(ROWS)('AC-9: %s is package %s, layer %s', (path, pkg, layer) => {
    expect(packageOf(path)).toBe(pkg)
    expect(layerOf(path)).toBe(layer)
  })

  it('AC-9: classifySource stamps the same package and layer on the file', () => {
    for (const [path, pkg, layer] of ROWS) {
      const file = classifySource("import { test } from 'vitest'\n", path)
      expect(file.package).toBe(packageOf(path))
      expect(file.layer).toBe(layerOf(path))
      expect([file.package, file.layer]).toEqual([pkg, layer])
    }
  })
})

describe('AC-10: aggregate is additive across both groupings', () => {
  const KEYS = [
    'C1',
    'C2',
    'C3',
    'C4',
    'other',
    'files',
    'tests',
    'skipped',
    'prints',
    'filesWithoutStrong',
  ] as const satisfies ReadonlyArray<keyof Totals>

  const countsArb: fc.Arbitrary<Counts> = fc.record({
    C1: fc.nat(20),
    C2: fc.nat(3),
    C3: fc.nat(3),
    C4: fc.nat(20),
    other: fc.nat(5),
  })

  const filesArb: fc.Arbitrary<FileCensus[]> = fc
    .array(
      fc.record({
        package: fc.constantFrom('platform', 'sdk', 'tests/e2e', 'apps/admin', 'templates/astro'),
        layer: fc.constantFrom('unit', 'integration', 'contract', 'e2e', 'architecture'),
        tests: fc.nat(30),
        skipped: fc.nat(5),
        prints: fc.nat(5),
        assertions: countsArb,
        otherMatchers: fc.array(fc.constantFrom('toBeValidOrder', 'toHaveStatus'), {
          maxLength: 3,
        }),
      }),
      { maxLength: 40 },
    )
    .map((rows) =>
      rows.map(
        (row, i): FileCensus => ({
          ...row,
          path: `${row.package}/f${i}.test.ts`,
          hasStrong: row.assertions.C2 + row.assertions.C3 > 0,
        }),
      ),
    )

  function inputSum(files: FileCensus[], key: (typeof KEYS)[number]): number {
    let sum = 0
    for (const f of files) {
      switch (key) {
        case 'files':
          sum += 1
          break
        case 'filesWithoutStrong':
          sum += f.assertions.C2 + f.assertions.C3 === 0 ? 1 : 0
          break
        case 'tests':
        case 'skipped':
        case 'prints':
          sum += f[key]
          break
        default:
          sum += f.assertions[key]
      }
    }
    return sum
  }

  function rowSum(rows: Record<string, Totals>, key: (typeof KEYS)[number]): number {
    return Object.values(rows).reduce((s, t) => s + t[key], 0)
  }

  it('AC-10: for every count, sum over byPackage = total = sum over byLayer = sum over the input files', () => {
    fc.assert(
      fc.property(filesArb, (files) => {
        const { byPackage, byLayer, total } = aggregate(files)
        for (const key of KEYS) {
          expect(total[key], `total.${key}`).toBe(inputSum(files, key))
          expect(rowSum(byPackage, key), `byPackage ${key}`).toBe(total[key])
          expect(rowSum(byLayer, key), `byLayer ${key}`).toBe(total[key])
        }
      }),
    )
  })

  it('AC-10: each row counts exactly the files of its package or layer, and no row is invented', () => {
    fc.assert(
      fc.property(filesArb, (files) => {
        const { byPackage, byLayer } = aggregate(files)
        const packages = [...new Set(files.map((f) => f.package))].sort()
        const layers = [...new Set(files.map((f) => f.layer))].sort()
        expect(Object.keys(byPackage).sort()).toEqual(packages)
        expect(Object.keys(byLayer).sort()).toEqual(layers)
        for (const p of packages) {
          const own = files.filter((f) => f.package === p)
          expect(byPackage[p]?.files).toBe(own.length)
          expect(byPackage[p]?.filesWithoutStrong).toBe(
            own.filter((f) => f.assertions.C2 + f.assertions.C3 === 0).length,
          )
        }
        for (const l of layers) {
          expect(byLayer[l]?.files).toBe(files.filter((f) => f.layer === l).length)
        }
      }),
    )
  })
})

describe('AC-11: the census CLI on the repository', () => {
  const PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/
  const EXCLUDED = ['tests/tooling/fixtures/', 'tests/sentinels/']

  it('AC-11: without paths it censuses every tracked test file except tooling fixtures and sentinels, and --json parses', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter((p) => PATTERN.test(p))
    // The premise: there are tracked decoys under both excluded trees, so the exclusion is observable.
    expect(tracked).toContain('tests/tooling/fixtures/census/decoy.spec.mjs')
    expect(tracked).toContain('tests/sentinels/fixtures/census-decoy.spec.mjs')
    const expected = tracked.filter((p) => !EXCLUDED.some((prefix) => p.startsWith(prefix))).sort()

    const res = spawnSync('pnpm', ['exec', 'tsx', 'scripts/test-census.ts', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    expect(res.status, res.stderr).toBe(0)
    const report = JSON.parse(res.stdout) as CensusJson

    expect(Object.keys(report)).toEqual(
      expect.arrayContaining(['byLayer', 'byPackage', 'files', 'total']),
    )
    const paths = report.files.map((f: FileCensus) => f.path).sort()
    expect(paths).toEqual(expected)
    expect(report.total.files).toBe(report.files.length)
  })
})
