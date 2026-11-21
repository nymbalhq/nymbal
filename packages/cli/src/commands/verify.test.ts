import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../../config/src/index.js'
import { CLI_BIN, cliEnv, freePort, stripAnsi } from '../../../../tests/support/doctor.js'
import {
  ADMIN_DIST_FIXTURE,
  migrateAllBut,
  storeConfig,
  storeProject,
} from '../../../../tests/support/start.js'

// `nymbal verify` through the built CLI (`pnpm build` first), in a store project of the test's own: a git repository
// committed before the run with the scaffold's .gitignore, a merchant's .env and a migrated nymbal.db. The storefront
// is tests/fixtures/storefront/verify-store.mjs through NYMBAL_STOREFRONT_ENTRY, copied outside the project; the admin
// is the fixture dist through NYMBAL_ADMIN_DIST. Each run gets a TMPDIR of its own, so the directory verify makes is
// the one `nymbal-verify-*` entry there. Nothing here knows how verify is built: it reads the exit, the two streams,
// the project's git status and what is left listening.

const STEPS = ['health', 'home', 'product', 'cart', 'checkout', 'order', 'admin']
const STAND_IN = fileURLToPath(
  new URL('../../../../tests/fixtures/storefront/verify-store.mjs', import.meta.url),
)
const SCAFFOLD_GITIGNORE = fileURLToPath(
  new URL('../../../../templates/astro/_dot.gitignore', import.meta.url),
)
const MERCHANT = {
  email: 'owner@shop.example',
  password: `merchant-${randomBytes(12).toString('hex')}`,
}
const RUN_MS = 240_000

type Mode = 'healthy' | 'product-500' | 'hold-product'

interface StandIn {
  entry: string
  /** What the stand-in wrote once listening, or null when it never started. */
  report(): { pid: number; port: number; apiUrl: string | null; nodeEnv: string | null } | null
}

interface VerifyRun {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  /** Whether the signal was sent (it waits for the first `verify: <step> ok` line). */
  signalled: boolean
  /** `nymbal-verify-*` entries in the run's TMPDIR when the signal was sent, and after the exit. */
  dirsWhenSignalled: string[]
  dirsAfter: string[]
}

