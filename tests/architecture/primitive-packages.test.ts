// Reads: packages/adapters/document-store/**, packages/adapters/event-bus/**, packages/adapters/media/**
// Reads: packages/platform/package.json, packages/platform/src/**
// Reads: packages/create-app/scripts/sync-scaffold.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT as REPO_ROOT } from './adapter-table'
import type { Manifest } from './workspace-manifests'

// AC-6: the kernel's manifest holds no Redis SDK and links the primitive packages for its own tests; each package
// peers its own SDK and @nymbalhq/types, never names the kernel, and is left out of the scaffold's dependencies. No
// kernel source file imports ioredis.
// PUBLISHED_DIRS (workspace-names.test.ts) and GUARDED_PACKAGES (architecture-guard.test.ts) list them as well.
// @nymbalhq/media-s3 peers @aws-sdk/client-s3: the same rules hold for it, and the kernel's dependencies and source
// name no @aws-sdk/* package.

interface PackageManifest extends Manifest {
  optionalDependencies?: Record<string, string>
}

/** Each package, its directory and the SDK it peers. */
const PRIMITIVES = [
  {
    dir: 'packages/adapters/document-store/redis',
    name: '@nymbalhq/document-store-redis',
    sdk: 'ioredis',
  },
  {
    dir: 'packages/adapters/document-store/postgres-jsonb',
    name: '@nymbalhq/document-store-postgres-jsonb',
    sdk: 'pg',
  },
  {
    dir: 'packages/adapters/event-bus/redis-streams',
    name: '@nymbalhq/event-bus-redis-streams',
    sdk: 'ioredis',
  },
  { dir: 'packages/adapters/media/s3', name: '@nymbalhq/media-s3', sdk: '@aws-sdk/client-s3' },
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

/** A literal caret floor on the workspace types' major (`^M.m.p`), which publishes as written. */
const TYPES_FLOOR = new RegExp(
  `^\\^${read('packages/types').version?.split('.')[0] ?? 'none'}\\.\\d+\\.\\d+$`,
)

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
const isAwsSdk = (spec: string): boolean => spec.startsWith('@aws-sdk/')

describe('AC-6: primitive SDKs live in the primitive packages, never in the kernel', () => {
  it("AC-6: the kernel's dependencies hold no ioredis, and it links the primitive packages for its own tests at workspace:*", () => {
    const platform = read('packages/platform')

    expect(listed(platform, ['dependencies', 'optionalDependencies']).filter(isRedisSdk)).toEqual(
      [],
    )
    expect(NAMES.filter((n) => platform.devDependencies?.[n] !== 'workspace:*')).toEqual([])
  })

  for (const primitive of PRIMITIVES) {
    it(`AC-6: ${primitive.name} peers ${primitive.sdk} and @nymbalhq/types, and not the kernel`, () => {
      expect(existsSync(join(REPO_ROOT, primitive.dir, 'package.json')), primitive.dir).toBe(true)
      const m = read(primitive.dir)

      expect(m.name).toBe(primitive.name)
      expect(Object.keys(m.peerDependencies ?? {})).toContain(primitive.sdk)
      expect(m.peerDependencies?.['@nymbalhq/types']).toMatch(TYPES_FLOOR)
      expect(listed(m, DEPENDENCY_FIELDS).filter((n) => n === '@nymbalhq/platform')).toEqual([])
      // The SDK is the project's to install: a regular dependency would put it in every tree that has the package.
      expect(listed(m, ['dependencies', 'optionalDependencies'])).not.toContain(primitive.sdk)
    })
  }

  it('AC-6: none of the primitive packages is a scaffold dependency', async () => {
    // An untyped script module: imported through a variable, so it is loaded as it is, without declarations.
    const { NON_SCAFFOLD_PACKAGES } = (await import(SCAFFOLD_SCRIPT)) as {
      NON_SCAFFOLD_PACKAGES: ReadonlySet<string>
    }

    expect(NAMES.filter((n) => NON_SCAFFOLD_PACKAGES.has(n)).length).toBe(NAMES.length)
  })

  it("AC-2: the kernel's dependencies name no @aws-sdk/* package, and no file under packages/platform/src imports one", () => {
    const platform = read('packages/platform')
    expect(listed(platform, ['dependencies', 'optionalDependencies']).filter(isAwsSdk)).toEqual([])

    const root = join(REPO_ROOT, 'packages', 'platform', 'src')
    const files = sourceFiles(root)
    expect(files.length).toBeGreaterThan(0)
    const offenders = files.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter(isAwsSdk)
        .map((spec) => `${file.slice(root.length + 1)}: ${spec}`),
    )
    expect(offenders).toEqual([])
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
