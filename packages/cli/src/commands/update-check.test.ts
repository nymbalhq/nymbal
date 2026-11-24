import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliEnv, closedPort, runCli, stripAnsi } from '../../../../tests/support/doctor.js'
import { runInProcess } from './fixtures/in-process.js'

// `nymbal update-check` run for real (in this process; one case through the built CLI, `pnpm build` first) in a fixture
// store: a git repository whose base commit and head commit differ as a Renovate pull request would, a fake
// node_modules for the head's install, a fake compatibility matrix over NYMBAL_MATRIX_URL and a fake npm registry over
// npm_config_registry serving the published @nymbalhq/platform tarballs. Nothing real is fetched.

vi.setConfig({ testTimeout: 30_000 })

const BASE = '1.8.0'
const HEAD = '1.8.1'
const ADAPTER = '@acme/nymbal-search'
const FAILURE = `not certified ${ADAPTER} (search): 2 of 30 cases failed`
const TS_ALIAS = 'npm:@typescript/typescript6@^6.0.2'
const STORE_PRESET = 'github>nymbalhq/nymbal//renovate/store'
const AUTO_UPDATES_PRESET = 'github>nymbalhq/nymbal//renovate/auto-updates'
const PUBLISHED_TAGS = ['0000_glorious_vision', '0001_tricky_glorian', '0028_tax_columns']
const NYMBAL = ['nymbal', '@nymbalhq/config', '@nymbalhq/platform', '@nymbalhq/sdk']

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

/** A store as create-nymbal-app writes it, at Nymbal version `v`, with `astro` at `astro`. */
function manifestAt(v: string, astro = '^7.4.0') {
  return {
    name: 'shop',
    private: true,
    type: 'module',
    dependencies: {
      nymbal: v,
      '@nymbalhq/config': v,
      '@nymbalhq/platform': v,
      '@nymbalhq/sdk': v,
      astro,
      [ADAPTER]: '1.0.0',
    },
    devDependencies: { typescript: TS_ALIAS },
    pnpm: {
      overrides: {
        nymbal: v,
        '@nymbalhq/config': v,
        // Declared, never installed top-level.
        '@nymbalhq/http': v,
        '@nymbalhq/platform': v,
        '@nymbalhq/sdk': v,
      },
    },
  }
}

const journalJson = (dialect: string, tags: string[]) =>
  JSON.stringify({
    version: '7',
    dialect,
    entries: tags.map((tag, idx) => ({
      idx,
      version: '6',
      when: 1776875073175 + idx,
      tag,
      breakpoints: true,
    })),
  })

// ─── fakes ──────────────────────────────────────────────────────────────────────────────────────────────────────────

async function listen(handler: (path: string, res: ServerResponse) => void) {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '').replace(/^\/+/, ''))
    requests.push(path)
    handler(path, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const { port } = server.address() as { port: number }
  return { base: `http://127.0.0.1:${port}/`, requests }
}

type AdapterStatus = 'passing' | 'failing'

/** The matrix with one row, for `stack`, listing the Nymbal set at that version and the store's adapter. */
async function matrixServer(stack: string, adapter: AdapterStatus = 'passing') {
  const packages = Object.fromEntries(
    [...NYMBAL, '@nymbalhq/http', '@nymbalhq/react', '@nymbalhq/stack'].map((n) => [n, stack]),
  )
  const body = JSON.stringify({
    schema: 1,
    generatedAt: '2026-11-21T03:00:00.000Z',
    stacks: {
      [stack]: {
        packages,
        adapters: {
          [ADAPTER]:
            adapter === 'failing'
              ? { version: '1.0.0', status: 'failing', line: FAILURE }
              : { version: '1.0.0', status: 'passing', line: '30 cases passed' },
        },
      },
    },
  })
  const fake = await listen((_path, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  return { url: `${fake.base}matrix.json`, requests: fake.requests }
}

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512)
  h.write(name, 0, 100, 'utf8')
  h.write('0000644\0', 100)
  h.write('0000000\0', 108)
  h.write('0000000\0', 116)
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  h.write('00000000000\0', 136)
  h.write('        ', 148)
  h.write('0', 156)
  h.write('ustar\0', 257)
  h.write('00', 263)
  let sum = 0
  for (const byte of h) sum += byte
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return h
}

