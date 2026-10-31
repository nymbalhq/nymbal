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

// AC-6: `nymbal test:contracts --package <pkg>` in a scratch project outside the monorepo, on the third-party fixture
// tests/fixtures/third-party-search: the well-behaved fixture is certified, the same package configured to ignore the
// cursor is not, and a bad setup exits 1 with one line. Nothing in the project changes but `.nymbal/contracts/`.
// Spawns the built CLI (`pnpm build` first).

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_BIN = resolve(HERE, '..', '..', 'bin', 'nymbal.mjs')
const REPO = resolve(HERE, '..', '..', '..', '..')
const CONTRACT_TESTS = join(REPO, 'packages', 'contract-tests')
const VITEST = dirname(createRequire(join(REPO, 'package.json')).resolve('vitest/package.json'))
const SEARCH_FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-search')
const NO_FACTORY_FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-no-create-adapter')
const WRONG_SLOT_FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-wrong-slot')
const PKG = '@acme/nymbal-search'
const NO_FACTORY_PKG = '@acme/nymbal-search-no-factory'
const WRONG_SLOT_PKG = '@acme/nymbal-wrong-slot'
/** The search fixture installed under the name the convention gives search provider 'acme'. */
const CONVENTION_PKG = '@nymbalhq/search-acme'
/** The certifying run is a vitest run of the full search suite over an in-memory index. */
const CERTIFY_WITHIN_MS = 150_000

