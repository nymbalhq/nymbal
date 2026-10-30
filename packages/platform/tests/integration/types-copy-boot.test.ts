import { execFile } from 'node:child_process'
import {
  cpSync,
  lstatSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installLine } from '../../src/adapters/resolve.js'
import {
  cliEnv,
  doctorLines,
  freePort,
  linesNaming,
  migratedSqlite,
  runCli,
} from '../../../../tests/support/doctor.js'
import { project as storeProject, workspace } from '../../../../tests/support/project.js'

// A store whose adapter loads its own copy of @nymbalhq/types fails to start, naming both copies; a store with one
// copy boots as before. Each project is a temp directory outside the repository. The duplicating adapter is a real
// directory (copied, not linked into the repository) holding a copied node_modules/@nymbalhq/types, and it imports
// from that copy, so without the check the kernel boots it and its errors miss the kernel's `instanceof`. createApp
// runs from the kernel's built dist in a child process whose working directory is the project, and doctor and dev
// run the built CLI there (`pnpm build` first).

const exec = promisify(execFile)
const PLATFORM = fileURLToPath(new URL('../../', import.meta.url))
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const CHILD = join(PLATFORM, 'tests', 'integration', 'fixtures', 'adapter-resolution', 'child.mjs')
const SEARCH_FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-search')
const TYPES = '@nymbalhq/types'
const DUP_PACKAGE = '@acme/nymbal-dup'

/** The kernel's own copy of @nymbalhq/types: the directory its node_modules links, and its version. */
const KERNEL_TYPES_DIR = realpathSync(join(PLATFORM, 'node_modules', ...TYPES.split('/')))
const KERNEL_TYPES_VERSION = (
  JSON.parse(readFileSync(join(KERNEL_TYPES_DIR, 'package.json'), 'utf8')) as { version: string }
).version

/** The kernel's version with its minor raised: a copy no dedupe can fold into the kernel's exact pin. */
const BUMPED_VERSION = (() => {
  const [major, minor] = KERNEL_TYPES_VERSION.split('.').map(Number)
  return `${major}.${minor! + 1}.0`
})()

/** The kernel's version with its minor lowered (or its major, at minor 0): an adapter's copy older than the core. */
const OLDER_VERSION = (() => {
  const [major, minor] = KERNEL_TYPES_VERSION.split('.').map(Number)
  return minor! > 0 ? `${major}.${minor! - 1}.0` : `${major! - 1}.0.0`
})()

