// Reads: packages/adapters/**, packages/platform/package.json, packages/stack/package.json, packages/platform/src/**
// Reads: packages/config/src/adapter-names.ts, registry/adapters.json
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADAPTER_CATALOGUE, isCommerceSlot } from '../../packages/config/src/adapter-names'
import { FIRST_PARTY_ADAPTERS, ROOT as REPO_ROOT } from './adapter-table'
import type { Manifest } from './workspace-manifests'

// AC-6: the kernel's manifest holds no commerce provider SDK and links every first-party adapter package for its own
// tests; the stack lists no adapter package; each adapter package peers the SDK its catalogue entry names (one that
// talks HTTP itself peers nothing) and @nymbalhq/types, and never names the kernel; no kernel source file imports a
// commerce provider SDK. The adapters are the first-party ones registry/adapters.json lists; PUBLISHED_DIRS
// (workspace-names.test.ts) and GUARDED_PACKAGES (architecture-guard.test.ts) read the same list.

interface PackageManifest extends Manifest {
  optionalDependencies?: Record<string, string>
}

/** Each first-party adapter, with the SDK its catalogue entry says it peers (none for one that talks HTTP itself). */
const ADAPTERS = FIRST_PARTY_ADAPTERS.map((a) => ({
  ...a,
  sdk: (ADAPTER_CATALOGUE[a.slot] as (typeof ADAPTER_CATALOGUE)[typeof a.slot] | undefined)?.[
    a.provider
  ]?.sdk,
}))

/** The exact SDK range an adapter peers, where it is pinned, by package. */
const SDK_RANGES: Readonly<Record<string, string>> = {
  '@nymbalhq/payments-stripe': '^17.4.0',
  '@nymbalhq/ai-anthropic': '^0.39.0',
  '@nymbalhq/email-smtp': '^6.9.16',
  '@nymbalhq/email-mailgun': '^6.9.16',
  '@nymbalhq/email-resend': '^6.9.16',
  '@nymbalhq/email-ses': '^6.9.16',
}

/** The commerce adapters' SDKs, which no kernel or stack install may pull in (the kernel's own Postgres store peers pg). */
const SDKS: readonly string[] = [
  ...new Set(
    ADAPTERS.flatMap((a) => (isCommerceSlot(a.slot) && a.sdk !== undefined ? [a.sdk] : [])),
  ),
]
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

/** A literal caret floor on the workspace types' major (`^M.m.p`), which publishes as written. */
const TYPES_FLOOR = new RegExp(
  `^\\^${read('packages/types').version?.split('.')[0] ?? 'none'}\\.\\d+\\.\\d+$`,
)

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

