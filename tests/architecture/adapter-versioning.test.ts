// Reads: .changeset/config.json, package.json, packages/platform/package.json, packages/adapters/*/*/package.json
// Reads: packages/adapters/*/*/CHANGELOG.md
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADAPTER_NAMES, FIRST_PARTY_ADAPTERS, ROOT } from './adapter-table'
import type { Manifest } from './workspace-manifests'

// AC-4: each first-party adapter peers @nymbalhq/types at a literal caret floor (`^M.m.p`, never `workspace:^`, which
// would publish as the types version of the day and raise the floor on every adapter release) and builds against it
// as a devDependency, never a dependency, so a store holds one copy of it; an adapter it depends on is
// `workspace:^`, so that adapter's release does not republish it. The changesets `fixed` group is the core and
// contract-tests alone. A moved adapter's CHANGELOG heads with its current name. AC-5: the platform peers no adapter
// (a store installs the ones it needs by name), and the repository root lists every one so the workspace's servers,
// walks and tests resolve them from the root.

interface PackageManifest extends Manifest {
  peerDependenciesMeta?: Record<string, unknown>
}

/** The core packages that version as one, and the suites that certify against the kernel they ship with. */
const FIXED_GROUP = [
  '@nymbalhq/stack',
  'nymbal',
  '@nymbalhq/config',
  '@nymbalhq/platform',
  '@nymbalhq/sdk',
  '@nymbalhq/types',
  '@nymbalhq/web-components',
  '@nymbalhq/http',
  '@nymbalhq/react',
  '@nymbalhq/admin',
  '@nymbalhq/contract-tests',
]

/** The adapters that depend on another adapter: the email providers that send through smtp. */
const ADAPTER_DEPENDENTS = [
  '@nymbalhq/email-mailgun',
  '@nymbalhq/email-resend',
  '@nymbalhq/email-ses',
]

const read = (dir: string): PackageManifest =>
  JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as PackageManifest

const TYPES = '@nymbalhq/types'

/** The workspace types' major: a floor on another major would refuse every kernel the workspace ships. */
const TYPES_MAJOR = Number(read('packages/types').version?.split('.')[0])
const LITERAL_FLOOR = /^\^(\d+)\.\d+\.\d+$/

describe('AC-4: the adapters peer @nymbalhq/types and version outside the fixed group', () => {
  it("AC-4: each of the thirteen first-party adapters peers @nymbalhq/types at a literal caret floor on the workspace types' major, has it in devDependencies at workspace:* and not in dependencies", () => {
    const manifests = FIRST_PARTY_ADAPTERS.map((a) => ({ name: a.name, m: read(a.dir) }))
    expect(TYPES_MAJOR).toBeGreaterThanOrEqual(1)
    const wrong = manifests.flatMap(({ name, m }) => [
      ...(Number(LITERAL_FLOOR.exec(m.peerDependencies?.[TYPES] ?? '')?.[1]) === TYPES_MAJOR
        ? []
        : [`${name}: peerDependencies ${TYPES} is ${m.peerDependencies?.[TYPES]}`]),
      ...(m.devDependencies?.[TYPES] === 'workspace:*'
        ? []
        : [`${name}: devDependencies ${TYPES} is ${m.devDependencies?.[TYPES]}`]),
      ...(m.dependencies?.[TYPES] === undefined
        ? []
        : [`${name}: dependencies ${TYPES} is ${m.dependencies[TYPES]}`]),
    ])

    expect(wrong).toEqual([])
    expect(manifests.map((x) => x.m.name)).toEqual(manifests.map((x) => x.name))
  })

  it('AC-4: every adapter one adapter depends on is at workspace:^, mailgun, resend and ses on smtp among them', () => {
    const edges = FIRST_PARTY_ADAPTERS.flatMap((a) =>
      Object.entries(read(a.dir).dependencies ?? {})
        .filter(([dep]) => ADAPTER_NAMES.includes(dep))
        .map(([dep, range]) => ({ from: a.name, dep, range })),
    )

    expect(edges.filter((e) => e.range !== 'workspace:^')).toEqual([])
    expect(
      ADAPTER_DEPENDENTS.filter(
        (name) => !edges.some((e) => e.from === name && e.dep === '@nymbalhq/email-smtp'),
      ),
    ).toEqual([])
  })

  it('AC-4: the changesets fixed group is exactly the core and @nymbalhq/contract-tests, one group, with no adapter in it', () => {
    const config = JSON.parse(readFileSync(join(ROOT, '.changeset', 'config.json'), 'utf8')) as {
      fixed: string[][]
    }

    expect(config.fixed.flat().filter((n) => ADAPTER_NAMES.includes(n))).toEqual([])
    expect(config.fixed).toHaveLength(1)
    expect([...(config.fixed[0] ?? [])].sort()).toEqual([...FIXED_GROUP].sort())
  })

  it('AC-4: each adapter that has a CHANGELOG heads it with `# <its package name>`', () => {
    const logs = FIRST_PARTY_ADAPTERS.filter((a) => existsSync(join(ROOT, a.dir, 'CHANGELOG.md')))
    const headers = logs.map((a) => ({
      name: a.name,
      first: readFileSync(join(ROOT, a.dir, 'CHANGELOG.md'), 'utf8').split('\n')[0],
    }))

    expect(headers.filter((h) => h.first !== `# ${h.name}`)).toEqual([])
  })
})

describe('AC-5: the platform names no adapter it does not need', () => {
  it('AC-5: packages/platform/package.json has no adapter in peerDependencies or peerDependenciesMeta', () => {
    const platform = read('packages/platform')
    const named = [
      ...Object.keys(platform.peerDependencies ?? {}),
      ...Object.keys(platform.peerDependenciesMeta ?? {}),
    ]

    expect(named.filter((n) => ADAPTER_NAMES.includes(n))).toEqual([])
  })

  it('AC-5: the root package.json lists each first-party adapter in devDependencies at workspace:*', () => {
    const root = read('')

    expect(ADAPTER_NAMES.filter((n) => root.devDependencies?.[n] !== 'workspace:*')).toEqual([])
  })
})
