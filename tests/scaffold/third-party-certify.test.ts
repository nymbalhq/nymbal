import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// AC-13: in scripts/scaffold-clean.sh's Verdaccio flow (the CI job scaffold-clean runs this project after the script
// has published every public package), a directory outside the workspace installs `nymbal`, `@nymbalhq/contract-tests`
// and vitest from the registry the script set up, plus the third-party fixture (tests/fixtures/third-party-search)
// from a tarball, and names the fixture only by `search: { provider: 'acme', package: '@acme/nymbal-search' }`, its
// infrastructure in the block form. `nymbal test:contracts --package <fixture>` certifies it; `nymbal dev --api-only`
// on its own port, with its SQLite in the project, answers GET /health 200; with `payments: { provider: 'strpe' }`,
// `nymbal dev` exits non-zero printing the suggestion and no install line. It installs at the version the scaffold
// resolved, so it runs exactly what was published.
//
//   NYMBAL_SCAFFOLD_DIR   the scaffolded project (its node_modules holds the published version)
//   npm_config_registry   the registry the script published to, exported by scaffold-clean.sh with its userconfig

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const REGISTRY = process.env['npm_config_registry']
if (!SCAFFOLD_DIR || !REGISTRY) {
  throw new Error(
    'AC-13 needs NYMBAL_SCAFFOLD_DIR and npm_config_registry (the local registry the packages were published to). ' +
      'Run it through scripts/scaffold-clean.sh <astro|nextjs>, which publishes, scaffolds and sets both.',
  )
}
const DIR: string = SCAFFOLD_DIR
const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const FIXTURE = join(REPO, 'tests', 'fixtures', 'third-party-search')
const PKG = '@acme/nymbal-search'
const INSTALL_VERB = /\b(npm install|npm i|pnpm add|yarn add|bun add)\b/

const project = mkdtempSync(join(tmpdir(), 'contracts-certify-published-'))
afterAll(() => rmSync(project, { recursive: true, force: true }))

/** The npm a user has: no Vitest variables, so the certifying run is not taken for this one. */
function userEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  delete env['NODE_ENV']
  delete env['TEST']
  delete env['NODE_PATH']
  delete env['npm_config_user_agent']
  delete env['NYMBAL_SQLITE_PATH']
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  return env
}

function npm(args: string[], timeout = 300_000) {
  const res = spawnSync('npm', args, { cwd: project, encoding: 'utf8', env: userEnv(), timeout })
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address !== null
          ? resolvePort(address.port)
          : reject(new Error('freePort: no address')),
      )
    })
  })
}

/** `nymbal dev --api-only --port <port>` in the project, its SQLite file there; stop kills its process group. */
function dev(port: number) {
  const child = spawn(
    'npm',
    ['exec', '--no', '--', 'nymbal', 'dev', '--api-only', '--port', String(port)],
    {
      cwd: project,
      env: { ...userEnv(), NYMBAL_SQLITE_PATH: join(project, 'nymbal.db') },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)))
  return {
    output: () => output,
    exited,
    stop: () => {
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        // already gone
      }
    },
  }
}

/** The project's config: native everywhere, block-form infrastructure, the fixture named by `package:` on search. */
function writeConfig(payments: Record<string, unknown> = { provider: 'native' }): void {
  writeFileSync(
    join(project, 'nymbal.config.ts'),
    `export default ${JSON.stringify({
      store: { name: 'Test Store', currency: 'GBP', locale: 'en-GB', timezone: 'Europe/London' },
      template: 'astro',
      infrastructure: {
        commandStore: 'sqlite',
        documentStore: { provider: 'in-memory' },
        eventBus: { provider: 'in-process' },
      },
      security: { adapter: 'middleware' },
      commerce: {
        payments,
        email: { provider: 'native' },
        reviews: { provider: 'native' },
        search: { provider: 'acme', package: PKG, config: {} },
        analytics: { provider: 'native' },
        shipping: { provider: 'native' },
        tax: { provider: 'native' },
        ai: { provider: 'none' },
      },
      http: { adapter: 'fastify' },
      deployment: { strategy: 'standard' },
    })}\n`,
  )
}

let packed: { status: number | null; out: string }
let install: { status: number | null; out: string }

beforeAll(() => {
  const published = (
    JSON.parse(readFileSync(join(DIR, 'node_modules', 'nymbal', 'package.json'), 'utf8')) as {
      version: string
    }
  ).version
  writeFileSync(
    join(project, 'package.json'),
    `${JSON.stringify({ name: 'contracts-certify', private: true, type: 'module' }, null, 2)}\n`,
  )
  packed = npm(['pack', FIXTURE, '--pack-destination', project])
  const tarball = readdirSync(project).find((f) => f.endsWith('.tgz'))
  writeConfig()
  install = npm([
    'install',
    '--no-audit',
    '--no-fund',
    `nymbal@${published}`,
    `@nymbalhq/contract-tests@${published}`,
    'vitest@^3',
    `./${tarball ?? 'missing.tgz'}`,
  ])
}, 600_000)

describe('AC-13: a store outside the workspace names a third-party adapter by package: with the published packages', () => {
  it("AC-13: with search { provider: 'acme', package: '@acme/nymbal-search' }, `nymbal test:contracts --package` exits 0 with `certified … (search): N cases passed`", () => {
    const run = npm(['exec', '--no', '--', 'nymbal', 'test:contracts', '--package', PKG])
    const certified = /^certified (\S+) \((\w+)\): (\d+) cases passed$/m.exec(run.out)

    expect(packed.status, packed.out).toBe(0)
    expect(install.status, install.out.slice(-3000)).toBe(0)
    expect(run.status, run.out.slice(-3000)).toBe(0)
    expect(certified?.slice(1, 3), run.out.slice(-3000)).toEqual([PKG, 'search'])
    expect(Number(certified?.[3])).toBeGreaterThan(0)
  }, 600_000)

  it('AC-13: `nymbal dev --api-only` on its own port, its SQLite in the project, loads the fixture and answers GET /health 200', async () => {
    writeConfig()
    const port = await freePort()
    const server = dev(port)
    try {
      await vi.waitFor(
        async () => {
          const res = await fetch(`http://127.0.0.1:${port}/health`)
          expect(res.status, server.output().slice(-2000)).toBe(200)
        },
        { timeout: 120_000, interval: 500 },
      )
      expect(readdirSync(project)).toContain('nymbal.db')
    } finally {
      server.stop()
    }
  }, 180_000)

  it("AC-13: with payments { provider: 'strpe' }, `nymbal dev --api-only` exits non-zero printing did you mean 'stripe' and no install verb", async () => {
    writeConfig({ provider: 'strpe' })
    const server = dev(await freePort())
    const timedOut = new Promise<'timed out'>((r) => {
      const t = setTimeout(() => r('timed out'), 90_000)
      void server.exited.then(() => clearTimeout(t))
    })
    try {
      const code = await Promise.race([server.exited, timedOut])

      expect(code, server.output().slice(-2000)).not.toBe('timed out')
      expect(code).not.toBe(0)
      expect(server.output()).toContain("did you mean 'stripe'")
      expect(server.output()).not.toMatch(INSTALL_VERB)
    } finally {
      server.stop()
      writeConfig()
    }
  }, 120_000)
})