function platformTarball(version: string): Buffer {
  const files: Array<[string, string]> = [
    ['package/package.json', JSON.stringify({ name: '@nymbalhq/platform', version })],
    ['package/migrations/sqlite/meta/_journal.json', journalJson('sqlite', PUBLISHED_TAGS)],
    ['package/migrations/postgres/meta/_journal.json', journalJson('postgresql', PUBLISHED_TAGS)],
  ]
  const blocks: Buffer[] = []
  for (const [name, body] of files) {
    const data = Buffer.from(body)
    blocks.push(tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** The registry: @nymbalhq/platform's packument for BASE and HEAD, each with a tarball of PUBLISHED_TAGS. */
async function registryServer(status = 200) {
  let base = ''
  const fake = await listen((path, res) => {
    if (status !== 200) {
      res.writeHead(status).end('registry failure')
      return
    }
    if (path === '@nymbalhq/platform') {
      const versions = Object.fromEntries(
        [BASE, HEAD].map((v) => [
          v,
          { name: path, version: v, dist: { tarball: `${base}tarballs/platform-${v}.tgz` } },
        ]),
      )
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ name: path, versions }))
      return
    }
    const tgz = /^tarballs\/platform-(.+)\.tgz$/.exec(path)
    if (tgz) {
      res
        .writeHead(200, { 'content-type': 'application/octet-stream' })
        .end(platformTarball(tgz[1]!))
      return
    }
    res.writeHead(404).end()
  })
  base = fake.base
  return { url: fake.base, requests: fake.requests }
}

// ─── the store ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface StoreOptions {
  /** renovate.json at both commits: an object, raw text, or null for none. */
  renovate?: object | string | null
  baseManifest?: object
  /** The head's package.json; null keeps the base's and changes only a source file. */
  headManifest?: object | null
  /** What the head installed: name to version. */
  installed?: Record<string, string>
  /** The journal tags of the installed @nymbalhq/platform. */
  headTags?: string[]
  ownMigrations?: boolean
}

function git(cwd: string, ...args: string[]): { status: number | null; stdout: string } {
  const run = spawnSync(
    'git',
    [
      '-c',
      'user.email=store@shop.test',
      '-c',
      'user.name=store',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  )
  if (run.status !== 0 && args[0] !== 'status') {
    throw new Error(`git ${args.join(' ')} in ${cwd}: ${run.stderr}`)
  }
  return { status: run.status, stdout: run.stdout }
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

function store(options: StoreOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-update-check-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'shop')
  mkdirSync(join(dir, 'src'), { recursive: true })
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }

  const renovate =
    options.renovate === undefined ? { extends: [AUTO_UPDATES_PRESET] } : options.renovate
  write('.gitignore', 'node_modules\n')
  write('package.json', json(options.baseManifest ?? manifestAt(BASE)))
  write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n# resolved at the base\n")
  write('src/index.ts', 'export const greeting = "hello"\n')
  if (renovate !== null)
    write('renovate.json', typeof renovate === 'string' ? renovate : json(renovate))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'base')

  const head = options.headManifest === undefined ? manifestAt(HEAD) : options.headManifest
  if (head === null) {
    write('src/index.ts', 'export const greeting = "hello, world"\n')
  } else {
    write('package.json', json(head))
    write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n# resolved at the head\n")
  }
  if (options.ownMigrations) write('migrations/0000_mine.sql', 'CREATE TABLE mine (id integer);\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'head')

  const installed = options.installed ?? {
    nymbal: HEAD,
    '@nymbalhq/config': HEAD,
    '@nymbalhq/platform': HEAD,
    '@nymbalhq/sdk': HEAD,
    astro: '7.4.2',
    [ADAPTER]: '1.0.0',
  }
  for (const [name, version] of Object.entries(installed)) {
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, version }))
  }
  const tags = options.headTags ?? PUBLISHED_TAGS
  write(
    'node_modules/@nymbalhq/platform/migrations/sqlite/meta/_journal.json',
    journalJson('sqlite', tags),
  )
  write(
    'node_modules/@nymbalhq/platform/migrations/postgres/meta/_journal.json',
    journalJson('postgresql', tags),
  )
  return dir
}

