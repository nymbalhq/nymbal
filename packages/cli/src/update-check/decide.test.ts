import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Matrix, MatrixAdapter, MatrixRow } from '../upgrade/matrix.js'
import {
  AUTO_UPDATES_PRESET,
  decideUpdate,
  renovateEnablesAutomerge,
  STORE_PRESET,
  type UpdateFacts,
} from './decide.js'

// Whether an update may merge itself, decided from facts alone: the store's renovate.json, what the base and the head
// declare, what the head installed, the compatibility matrix and the migrations the update adds. A clean update is a
// Nymbal patch release moving the whole set from BASE to HEAD; each condition below breaks exactly one fact of it.

const BASE = '1.8.0'
const HEAD = '1.8.1'
const ADAPTER = '@acme/nymbal-search'
const ELSEWHERE = '@acme/elsewhere'
const LINE = `not certified ${ADAPTER} (search): 2 of 30 cases failed`
const TS_ALIAS = 'npm:@typescript/typescript6@^6.0.2'
const NYMBAL_INSTALLED = ['@nymbalhq/platform', '@nymbalhq/sdk', '@nymbalhq/config'] as const

type Declared = Record<string, string>

/** What a scaffolded store declares at Nymbal version `v` (declaredVersions over its package.json). */
function declared(v: string): Declared {
  return {
    nymbal: v,
    '@nymbalhq/platform': v,
    '@nymbalhq/sdk': v,
    '@nymbalhq/config': v,
    // Only in pnpm.overrides in a scaffold: declared, never installed top-level.
    '@nymbalhq/http': v,
    astro: '^7.4.0',
    zod: '^3.23.0',
    [ADAPTER]: '1.0.0',
    typescript: TS_ALIAS,
  }
}

function rowAt(v: string, adapters: Record<string, MatrixAdapter>): MatrixRow {
  return {
    packages: {
      nymbal: v,
      '@nymbalhq/platform': v,
      '@nymbalhq/sdk': v,
      '@nymbalhq/config': v,
      '@nymbalhq/http': v,
      '@nymbalhq/react': v,
    },
    adapters,
  }
}

const PASSING: Record<string, MatrixAdapter> = {
  [ADAPTER]: { version: '1.0.0', status: 'passing', line: '30 cases passed' },
  // An adapter the store does not declare: whatever its status, it never counts.
  [ELSEWHERE]: { version: '9.9.9', status: 'failing', line: 'not ours' },
}

const matrixOf = (stacks: Record<string, MatrixRow>): Matrix => ({
  schema: 1,
  generatedAt: '2026-11-21T03:00:00.000Z',
  stacks,
})

function clean(): UpdateFacts {
  return {
    renovate: { automerge: true },
    base: declared(BASE),
    head: declared(HEAD),
    dependencyFilesChanged: true,
    ownMigrations: false,
    installed: {
      nymbal: HEAD,
      '@nymbalhq/platform': HEAD,
      '@nymbalhq/sdk': HEAD,
      '@nymbalhq/config': HEAD,
      astro: '7.4.2',
      zod: '3.23.8',
      [ADAPTER]: '1.0.0',
    },
    matrix: matrixOf({ [HEAD]: rowAt(HEAD, { ...PASSING }) }),
    migrationsAdded: [],
  }
}

const headOf = (f: UpdateFacts): Declared => f.head
const rowOf = (f: UpdateFacts): MatrixRow => (f.matrix as Matrix).stacks[HEAD]!

// ─── generators ─────────────────────────────────────────────────────────────────────────────────────────────────────

const version = fc
  .tuple(fc.nat(3), fc.nat(9), fc.nat(9))
  .map(([major, minor, patch]) => `${major}.${minor}.${patch}`)
const name = fc.constantFrom(
  'nymbal',
  '@nymbalhq/platform',
  '@nymbalhq/sdk',
  ADAPTER,
  'zod',
  'left-pad',
  'typescript',
)
const range = fc.oneof(
  version,
  version.map((v) => `^${v}`),
  fc.constant(TS_ALIAS),
  fc.constant('workspace:*'),
)
const declaredArb = fc.dictionary(name, range)
const status = fc.constantFrom<MatrixAdapter['status']>(
  'passing',
  'failing',
  'suspended',
  'no-suite',
  'first-party',
)
const matrixArb: fc.Arbitrary<Matrix> = fc
  .dictionary(
    version,
    fc.record({
      packages: fc.dictionary(name, version),
      adapters: fc.dictionary(name, fc.record({ version, status, line: fc.string() })),
    }),
  )
  .map(matrixOf)
