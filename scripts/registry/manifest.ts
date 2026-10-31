import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import {
  ADAPTER_CATALOGUE,
  conventionPackage,
  PROVIDER_NAME,
  slotFolder,
} from '../../packages/config/src/adapter-names'
import type { Slot } from '../../packages/types/src/adapters/adapter-base'
import { badgePath } from './site'

/** The repo this script is in, whose packages/adapters a first-party entry is checked against. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url))

export const TIERS = ['first-party', 'verified', 'community'] as const
export type Tier = (typeof TIERS)[number]

export type ManifestEntry = {
  package: string
  /** The kebab folder spelling: `document-store`. */
  slot: string
  provider: string
  tier: Tier
  maintainer?: string
  repository?: string
  /** A directory in this repo, packed; or a semver range on npm. Exactly one. */
  source: { dir: string } | { npm: string }
}

export type Manifest = { adapters: ManifestEntry[] }

const SLOT_BY_FOLDER = new Map<string, Slot>(
  (Object.keys(ADAPTER_CATALOGUE) as Slot[]).map((slot) => [slotFolder(slot), slot]),
)

/** An npm package name, scoped or not. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isHttps = (v: unknown): boolean => {
  if (typeof v !== 'string' || !v.startsWith('https://')) return false
  try {
    return new URL(v).protocol === 'https:'
  } catch {
    return false
  }
}

/** The problems with one entry, each a field and what is wrong with it. */
function entryProblems(e: Record<string, unknown>, root: string): string[] {
  const out: string[] = []
  const pkg = e['package']
  const slot = typeof e['slot'] === 'string' ? SLOT_BY_FOLDER.get(e['slot']) : undefined
  const provider = e['provider']
  const tier = e['tier']
  const source = e['source']

  if (typeof pkg !== 'string' || !PACKAGE_NAME.test(pkg))
    out.push('package: not an npm package name')
  if (slot === undefined) {
    out.push(`slot: must be one of ${[...SLOT_BY_FOLDER.keys()].join(', ')}`)
  }
  const providerOk = typeof provider === 'string' && PROVIDER_NAME.test(provider)
  if (!providerOk) out.push(`provider: must match ${String(PROVIDER_NAME)}`)

  const src = isRecord(source) ? source : {}
  const sourceKeys = (['dir', 'npm'] as const).filter((k) => src[k] !== undefined)
  const dir = typeof src['dir'] === 'string' ? src['dir'] : undefined
  if (sourceKeys.length !== 1) {
    out.push('source: must have exactly one of dir and npm')
  } else if (sourceKeys[0] === 'dir' ? dir === undefined || dir === '' : !validRange(src['npm'])) {
    out.push(sourceKeys[0] === 'dir' ? 'source.dir: not a path' : 'source.npm: not a semver range')
  }

  for (const field of ['maintainer', 'repository'] as const) {
    if (e[field] !== undefined && !isHttps(e[field])) out.push(`${field}: not an https: URL`)
  }

  if (tier === 'first-party') {
    if (slot !== undefined && providerOk) {
      const folder = slotFolder(slot)
      const want = conventionPackage(slot, provider)
      const wantDir = `packages/adapters/${folder}/${provider}`
      if (pkg !== want) out.push(`package: a first-party adapter is ${want}`)
      if (dir !== undefined && dir !== wantDir) {
        out.push(`source.dir: a first-party adapter lives in ${wantDir}`)
      }
      const manifestFile = join(root, wantDir, 'package.json')
      if (pkg === want && existsSync(manifestFile)) {
        const name = (JSON.parse(readFileSync(manifestFile, 'utf8')) as { name?: unknown }).name
        if (name !== want) out.push(`package: ${wantDir} holds ${String(name)}, not ${want}`)
      }
    }
  } else if (tier === 'verified' || tier === 'community') {
    if (typeof pkg === 'string' && pkg.startsWith('@nymbalhq/')) {
      out.push('package: the @nymbalhq/ scope is for first-party adapters')
    }
    if (e['maintainer'] === undefined) out.push('maintainer: a third-party adapter names one')
  } else {
    out.push(`tier: must be one of ${TIERS.join(', ')}`)
  }
  return out
}

function validRange(range: unknown): boolean {
  return typeof range === 'string' && range.trim() !== '' && semver.validRange(range) !== null
}

/**
 * Every problem with a registry manifest, one line each, naming the entry and the field. `root` is the repo, whose
 * `packages/adapters` a first-party entry is checked against. A `source.dir` that does not exist is not a problem
 * here: it fails that entry's install.
 */
export function validateManifest(value: unknown, root: string): string[] {
  if (!isRecord(value) || !Array.isArray(value['adapters'])) {
    return ['manifest: must be an object with an adapters array']
  }
  const lines: string[] = []
  const packages = new Set<string>()
  const badges = new Map<string, string>()
  value['adapters'].forEach((e: unknown, i) => {
    if (!isRecord(e)) {
      lines.push(`adapters[${i}]: not an object`)
      return
    }
    const pkg = e['package']
    const name = `adapters[${i}] (${typeof pkg === 'string' ? pkg : 'no package'})`
    for (const problem of entryProblems(e, root)) lines.push(`${name} ${problem}`)
    if (typeof pkg !== 'string') return
    if (packages.has(pkg)) {
      lines.push(`${name} package: listed twice`)
      return
    }
    packages.add(pkg)
    const badge = badgePath(pkg)
    const holder = badges.get(badge)
    if (holder !== undefined) lines.push(`${name} package: its badge ${badge} is also ${holder}'s`)
    else badges.set(badge, pkg)
  })
  return lines
}

/** The manifest at `path`, validated; throws an Error carrying every problem, one a line. */
export function readManifest(path: string): Manifest {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`)
  }
  const lines = validateManifest(value, REPO)
  if (lines.length > 0) throw new Error(lines.join('\n'))
  return value as Manifest
}
