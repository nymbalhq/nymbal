import { describe, expect, it } from 'vitest'
import { workspaceMembers, type Manifest } from './workspace-manifests'

// Acceptance test for P0-05 AC-4: one Vitest major (3) across every workspace manifest. Two majors mean two
// runners with different semantics in one `pnpm test`. The `@vitest/*` runner packages (coverage, ui, browser)
// must match the runner's major; `@vitest/eslint-plugin` versions on its own line and is not counted.

const EXPECTED_MAJOR = 3
const SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

function isVitestPackage(name: string): boolean {
  return name === 'vitest' || (name.startsWith('@vitest/') && name !== '@vitest/eslint-plugin')
}

/** The major of the lowest version a range admits (`^3.2.4`, `~3.0.0`, `>=3.0.0`, `3.x`, `3`); null if none. */
function lowestMajor(range: string): number | null {
  const m = /(?:^|[\s|])(?:[\^~]|>=?|=)?\s*v?(\d+)(?:\.|$|\s)/.exec(range.trim())
  return m ? Number(m[1]) : null
}

interface Declaration {
  where: string
  range: string
  major: number | null
}

function declarations(dir: string, manifest: Manifest): Declaration[] {
  const found: Declaration[] = []
  for (const section of SECTIONS) {
    const deps = (manifest[section] ?? {}) as Record<string, string>
    for (const [name, range] of Object.entries(deps)) {
      if (!isVitestPackage(name)) continue
      found.push({
        where: `${dir || '.'}/package.json ${section}.${name}`,
        range,
        major: lowestMajor(range),
      })
    }
  }
  return found
}

describe('AC-4: one Vitest major across the workspace', () => {
  const all = workspaceMembers().flatMap((m) => declarations(m.dir, m.manifest))

  it('AC-4: every workspace manifest that declares vitest (or a @vitest/* runner package) asks for major 3', () => {
    // The range reader takes the lowest admitted major.
    expect(
      ['^3.2.4', '~3.0.0', '>=3.0.0', '3.x', '3', '^2.1.9 || ^3.0.0'].map(lowestMajor),
    ).toEqual([3, 3, 3, 3, 3, 2])
    // The root and at least the packages that run their own suites declare it.
    expect(all.length).toBeGreaterThanOrEqual(2)
    const offMajor = all
      .filter((d) => d.major !== EXPECTED_MAJOR)
      .map((d) => `${d.where}: "${d.range}"`)
    expect(offMajor).toEqual([])
    expect(new Set(all.map((d) => d.major)).size).toBe(1)
  })
})