const scratches: string[] = []
afterAll(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface Scratch {
  /** The slot's `config` record: the adapter's options. */
  config?: Record<string, unknown>
  /** The slot's `config` as TypeScript source, for a record JSON cannot write (a Date, an undefined value). */
  configSource?: string
  /** The package the search slot names. */
  slotPackage?: string
  /** The whole search block, in place of the `custom` one naming `slotPackage`. */
  search?: Record<string, unknown>
  /** Linked into node_modules, by name. */
  links: Record<string, string>
}

function link(project: string, name: string, target: string): void {
  const at = join(project, 'node_modules', name)
  mkdirSync(dirname(at), { recursive: true })
  symlinkSync(target, at, 'dir')
}

const CONFIG_SOURCE = '<slot config source>'

/** A store project in a fresh temp directory, far from the workspace's node_modules. */
function scratchProject(s: Scratch): string {
  const project = mkdtempSync(join(tmpdir(), 'contracts-certify-'))
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
    `${JSON.stringify({ name: 'contracts-scratch-store', private: true, type: 'module', dependencies }, null, 2)}\n`,
  )
  const search = s.search ?? {
    provider: 'custom',
    package: s.slotPackage ?? PKG,
    ...(s.config !== undefined && { config: s.config }),
    ...(s.configSource !== undefined && { config: CONFIG_SOURCE }),
  }
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify(
      {
        store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
        template: 'astro',
        infrastructure: {
          commandStore: 'sqlite',
          documentStore: { provider: 'in-memory' },
          eventBus: { provider: 'in-process' },
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
    ).replace(JSON.stringify(CONFIG_SOURCE), s.configSource ?? '')}\n`,
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

describe('AC-6: nymbal test:contracts --package certifies a third-party adapter outside the monorepo', () => {
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
      // The fixture reads contractOptions.unreachable in initialize, as adapter-smtp reads its config. A failing run
      // lists every case: both downtime cases pass there, in a suite as large as the one certified with no failure, so
      // the certified count holds them, which it can only when the unreachable adapter is built as the certified one.
      expect(
        refused.lines.filter((l) => /✓/.test(l) && /unreachable dependency > down: /.test(l)),
        refused.out.slice(-3000),
      ).toHaveLength(2)

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

  it(
    'AC-6: a slot config holding a Date exits 1 with one line naming the package and JSON, and changes nothing; one whose only odd value is an undefined key is certified',
    () => {
      const dated = scratchProject({
        links: ALL_LINKS,
        configSource: '{ ignoreCursor: false, since: new Date(0) }',
      })
      const unset = scratchProject({
        links: ALL_LINKS,
        configSource: '{ ignoreCursor: false, apiKey: undefined }',
      })
      const before = tree(dated)

      const refused = certify(dated, PKG, 60_000)
      const certified = certify(unset, PKG)

      expect(refused.status, refused.out).toBe(1)
      expect(refused.lines, refused.out).toHaveLength(1)
      expect(refused.lines[0]).toContain(PKG)
      expect(refused.lines[0]).toContain('JSON')
      expect(changedOutsideContracts(before, tree(dated))).toEqual([])

      expect(certified.status, certified.out.slice(-3000)).toBe(0)
      expect(CERTIFIED.exec(certified.out)?.slice(1, 3), certified.out.slice(-3000)).toEqual([
        PKG,
        'search',
      ])
    },
    CERTIFY_WITHIN_MS + 90_000,
  )

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

describe('AC-10: test:contracts picks the slot the kernel would load the package on, and checks the module first', () => {
  it(
    "AC-10: a slot naming the package by package: with a provider other than custom is picked: search { provider: 'acme', package, config: { ignoreCursor: true } } is not certified, failing the pagination case",
    () => {
      const project = scratchProject({
        links: ALL_LINKS,
        search: { provider: 'acme', package: PKG, config: { ignoreCursor: true } },
      })

      const run = certify(project, PKG)
      const failed = NOT_CERTIFIED.exec(run.out)

      expect(run.status, run.out.slice(-3000)).toBe(1)
      expect(failed?.slice(1, 3), run.out.slice(-3000)).toEqual([PKG, 'search'])
      expect(Number(failed?.[3])).toBeGreaterThan(0)
      expect(Number(failed?.[3])).toBeLessThan(Number(failed?.[4]))
    },
    CERTIFY_WITHIN_MS + 30_000,
  )

  it(
    `AC-10: a slot whose convention name is the package is picked: search { provider: 'acme', config: { ignoreCursor: true } } with ${CONVENTION_PKG} installed is not certified, failing the pagination case`,
    () => {
      const project = scratchProject({
        links: {
          vitest: VITEST,
          '@nymbalhq/contract-tests': CONTRACT_TESTS,
          [CONVENTION_PKG]: SEARCH_FIXTURE,
        },
        search: { provider: 'acme', config: { ignoreCursor: true } },
      })

      const run = certify(project, CONVENTION_PKG)
      const failed = NOT_CERTIFIED.exec(run.out)

      expect(run.status, run.out.slice(-3000)).toBe(1)
      expect(failed?.slice(1, 3), run.out.slice(-3000)).toEqual([CONVENTION_PKG, 'search'])
      expect(Number(failed?.[3])).toBeGreaterThan(0)
      expect(Number(failed?.[3])).toBeLessThan(Number(failed?.[4]))
    },
    CERTIFY_WITHIN_MS + 30_000,
  )

  it('AC-10: a module whose slot export is payments, named on the search slot, exits 1 with one line naming the package and both slots, before any suite runs', () => {
    const project = scratchProject({
      links: { ...ALL_LINKS, [WRONG_SLOT_PKG]: WRONG_SLOT_FIXTURE },
      search: { provider: 'acme', package: WRONG_SLOT_PKG },
    })

    const run = certify(project, WRONG_SLOT_PKG, 60_000)

    expect(run.status, run.out).toBe(1)
    expect(run.lines, run.out).toHaveLength(1)
    expect(run.lines[0]).toContain(WRONG_SLOT_PKG)
    expect(run.lines[0]).toMatch(/\bpayments\b/)
    expect(run.lines[0]).toMatch(/\bsearch\b/)
    expect(CERTIFIED.test(run.out) || NOT_CERTIFIED.test(run.out)).toBe(false)
  }, 90_000)
})
