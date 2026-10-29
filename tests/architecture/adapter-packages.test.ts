// Reads: packages/adapters/**, packages/platform/package.json, packages/stack/package.json, packages/platform/src/**
// Reads: .changeset/config.json
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT as REPO_ROOT } from './adapter-table'
import type { Manifest } from './workspace-manifests'

// AC-6: the kernel's manifest holds no provider SDK and peers the seven adapter packages as optional; the stack lists
// no adapter package; each adapter package peers its own SDK (one that talks HTTP itself peers nothing), depends on
// @nymbalhq/types and never on the kernel, and versions with the fixed group; no kernel source file imports a provider
// SDK. PUBLISHED_DIRS (workspace-names.test.ts) and GUARDED_PACKAGES (architecture-guard.test.ts) list the seven as
// well.

interface PackageManifest extends Manifest {
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  optionalDependencies?: Record<string, string>
}

/** Each adapter package, its directory and the SDK range it peers. */
const ADAPTERS = [
  {
    dir: 'packages/adapters/payments/stripe',
    name: '@nymbalhq/payments-stripe',
    sdk: 'stripe',
    range: '^17.4.0',
  },
  {
    dir: 'packages/adapters/ai/anthropic',
    name: '@nymbalhq/ai-anthropic',
    sdk: '@anthropic-ai/sdk',
    range: '^0.39.0',
  },
  {
    dir: 'packages/adapters/email/smtp',
    name: '@nymbalhq/email-smtp',
    sdk: 'nodemailer',
    range: '^6.9.16',
  },
  {
    dir: 'packages/adapters/email/mailgun',
    name: '@nymbalhq/email-mailgun',
    sdk: 'nodemailer',
    range: '^6.9.16',
  },
  {
    dir: 'packages/adapters/email/resend',
    name: '@nymbalhq/email-resend',
    sdk: 'nodemailer',
    range: '^6.9.16',
  },
  {
    dir: 'packages/adapters/email/ses',
    name: '@nymbalhq/email-ses',
    sdk: 'nodemailer',
    range: '^6.9.16',
  },
] as const

/** Each adapter package that peers no SDK: it only verifies and maps a provider's webhooks. */
const SDK_FREE_ADAPTERS = [
  { dir: 'packages/adapters/shipping/easypost', name: '@nymbalhq/shipping-easypost' },
] as const

const SDKS: readonly string[] = ADAPTERS.map((a) => a.sdk)
const ADAPTER_NAMES: readonly string[] = [
  ...ADAPTERS.map((a) => a.name),
  ...SDK_FREE_ADAPTERS.map((a) => a.name),
]

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

  it('AC-6: the kernel peers the seven adapter packages, each optional, and links them for the workspace', () => {
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

  for (const adapter of SDK_FREE_ADAPTERS) {
    it(`AC-6: ${adapter.name} peers nothing, depends on @nymbalhq/types and not on the kernel, and lists no provider SDK`, () => {
      expect(existsSync(join(REPO_ROOT, adapter.dir, 'package.json')), adapter.dir).toBe(true)
      const m = read(adapter.dir)

      expect(m.name).toBe(adapter.name)
      expect(Object.keys(m.peerDependencies ?? {})).toEqual([])
      expect(Object.keys(m.dependencies ?? {})).toContain('@nymbalhq/types')
      expect(listed(m, DEPENDENCY_FIELDS).filter((n) => n === '@nymbalhq/platform')).toEqual([])
      expect(listed(m, ['dependencies', 'optionalDependencies']).filter(isSdk)).toEqual([])
    })
  }

  it('AC-6: the seven adapter packages version in the fixed group the kernel is in', () => {
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

// AC-10: @nymbalhq/security-cloudflare publishes as the adapter packages do: in the changesets fixed group at the
// kernel's version, `dist` and `recipes` in `files` and `./recipes/*` exported, depending on @nymbalhq/types and never
// on the kernel, with no Cloudflare SDK anywhere (it talks to the API with fetch), and peered by the kernel as
// optional and linked for the workspace, so the kernel's loader resolves it.

const SECURITY = {
  dir: 'packages/adapters/security/cloudflare',
  name: '@nymbalhq/security-cloudflare',
}

describe('AC-10: @nymbalhq/security-cloudflare publishes like the adapter packages', () => {
  it("AC-10: it is in the fixed group the kernel is in, at the kernel's version", () => {
    const changesets = JSON.parse(
      readFileSync(join(REPO_ROOT, '.changeset', 'config.json'), 'utf8'),
    ) as { fixed: string[][] }
    const group = changesets.fixed.find((g) => g.includes('@nymbalhq/platform')) ?? []

    expect(group).toContain(SECURITY.name)
    expect(existsSync(join(REPO_ROOT, SECURITY.dir, 'package.json')), SECURITY.dir).toBe(true)
    expect(read(SECURITY.dir).version).toBe(read('packages/platform').version)
  })

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

  it('AC-10: it depends on @nymbalhq/types, never on the kernel, and lists no Cloudflare SDK and no peer', () => {
    expect(existsSync(join(REPO_ROOT, SECURITY.dir, 'package.json')), SECURITY.dir).toBe(true)
    const m = read(SECURITY.dir)

    expect(Object.keys(m.dependencies ?? {})).toContain('@nymbalhq/types')
    expect(listed(m, DEPENDENCY_FIELDS).filter((n) => n === '@nymbalhq/platform')).toEqual([])
    expect(
      listed(m, DEPENDENCY_FIELDS).filter((n) => n === 'cloudflare' || n.startsWith('cloudflare/')),
    ).toEqual([])
    expect(Object.keys(m.peerDependencies ?? {})).toEqual([])
  })

  it('AC-10: the kernel peers it as optional and links it for the workspace, as it does the adapter packages', () => {
    const platform = read('packages/platform')

    expect(platform.peerDependencies?.[SECURITY.name]).toBe(
      platform.peerDependencies?.['@nymbalhq/payments-stripe'],
    )
    expect(platform.peerDependenciesMeta?.[SECURITY.name]?.optional).toBe(true)
    expect(platform.devDependencies?.[SECURITY.name]).toBe('workspace:*')
  })
})
