// Reads: tests/fixtures/third-party-search-broken/package.json
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { type Matrix, parseMatrix } from '../../packages/cli/src/upgrade/matrix'
import { planUpgrade } from '../../packages/cli/src/upgrade/plan'
import { mergeMatrix } from '../../scripts/registry/matrix'
import type { EntryStatus } from '../../scripts/registry/status'

// The two sides of the compatibility matrix against each other: what the nightly merges and what the CLI accepts.

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const NOW = new Date('2026-11-09T03:00:00.000Z')
const STATUSES: EntryStatus[] = ['passing', 'failing', 'suspended', 'no-suite', 'first-party']

type NightEntry = { version: string | null; status: EntryStatus; line: string }

const version = fc
  .tuple(fc.nat(3), fc.nat(5), fc.nat(5))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`)

const nightEntry: fc.Arbitrary<NightEntry> = fc.constantFrom(...STATUSES).chain((status) =>
  fc.record({
    status: fc.constant(status),
    // Empty is what a first-party entry's history carries.
    line: fc.constantFrom('', '30 cases passed', 'not certified x (search): 2 of 30 cases failed'),
    version:
      status === 'failing' || status === 'suspended' ? fc.option(version, { nil: null }) : version,
  }),
)

const names = fc.constantFrom('@acme/a', '@acme/b', '@nymbalhq/search-typesense')
const night = fc.dictionary(names, nightEntry, { noNullPrototype: true })
const packages = fc.dictionary(
  fc.constantFrom('nymbal', '@nymbalhq/platform', '@nymbalhq/stack'),
  version,
  { noNullPrototype: true },
)
const stack = fc.record({ version, packages })

const previousMatrix: fc.Arbitrary<Matrix | undefined> = fc.option(
  fc
    .dictionary(version, fc.record({ packages, adapters: night }), {
      maxKeys: 5,
      noNullPrototype: true,
    })
    .map((stacks) => ({ schema: 1 as const, generatedAt: '2026-11-08T03:00:00.000Z', stacks })),
  { nil: undefined },
)

/** A night's adapters as the two sides agree on them; the merge may leave an empty line out. */
const sameAdapters = (
  adapters: Record<string, NightEntry | Matrix['stacks'][string]['adapters'][string]>,
) =>
  Object.fromEntries(
    Object.entries(adapters).map(([name, a]) => [
      name,
      { version: a.version, status: a.status, line: a.line ?? '' },
    ]),
  )

describe("AC-16: mergeMatrix keeps every other row and replaces only the night's own", () => {
  it('AC-16: over generated nights, the current row is what the night supplied, every other row is carried unchanged and none is dropped', () => {
    fc.assert(
      fc.property(previousMatrix, stack, night, (previous, current, adapters) => {
        const merged = mergeMatrix(previous, current, adapters, NOW)
        const earlier = previous?.stacks ?? {}

        expect(merged.schema).toBe(1)
        expect(merged.generatedAt).toBe(NOW.toISOString())
        expect(merged.stacks[current.version]!.packages).toEqual(current.packages)
        expect(sameAdapters(merged.stacks[current.version]!.adapters)).toEqual(
          sameAdapters(adapters),
        )
        expect(Object.keys(merged.stacks).sort()).toEqual(
          [...new Set([...Object.keys(earlier), current.version])].sort(),
        )
        const carried = Object.keys(earlier).filter((row) => row !== current.version)
        expect(carried.map((row) => merged.stacks[row])).toEqual(carried.map((row) => earlier[row]))
      }),
    )
  })

  it('AC-16: a second night on one stack version replaces the row, keeping nothing of the stale night', () => {
    const previous: Matrix = {
      schema: 1,
      generatedAt: '2026-11-08T03:00:00.000Z',
      stacks: {
        '1.9.0': {
          packages: { nymbal: '1.9.0' },
          adapters: {
            '@acme/a': { version: '1.0.0', status: 'passing', line: '30 cases passed' },
            '@acme/gone-from-the-manifest': { version: '1.0.0', status: 'passing' },
          },
        },
      },
    }
    const line = 'not certified @acme/a (search): 2 of 30 cases failed'

    const merged = mergeMatrix(
      previous,
      { version: '1.9.0', packages: { nymbal: '1.9.0' } },
      {
        '@acme/a': { version: '1.0.1', status: 'failing', line },
        '@nymbalhq/search-typesense': { version: '1.2.0', status: 'first-party', line: '' },
      },
      NOW,
    )

    expect(sameAdapters(merged.stacks['1.9.0']!.adapters)).toEqual({
      '@acme/a': { version: '1.0.1', status: 'failing', line },
      '@nymbalhq/search-typesense': { version: '1.2.0', status: 'first-party', line: '' },
    })
  })
})

describe('AC-17: the matrix the nightly writes is the matrix the CLI reads', () => {
  it('AC-17: over generated nights, what mergeMatrix writes survives the file and parseMatrix accepts it', () => {
    fc.assert(
      fc.property(previousMatrix, stack, night, (previous, current, adapters) => {
        const merged = mergeMatrix(previous, current, adapters, NOW)

        expect(parseMatrix(JSON.parse(JSON.stringify(merged)))).toEqual(merged)
      }),
    )
  })

  it("AC-17: a night with the broken fixture's result makes planUpgrade refuse, naming it", () => {
    const broken = JSON.parse(
      readFileSync(
        join(REPO, 'tests', 'fixtures', 'third-party-search-broken', 'package.json'),
        'utf8',
      ),
    ) as { name: string; version: string }
    const line = `not certified ${broken.name} (search): 3 of 30 cases failed`
    const merged = mergeMatrix(
      undefined,
      { version: '1.9.0', packages: { nymbal: '1.9.0' } },
      { [broken.name]: { version: broken.version, status: 'failing', line } },
      NOW,
    )

    const plan = planUpgrade({
      current: '1.8.0',
      manifest: { dependencies: { nymbal: '1.8.0', [broken.name]: `^${broken.version}` } },
      installed: { [broken.name]: broken.version },
      matrix: parseMatrix(JSON.parse(JSON.stringify(merged))),
    })

    expect(plan).toEqual({
      kind: 'refused',
      current: '1.8.0',
      blocked: [
        { stack: '1.9.0', adapter: broken.name, version: broken.version, status: 'failing', line },
      ],
    })
  })
})
