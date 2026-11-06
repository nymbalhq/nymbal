import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cliEnv, doctorLines } from '../support/doctor'
import { holdWorkspace } from '../support/workspace-lock'

// AC-6: each new form of `nymbal add` leaves a store that `nymbal doctor` passes. A fresh Astro scaffold, made
// in the checkout (as smoke-astro, a workspace member, with --no-install, then `pnpm install`):
// - `nymbal add payments stripe`, then the payments block pointed at a Stripe stand-in this test serves (GET /v1/balance
//   answers 200) and the three STRIPE_* variables exported, then `nymbal migrate`: `nymbal doctor` exits 0, its payments
//   slot ok on stripe, its health read from the stand-in.
// - on another such scaffold, the third-party fixture @acme/nymbal-search-x installed from its path, then
//   `nymbal add @acme/nymbal-search-x --no-install`, ACME_SEARCH_KEY exported, then `nymbal migrate`: `nymbal doctor`
//   exits 0, with `package search` ok naming the package.
// The installs rewrite the workspace lockfile and re-link its node_modules; the test puts the lockfile back byte for
// byte and re-installs from it, holding the workspace lock (tests/support/workspace-lock.ts) throughout. Needs
// `pnpm build`.

const exec = promisify(execFile)
const REPO = fileURLToPath(new URL('../../', import.meta.url))
const NAME = 'smoke-astro'
const DIR = join(REPO, NAME)
const LOCKFILE = join(REPO, 'pnpm-lock.yaml')
const SEARCH_X = '@acme/nymbal-search-x'
const SEARCH_X_DIR = join(REPO, 'tests/fixtures/third-party-search-x')
const LOCK_WAIT_MS = 1_200_000

let release: (() => void) | null = null
let lockfile: Buffer | null = null
let installed = false

