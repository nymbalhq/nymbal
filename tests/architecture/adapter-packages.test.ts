import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, type Manifest } from './workspace-manifests'

// Acceptance tests for P2-01 AC-6: the kernel's manifest holds no provider SDK and peers the three adapter packages as
// optional; the stack lists no adapter package; each adapter package peers its own SDK, depends on @nymbalhq/types and
// never on the kernel, and versions with the fixed group; no kernel source file imports a provider SDK. Kills: an SDK
// creeping back into the kernel, an adapter package depending on the kernel (a cycle), and the stack pulling SDKs in.
// PUBLISHED_DIRS (workspace-names.test.ts) and GUARDED_PACKAGES (architecture-guard.test.ts) list the three as well.

interface PackageManifest extends Manifest {
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
}

/** Decision 3: each adapter package, its directory and the SDK range it peers. */
const ADAPTERS = [
  {
    dir: 'packages/adapter-stripe',
    name: '@nymbalhq/adapter-stripe',
    sdk: 'stripe',
    range: '^17.4.0',
  },
  {
    dir: 'packages/adapter-anthropic',
    name: '@nymbalhq/adapter-anthropic',
    sdk: '@anthropic-ai/sdk',
    range: '^0.39.0',
  },
  {
    dir: 'packages/adapter-smtp',
    name: '@nymbalhq/adapter-smtp',
    sdk: 'nodemailer',
    range: '^6.9.16',
  },
] as const

const SDKS: readonly string[] = ADAPTERS.map((a) => a.sdk)
const ADAPTER_NAMES: readonly string[] = ADAPTERS.map((a) => a.name)

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

function read(dir: string): PackageManifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, 'package.json'), 'utf8')) as PackageManifest
}

/** Every package name a manifest lists, in the fields given. */
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

const isSdk = (spec: string): boolean =>
  SDKS.some((sdk) => spec === sdk || spec.startsWith(`${sdk}/`))

describe('P2-01 AC-6: provider SDKs live in adapter packages, never in the kernel', () => {
  it("AC-6: neither the kernel's nor the stack's install pulls a provider SDK or an adapter package in", () => {
    const platform = read('packages/platform')
    const stack = read('packages/stack')

    expect(listed(platform, ['dependencies', 'optionalDependencies']).filter(isSdk)).toEqual([])
    expect(
      listed(stack, ['dependencies', 'peerDependencies', 'optionalDependencies']).filter(
        (n) => isSdk(n) || n.startsWith('@nymbalhq/adapter-'),
      ),
    ).toEqual([])
  })

  it('AC-6: the kernel peers the three adapter packages, each optional, and links them for the workspace', () => {
    const platform = read('packages/platform')
    const peers = Object.keys(platform.peerDependencies ?? {})
    const optional = Object.entries(platform.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta.optional === true)
      .map(([name]) => name)

    expect(ADAPTER_NAMES.filter((n) => !peers.includes(n))).toEqual([])
    expect(ADAPTER_NAMES.filter((n) => !optional.includes(n))).toEqual([])
    expect(ADAPTER_NAMES.filter((n) => platform.devDependencies?.[n] !== 'workspace:*')).toEqual([])
  })

  for (const adapter of ADAPTERS) {
    it(`AC-6: ${adapter.name} peers ${adapter.sdk} ${adapter.range}, depends on @nymbalhq/types and not on the kernel`, () => {
      expect(existsSync(join(REPO_ROOT, adapter.dir, 'package.json')), adapter.dir).toBe(true)
      const m = read(adapter.dir)

      expect(m.name).toBe(adapter.name)
      expect(m.peerDependencies?.[adapter.sdk]).toBe(adapter.range)
      expect(Object.keys(m.dependencies ?? {})).toContain('@nymbalhq/types')
      expect(listed(m, DEPENDENCY_FIELDS).filter((n) => n === '@nymbalhq/platform')).toEqual([])
      // The SDK is the project's to install: a regular dependency would put it in every tree that has the package.
      expect(listed(m, ['dependencies', 'optionalDependencies']).filter(isSdk)).toEqual([])
    })
  }

  it('AC-6: the three adapter packages version in the fixed group the kernel is in', () => {
    const changesets = JSON.parse(
      readFileSync(join(REPO_ROOT, '.changeset', 'config.json'), 'utf8'),
    ) as { fixed: string[][] }
    const group = changesets.fixed.find((g) => g.includes('@nymbalhq/platform')) ?? []

    expect(ADAPTER_NAMES.filter((n) => group.includes(n)).length).toBe(ADAPTER_NAMES.length)
  })

  it('AC-6: no file under packages/platform/src imports stripe, @anthropic-ai/sdk or nodemailer', () => {
    const root = join(REPO_ROOT, 'packages', 'platform', 'src')
    const files = sourceFiles(root)
    expect(files.length).toBeGreaterThan(0)

    const offenders = files.flatMap((file) =>
      specifiers(readFileSync(file, 'utf8'))
        .filter(isSdk)
        .map((spec) => `${file.slice(root.length + 1)}: ${spec}`),
    )
    expect(offenders).toEqual([])
  })
})