const tags = fc.array(
  fc.nat(9999).map((n) => `${String(n).padStart(4, '0')}_x`),
  { maxLength: 4 },
)
const error = fc.record({ error: fc.string() })

/** Every fact but renovate.json's, errors included. */
const otherFacts = fc.record({
  base: fc.oneof(declaredArb, error),
  head: declaredArb,
  dependencyFilesChanged: fc.boolean(),
  ownMigrations: fc.boolean(),
  installed: fc.dictionary(name, version),
  matrix: fc.oneof(matrixArb, error),
  migrationsAdded: fc.oneof(tags, error),
})

// ─── AC-1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

type Segment = { key: string } | 'rule'
const segment: fc.Arbitrary<Segment> = fc.oneof(
  fc.constantFrom('vulnerabilityAlerts', 'lockFileMaintenance', 'major', 'minor').map((key) => ({
    key,
  })),
  fc.constant('rule' as const),
)

/** `leaf` nested under the path: a key holds the next level, `rule` puts it in a packageRules entry. */
function nest(path: Segment[], leaf: Record<string, unknown>): Record<string, unknown> {
  return path.reduceRight<Record<string, unknown>>(
    (inner, seg) =>
      seg === 'rule'
        ? { packageRules: [{ matchPackageNames: ['left-pad'] }, inner] }
        : { [seg.key]: inner },
    leaf,
  )
}

describe('AC-1: auto-updates are on only when renovate.json asks for them', () => {
  it('AC-1: the auto-updates preset in extends, or automerge true at the top level, in a packageRules entry or in vulnerabilityAlerts, turns automerge on; the store preset alone or automerge false does not', () => {
    expect(
      [
        { extends: [AUTO_UPDATES_PRESET] },
        { extends: [STORE_PRESET, AUTO_UPDATES_PRESET] },
        { extends: [STORE_PRESET], automerge: true },
        {
          extends: [STORE_PRESET],
          packageRules: [{ matchPackageNames: ['next'], automerge: true }],
        },
        { extends: [STORE_PRESET], vulnerabilityAlerts: { automerge: true } },
        { extends: [`${AUTO_UPDATES_PRESET}#1.9.0`] },
        { extends: [`${AUTO_UPDATES_PRESET}.json`] },
        { extends: [STORE_PRESET, ':automergePatch'] },
        { extends: [STORE_PRESET], packageRules: [{ extends: [':automergeMinor'] }] },
        { extends: [STORE_PRESET] },
        { extends: [STORE_PRESET, 'config:recommended'] },
        { extends: [STORE_PRESET], automerge: false },
        { extends: [STORE_PRESET], vulnerabilityAlerts: { automerge: false } },
      ].map(renovateEnablesAutomerge),
    ).toEqual([true, true, true, true, true, true, true, true, true, false, false, false, false])
  })

  it('AC-1: automerge true at any depth turns it on and automerge false at the same place does not (property)', () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 4 }), (path) => {
        expect(
          renovateEnablesAutomerge({ extends: [STORE_PRESET], ...nest(path, { automerge: true }) }),
        ).toBe(true)
        expect(
          renovateEnablesAutomerge({
            extends: [STORE_PRESET],
            ...nest(path, { automerge: false }),
          }),
        ).toBe(false)
      }),
    )
  })

  it('AC-1: any JSON that names neither automerge nor extends leaves it off (property)', () => {
    fc.assert(
      fc.property(
        fc.jsonValue().filter((v) => {
          const text = JSON.stringify(v) ?? ''
          return !text.includes('automerge') && !text.includes('"extends"')
        }),
        (value) => {
          expect(renovateEnablesAutomerge(value)).toBe(false)
          expect(renovateEnablesAutomerge({ extends: [STORE_PRESET], other: value })).toBe(false)
        },
      ),
    )
  })

  it('AC-1: with automerge off the update is ok with "auto-updates off", whatever every other fact holds (property)', () => {
    fc.assert(
      fc.property(otherFacts, (other) => {
        const decision = decideUpdate({ renovate: { automerge: false }, ...other })
        expect(decision.ok).toBe(true)
        expect(decision.lines.join('\n')).toContain('auto-updates off')
      }),
    )
  })

  it('AC-1: an unreadable renovate.json is refused naming renovate.json, whatever every other fact holds (property)', () => {
    fc.assert(
      fc.property(otherFacts, (other) => {
        const decision = decideUpdate({
          renovate: { error: 'Unexpected token } in JSON at position 3' },
          ...other,
        })
        expect(decision.ok).toBe(false)
        expect(decision.lines.join('\n')).toContain('renovate.json')
      }),
    )
  })

  it('AC-1: with automerge on, a readable base and no dependency file changed, the update is ok with "no dependency changed" whatever the matrix, the journals, the install and a migrations folder hold (property)', () => {
    fc.assert(
      fc.property(otherFacts, declaredArb, (other, same) => {
        const decision = decideUpdate({
          ...other,
          renovate: { automerge: true },
          base: same,
          head: { ...same },
          dependencyFilesChanged: false,
        })
        expect(decision.ok).toBe(true)
        expect(decision.lines.join('\n')).toContain('no dependency changed')
      }),
    )
  })
})

