import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

// P2-13 AC-6 (spec P2-13-contract-tests-public, decision 5): `nymbal test:contracts --package <pkg>` run by the built
// CLI (`pnpm build` first) in a scratch project outside the monorepo. The project links vitest and
// @nymbalhq/contract-tests from the workspace and the third-party fixture tests/fixtures/third-party-search as its
// `file:` dependency would; its config names the fixture on the search slot (`provider: 'custom', package`) with the
// slot's `config` record as the adapter's options. The well-behaved fixture is certified with exit 0; the same package
// configured to ignore the cursor exits 1, not certified, and names the failing pagination case; the counts relate
// (the same suite has as many cases either way). Missing vitest, a package with no createAdapter and an absent
// package each exit 1 with one line. Nothing in the project changes but `.nymbal/contracts/`. Kills: a command that
// shells out to the monorepo (`pnpm vitest --project contracts-native`), resolves vitest or the suites from the CLI's
// own location, takes the options from anywhere but the slot's config, certifies a broken adapter, crashes on a bad
// package, or writes outside `.nymbal/contracts/` (a vitest cache in node_modules, a project config it edits).

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(HERE, '..', '..', 'bin', 'nymbal.mjs')
const REPO = resolve(HERE, '..', '..', '..', '..')
const CONTRACT_TESTS = join(REPO, 'packages', 'contract-tests')
const VITEST = dirname(createRequire(join(REPO, 'package.json')).resolve('vitest/package.json'))
const SEARCH_FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-search')
const NO_FACTORY_FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-no-create-adapter')
const PKG = '@acme/nymbal-search'
const NO_FACTORY_PKG = '@acme/nymbal-search-no-factory'
/** The certifying run is a vitest run of the full search suite over an in-memory index. */
const CERTIFY_WITHIN_MS = 150_000

const scratches: string[] = []
afterAll(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Scratch {
  /** The slot's `config` record: the adapter's options. */
  config?: Record<string, unknown>
  /** The package the search slot names. */
  slotPackage?: string
  /** Linked into node_modules, by name. */
  links: Record<string, string>
}

function link(project: string, name: string, target: string): void {
  const at = join(project, 'node_modules', name)
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at, 'dir')
}

/** A store project in a fresh temp directory, far from the workspace's node_modules. */
function scratchProject(s: Scratch): string {
  const project = mkdtempSync(join(tmpdir(), 'p2-13-certify-'))
  scratches.push(project)
  const dependencies: Record<string, string> = {}
  for (const [name, target] of Object.entries(s.links)) {
    link(project, name, target)
    // The fixture as a third party's `file:` dependency; the workspace's own packages as `link:`, what the links are.
    dependencies[name] = target.startsWith(join(REPO, 'tests'))
      ? `file:${target}`
      : `link:${target}`
  }
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'p2-13-scratch-store', private: true, type: 'module', dependencies }, null, 2)}\n`,
  )
  const search = {
    provider: 'custom',
    package: s.slotPackage ?? PKG,
    ...(s.config !== undefined && { config: s.config }),
  }
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(
      {
        store: { name: 'P2-13', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
        template: 'astro',
        infrastructure: {
          commandStore: 'sqlite',
          documentStore: 'in-memory',
          eventBus: 'in-process',
        },
        security: { adapter: 'middleware' },
        commerce: {
          payments: { provider: 'native' },
          email: { provider: 'native' },
          reviews: { provider: 'native' },
          search,
          analytics: { provider: 'native' },
          shipping: { provider: 'native' },
          tax: { provider: 'native' },
          ai: { provider: 'none' },
        },
        http: { adapter: 'fastify' },
        deployment: { strategy: 'standard' },
      },
      null,
      2,
    )}\n`,
  )
  return project
}

const ALL_LINKS = {
  vitest: VITEST,
  '@nymbalhq/contract-tests': CONTRACT_TESTS,
  [PKG]: SEARCH_FIXTURE,
}

/** A user's shell: no Vitest variables (the run must not think it is inside this one), no NODE_PATH, no colour. */
function userShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1' }
  delete env['NODE_ENV']
  delete env['TEST']
  delete env['NODE_PATH']
  delete env['NODE_OPTIONS']
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  return env
}

function certify(project: string, pkg: string, timeout = CERTIFY_WITHIN_MS) {
  const res = spawnSync(process.execPath, [CLI_BIN, 'test:contracts', '--package', pkg], {
    cwd: project,
    encoding: 'utf8',
    env: userShellEnv(),
    timeout,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  return { status: res.status, out, lines: out.split('\n').filter((l) => l.trim() !== '') }
}

/** Every path under the project, not following links, with what it is: a link's target, a file's content hash. */
function tree(project: string): Map<string, string> {
  const seen = new Map<string, string>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      const rel = relative(project, full)
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) seen.set(rel, `link ${readlinkSync(full)}`)
      else if (stat.isDirectory()) {
        seen.set(rel, 'dir')
        walk(full)
      } else {
        seen.set(rel, `file ${createHash('sha256').update(readFileSync(full)).digest('hex')}`)
      }
    }
  }
  walk(project)
  return seen
}

