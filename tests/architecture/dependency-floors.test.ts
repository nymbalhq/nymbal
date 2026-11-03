// Reads: pnpm-workspace.yaml, **/package.json, pnpm-lock.yaml
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import semver from 'semver'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, workspaceMembers, type Manifest } from './workspace-manifests'

// AC-1: the HTTP stack and the data libraries stay at or above the release that fixed their published advisories.
// Each floor is the newest security release of its line. A range that admits an older version, or a lockfile that
// installs one, takes a known vulnerability back into every store.

const FLOORS: Readonly<Record<string, string>> = {
  fastify: '5.12.6',
  '@fastify/http-proxy': '11.6.5',
  '@fastify/reply-from': '12.8.0',
  '@fastify/cookie': '11.0.0',
  '@fastify/cors': '11.3.1',
  'drizzle-orm': '0.45.2',
  zod: '4.6.6',
}

/** Not declared by any manifest: the proxy brings it, so its floor is checked where the proxy resolves it. */
const TRANSITIVE: Readonly<Record<string, string>> = {
  '@fastify/reply-from': '@fastify/http-proxy',
}

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

interface Declaration {
  dir: string
  pkg: string
  range: string
}

function declarations(dir: string, manifest: Manifest): Declaration[] {
  const found: Declaration[] = []
  for (const section of SECTIONS) {
    const deps = (manifest[section] ?? {}) as Record<string, string>
    for (const [pkg, range] of Object.entries(deps)) {
      if (pkg in FLOORS) found.push({ dir, pkg, range })
    }
  }
  return found
}

/**
 * The installed copy of `pkg` as Node resolves it from `fromDir`: its main entry, then up to the nearest package.json
 * named `pkg` (drizzle-orm's `exports` has no `./package.json`).
 */
function installed(pkg: string, fromDir: string): { dir: string; version: string } {
  let dir = dirname(createRequire(join(fromDir, 'package.json')).resolve(pkg))
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
      if (manifest.name === pkg && typeof manifest.version === 'string') {
        return { dir, version: manifest.version }
      }
    } catch {
      // no package.json at this level
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`no package.json named ${pkg} above its entry`)
    dir = parent
  }
}

const below = (version: string | null, floor: string): boolean =>
  version === null || semver.lt(version, floor)

describe('AC-1: every floored dependency is at or above its security floor', () => {
  const all = workspaceMembers().flatMap((m) => declarations(m.dir, m.manifest))

  it('AC-1: every workspace manifest declaring fastify, @fastify/http-proxy, @fastify/cookie, @fastify/cors, drizzle-orm or zod admits no version below its floor', () => {
    const declared = new Set(all.map((d) => d.pkg))
    expect([...declared].sort()).toEqual(
      Object.keys(FLOORS)
        .filter((p) => !(p in TRANSITIVE))
        .sort(),
    )
    const admitsOlder = all
      .filter((d) => {
        const lowest = semver.validRange(d.range) ? semver.minVersion(d.range) : null
        return below(lowest?.version ?? null, FLOORS[d.pkg]!)
      })
      .map((d) => `${d.dir || '.'}/package.json ${d.pkg} "${d.range}" < ${FLOORS[d.pkg]}`)
    expect(admitsOlder).toEqual([])
  })

  it('AC-1: the copy installed for each declaring package, and the reply-from its http-proxy resolves, is at or above the floor', () => {
    const offFloor: string[] = []
    const seen = new Set<string>()
    for (const d of all) {
      const from = join(REPO_ROOT, d.dir)
      const copy = installed(d.pkg, from)
      seen.add(d.pkg)
      if (below(copy.version, FLOORS[d.pkg]!)) {
        offFloor.push(`${d.dir || '.'}: ${d.pkg}@${copy.version} < ${FLOORS[d.pkg]}`)
      }
      for (const [dep, via] of Object.entries(TRANSITIVE)) {
        if (via !== d.pkg) continue
        const inner = installed(dep, copy.dir)
        seen.add(dep)
        if (below(inner.version, FLOORS[dep]!)) {
          offFloor.push(`${d.dir || '.'}: ${via} -> ${dep}@${inner.version} < ${FLOORS[dep]}`)
        }
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(FLOORS).sort())
    expect(offFloor).toEqual([])
  })
})