// ─── AC-2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Each independent condition: what it breaks, and a token only its reason line holds (null: none is specified). */
const CONDITIONS: Record<string, { apply: (f: UpdateFacts) => void; token: string | null }> = {
  'own migrations folder': {
    apply: (f) => {
      f.ownMigrations = true
    },
    token: null,
  },
  'dependency added': {
    apply: (f) => {
      headOf(f)['left-pad'] = '1.3.0'
    },
    token: 'left-pad',
  },
  'major rise': {
    apply: (f) => {
      headOf(f)['zod'] = '^4.0.0'
    },
    token: 'zod',
  },
  'unreadable range changed': {
    apply: (f) => {
      headOf(f)['typescript'] = 'npm:@typescript/typescript6@^6.1.0'
    },
    token: 'typescript',
  },
  'mixed Nymbal set': {
    apply: (f) => {
      f.installed['@nymbalhq/sdk'] = BASE
    },
    token: '@nymbalhq/sdk',
  },
  'blocked adapter': {
    apply: (f) => {
      rowOf(f).adapters[ADAPTER] = { version: '1.0.0', status: 'failing', line: LINE }
    },
    token: ADAPTER,
  },
  'migration added': {
    apply: (f) => {
      f.migrationsAdded = ['0029_x']
    },
    token: '0029_x',
  },
}
const CONDITION_NAMES = Object.keys(CONDITIONS)
const TOKENS = Object.values(CONDITIONS).flatMap((c) => (c.token === null ? [] : [c.token]))

describe('AC-2: every condition that holds is one reason, and only a clean update is ok', () => {
  it('AC-2: a clean Nymbal patch release (the whole set moved, its row certified, no migration) may merge', () => {
    const decision = decideUpdate(clean())
    expect(decision.ok).toBe(true)
    expect(decision.lines.join('\n')).toContain('may merge')
  })

  it('AC-2: over every subset of the independent conditions, ok exactly when the subset is empty, with one reason line per condition in it (property)', () => {
    fc.assert(
      fc.property(fc.subarray(CONDITION_NAMES), (subset) => {
        const facts = clean()
        for (const condition of subset) CONDITIONS[condition]!.apply(facts)

        const decision = decideUpdate(facts)

        expect(decision.ok).toBe(subset.length === 0)
        if (subset.length === 0) return
        expect(decision.lines).toHaveLength(subset.length)
        for (const condition of subset) {
          const token = CONDITIONS[condition]!.token
          if (token === null) continue
          expect(
            decision.lines.filter((line: string) => line.includes(token)),
            `${condition}: one line names ${token}`,
          ).toHaveLength(1)
        }
        // The one line no token claims is the migrations folder's.
        const rest = decision.lines.filter((line: string) => !TOKENS.some((t) => line.includes(t)))
        expect(rest.length).toBe(subset.includes('own migrations folder') ? 1 : 0)
        for (const line of rest) expect(line).toMatch(/migrations/)
      }),
      { numRuns: 200 },
    )
  })

  it('AC-2: an unreadable base hides added-or-removed, major, unreadable-range and migration: one reason, naming package.json', () => {
    const facts = clean()
    for (const c of [
      'dependency added',
      'major rise',
      'unreadable range changed',
      'migration added',
    ]) {
      CONDITIONS[c]!.apply(facts)
    }
    facts.base = { error: "fatal: invalid object name 'HEAD^1'" }

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(false)
    expect(decision.lines).toHaveLength(1)
    expect(decision.lines[0]).toContain('package.json')
  })

  it('AC-2: an unreadable matrix hides no-row, mixed and adapter: one reason, "cannot read the compatibility matrix"', () => {
    const facts = clean()
    CONDITIONS['mixed Nymbal set']!.apply(facts)
    facts.matrix = { error: 'the server answered 500' }

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(false)
    expect(decision.lines).toHaveLength(1)
    expect(decision.lines[0]).toContain('cannot read the compatibility matrix')
  })

  it('AC-2: no row for the installed version hides mixed and adapter: one reason, naming the version', () => {
    const facts = clean()
    CONDITIONS['mixed Nymbal set']!.apply(facts)
    // Only the base's row: it fails the adapter, which must not be reported against a row the head is not on.
    facts.matrix = matrixOf({
      [BASE]: rowAt(BASE, { [ADAPTER]: { version: '1.0.0', status: 'failing', line: LINE } }),
    })

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(false)
    expect(decision.lines).toHaveLength(1)
    expect(decision.lines[0]).toContain('not in the compatibility matrix')
    expect(decision.lines[0]).toContain(HEAD)
  })

  it('AC-2: unreadable journals stand in for a migration added: refused, one reason', () => {
    const facts = clean()
    facts.migrationsAdded = { error: 'the registry answered 500 for the tarball' }

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(false)
    expect(decision.lines).toHaveLength(1)
  })
})