/** The paths that differ between two trees, outside `.nymbal/contracts/` (and the `.nymbal` directory holding it). */
function changedOutsideContracts(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const inContracts = (p: string) =>
    p === '.nymbal' ||
    p === join('.nymbal', 'contracts') ||
    p.startsWith(join('.nymbal', 'contracts', ''))
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((p) => !inContracts(p) && before.get(p) !== after.get(p)).sort()
}

const CERTIFIED = /^certified (\S+) \((\w+)\): (\d+) cases passed$/m
const NOT_CERTIFIED = /^not certified (\S+) \((\w+)\): (\d+) of (\d+) cases failed$/m

describe('P2-13 AC-6: nymbal test:contracts --package certifies a third-party adapter outside the monorepo', () => {
  it(
    'AC-6: the well-behaved fixture is certified (exit 0, `certified … (search): N cases passed`); the same package with ignoreCursor in its slot config exits 1, `not certified … (search): F of N cases failed`, names the failing pagination case; neither run changes the project outside .nymbal/contracts/',
    () => {
      const good = scratchProject({ links: ALL_LINKS, config: { ignoreCursor: false } })
      const bad = scratchProject({ links: ALL_LINKS, config: { ignoreCursor: true } })
      const goodBefore = tree(good)
      const badBefore = tree(bad)

      const certified = certify(good, PKG)
      const refused = certify(bad, PKG)

      const passed = CERTIFIED.exec(certified.out)
      const failed = NOT_CERTIFIED.exec(refused.out)
      expect(certified.status, certified.out.slice(-3000)).toBe(0)
      expect(passed?.slice(1, 3), certified.out.slice(-3000)).toEqual([PKG, 'search'])
      expect(Number(passed?.[3])).toBeGreaterThan(0)

      expect(refused.status, refused.out.slice(-3000)).toBe(1)
      expect(failed?.slice(1, 3), refused.out.slice(-3000)).toEqual([PKG, 'search'])
      expect(Number(failed?.[3])).toBeGreaterThan(0)
      expect(Number(failed?.[3])).toBeLessThan(Number(failed?.[4]))
      expect(Number(failed?.[4])).toBe(Number(passed?.[3]))
      expect(
        refused.lines.filter((l) => /cursor|pagin/i.test(l) && /×|✗|✕|fail/i.test(l)).length,
        refused.out.slice(-3000),
      ).toBeGreaterThan(0)

      expect(changedOutsideContracts(goodBefore, tree(good))).toEqual([])
      expect(changedOutsideContracts(badBefore, tree(bad))).toEqual([])
    },
    2 * CERTIFY_WITHIN_MS + 30_000,
  )

  it('AC-6: with no vitest in the project, it exits 1 with one line naming vitest and the line that installs it, and changes nothing', () => {
    const project = scratchProject({
      links: { '@nymbalhq/contract-tests': CONTRACT_TESTS, [PKG]: SEARCH_FIXTURE },
    })
    const before = tree(project)

    const run = certify(project, PKG, 60_000)

    expect(run.status, run.out).toBe(1)
    expect(run.lines, run.out).toHaveLength(1)
    expect(run.lines[0]).toMatch(/vitest/)
    expect(run.lines[0]).toMatch(/\b(npm (i|install)|pnpm add|yarn add|bun add)\b[^\n]*\bvitest\b/)
    expect(changedOutsideContracts(before, tree(project))).toEqual([])
  }, 90_000)

  it('AC-6: a package with no createAdapter export exits 1 with one line naming the package and createAdapter', () => {
    const project = scratchProject({
      links: { ...ALL_LINKS, [NO_FACTORY_PKG]: NO_FACTORY_FIXTURE },
      slotPackage: NO_FACTORY_PKG,
    })

    const run = certify(project, NO_FACTORY_PKG, 60_000)

    expect(run.status, run.out).toBe(1)
    expect(run.lines, run.out).toHaveLength(1)
    expect(run.lines[0]).toContain(NO_FACTORY_PKG)
    expect(run.lines[0]).toContain('createAdapter')
  }, 90_000)

  it('AC-6: a package the project has not installed exits 1 with one line naming it and the line that installs it', () => {
    const project = scratchProject({
      links: { vitest: VITEST, '@nymbalhq/contract-tests': CONTRACT_TESTS },
    })

    const run = certify(project, PKG, 60_000)

    expect(run.status, run.out).toBe(1)
    expect(run.lines, run.out).toHaveLength(1)
    expect(run.lines[0]).toMatch(
      new RegExp(
        `\\b(npm (i|install)|pnpm add|yarn add|bun add)\\b[^\\n]*${PKG.replace('/', '\\/')}`,
      ),
    )
  }, 90_000)
})