const scratch: string[] = []
const pids: number[] = []
afterAll(() => {
  // Hygiene only, after every assertion has read what the run left: nothing of a red run outlives the file.
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  scratch.push(dir)
  return dir
}

function standIn(mode: Mode): StandIn {
  const dir = tempDir('verify-stand-in-')
  const entry = join(dir, 'verify-store.mjs')
  const report = join(dir, 'report.json')
  copyFileSync(STAND_IN, entry)
  writeFileSync(join(dir, 'verify-store.json'), JSON.stringify({ mode, report }))
  return {
    entry,
    report() {
      if (!existsSync(report)) return null
      const read = JSON.parse(readFileSync(report, 'utf8')) as ReturnType<StandIn['report']>
      if (read !== null) pids.push(read.pid)
      return read
    },
  }
}

const git = (cwd: string, ...args: string[]) => {
  const run = spawnSync(
    'git',
    ['-c', 'user.email=verify@test.local', '-c', 'user.name=verify', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GIT_INDEX_FILE: undefined,
      },
    },
  )
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

interface Project {
  dir: string
  /** nymbal.db's bytes and mtime before the run, when the project has one. */
  db: { sha: string; mtimeMs: number } | null
}

/**
 * A store project as a merchant's checkout holds it: `config` (with an API port of its own), the scaffold's .gitignore,
 * committed to git; with `merchant`, also the ignored .env holding the merchant's admin pair and a migrated nymbal.db.
 */
async function verifyProject(
  config: Record<string, unknown>,
  opts: { merchant: boolean; files?: Record<string, string> } = { merchant: true },
): Promise<Project> {
  const port = await freePort()
  const p = storeProject({ ...config, http: { adapter: 'fastify', port } })
  scratch.push(p.dir)
  copyFileSync(SCAFFOLD_GITIGNORE, join(p.dir, '.gitignore'))
  for (const [name, text] of Object.entries(opts.files ?? {})) {
    mkdirSync(join(p.dir, name, '..'), { recursive: true })
    writeFileSync(join(p.dir, name), text)
  }
  let db: Project['db'] = null
  if (opts.merchant) {
    writeFileSync(
      join(p.dir, '.env'),
      `NYMBAL_ADMIN_EMAIL=${MERCHANT.email}\nNYMBAL_ADMIN_PASSWORD=${MERCHANT.password}\n`,
    )
    const path = join(p.dir, 'nymbal.db')
    await migrateAllBut('sqlite', path, 0)
    db = { sha: sha(path), mtimeMs: statSync(path).mtimeMs }
  }
  git(p.dir, 'init', '-q')
  git(p.dir, 'add', '-A')
  git(p.dir, 'commit', '-q', '-m', 'store')
  return { dir: p.dir, db }
}

/** The environment a CI job gives verify: no admin pair, no store selection, no NODE_ENV unless the case sets one. */
function verifyEnv(tmp: string, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return cliEnv({
    TMPDIR: tmp,
    NYMBAL_ADMIN_DIST: ADMIN_DIST_FIXTURE,
    NYMBAL_ADMIN_EMAIL: undefined,
    NYMBAL_ADMIN_PASSWORD: undefined,
    NODE_ENV: undefined,
    ...extra,
  })
}

const verifyDirs = (tmp: string) =>
  existsSync(tmp) ? readdirSync(tmp).filter((n) => n.startsWith('nymbal-verify-')) : []

/** `nymbal verify` in `cwd`; with `signal`, sent once stdout has its first `verify: <step> ok` line. */
async function verify(
  cwd: string,
  env: Record<string, string | undefined>,
  opts: { signal?: NodeJS.Signals } = {},
): Promise<VerifyRun & { tmp: string }> {
  const tmp = tempDir('verify-tmpdir-')
  const child = spawn(process.execPath, [CLI_BIN, 'verify'], {
    cwd,
    env: verifyEnv(tmp, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  let signalled = false
  let dirsWhenSignalled: string[] = []
  child.stdout.on('data', (b: Buffer) => {
    stdout += b.toString()
    if (opts.signal !== undefined && !signalled && /verify: \w+ ok/.test(stripAnsi(stdout))) {
      signalled = true
      dirsWhenSignalled = verifyDirs(tmp)
      child.kill(opts.signal)
    }
  })
  child.stderr.on('data', (b: Buffer) => (stderr += b.toString()))
  const timer = setTimeout(() => child.kill('SIGKILL'), RUN_MS - 10_000)
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
    child.once('exit', (c, s) => resolve([c, s])),
  )
  clearTimeout(timer)
  return {
    code,
    signal,
    stdout: stripAnsi(stdout),
    stderr: stripAnsi(stderr),
    signalled,
    dirsWhenSignalled,
    dirsAfter: verifyDirs(tmp),
    tmp,
  }
}

/** The steps of each `verify: <step> ok` line on stdout, in order. */
const okSteps = (stdout: string) =>
  [...stdout.matchAll(/^.*verify: (\w+) ok\s*$/gm)].map((m) => m[1]!)
/** Every line naming a step's outcome, ok or failed, on either stream. */
const stepLines = (run: VerifyRun) =>
  `${run.stdout}\n${run.stderr}`
    .split('\n')
    .filter((line) => new RegExp(`verify: (${STEPS.join('|')}) (ok|failed)`).test(line))

/** Whether connecting to the port on loopback is refused (nothing listens). */
function refuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    socket.setTimeout(2_000, () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'ECONNREFUSED'))
  })
}

/** What a run left: the project's git status, its database, and whether either stream holds the merchant's password. */
function leftBehind(project: Project, run: VerifyRun) {
  const path = join(project.dir, 'nymbal.db')
  return {
    status: git(project.dir, 'status', '--porcelain'),
    db: project.db === null ? null : { sha: sha(path), mtimeMs: statSync(path).mtimeMs },
    passwordPrinted: `${run.stdout}${run.stderr}`.includes(MERCHANT.password),
  }
}

// ─── AC-7, AC-9: a passing run ──────────────────────────────────────────────────────────────────────────────────────

