import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, type Manifest } from './workspace-manifests'

// Acceptance tests for P2-02 AC-6 (spec P2-02-primitives-are-protocols): the kernel's manifest holds no Redis SDK and
// peers the three primitive packages as optional (`workspace:^`); each package peers its own SDK, depends on
// @nymbalhq/types and never on the kernel, starts at the fixed group's version, versions with that group and is left
// out of the scaffold's dependencies. No kernel source file imports ioredis. PUBLISHED_DIRS (workspace-names.test.ts)
// and GUARDED_PACKAGES (architecture-guard.test.ts) list the three as well. Kills: a primitive SDK entering the
// kernel's install, a package depending on the kernel (a cycle), and a package outside the release group.

interface PackageManifest extends Manifest {
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
}

/** Decision 8: each package, its directory and the SDK it peers (decision 2). */
const PRIMITIVES = [
  { dir: 'packages/doc-store-redis', name: '@nymbalhq/doc-store-redis', sdk: 'ioredis' },
  {
    dir: 'packages/doc-store-postgres-jsonb',
    name: '@nymbalhq/doc-store-postgres-jsonb',
    sdk: 'pg',
  },
  {
    dir: 'packages/event-bus-redis-streams',
    name: '@nymbalhq/event-bus-redis-streams',
    sdk: 'ioredis',
  },
] as const

const NAMES: readonly string[] = PRIMITIVES.map((p) => p.name)

const SCAFFOLD_SCRIPT: string = join(REPO_ROOT, 'packages/create-app/scripts/sync-scaffold.mjs')

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

function read(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as PackageManifest
}

function listed(
  m: PackageManifest,
  fields: readonly (typeof DEPENDENCY_FIELDS)[number][],
): string[] {
  return fields.flatMap((f) => Object.keys(m[f] ?? {}))
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.[cm]?[jt]sx?$/.test(entry)) out.push(full)
  }
  return out
}

/** Module specifiers a file imports: static and type imports, re-exports, dynamic import() and require(). */
function specifiers(source: string): string[] {
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  return patterns.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]!))
}

const isRedisSdk = (spec: string): boolean => spec === 'ioredis' || spec.startsWith('ioredis/')

describe('P2-02 AC-6: primitive SDKs live in the primitive packages, never in the kernel', () => {
  it("AC-6: the kernel's dependencies hold no ioredis, and it peers the three packages, each optional, at workspace:^", () => {
    const platform = read('packages/platform')
    const optional = Object.entries(platform.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name)

    expect(listed(platform, ['dependencies', 'optionalDependencies']).filter(isRedisSdk)).toEqual(
      [],
    )
    expect(NAMES.filter((n) => platform.peerDependencies?.[n] !== 'workspace:^')).toEqual([])
    expect(NAMES.filter((n) => !optional.includes(n))).toEqual([])
  })

  for (const primitive of PRIMITIVES) {
    it(`AC-6: ${primitive.name} peers ${primitive.sdk}, depends on @nymbalhq/types and not on the kernel, at the kernel’s version`, () => {
      expect(existsSync(join(REPO_ROOT, primitive.dir, 'package.json')), primitive.dir).toBe(true)
      const m = read(primitive.dir)

      expect(m.name).toBe(primitive.name)
      expect(Object.keys(m.peerDependencies ?? {})).toContain(primitive.sdk)
      expect(Object.keys(m.dependencies ?? {})).toContain('@nymbalhq/types')
      expect(listed(m, DEPENDENCY_FIELDS).filter((n) => n === '@nymbalhq/platform')).toEqual([])
      // The SDK is the project's to install: a regular dependency would put it in every tree that has the package.
      expect(listed(m, ['dependencies', 'optionalDependencies'])).not.toContain(primitive.sdk)
      // Decision 8: it starts at the group's current version, so the kernel's workspace:^ peer on it is in range.
      expect(m.version).toBe(read('packages/platform').version)
    })
  }

  it('AC-6: the three packages version in the fixed group the kernel is in, and none is a scaffold dependency', async () => {
    // An untyped script module: imported through a variable, so it is loaded as it is, without declarations.
    const { NON_SCAFFOLD_PACKAGES } = (await import(SCAFFOLD_SCRIPT)) as {
      NON_SCAFFOLD_PACKAGES: ReadonlySet<string>
    }
    const changesets = JSON.parse(
      readFileSync(join(REPO_ROOT, '.changeset', 'config.json'), 'utf8'),
    ) as { fixed: string[][] }
    const group = changesets.fixed.find((g) => g.includes('@nymbalhq/platform')) ?? []

    expect(NAMES.filter((n) => group.includes(n)).length).toBe(NAMES.length)
    expect(NAMES.filter((n) => NON_SCAFFOLD_PACKAGES.has(n)).length).toBe(NAMES.length)
  })

  it('AC-6: no file under packages/platform/src imports ioredis', () => {
    const root = join(REPO_ROOT, 'packages', 'platform', 'src')
    const files = sourceFiles(root)
    expect(files.length).toBeGreaterThan(0)

    const offenders = files.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter(isRedisSdk)
        .map((spec) => `${file.slice(root.length + 1)}: ${spec}`),
    )
    expect(offenders).toEqual([])
  })
})
