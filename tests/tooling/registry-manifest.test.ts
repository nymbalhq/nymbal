// Reads: registry/adapters.json, packages/adapters/*/*/package.json
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterAll, describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, slotFolder } from '../../packages/config/src/adapter-names'
import type { Slot } from '../../packages/types/src/adapters/adapter-base'
import { readManifest, validateManifest } from '../../scripts/registry/manifest'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

type Entry = Record<string, unknown>

const FIRST_PARTY: Entry = {
  package: '@nymbalhq/search-algolia',
  slot: 'search',
  provider: 'algolia',
  tier: 'first-party',
  source: { dir: 'packages/adapters/search/algolia' },
}
const COMMUNITY: Entry = {
  package: '@acme/nymbal-search',
  slot: 'search',
  provider: 'acme',
  tier: 'community',
  maintainer: 'https://github.com/acme',
  repository: 'https://github.com/acme/nymbal-search',
  source: { npm: '^1.0.0' },
}

const manifest = (...adapters: Entry[]) => ({ adapters })
const without = (entry: Entry, key: string): Entry =>
  Object.fromEntries(Object.entries(entry).filter(([k]) => k !== key))

/** Does the line name the entry: its package, or its index in the list? */
function namesEntry(line: string, pkg: string, index: number): boolean {
  return line.includes(pkg) || new RegExp(`(\\[|#|entry |index )${index}\\b`).test(line)
}

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('AC-2: the manifest is validated', () => {
  it('AC-2: a valid manifest gives no lines, and a community source.dir that does not exist is not a line', () => {
    expect(validateManifest(manifest(FIRST_PARTY, COMMUNITY), REPO)).toEqual([])
    expect(
      validateManifest(
        manifest(FIRST_PARTY, { ...COMMUNITY, source: { dir: 'tests/fixtures/no-such-adapter' } }),
        REPO,
      ),
    ).toEqual([])
  })

  // Each case: the entries, which entry is at fault (its index), and the field the line must name.
  const cases: Array<{ name: string; adapters: Entry[]; at: number; field: RegExp }> = [
    {
      name: 'a duplicate package',
      adapters: [FIRST_PARTY, COMMUNITY, { ...COMMUNITY, provider: 'acme-two' }],
      at: 2,
      field: /package/,
    },
    {
      name: 'a camelCase slot',
      adapters: [
        FIRST_PARTY,
        { ...COMMUNITY, package: '@acme/nymbal-docs', slot: 'documentStore' },
      ],
      at: 1,
      field: /slot/,
    },
    {
      name: 'a slot that is no Slot',
      adapters: [FIRST_PARTY, { ...COMMUNITY, slot: 'searching' }],
      at: 1,
      field: /slot/,
    },
    {
      name: 'a provider not matching PROVIDER_NAME',
      adapters: [FIRST_PARTY, { ...COMMUNITY, provider: 'Acme_Search' }],
      at: 1,
      field: /provider/,
    },
    {
      name: 'a first-party package that is not the convention name',
      adapters: [{ ...FIRST_PARTY, package: '@nymbalhq/algolia-search' }, COMMUNITY],
      at: 0,
      field: /package/,
    },
    {
      name: 'a first-party source.dir that is not packages/adapters/<slot>/<provider>',
      adapters: [{ ...FIRST_PARTY, source: { dir: 'packages/adapters/search/meili' } }, COMMUNITY],
      at: 0,
      field: /dir/,
    },
    {
      name: 'a community entry under @nymbalhq/',
      adapters: [FIRST_PARTY, { ...COMMUNITY, package: '@nymbalhq/search-acme' }],
      at: 1,
      field: /package|scope|@nymbalhq/,
    },
    {
      name: 'a verified entry under @nymbalhq/',
      adapters: [FIRST_PARTY, { ...COMMUNITY, tier: 'verified', package: '@nymbalhq/search-acme' }],
      at: 1,
      field: /package|scope|@nymbalhq/,
    },
    {
      name: 'a community entry with no maintainer',
      adapters: [FIRST_PARTY, without(COMMUNITY, 'maintainer')],
      at: 1,
      field: /maintainer/,
    },
    {
      name: 'a source with neither dir nor npm',
      adapters: [FIRST_PARTY, { ...COMMUNITY, source: {} }],
      at: 1,
      field: /source/,
    },
    {
      name: 'a source with both dir and npm',
      adapters: [
        FIRST_PARTY,
        { ...COMMUNITY, source: { dir: 'tests/fixtures/third-party-search', npm: '^1.0.0' } },
      ],
      at: 1,
      field: /source/,
    },
    {
      name: 'an unknown tier',
      adapters: [FIRST_PARTY, { ...COMMUNITY, tier: 'gold' }],
      at: 1,
      field: /tier/,
    },
    {
      name: 'a javascript: maintainer',
      adapters: [FIRST_PARTY, { ...COMMUNITY, maintainer: 'javascript:alert(1)' }],
      at: 1,
      field: /maintainer/,
    },
    {
      name: 'an http: maintainer',
      adapters: [FIRST_PARTY, { ...COMMUNITY, maintainer: 'http://github.com/acme' }],
      at: 1,
      field: /maintainer/,
    },
    {
      name: 'a repository that is not an https: URL',
      adapters: [FIRST_PARTY, { ...COMMUNITY, repository: '"><script>alert(1)</script>' }],
      at: 1,
      field: /repository/,
    },
    {
      name: 'two entries with one badgePath',
      adapters: [
        FIRST_PARTY,
        COMMUNITY,
        { ...COMMUNITY, package: '@acme-nymbal/search', provider: 'acme-two' },
      ],
      at: 2,
      field: /badge/i,
    },
  ]

  for (const c of cases) {
    it(`AC-2: ${c.name} gives one line naming the entry and the field`, () => {
      const lines: string[] = validateManifest(manifest(...c.adapters), REPO)
      const pkg = String(c.adapters[c.at]!['package'])

      expect(lines, lines.join('\n')).toHaveLength(1)
      expect(namesEntry(lines[0]!, pkg, c.at), lines[0]).toBe(true)
      expect(lines[0]).toMatch(c.field)
    })
  }

  // Each defect touches one field of one community entry; none touches another entry.
  const DEFECTS: Record<string, (e: Entry) => Entry> = {
    'no maintainer': (e) => without(e, 'maintainer'),
    'unknown tier': (e) => ({ ...e, tier: 'platinum' }),
    'bad provider': (e) => ({ ...e, provider: `-${String(e['provider'])}` }),
    'camelCase slot': (e) => ({ ...e, slot: 'eventBus' }),
    'javascript: repository': (e) => ({ ...e, repository: 'javascript:void(0)' }),
    'both sources': (e) => ({ ...e, source: { npm: '^1.0.0', dir: 'x' } }),
    'no source': (e) => without(e, 'source'),
  }

  it('AC-2: a manifest of valid and defective entries gives exactly one line per defective entry, naming it, and none for a valid one', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.constantFrom(...Object.keys(DEFECTS)), { nil: undefined }), {
          minLength: 1,
          maxLength: 8,
        }),
        (plan) => {
          const adapters = plan.map((defect, i) => {
            const entry = {
              ...COMMUNITY,
              package: `@acme/nymbal-search-${i}`,
              provider: `acme-${i}`,
            }
            return defect === undefined ? entry : DEFECTS[defect]!(entry)
          })
          const lines: string[] = validateManifest(manifest(FIRST_PARTY, ...adapters), REPO)
          const faulty = plan.flatMap((d, i) => (d === undefined ? [] : [i]))

          expect(lines.length, lines.join('\n')).toBe(faulty.length)
          for (const [i] of plan.entries()) {
            const naming = lines.filter((l) => namesEntry(l, `@acme/nymbal-search-${i}`, i + 1))
            expect(naming.length, `entry ${i}: ${lines.join('\n')}`).toBe(
              faulty.includes(i) ? 1 : 0,
            )
          }
        },
      ),
      { numRuns: 100 },
    )
  })

  it('AC-2: readManifest throws an Error carrying every line validateManifest gives for the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-manifest-'))
    scratch.push(dir)
    const bad = manifest(
      FIRST_PARTY,
      { ...COMMUNITY, tier: 'gold' },
      { ...without(COMMUNITY, 'maintainer'), package: '@acme/other', provider: 'other' },
    )
    const file = join(dir, 'adapters.json')
    writeFileSync(file, JSON.stringify(bad))
    const lines: string[] = validateManifest(bad, REPO)

    let message = ''
    try {
      readManifest(file)
    } catch (err) {
      message = err instanceof Error ? err.message : `not an Error: ${String(err)}`
    }

    expect(lines).toHaveLength(2)
    expect(lines.filter((l) => message.includes(l))).toEqual(lines)
  })
})