describe('AC-6: provider SDKs live in adapter packages, never in the kernel', () => {
  it("AC-6: neither the kernel's nor the stack's install pulls a provider SDK or an adapter package in", () => {
    const platform = read('packages/platform')
    const stack = read('packages/stack')

    expect(listed(platform, ['dependencies', 'optionalDependencies']).filter(isSdk)).toEqual([])
    expect(
      listed(stack, ['dependencies', 'peerDependencies', 'optionalDependencies']).filter(
        (n) => isSdk(n) || ADAPTER_NAMES.includes(n),
      ),
    ).toEqual([])
  })

  it('AC-6: the kernel links every first-party adapter package for its own tests, as devDependencies at workspace:*', () => {
    const platform = read('packages/platform')

    expect(ADAPTER_NAMES.filter((n) => platform.devDependencies?.[n] !== 'workspace:*')).toEqual([])
  })

  for (const { sdk, ...adapter } of ADAPTERS.flatMap((a) =>
    a.sdk === undefined ? [] : [{ ...a, sdk: a.sdk }],
  )) {
    it(`AC-6: ${adapter.name} peers ${sdk}, its catalogue SDK, and @nymbalhq/types, and not the kernel`, () => {
      expect(existsSync(join(REPO_ROOT, adapter.dir, 'package.json')), adapter.dir).toBe(true)
      const m = read(adapter.dir)

      expect(m.name).toBe(adapter.name)
      expect(
        Object.keys(m.peerDependencies ?? {}).filter((n) => !n.startsWith('@nymbalhq/')),
      ).toEqual([sdk])
      expect(m.peerDependencies?.['@nymbalhq/types']).toMatch(TYPES_FLOOR)
      expect(listed(m, DEPENDENCY_FIELDS).filter((n) => n === '@nymbalhq/platform')).toEqual([])
      // The SDK is the project's to install: a regular dependency would put it in every tree that has the package.
      expect(
        listed(m, ['dependencies', 'optionalDependencies']).filter(
          (n) => n === sdk || n.startsWith(`${sdk}/`) || isSdk(n),
        ),
      ).toEqual([])
    })
  }

  for (const [name, range] of Object.entries(SDK_RANGES)) {
    it(`AC-6: ${name} peers its catalogue SDK at ${range}`, () => {
      const adapter = ADAPTERS.find((a) => a.name === name)
      const m = adapter === undefined ? undefined : read(adapter.dir)

      expect(adapter?.sdk === undefined ? undefined : m?.peerDependencies?.[adapter.sdk]).toBe(
        range,
      )
    })
  }

  for (const adapter of ADAPTERS.filter((a) => a.sdk === undefined)) {
    it(`AC-6: ${adapter.name} peers @nymbalhq/types alone, not the kernel, and lists no provider SDK`, () => {
      expect(existsSync(join(REPO_ROOT, adapter.dir, 'package.json')), adapter.dir).toBe(true)
      const m = read(adapter.dir)

      expect(m.name).toBe(adapter.name)
      expect(m.peerDependencies).toEqual({ '@nymbalhq/types': expect.stringMatching(TYPES_FLOOR) })
      expect(listed(m, DEPENDENCY_FIELDS).filter((n) => n === '@nymbalhq/platform')).toEqual([])
      expect(listed(m, ['dependencies', 'optionalDependencies']).filter(isSdk)).toEqual([])
    })
  }

  it('AC-6: no file under packages/platform/src imports the SDK of a commerce adapter', () => {
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

// AC-10: @nymbalhq/security-cloudflare publishes as the adapter packages do: `dist` and `recipes` in `files` and
// `./recipes/*` exported, peering @nymbalhq/types and never naming the kernel, with no Cloudflare SDK anywhere (it
// talks to the API with fetch), and linked by the kernel for its own tests as the adapter packages are.

const SECURITY = {
  dir: 'packages/adapters/security/cloudflare',
  name: '@nymbalhq/security-cloudflare',
}

describe('AC-10: @nymbalhq/security-cloudflare publishes like the adapter packages', () => {
  it('AC-10: its files hold dist and recipes, and it exports ./recipes/*', () => {
    expect(existsSync(join(REPO_ROOT, SECURITY.dir, 'package.json')), SECURITY.dir).toBe(true)
    const m = read(SECURITY.dir) as PackageManifest & { exports?: Record<string, unknown> }
    const files = (Array.isArray(m.files) ? (m.files as string[]) : []).map((f) =>
      f.replace(/^\.\//, '').replace(/\/$/, ''),
    )

    expect(m.name).toBe(SECURITY.name)
    expect(['dist', 'recipes'].filter((f) => !files.includes(f))).toEqual([])
    expect(m.exports?.['./recipes/*']).toBe('./recipes/*')
  })

  it('AC-10: it peers @nymbalhq/types and nothing else, never names the kernel, and lists no Cloudflare SDK', () => {
    expect(existsSync(join(REPO_ROOT, SECURITY.dir, 'package.json')), SECURITY.dir).toBe(true)
    const m = read(SECURITY.dir)

    expect(m.peerDependencies).toEqual({ '@nymbalhq/types': expect.stringMatching(TYPES_FLOOR) })
    expect(listed(m, DEPENDENCY_FIELDS).filter((n) => n === '@nymbalhq/platform')).toEqual([])
    expect(
      listed(m, DEPENDENCY_FIELDS).filter((n) => n === 'cloudflare' || n.startsWith('cloudflare/')),
    ).toEqual([])
  })

  it('AC-10: the kernel links it for its own tests as it does the adapter packages', () => {
    const platform = read('packages/platform')

    expect(platform.devDependencies?.[SECURITY.name]).toBe(
      platform.devDependencies?.['@nymbalhq/payments-stripe'],
    )
    expect(platform.devDependencies?.[SECURITY.name]).toBe('workspace:*')
  })
})