/** The remedy a dedupe is for each package manager, as `installLine` picks the manager. */
const DEDUPE: Record<string, string> = {
  npm: 'npm dedupe',
  pnpm: 'pnpm dedupe',
  yarn: 'yarn dedupe',
  bun: 'bun install --force',
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(installed: Record<string, string> = {}): string {
  const dir = storeProject(installed, { prefix: 'types-copy-boot-' })
  dirs.push(dir)
  return dir
}

interface DupProject {
  dir: string
  /** The realpath of the adapter's own copy of @nymbalhq/types. */
  adapterTypesDir: string
  dedupe: string
}

/**
 * A pnpm project (by its lockfile) whose node_modules holds `@acme/nymbal-dup`: the third-party search fixture copied
 * as a real directory, importing from @nymbalhq/types, with its own copy of the kernel's @nymbalhq/types at `version`.
 */
function dupProject(version: string): DupProject {
  const dir = project()
  writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  const adapter = join(dir, 'node_modules', ...DUP_PACKAGE.split('/'))
  cpSync(SEARCH_FIXTURE, adapter, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(adapter, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >
  writeFileSync(
    join(adapter, 'package.json'),
    `${JSON.stringify({ ...manifest, name: DUP_PACKAGE }, null, 2)}\n`,
  )
  writeFileSync(
    join(adapter, 'index.js'),
    `${readFileSync(join(adapter, 'index.js'), 'utf8')}\nimport { NymbalError } from '${TYPES}'\nexport const typesError = NymbalError\n`,
  )
  const copy = join(adapter, 'node_modules', ...TYPES.split('/'))
  cpSync(join(KERNEL_TYPES_DIR, 'dist'), join(copy, 'dist'), { recursive: true })
  const types = JSON.parse(readFileSync(join(KERNEL_TYPES_DIR, 'package.json'), 'utf8')) as Record<
    string,
    unknown
  >
  writeFileSync(join(copy, 'package.json'), `${JSON.stringify({ ...types, version }, null, 2)}\n`)
  const pm = installLine([], {}, dir).split(' ')[0]!
  return { dir, adapterTypesDir: realpathSync(copy), dedupe: DEDUPE[pm]! }
}

type Raw = Record<string, unknown> & { commerce: Record<string, unknown> }

/** A raw config, as nymbal.config.ts would export it: SQLite, every slot native but the commerce blocks given. */
function rawConfig(commerce: Record<string, unknown>): Raw {
  return {
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
      email: { provider: 'native', config: { transport: 'console' } },
      reviews: { provider: 'native' },
      search: { provider: 'native' },
      analytics: { provider: 'native' },
      shipping: { provider: 'native' },
      tax: { provider: 'native' },
      ai: { provider: 'none' },
      ...commerce,
    },
    http: { adapter: 'fastify', port: 3999, host: '127.0.0.1' },
    deployment: { strategy: 'standard' },
  }
}

const DUP = { search: { provider: 'acme', package: DUP_PACKAGE } }
const ACME = { search: { provider: 'acme', package: '@acme/nymbal-search' } }
const STRIPE = {
  payments: {
    provider: 'stripe',
    config: { secretKey: 'sk_test_types_copy', webhookSecret: 'whsec_types_copy' },
  },
}

interface Outcome {
  started?: { payments: string; search: string | null }
  error?: { name?: string; code?: string; message: string; context: Record<string, unknown> | null }
}

/** createApp on `raw`, in a child whose working directory is `cwd`. */
async function boot(cwd: string, raw: Raw): Promise<Outcome> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['npm_config_user_agent']
  delete env['NODE_OPTIONS']
  const { stdout } = await exec(process.execPath, [CHILD, JSON.stringify(raw)], {
    cwd,
    env: { ...env, ADAPTER_RESOLUTION: JSON.stringify({ settings: [] }) },
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  const line = stdout.split('\n').find((l) => l.startsWith('ADAPTER-RESOLUTION-OUTCOME '))
  if (line === undefined) throw new Error(`the child printed no outcome:\n${stdout}`)
  return JSON.parse(line.slice('ADAPTER-RESOLUTION-OUTCOME '.length)) as Outcome
}

/** A path or a file URL, as a path. */
const asPath = (value: unknown): string => {
  const text = String(value)
  return text.startsWith('file:') ? fileURLToPath(text) : text
}

/** Whether `path` is `dir` or lies inside it. */
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep)

/** The context's two copies: each a realpath, distinct from the other, inside the directory its side loads. */
function expectTwoCopies(context: Record<string, unknown> | null | undefined, adapterDir: string) {
  const adapterTypes = asPath(context?.['adapterTypes'])
  const kernelTypes = asPath(context?.['kernelTypes'])
  expect(adapterTypes).toBe(realpathSync(adapterTypes))
  expect(kernelTypes).toBe(realpathSync(kernelTypes))
  expect(adapterTypes).not.toBe(kernelTypes)
  expect(within(adapterTypes, adapterDir), adapterTypes).toBe(true)
  expect(within(kernelTypes, KERNEL_TYPES_DIR), kernelTypes).toBe(true)
}

describe('AC-1: a second @nymbalhq/types fails createApp', () => {
  let same: DupProject
  let bumped: DupProject
  let sameOutcome: Outcome
  let bumpedOutcome: Outcome
  let olderOutcome: Outcome

  beforeAll(async () => {
    same = dupProject(KERNEL_TYPES_VERSION)
    bumped = dupProject(BUMPED_VERSION)
    const older = dupProject(OLDER_VERSION)
    // The copy is the adapter's own real directory, not a link to the kernel's.
    expect(lstatSync(same.adapterTypesDir).isSymbolicLink()).toBe(false)
    ;[sameOutcome, bumpedOutcome, olderOutcome] = await Promise.all([
      boot(same.dir, rawConfig(DUP)),
      boot(bumped.dir, rawConfig(DUP)),
      boot(older.dir, rawConfig(DUP)),
    ])
  }, 120_000)

  it("AC-1: with the adapter's copy at the kernel's version, createApp fails adapter.types_duplicate on the search slot, naming both paths and the project's dedupe line", () => {
    const error = sameOutcome.error
    expect(error?.code, JSON.stringify(sameOutcome)).toBe('adapter.types_duplicate')
    expect(error?.name).toBe('ConfigError')
    expect(error?.context?.['slot']).toBe('search')
    expect(error?.context?.['provider']).toBe('acme')
    expect(error?.context?.['package']).toBe(DUP_PACKAGE)
    expectTwoCopies(error?.context, same.adapterTypesDir)
    expect(error?.context?.['adapterVersion']).toBe(error?.context?.['kernelVersion'])
    expect(error?.context?.['kernelVersion']).toBe(KERNEL_TYPES_VERSION)
    expect(error?.message).toContain(DUP_PACKAGE)
    expect(error?.message).toContain(same.adapterTypesDir)
    expect(error?.message).toContain(KERNEL_TYPES_DIR)
    expect(error?.message).toContain(same.dedupe)
  })

  it("AC-1: with the adapter's copy at a higher version, the message names both versions and the version step, not a dedupe", () => {
    const error = bumpedOutcome.error
    expect(error?.code, JSON.stringify(bumpedOutcome)).toBe('adapter.types_duplicate')
    expect(error?.context?.['slot']).toBe('search')
    expectTwoCopies(error?.context, bumped.adapterTypesDir)
    expect(error?.context?.['adapterVersion']).toBe(BUMPED_VERSION)
    expect(error?.context?.['kernelVersion']).toBe(KERNEL_TYPES_VERSION)
    expect(error?.message).toContain(`${TYPES} ${BUMPED_VERSION}`)
    expect(error?.message).toContain(KERNEL_TYPES_VERSION)
    expect(error?.message).toContain(`at least ${BUMPED_VERSION}`)
    expect(error?.message).not.toMatch(/dedupe|install --force/)
  })

  it("AC-1: with the adapter's copy at a lower version, the version step is the adapter's alone, since the core already satisfies it", () => {
    const error = olderOutcome.error
    expect(error?.code, JSON.stringify(olderOutcome)).toBe('adapter.types_duplicate')
    expect(error?.context?.['adapterVersion']).toBe(OLDER_VERSION)
    expect(error?.context?.['kernelVersion']).toBe(KERNEL_TYPES_VERSION)
    expect(error?.message).toContain(`${TYPES} ${OLDER_VERSION}`)
    expect(error?.message).toContain(
      `Install ${DUP_PACKAGE} at a version whose ${TYPES} peer range includes ${KERNEL_TYPES_VERSION}`,
    )
    expect(error?.message).not.toContain("Update Nymbal's core")
    expect(error?.message).not.toContain(`at least ${OLDER_VERSION}`)
    expect(error?.message).not.toMatch(/dedupe|install --force/)
  })

  describe('AC-4: doctor and dev on the same project', () => {
    it('AC-4: `nymbal doctor` exits 1 with package search down, its detail naming both copies', async () => {
      const sqlitePath = join(same.dir, 'doctor.db')
      writeFileSync(
        join(same.dir, 'nymbal.config.ts'),
        `export default ${JSON.stringify(rawConfig(DUP), null, 2)}\n`,
      )
      await migratedSqlite(sqlitePath)

      const run = await runCli(['doctor'], {
        cwd: same.dir,
        env: cliEnv({ NYMBAL_SQLITE_PATH: sqlitePath, npm_config_user_agent: undefined }),
      })

      const search = doctorLines(run.out).find((l) => l.name === 'package search')
      expect(search?.status, run.out.slice(-3000)).toBe('down')
      expect(search?.detail).toContain(same.adapterTypesDir)
      expect(search?.detail).toContain(KERNEL_TYPES_DIR)
      expect(run.code).toBe(1)
    }, 90_000)

    it('AC-4: `nymbal dev --api-only` exits 1, printing the message once with no stack', async () => {
      writeFileSync(
        join(same.dir, 'nymbal.config.ts'),
        `export default ${JSON.stringify(rawConfig(DUP), null, 2)}\n`,
      )
      // dev migrates first, from the project's own migrations as a scaffold carries them.
      symlinkSync(join(PLATFORM, 'migrations'), join(same.dir, 'migrations'), 'dir')
      const run = await runCli(['dev', '--api-only', '--port', String(await freePort())], {
        cwd: same.dir,
        env: cliEnv({
          NYMBAL_SQLITE_PATH: join(same.dir, 'dev.db'),
          npm_config_user_agent: undefined,
        }),
        timeoutMs: 30_000,
      })

      expect(run.code, run.out.slice(-3000)).toBe(1)
      expect(linesNaming(run.out, same.adapterTypesDir, KERNEL_TYPES_DIR)).toHaveLength(1)
      expect(run.out).not.toMatch(/^\s+at .+:\d+:\d+\)?$/m)
    }, 90_000)
  })
})

describe('AC-2: one copy boots unchanged', () => {
  it("AC-2: a project with @nymbalhq/payments-stripe, whose types is the kernel's own, boots with stripe; the third-party search that resolves no types boots with it", async () => {
    const stripe = project(workspace('@nymbalhq/payments-stripe'))
    const acme = project({ '@acme/nymbal-search': SEARCH_FIXTURE })

    const [withStripe, withAcme] = await Promise.all([
      boot(stripe, rawConfig(STRIPE)),
      boot(acme, rawConfig(ACME)),
    ])

    expect(withStripe.error, JSON.stringify(withStripe.error)).toBeUndefined()
    expect(withStripe.started?.payments).toBe('stripe')
    expect(withAcme.error, JSON.stringify(withAcme.error)).toBeUndefined()
    expect(withAcme.started?.search).toBe('acme-search')
  }, 120_000)
})