// ─── AC-3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-3: the Nymbal set moves as one', () => {
  it('AC-3: the installed nymbal version with no row is refused, naming the version', () => {
    const facts = clean()
    facts.matrix = matrixOf({ [BASE]: rowAt(BASE, { ...PASSING }) })

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(false)
    expect(
      decision.lines.filter((l: string) => l.includes('not in the compatibility matrix')),
    ).toEqual([expect.stringContaining(HEAD)])
  })

  it('AC-3: nymbal 1.8.1 with @nymbalhq/platform installed at 1.8.0 is refused, naming the platform', () => {
    const facts = clean()
    facts.installed['@nymbalhq/platform'] = BASE

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(false)
    expect(decision.lines.join('\n')).toContain('@nymbalhq/platform')
  })

  it("AC-3: a package of the row installed at another version refuses and names it; one at the row's version or not installed top-level does not (property)", () => {
    const placement = fc.constantFrom('at the row', 'another version', 'not installed')
    fc.assert(
      fc.property(fc.tuple(placement, placement, placement), (placements) => {
        const facts = clean()
        NYMBAL_INSTALLED.forEach((pkg, i) => {
          if (placements[i] === 'another version') facts.installed[pkg] = BASE
          if (placements[i] === 'not installed') delete facts.installed[pkg]
        })

        const decision = decideUpdate(facts)

        const mixed = NYMBAL_INSTALLED.filter((_, i) => placements[i] === 'another version')
        const fine = NYMBAL_INSTALLED.filter((_, i) => placements[i] !== 'another version')
        const text = decision.lines.join('\n')
        expect(decision.ok).toBe(mixed.length === 0)
        expect(mixed.filter((pkg) => !text.includes(pkg))).toEqual([])
        expect(fine.filter((pkg) => text.includes(pkg))).toEqual([])
      }),
    )
  })

  it('AC-3: a declared name the row does not list does not count, at whatever version it is installed', () => {
    const facts = clean()
    facts.base = { ...declared(BASE), '@acme/our-own': '0.4.0' }
    facts.head = { ...declared(HEAD), '@acme/our-own': '0.4.0' }
    facts.installed['@acme/our-own'] = '0.4.0'

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(true)
    expect(decision.lines.join('\n')).not.toContain('@acme/our-own')
  })

  it('AC-3: @nymbalhq/http declared only in pnpm.overrides and not installed top-level is ignored, though the row lists it', () => {
    const facts = clean()
    expect(Object.hasOwn(facts.installed, '@nymbalhq/http')).toBe(false)
    expect(rowOf(facts).packages['@nymbalhq/http']).toBe(headOf(facts)['@nymbalhq/http'])

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(true)
    expect(decision.lines.join('\n')).not.toContain('@nymbalhq/http')
  })
})

