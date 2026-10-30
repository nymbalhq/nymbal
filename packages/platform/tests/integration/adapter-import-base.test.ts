import { execFile } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { installLine } from '../../src/adapters/resolve.js'
import { project as storeProject } from '../../../../tests/support/project.js'

// AC-6: the kernel imports an adapter package from the project it runs in, `process.cwd()`, and not from its own
// location. A child process runs createApp from the built dist (`pnpm build` first) with its working directory a temp
// project outside the repository. The third-party search fixture is installed in that project's node_modules with an
// `import`-only exports map, so a resolver that uses `require` conditions cannot find it. With the fixture absent,
// the kernel's own node_modules and the repository's above it must not stand in for the project's.

const exec = promisify(execFile)
const PLATFORM = fileURLToPath(new URL('../../', import.meta.url))
const REPO = fileURLToPath(new URL('../../../../', import.meta.url))
const CHILD = join(PLATFORM, 'tests', 'integration', 'fixtures', 'adapter-resolution', 'child.mjs')
const SEARCH_FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-search')
const SEARCH_PACKAGE = '@acme/nymbal-search'
const STRIPE_PACKAGE = '@nymbalhq/payments-stripe'

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A store project in the system temp directory, with `installed` (name to package directory) in its node_modules. */
function project(installed: Record<string, string> = {}): string {
  const dir = storeProject(installed, { prefix: 'adapter-import-base-' })
  dirs.push(dir)
  return dir
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

/** The code `require.resolve` fails with for `specifier` from `dir`, or null when it resolves. */
function requireResolveFailure(dir: string, specifier: string): string | null {
  try {
    createRequire(join(dir, 'package.json')).resolve(specifier)
    return null
  } catch (error) {
    return String((error as { code?: unknown }).code)
  }
}

const SEARCH = { search: { provider: 'acme', package: SEARCH_PACKAGE } }
const STRIPE = {
  payments: {
    provider: 'stripe',
    config: { secretKey: 'sk_test_import_base', webhookSecret: 'whsec_import_base' },
  },
}

describe('AC-6: the kernel imports adapters from the project root', () => {
  it('AC-6: from a temp project outside the repository whose node_modules holds an import-only @acme/nymbal-search, createApp loads it as the search adapter', async () => {
    const dir = project({ [SEARCH_PACKAGE]: SEARCH_FIXTURE })
    expect(relative(REPO, dir).startsWith('..'), dir).toBe(true)
    // The exports map has only the `import` condition: a resolver using `require` conditions fails it.
    expect(requireResolveFailure(dir, SEARCH_PACKAGE)).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')

    const outcome = await boot(dir, rawConfig(SEARCH))

    expect(outcome.error, JSON.stringify(outcome.error)).toBeUndefined()
    expect(outcome.started?.search).toBe('acme-search')
  }, 90_000)

  it("AC-6: with the package absent from the project, the same config fails adapter.package_missing, and so does payments stripe, which the kernel's own node_modules holds", async () => {
    const dir = project()
    // Installed beside the kernel, for its own tests: an import from the kernel's location would find it.
    expect(existsSync(join(PLATFORM, 'node_modules', STRIPE_PACKAGE, 'package.json'))).toBe(true)

    const [search, stripe] = await Promise.all([
      boot(dir, rawConfig(SEARCH)),
      boot(dir, rawConfig(STRIPE)),
    ])

    expect(search.error?.code, search.error?.message).toBe('adapter.package_missing')
    expect(search.error?.context?.['install']).toBe(installLine([SEARCH_PACKAGE], {}, dir))
    expect(stripe.error?.code, JSON.stringify(stripe.started)).toBe('adapter.package_missing')
    expect(stripe.error?.context?.['install']).toBe(
      installLine([STRIPE_PACKAGE, 'stripe'], {}, dir),
    )
  }, 90_000)
})