/** The first-party adapters the workspace holds: one per packages/adapters/<slot folder>/<provider>. */
function workspaceAdapters(): Array<{
  package: string
  slot: string
  provider: string
  dir: string
}> {
  const root = join(REPO, 'packages', 'adapters')
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((slot) =>
      readdirSync(join(root, slot.name), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .flatMap((provider) => {
          const dir = `packages/adapters/${slot.name}/${provider.name}`
          let name: string
          try {
            name = (
              JSON.parse(readFileSync(join(REPO, dir, 'package.json'), 'utf8')) as { name: string }
            ).name
          } catch {
            return []
          }
          return [{ package: name, slot: slot.name, provider: provider.name, dir }]
        }),
    )
    .sort((a, b) => a.package.localeCompare(b.package))
}

describe('AC-3: the real manifest matches the repo', () => {
  const real = (): { adapters: Array<Entry & { source: { dir?: string } }> } =>
    JSON.parse(readFileSync(join(REPO, 'registry', 'adapters.json'), 'utf8'))

  it('AC-3: registry/adapters.json validates', () => {
    const lines: string[] = validateManifest(real(), REPO)
    expect(lines, lines.join('\n')).toEqual([])
  })

  it('AC-3: its first-party entries are exactly the workspace adapter packages, by name, slot folder, provider and directory', () => {
    const listed = real()
      .adapters.filter((e) => e['tier'] === 'first-party')
      .map((e) => ({
        package: e['package'],
        slot: e['slot'],
        provider: e['provider'],
        dir: e.source.dir,
      }))
      .sort((a, b) => String(a.package).localeCompare(String(b.package)))
    const workspace = workspaceAdapters()

    expect(listed).toEqual(workspace)
    expect(workspace).toHaveLength(13)
  })

  it("AC-3: its first-party entries are exactly ADAPTER_CATALOGUE's entries that are not built in", () => {
    const listed = real()
      .adapters.filter((e) => e['tier'] === 'first-party')
      .map((e) => `${String(e['slot'])}/${String(e['provider'])}`)
      .sort()
    const catalogue = (Object.keys(ADAPTER_CATALOGUE) as Slot[])
      .flatMap((slot) =>
        Object.entries(ADAPTER_CATALOGUE[slot])
          .filter(([, entry]) => entry.builtIn !== true)
          .map(([provider]) => `${slotFolder(slot)}/${provider}`),
      )
      .sort()

    expect(listed).toEqual(catalogue)
  })
})