async function updateCheck(
  cwd: string,
  urls: { matrix: string; registry: string },
  args: string[] = [],
  how: 'in-process' | 'spawned' = 'in-process',
) {
  const run = await (how === 'spawned' ? runCli : runInProcess)(['update-check', ...args], {
    cwd,
    env: cliEnv({
      NYMBAL_MATRIX_URL: urls.matrix,
      npm_config_registry: urls.registry,
      NO_COLOR: '1',
    }),
  })
  const errors = stripAnsi(run.stderr)
  return {
    ...run,
    printed: stripAnsi(run.stdout),
    errors,
    refusals: errors.split('\n').filter((line) => line.startsWith('update-check: refused:')),
  }
}

const porcelain = (dir: string) => git(dir, 'status', '--porcelain').stdout
/** What a write by the command would change: the commit checked out and the working tree's status. */
const checkoutState = (dir: string) => ({
  head: git(dir, 'rev-parse', 'HEAD').stdout,
  status: porcelain(dir),
})

// ─── AC-8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("AC-8: a release the nightly found breaks the store's adapter does not merge itself", () => {
  it('AC-8: the head row fails the declared adapter: exit 1, refused naming adapter, version, status and failure line, and the checkout is untouched', async () => {
    const matrix = await matrixServer(HEAD, 'failing')
    const registry = await registryServer()
    const dir = store()
    const before = checkoutState(dir)

    const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url })

    expect(run.code, run.out).toBe(1)
    expect(
      run.refusals.filter(
        (l) =>
          l.includes(ADAPTER) &&
          l.includes('1.0.0') &&
          l.includes('failing') &&
          l.includes(FAILURE),
      ),
      run.out,
    ).toHaveLength(1)
    expect(porcelain(dir)).toBe('')
    expect(before).toEqual(checkoutState(dir))
  })
})

// ─── AC-9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-9: the base is the commit before, and the journals compared are its published ones', () => {
  it('AC-9: the Nymbal set moved 1.8.0 to 1.8.1 with every fact clean: exit 0, "update-check: may merge", the checkout untouched', async () => {
    const matrix = await matrixServer(HEAD)
    const registry = await registryServer()
    const dir = store()
    const before = checkoutState(dir)

    const run = await updateCheck(
      dir,
      { matrix: matrix.url, registry: registry.url },
      [],
      'spawned',
    )

    expect(run.code, run.out).toBe(0)
    expect(run.printed).toContain('update-check: may merge')
    expect(porcelain(dir)).toBe('')
    expect(before).toEqual(checkoutState(dir))
  })

  it("AC-9: a head journal holding one tag more than the base's published one: exit 1, refused naming that tag", async () => {
    const matrix = await matrixServer(HEAD)
    const registry = await registryServer()
    const dir = store({ headTags: [...PUBLISHED_TAGS, '0029_x'] })

    const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url })

    expect(run.code, run.out).toBe(1)
    expect(
      run.refusals.filter((l) => l.includes('0029_x')),
      run.out,
    ).toHaveLength(1)
  })

  it('AC-9: base and head on the same platform version (a third-party patch only): may merge, and the registry receives no request', async () => {
    const matrix = await matrixServer(HEAD)
    const registry = await registryServer()
    const dir = store({
      baseManifest: manifestAt(HEAD, '^7.4.0'),
      headManifest: manifestAt(HEAD, '^7.4.2'),
    })

    const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url })

    expect(run.code, run.out).toBe(0)
    expect(run.printed).toContain('update-check: may merge')
    expect(registry.requests).toEqual([])
  })
})