// ─── AC-4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("AC-4: the row's verdict on the store's adapters", () => {
  it('AC-4: a declared adapter failing or suspended refuses naming adapter, version, status and line; passing, first-party and no-suite do not; an undeclared adapter never counts (property)', () => {
    fc.assert(
      fc.property(status, status, (own, other) => {
        const facts = clean()
        rowOf(facts).adapters[ADAPTER] = { version: '2.0.0', status: own, line: LINE }
        rowOf(facts).adapters[ELSEWHERE] = { version: '9.9.9', status: other, line: 'not ours' }

        const decision = decideUpdate(facts)

        const blocks = own === 'failing' || own === 'suspended'
        expect(decision.ok).toBe(!blocks)
        const naming = decision.lines.filter(
          (l: string) =>
            l.includes(ADAPTER) && l.includes('2.0.0') && l.includes(own) && l.includes(LINE),
        )
        expect(naming).toHaveLength(blocks ? 1 : 0)
        expect(decision.lines.filter((l: string) => l.includes(ELSEWHERE))).toEqual([])
      }),
    )
  })
})

// ─── AC-5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-5: what a declared dependency may do', () => {
  it('AC-5: a rise of the minimum version refuses exactly when its major rises (property, over exact, caret and tilde ranges)', () => {
    const prefix = fc.constantFrom('', '^', '~')
    const move = fc
      .record({
        major: fc.integer({ min: 1, max: 20 }),
        minor: fc.nat(20),
        patch: fc.nat(20),
        majorUp: fc.nat(3),
        minorUp: fc.nat(3),
        patchUp: fc.nat(3),
        from: prefix,
        to: prefix,
      })
      .map((m) => {
        const base = `${m.from}${m.major}.${m.minor}.${m.patch}`
        const head =
          m.majorUp > 0
            ? `${m.to}${m.major + m.majorUp}.0.0`
            : m.minorUp > 0
              ? `${m.to}${m.major}.${m.minor + m.minorUp}.0`
              : `${m.to}${m.major}.${m.minor}.${m.patch + m.patchUp}`
        return { base, head, majorRises: m.majorUp > 0 }
      })
    fc.assert(
      fc.property(move, ({ base, head, majorRises }) => {
        const facts = clean()
        facts.base = { ...declared(BASE), next: base }
        facts.head = { ...declared(HEAD), next: head }

        const decision = decideUpdate(facts)

        expect(decision.ok).toBe(!majorRises)
        expect(decision.lines.filter((l: string) => l.includes('next'))).toHaveLength(
          majorRises ? 1 : 0,
        )
      }),
    )
  })

  it('AC-5: next 16.4.5 to 16.4.6 alone beside the Nymbal set may merge', () => {
    const facts = clean()
    facts.base = { ...declared(BASE), next: '16.4.5' }
    facts.head = { ...declared(HEAD), next: '16.4.6' }

    expect(decideUpdate(facts).ok).toBe(true)
  })

  it('AC-5: a declared dependency added or removed refuses, naming it', () => {
    const added = clean()
    headOf(added)['left-pad'] = '1.3.0'
    const removed = clean()
    delete headOf(removed)['astro']

    const decisions = [decideUpdate(added), decideUpdate(removed)]

    expect(decisions.map((d) => d.ok)).toEqual([false, false])
    expect(decisions[0]!.lines.filter((l: string) => l.includes('left-pad'))).toHaveLength(1)
    expect(decisions[1]!.lines.filter((l: string) => l.includes('astro'))).toHaveLength(1)
  })

  it('AC-5: values semver cannot read (the TypeScript npm: alias, workspace:*) are ignored while unchanged, with no throw and no reason', () => {
    const facts = clean()
    facts.base = { ...declared(BASE), '@acme/local': 'workspace:*' }
    facts.head = { ...declared(HEAD), '@acme/local': 'workspace:*' }
    expect(headOf(facts)['typescript']).toBe((facts.base as Declared)['typescript'])

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(true)
    expect(
      decision.lines.filter((l: string) => l.includes('typescript') || l.includes('@acme/local')),
    ).toEqual([])
  })

  it('AC-5: the TypeScript alias changed inside the alias (^6.0.2 to ^6.1.0) refuses, naming typescript', () => {
    const facts = clean()
    headOf(facts)['typescript'] = 'npm:@typescript/typescript6@^6.1.0'

    const decision = decideUpdate(facts)

    expect(decision.ok).toBe(false)
    expect(decision.lines.filter((l: string) => l.includes('typescript'))).toHaveLength(1)
  })
})
