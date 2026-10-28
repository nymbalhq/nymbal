// Reads: pnpm-workspace.yaml, **/package.json
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  NEW_SCOPE,
  REPO_ROOT,
  isPublished,
  workspaceMembers,
  type Manifest,
} from './workspace-manifests'

// AC-2: workspace names are unique; each is @nymbalhq/<x>, `nymbal` (the CLI), `create-nymbal-app` or a private name;
// every published manifest carries publishConfig.access "public", `files` and `repository`; every private one stays
// private; the root is private and does not take the CLI's name.

const members = workspaceMembers()
const root = members.find((m) => m.dir === '')
const published = members.filter((m) => m.dir !== '' && isPublished(m.manifest))

/**
 * The twenty-one published packages, by directory (names are what is under test).
 */
const PUBLISHED_DIRS = [
  'apps/admin',
  'packages/adapter-anthropic',
  'packages/adapter-smtp',
  'packages/adapter-stripe',
  'packages/cli',
  'packages/config',
  'packages/contract-tests',
  'packages/create-app',
  'packages/doc-store-postgres-jsonb',
  'packages/doc-store-redis',
  'packages/event-bus-redis-streams',
  'packages/http',
  'packages/importers',
  'packages/media-s3',
  'packages/platform',
  'packages/react',
  'packages/sdk',
  'packages/security-cloudflare',
  'packages/stack',
  'packages/types',
  'packages/web-components',
]

const SCOPED_NAME = new RegExp(`^${NEW_SCOPE.replace('/', '\\/')}[a-z0-9][a-z0-9-]*$`)
const UNSCOPED_PUBLISHED = new Set(['nymbal', 'create-nymbal-app'])

/** owner/repo from a git or npm repository URL. */
function ownerRepo(url: string): string {
  return url
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^(ssh|git):\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\/$/, '')
    .toLowerCase()
}

function repositoryUrl(m: Manifest): string | undefined {
  const r = m.repository
  if (typeof r === 'string') return r
  if (r && typeof r === 'object' && typeof (r as { url?: unknown }).url === 'string') {
    return (r as { url: string }).url
  }
  return undefined
}

describe('AC-2: workspace package names and published manifests', () => {
  it('AC-2: names are unique; each published one is @nymbalhq/<x>, nymbal or create-nymbal-app; only the twenty-one publish', () => {
    // Discovery guard: every published package directory is a workspace member.
    const dirs = new Set(members.map((m) => m.dir))
    expect.soft(root).toBeDefined()
    expect.soft(PUBLISHED_DIRS.filter((d) => !dirs.has(d))).toEqual([])

    const names = members.map((m) => m.manifest.name)
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i)
    expect
      .soft(new Set(names).size, `duplicate names: ${duplicates.join(', ')}`)
      .toBe(members.length)

    // Leak guard: a private member that loses `private: true` publishes.
    expect.soft(published.map((m) => m.dir).sort()).toEqual([...PUBLISHED_DIRS].sort())

    const wrong = published
      .filter(({ manifest }) => {
        const name = String(manifest.name)
        return !(SCOPED_NAME.test(name) || UNSCOPED_PUBLISHED.has(name))
      })
      .map(({ dir, manifest }) => `${dir}: ${String(manifest.name)}`)
    expect(wrong).toEqual([])
  })

  it('AC-2: the root is private and does not take the CLI name', () => {
    expect(root?.manifest.private).toBe(true)
    const cli = members.find((m) => m.dir === 'packages/cli')
    expect(root?.manifest.name).not.toBe(cli?.manifest.name)
    expect(root?.manifest.name).not.toBe('nymbal')
  })

  it('AC-2: the CLI publishes as `nymbal`', () => {
    const cli = members.find((m) => m.dir === 'packages/cli')
    expect(cli?.manifest.name).toBe('nymbal')
    expect(cli && isPublished(cli.manifest)).toBe(true)
  })

  it('AC-2: every published manifest has publishConfig.access public, files and repository', () => {
    const problems: string[] = []
    for (const { dir, manifest } of published) {
      if (manifest.publishConfig?.access !== 'public') {
        problems.push(`${dir}: publishConfig.access is ${String(manifest.publishConfig?.access)}`)
      }
      if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
        problems.push(`${dir}: files is missing or empty`)
      }
      if (repositoryUrl(manifest) === undefined) problems.push(`${dir}: repository is missing`)
    }
    expect(problems).toEqual([])
  })

  it('AC-2: every published repository points at the repository this checkout came from (provenance)', () => {
    const origin = ownerRepo(
      execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, encoding: 'utf8' }),
    )
    const mismatched = published
      .map(({ dir, manifest }) => ({ dir, repo: repositoryUrl(manifest) }))
      .filter(({ repo }) => repo === undefined || ownerRepo(repo) !== origin)
      .map(({ dir, repo }) => `${dir}: ${String(repo)} (origin is ${origin})`)
    expect(mismatched).toEqual([])
  })
})
