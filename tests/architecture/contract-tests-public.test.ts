import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT, type Manifest } from './workspace-manifests'

// P2-13 AC-1 (spec P2-13-contract-tests-public, decision 1): @nymbalhq/contract-tests is publishable and versions with
// the group. Its manifest is not private, has publishConfig (public) and repository, depends on fast-check (the moved
// property suites need it at runtime) and peers vitest without depending on it; it is in the changesets fixed group
// the kernel is in, at the kernel's version. `npm pack` holds dist/index.js and its declarations, and that build
// exports `contractSuites` with a suite for every kind that has a contract (the eight commerce slots, documentStore,
// eventBus, media) and the search oracle the runners use. PUBLISHED_DIRS (workspace-names.test.ts) lists it too.
// Needs `pnpm build`. Kills: a package that stays private or outside the group, a tarball without the suites or the
// oracle, a suite missing for a kind the CLI looks up, and vitest bundled as a dependency (two vitests in a project).

const DIR = join(REPO_ROOT, 'packages', 'contract-tests')
const read = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest

/** Decision 3: ContractKind = Slot, and every kind with a contract today has a suite. */
const KINDS = [
  'payments',
  'email',
  'reviews',
  'search',
  'analytics',
  'shipping',
  'tax',
  'ai',
  'documentStore',
  'eventBus',
  'media',
] as const
const ORACLE = ['searchTerms', 'matchesQuery', 'toSearchDocument'] as const

describe('P2-13 AC-1: @nymbalhq/contract-tests publishes with the group', () => {
  it('AC-1: the manifest is public, with publishConfig access public and a repository; fast-check is a dependency and vitest only a peer', () => {
    const m = read(DIR)

    expect(m.name).toBe('@nymbalhq/contract-tests')
    expect(m.private).not.toBe(true)
    expect(m.publishConfig?.access).toBe('public')
    const platform = read(join(REPO_ROOT, 'packages', 'platform')).repository as { url?: string }
    expect(m.repository).toEqual({
      type: 'git',
      url: platform.url,
      directory: 'packages/contract-tests',
    })
    expect(Object.keys(m.dependencies ?? {})).toContain('fast-check')
    expect(Object.keys(m.peerDependencies ?? {})).toContain('vitest')
    expect(Object.keys(m.dependencies ?? {})).not.toContain('vitest')
  })

  it("AC-1: it is in the changesets fixed group the kernel is in, at the kernel's version", () => {
    const changesets = JSON.parse(
      readFileSync(join(REPO_ROOT, '.changeset', 'config.json'), 'utf8'),
    ) as { fixed: string[][] }
    const group = changesets.fixed.find((g) => g.includes('@nymbalhq/platform')) ?? []

    expect(group).toContain('@nymbalhq/contract-tests')
    expect(read(DIR).version).toBe(read(join(REPO_ROOT, 'packages', 'platform')).version)
  })

  it('AC-1: npm pack holds dist/index.js and its declarations, which export contractSuites for every kind and the search oracle', async () => {
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    ) as Array<{ files: Array<{ path: string }> }>
    const files = packed[0]?.files.map((f) => f.path) ?? []
    const built = (await import(pathToFileURL(join(DIR, 'dist', 'index.js')).href)) as Record<
      string,
      unknown
    >
    const suites = (built['contractSuites'] ?? {}) as Record<string, unknown>
    const declarations = readFileSync(join(DIR, 'dist', 'index.d.ts'), 'utf8')

    expect(files).toEqual(expect.arrayContaining(['dist/index.js', 'dist/index.d.ts']))
    expect(KINDS.filter((kind) => typeof suites[kind] !== 'function')).toEqual([])
    expect(ORACLE.filter((name) => typeof built[name] !== 'function')).toEqual([])
    expect(
      ['contractSuites', 'ContractOptions', 'ContractProduct', ...ORACLE].filter(
        (name) => !new RegExp(`\\b${name}\\b`).test(declarations),
      ),
    ).toEqual([])
    // The oracle the package exports is the runners' one: a product matches a query made of its own name's terms.
    const product = {
      id: 'p2-13',
      name: 'Merino Crew-Neck',
      description: 'warm',
      variants: [],
      categoryIds: [],
    }
    const terms = (built['searchTerms'] as (t: string) => string[])(product.name)
    expect(
      (built['matchesQuery'] as (p: unknown, q: string) => boolean)(product, terms.join(' ')),
    ).toBe(terms.length > 0)
  }, 30_000)
})