describe('a store that works', () => {
  let project: Project
  let run: VerifyRun
  let stand: StandIn

  beforeAll(async () => {
    project = await verifyProject(storeConfig())
    stand = standIn('healthy')
    run = await verify(project.dir, { NYMBAL_STOREFRONT_ENTRY: stand.entry })
  }, RUN_MS)

  it('AC-7: nymbal verify exits 0 after printing each of the seven steps ok in order, then passed, 7 steps', () => {
    expect(run.code, `${run.stdout}\n${run.stderr}`.slice(-3000)).toBe(0)
    expect(okSteps(run.stdout)).toEqual(STEPS)
    const lastOk = run.stdout.lastIndexOf(`verify: ${STEPS.at(-1)} ok`)
    const passed = run.stdout.indexOf('verify: passed, 7 steps')
    expect(passed).toBeGreaterThan(lastOk)
    expect(lastOk).toBeGreaterThanOrEqual(0)
  })

  it('AC-8: after a passing run the storefront it started had its API on loopback, both ports refuse connections and no nymbal-verify-* directory is left', async () => {
    expect(run.stdout).toContain('verify: passed, 7 steps')
    const report = stand.report()
    expect(report, 'the storefront stand-in never started').not.toBeNull()
    expect(report!.apiUrl).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/)
    const apiPort = Number(new URL(report!.apiUrl!).port)
    expect([await refuses(apiPort), await refuses(report!.port)]).toEqual([true, true])
    expect(run.dirsAfter).toEqual([])
  })

  it("AC-9: after a passing run the project's git status is empty, nymbal.db keeps its bytes and mtime, and the .env's admin password is in neither stream", () => {
    expect(run.stdout).toContain('verify: passed, 7 steps')
    expect(leftBehind(project, run)).toEqual({ status: '', db: project.db, passwordPrinted: false })
  })
})

// ─── AC-8, AC-9: a failing run ──────────────────────────────────────────────────────────────────────────────────────

describe('a store whose product page fails', () => {
  let project: Project
  let run: VerifyRun
  let stand: StandIn

  beforeAll(async () => {
    project = await verifyProject(storeConfig())
    stand = standIn('product-500')
    run = await verify(project.dir, { NYMBAL_STOREFRONT_ENTRY: stand.entry })
  }, RUN_MS)

  it('AC-8: exit 1, stderr names the product step with the 500, and nothing is printed for a later step or as passed', () => {
    expect(run.code, `${run.stdout}\n${run.stderr}`.slice(-3000)).toBe(1)
    expect(run.stderr).toMatch(/verify: product failed:.*\b500\b/)
    expect(okSteps(run.stdout)).toEqual(STEPS.slice(0, STEPS.indexOf('product')))
    expect(stepLines(run).filter((l) => /verify: (cart|checkout|order|admin) /.test(l))).toEqual([])
    expect(run.stdout).not.toContain('passed')
  })

  it("AC-8: after the failure no nymbal-verify-* directory is left, both ports refuse connections, and the project's git status is empty", async () => {
    expect(run.stderr).toContain('verify: product failed:')
    const report = stand.report()
    expect(report, 'the storefront stand-in never started').not.toBeNull()
    expect(run.dirsAfter).toEqual([])
    const apiPort = Number(new URL(report!.apiUrl!).port)
    expect([await refuses(apiPort), await refuses(report!.port)]).toEqual([true, true])
    expect(git(project.dir, 'status', '--porcelain')).toBe('')
  })

  it("AC-9: after a failing run the project's git status is empty, nymbal.db keeps its bytes and mtime, and the .env's admin password is in neither stream", () => {
    expect(run.stderr).toContain('verify: product failed:')
    expect(leftBehind(project, run)).toEqual({ status: '', db: project.db, passwordPrinted: false })
  })
})

// ─── AC-8: stopped by a signal ──────────────────────────────────────────────────────────────────────────────────────

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  describe(`a run stopped with ${signal}`, () => {
    let project: Project
    let run: VerifyRun
    let stand: StandIn

    beforeAll(async () => {
      project = await verifyProject(storeConfig())
      stand = standIn('hold-product')
      run = await verify(project.dir, { NYMBAL_STOREFRONT_ENTRY: stand.entry }, { signal })
    }, RUN_MS)

    it(`AC-8: ${signal} once the first step is ok exits 1 with verify: stopped, removes the directory it made, closes both ports and leaves the project clean`, async () => {
      expect(
        run.signalled,
        `no verify: <step> ok line before the exit:\n${run.stdout}\n${run.stderr}`.slice(-3000),
      ).toBe(true)
      expect([run.code, run.signal]).toEqual([1, null])
      expect(run.stderr).toContain('verify: stopped')
      expect([run.dirsWhenSignalled.length, run.dirsAfter]).toEqual([1, []])
      const report = stand.report()
      expect(report, 'the storefront stand-in never started').not.toBeNull()
      const apiPort = Number(new URL(report!.apiUrl!).port)
      expect([await refuses(apiPort), await refuses(report!.port)]).toEqual([true, true])
      expect(leftBehind(project, run)).toEqual({
        status: '',
        db: project.db,
        passwordPrinted: false,
      })
    })
  })
}