async function sh(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = cliEnv(),
  timeout = 300_000,
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, {
      cwd,
      env,
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, output: stdout + stderr }
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string; message: string }
    return {
      code: typeof e.code === 'number' ? e.code : -1,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message}`,
    }
  }
}

// Through pnpm, as a developer runs it: its user agent is how `nymbal add` picks `pnpm add` in a workspace member.
const nymbal = (...args: string[]) => sh('pnpm', ['exec', 'nymbal', ...args], DIR)
// The project's own bin under plain node, with the environment the store runs with.
const doctor = (env: NodeJS.ProcessEnv) =>
  sh(process.execPath, [join(DIR, 'node_modules/nymbal/bin/nymbal.mjs'), 'doctor'], DIR, env)

/** A fresh astro scaffold at DIR with `dependencies` added to its package.json, installed with pnpm. */
async function scaffoldStore(dependencies: Record<string, string> = {}): Promise<void> {
  if (existsSync(DIR)) {
    throw new Error(
      `${DIR} exists: remove it first (this test scaffolds it and deletes it afterwards)`,
    )
  }
  const made = await sh(
    process.execPath,
    [
      join(REPO, 'packages/create-app/bin/create-nymbal-app.mjs'),
      NAME,
      '--template',
      'astro',
      '--yes',
      '--no-install',
    ],
    REPO,
  )
  if (made.code !== 0) throw new Error(`create-nymbal-app failed:\n${made.output}`)
  const manifestPath = join(DIR, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  manifest.dependencies = { ...manifest.dependencies, ...dependencies }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  installed = true
  const install = await sh('pnpm', ['install', '--no-frozen-lockfile', '--prefer-offline'], DIR)
  if (install.code !== 0) throw new Error(`pnpm install failed:\n${install.output.slice(-4000)}`)
}

beforeAll(async () => {
  release = await holdWorkspace(LOCK_WAIT_MS)
  lockfile = readFileSync(LOCKFILE)
}, LOCK_WAIT_MS + 60_000)

afterAll(async () => {
  try {
    rmSync(DIR, { recursive: true, force: true })
    if (lockfile !== null && !readFileSync(LOCKFILE).equals(lockfile))
      writeFileSync(LOCKFILE, lockfile)
    // The installs also re-linked the workspace's node_modules for the scaffold; put them back to the lockfile.
    if (installed) {
      const synced = await sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], REPO)
      if (synced.code !== 0)
        throw new Error(`pnpm install --frozen-lockfile failed:\n${synced.output.slice(-4000)}`)
    }
  } finally {
    release?.()
  }
}, 360_000)

describe('AC-6: `nymbal add payments stripe` leaves a scaffold doctor passes', () => {
  let stub: Server | null = null
  let port = 0
  let balanceReads = 0

  beforeAll(async () => {
    stub = createServer((req, res) => {
      if (req.method === 'GET' && (req.url ?? '').startsWith('/v1/balance')) {
        balanceReads++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'balance', available: [], pending: [], livemode: false }))
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'not stubbed' } }))
    })
    await new Promise<void>((resolve) => stub!.listen(0, '127.0.0.1', resolve))
    port = (stub.address() as { port: number }).port
    await scaffoldStore()
  }, 600_000)

  afterAll(async () => {
    await new Promise((resolve) => (stub === null ? resolve(null) : stub.close(resolve)))
    rmSync(DIR, { recursive: true, force: true })
  })

  it('AC-6: after `nymbal add payments stripe`, the stub config, the STRIPE_* variables and `nymbal migrate`, doctor exits 0 with the payments slot ok on stripe, read from the stub', async () => {
    const added = await nymbal('add', 'payments', 'stripe')
    expect(added.code, added.output.slice(-4000)).toBe(0)

    const configPath = join(DIR, 'nymbal.config.ts')
    const source = readFileSync(configPath, 'utf8')
    const pointed = source.replace(
      /payments: \{\s*provider: (['"])stripe\1,?\s*\}/,
      `payments: { provider: 'stripe', config: { host: '127.0.0.1', port: ${port}, protocol: 'http' } }`,
    )
    expect(pointed, `commerce.payments is { provider: 'stripe' }:\n${source}`).not.toBe(source)
    writeFileSync(configPath, pointed)

    const migrated = await nymbal('migrate')
    expect(migrated.code, migrated.output.slice(-4000)).toBe(0)

    const readsBefore = balanceReads
    const run = await doctor(
      cliEnv({
        STRIPE_SECRET_KEY: 'sk_test_nymbal_add_slot',
        STRIPE_WEBHOOK_SECRET: 'whsec_nymbal_add_slot',
        STRIPE_PUBLISHABLE_KEY: 'pk_test_nymbal_add_slot',
      }),
    )
    const lines = doctorLines(run.output)

    expect(run.code, run.output.slice(-4000)).toBe(0)
    expect(lines.filter((l) => l.status === 'down')).toEqual([])
    const payments = lines.find((l) => l.name === 'slot payments')
    expect(payments?.status, run.output).toBe('ok')
    expect(payments?.detail).toContain('stripe')
    expect(balanceReads, 'doctor read the balance from the stub').toBeGreaterThan(readsBefore)
  }, 600_000)
})

describe('AC-6: `nymbal add <package>` leaves a scaffold doctor passes', () => {
  beforeAll(async () => {
    await scaffoldStore({ [SEARCH_X]: `file:${SEARCH_X_DIR}` })
  }, 600_000)

  afterAll(() => {
    rmSync(DIR, { recursive: true, force: true })
  })

  it('AC-6: with the fixture installed from its path, after `nymbal add @acme/nymbal-search-x --no-install`, ACME_SEARCH_KEY exported and `nymbal migrate`, doctor exits 0 with `package search` ok naming the package', async () => {
    const added = await nymbal('add', SEARCH_X, '--no-install')
    expect(added.code, added.output.slice(-4000)).toBe(0)

    const migrated = await nymbal('migrate')
    expect(migrated.code, migrated.output.slice(-4000)).toBe(0)

    const run = await doctor(cliEnv({ ACME_SEARCH_KEY: 'acme-key-nymbal-add-package' }))
    const lines = doctorLines(run.output)

    expect(run.code, run.output.slice(-4000)).toBe(0)
    expect(lines.filter((l) => l.status === 'down')).toEqual([])
    const pkg = lines.find((l) => l.name === 'package search')
    expect(pkg?.status, run.output).toBe('ok')
    expect(pkg?.detail).toBe(SEARCH_X)
    const slot = lines.find((l) => l.name === 'slot search')
    expect(slot?.status, run.output).toBe('ok')
    expect(slot?.detail).toContain('acme-x')
  }, 600_000)
})