// ─── AC-10 ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-10: off means no network, and every fact that cannot be read refuses', () => {
  it.each([
    {
      label: 'renovate.json extending only the store preset',
      renovate: { extends: [STORE_PRESET] },
    },
    { label: 'no renovate.json', renovate: null },
  ])(
    'AC-10: $label, with the Nymbal set moved: exit 0, "update-check: auto-updates off", and neither the matrix nor the registry is asked',
    async ({ renovate }) => {
      const matrix = await matrixServer(HEAD, 'failing')
      const registry = await registryServer()
      const dir = store({ renovate })

      const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url })

      expect(run.code, run.out).toBe(0)
      expect(run.printed).toContain('update-check: auto-updates off')
      expect([matrix.requests, registry.requests]).toEqual([[], []])
    },
  )

  it('AC-10: the auto-updates preset and a head that changes only a source file: exit 0, "no dependency changed", no request', async () => {
    const matrix = await matrixServer(HEAD, 'failing')
    const registry = await registryServer()
    const dir = store({ baseManifest: manifestAt(HEAD), headManifest: null })

    const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url })

    expect(run.code, run.out).toBe(0)
    expect(run.printed).toContain('update-check: no dependency changed')
    expect([matrix.requests, registry.requests]).toEqual([[], []])
  })

  it('AC-10: a matrix server refusing connections: exit 1, refused "cannot read the compatibility matrix"', async () => {
    const registry = await registryServer()
    const dir = store()

    const run = await updateCheck(dir, {
      matrix: `http://127.0.0.1:${await closedPort()}/matrix.json`,
      registry: registry.url,
    })

    expect(run.code, run.out).toBe(1)
    expect(
      run.refusals.filter((l) => l.includes('cannot read the compatibility matrix')),
      run.out,
    ).toHaveLength(1)
  })

  it("AC-10: a registry answering 500 for the base's platform: exit 1 with that one reason", async () => {
    const matrix = await matrixServer(HEAD)
    const registry = await registryServer(500)
    const dir = store()

    const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url })

    expect(run.code, run.out).toBe(1)
    expect(run.refusals, run.out).toEqual([expect.stringMatching(/500|migrations/)])
    expect(run.printed).not.toContain('may merge')
  })

  it('AC-10: --base naming no commit: exit 1 with one reason, naming package.json', async () => {
    const matrix = await matrixServer(HEAD)
    const registry = await registryServer()
    const dir = store()

    const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url }, [
      '--base',
      'no-such-revision',
    ])

    expect(run.code, run.out).toBe(1)
    expect(run.refusals, run.out).toEqual([expect.stringContaining('package.json')])
  })

  it('AC-10: a project migrations/ folder: exit 1 with one reason, naming migrations', async () => {
    const matrix = await matrixServer(HEAD)
    const registry = await registryServer()
    const dir = store({ ownMigrations: true })

    const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url })

    expect(run.code, run.out).toBe(1)
    expect(run.refusals, run.out).toEqual([expect.stringContaining('migrations')])
  })

  it('AC-10: a renovate.json that is not JSON: exit 1, refused naming renovate.json', async () => {
    const matrix = await matrixServer(HEAD)
    const registry = await registryServer()
    const dir = store({ renovate: '{ "extends": [\n' })

    const run = await updateCheck(dir, { matrix: matrix.url, registry: registry.url })

    expect(run.code, run.out).toBe(1)
    expect(
      run.refusals.filter((l) => l.includes('renovate.json')),
      run.out,
    ).toHaveLength(1)
  })

  it('AC-10: no package.json in the current directory: exit 1, naming package.json', async () => {
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-update-check-empty-')))
    cleanup.push(() => rmSync(empty, { recursive: true, force: true }))
    const matrix = await matrixServer(HEAD)
    const registry = await registryServer()

    const run = await updateCheck(empty, { matrix: matrix.url, registry: registry.url })

    expect(run.code, run.out).toBe(1)
    expect(run.errors).toContain('package.json')
  })
})