// ─── AC-10: a CI checkout with no secrets ───────────────────────────────────────────────────────────────────────────

describe('a CI checkout of a store whose config names Stripe and Postgres, with neither installed nor configured', () => {
  let project: Project
  let run: VerifyRun
  let stand: StandIn

  beforeAll(async () => {
    const config = storeConfig({ commandStore: 'postgres' })
    config['commerce'] = {
      ...(config['commerce'] as Record<string, unknown>),
      payments: { provider: 'stripe' },
    }
    project = await verifyProject(config, { merchant: false })
    stand = standIn('healthy')
    const noStripe = Object.fromEntries(
      Object.keys(process.env)
        .filter((k) => k.startsWith('STRIPE_') || k.startsWith('NYMBAL_STRIPE'))
        .map((k) => [k, undefined]),
    )
    run = await verify(project.dir, {
      ...noStripe,
      NYMBAL_STOREFRONT_ENTRY: stand.entry,
      NODE_ENV: 'production',
      DATABASE_URL: undefined,
    })
  }, RUN_MS)

  it('AC-10: with no .env, no nymbal.db, no Stripe key, no DATABASE_URL and NODE_ENV=production inherited, verify exits 0 with all seven steps', async () => {
    // The config itself loads: what verify must not do is load its providers or connect to its database.
    const loaded = await loadConfig(project.dir)
    expect([
      loaded.config.commerce.payments.provider,
      loaded.config.infrastructure.commandStore,
    ]).toEqual(['stripe', 'postgres'])
    expect(['.env', 'nymbal.db'].filter((f) => existsSync(join(project.dir, f)))).toEqual([])

    expect(run.code, `${run.stdout}\n${run.stderr}`.slice(-3000)).toBe(0)
    expect(okSteps(run.stdout)).toEqual(STEPS)
    expect(run.stdout).toContain('verify: passed, 7 steps')
    // The storefront was built and served as production; the API ignored the inherited NODE_ENV.
    expect(stand.report()?.nodeEnv).toBe('production')
    expect(['.env', 'nymbal.db'].filter((f) => existsSync(join(project.dir, f)))).toEqual([])
  })
})

// ─── AC-11: what stops verify before the journey ────────────────────────────────────────────────────────────────────

describe('a directory with no store, and a store whose storefront does not build', () => {
  let none: VerifyRun
  let broken: VerifyRun
  let brokenProject: Project

  beforeAll(async () => {
    none = await verify(tempDir('verify-no-store-'), {})

    // A flat Astro project whose framework bin fails its production build.
    brokenProject = await verifyProject(storeConfig(), {
      merchant: false,
      files: {
        'astro.config.mjs': 'export default {}\n',
        'node_modules/.bin/astro': `#!${process.execPath}\nconsole.error('astro build: [ERROR] Could not resolve "./missing"')\nprocess.exit(1)\n`,
      },
    })
    chmodSync(join(brokenProject.dir, 'node_modules', '.bin', 'astro'), 0o755)
    broken = await verify(brokenProject.dir, { NYMBAL_STOREFRONT_ENTRY: undefined })
  }, RUN_MS)

  it('AC-11: with no nymbal.config.ts in reach verify exits 1 naming it, and makes no directory', () => {
    expect(none.code).toBe(1)
    expect(none.stderr).toMatch(/verify:.*nymbal\.config/)
    expect(none.dirsAfter).toEqual([])
    expect(stepLines(none)).toEqual([])
  })

  it('AC-11: a framework bin that exits 1 on build makes verify exit 1 with verify: storefront build failed, no step line, and no directory left', () => {
    expect(broken.code).toBe(1)
    expect(broken.stderr).toContain('verify: storefront build failed')
    expect(stepLines(broken)).toEqual([])
    expect(broken.dirsAfter).toEqual([])
    expect(git(brokenProject.dir, 'status', '--porcelain')).toBe('')
  })
})
