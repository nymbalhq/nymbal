import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cliEnv, closedPort, runCli, stripAnsi } from '../../../../tests/support/doctor.js'

// `nymbal upgrade` run for real against a store on disk: the built CLI (`pnpm build` first), a fake compatibility
// matrix over NYMBAL_MATRIX_URL, recording fakes for the package managers on PATH and for the store's own
// `node_modules/.bin/nymbal`. Nothing real is fetched or installed.

vi.setConfig({ testTimeout: 30_000 })

const CURRENT = '1.8.0'
const TARGET = '1.9.0'
const THIRD = '@acme/nymbal-search'
const FIRST = '@nymbalhq/search-typesense'
const OWN = '@acme/our-own-adapter'
const FAILURE = `not certified ${THIRD} (search): 2 of 30 cases failed`
const PAGE = '<h1>The merchant copied and edited this page</h1>\n'
const DOCTOR_NONE_PENDING = '3 applied, none pending'
const DOCTOR_PENDING = '2 pending: run `nymbal migrate`'

const NYMBAL_NAMES = ['nymbal', '@nymbalhq/platform', '@nymbalhq/sdk']

function manifestAt(version: string, firstParty: string, thirdParty: string) {
  const pins = { nymbal: version, '@nymbalhq/platform': version }
  return {
    name: 'shop',
    private: true,
    type: 'module',
    scripts: { build: 'nymbal build', dev: 'nymbal dev' },
    dependencies: {
      nymbal: version,
      '@nymbalhq/platform': version,
      '@nymbalhq/sdk': version,
      astro: '^5.0.0',
      [FIRST]: firstParty,
      [THIRD]: thirdParty,
      [OWN]: '0.4.0',
    },
    devDependencies: { typescript: '^5.0.0' },
    pnpm: { overrides: pins },
    overrides: pins,
  }
}

type Adapters = Record<string, { version: string | null; status: string; line?: string }>

const rowAt = (stack: string, adapters: Adapters) => ({
  packages: {
    nymbal: stack,
    '@nymbalhq/platform': stack,
    '@nymbalhq/sdk': stack,
    // A package of the stack this store does not declare: never added.
    '@nymbalhq/react': stack,
  },
  adapters,
})

const matrixOf = (stacks: Record<string, ReturnType<typeof rowAt>>) => ({
  schema: 1,
  generatedAt: '2026-11-09T03:00:00.000Z',
  stacks,
})

/** The compatible row: both of the store's certified adapters move, and an adapter it does not declare fails. */
const COMPATIBLE = matrixOf({
  [TARGET]: rowAt(TARGET, {
    [FIRST]: { version: '1.2.0', status: 'first-party' },
    [THIRD]: { version: '1.5.0', status: 'passing', line: '30 cases passed' },
    '@acme/elsewhere': { version: '9.9.9', status: 'failing', line: 'not ours' },
  }),
})

const BLOCKED = matrixOf({
  [TARGET]: rowAt(TARGET, { [THIRD]: { version: '2.0.0', status: 'failing', line: FAILURE } }),
})

const NOTHING_NEWER = matrixOf({ [CURRENT]: rowAt(CURRENT, {}) })

let cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn()
  cleanup = []
})

interface Reply {
  status: number
  body: string
}

async function matrixServer(reply: Reply | object) {
  const answer: Reply =
    'status' in reply && 'body' in reply
      ? (reply as Reply)
      : { status: 200, body: JSON.stringify(reply) }
  let hits = 0
  const server: Server = createServer((_req, res) => {
    hits += 1
    res.writeHead(answer.status, { 'content-type': 'application/json' })
    res.end(answer.body)
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
  return { url: `http://127.0.0.1:${port}/matrix.json`, hits: () => hits }
}

const MANAGERS = ['pnpm', 'npm', 'yarn', 'bun']

interface StoreOptions {
  lockfile?: string
  marker?: string
  /** What the fake package manager does to the store: moves nymbal to TARGET, or exits 0 without moving it, or fails. */
  install?: 'moves' | 'leaves' | 'fails'
  buildExit?: number
  doctorOutput?: string
  doctorExit?: number
}

const doctorJson = (detail: string) =>
  JSON.stringify({
    checks: [
      { name: 'config', status: 'ok', detail: 'valid' },
      { name: 'migrations', status: detail === DOCTOR_PENDING ? 'down' : 'ok', detail },
    ],
  })

/** A store on disk as `create-nymbal-app` leaves it, with the fakes that record every process it spawns. */
function store(options: StoreOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'nymbal-upgrade-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'shop')
  const bin = join(root, 'path-bin')
  const log = join(root, 'calls.log')
  const sawManifest = join(root, 'manifest-at-install.json')
  const doctorFile = join(root, 'doctor-output')
  const lockfile = options.lockfile ?? 'pnpm-lock.yaml'
  const lockPath = join(dir, lockfile)
  const nymbalPkg = join(dir, 'node_modules', 'nymbal', 'package.json')

  mkdirSync(join(dir, 'src', 'pages'), { recursive: true })
  mkdirSync(bin)
  mkdirSync(dirname(nymbalPkg), { recursive: true })
  const manifest = manifestAt(CURRENT, '1.1.0', '^1.0.0')
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(lockPath, 'lockfile before the upgrade\n')
  writeFileSync(join(dir, options.marker ?? 'astro.config.mjs'), 'export default {}\n')
  writeFileSync(join(dir, 'src', 'pages', 'index.astro'), PAGE)
  writeFileSync(nymbalPkg, JSON.stringify({ name: 'nymbal', version: CURRENT }))
  for (const [name, version] of [
    [FIRST, '1.1.0'],
    [THIRD, '1.0.0'],
  ] as const) {
    const at = join(dir, 'node_modules', name, 'package.json')
    mkdirSync(dirname(at), { recursive: true })
    writeFileSync(at, JSON.stringify({ name, version }))
  }

  const install = options.install ?? 'moves'
  const effect =
    install === 'fails'
      ? ['exit 1']
      : install === 'leaves'
        ? ['exit 0']
        : [
            `printf '{"name":"nymbal","version":"${TARGET}"}' > node_modules/nymbal/package.json`,
            'exit 0',
          ]
  for (const manager of MANAGERS) {
    const script = [
      '#!/bin/sh',
      `printf '%s %s\\n' '${manager}' "$*" >> '${log}'`,
      `cp package.json '${sawManifest}'`,
      // Every real install rewrites the lockfile, including one that goes on to fail.
      `printf 'rewritten by the package manager\\n' >> '${lockfile}'`,
      ...effect,
      '',
    ]
    writeFileSync(join(bin, manager), script.join('\n'))
    chmodSync(join(bin, manager), 0o755)
  }

  writeFileSync(doctorFile, options.doctorOutput ?? doctorJson(DOCTOR_NONE_PENDING))
  const localBin = join(dir, 'node_modules', '.bin', 'nymbal')
  mkdirSync(dirname(localBin), { recursive: true })
  writeFileSync(
    localBin,
    [
      '#!/bin/sh',
      `printf 'nymbal %s\\n' "$*" >> '${log}'`,
      'case "$1" in',
      `  build) exit ${options.buildExit ?? 0} ;;`,
      `  doctor) cat '${doctorFile}'; exit ${options.doctorExit ?? 0} ;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(localBin, 0o755)

  const manifestFile = join(dir, 'package.json')
  return {
    dir,
    manifest,
    manifestFile,
    lockPath,
    lockfile,
    pageFile: join(dir, 'src', 'pages', 'index.astro'),
    env: (matrixUrl: string, extra: Record<string, string | undefined> = {}) =>
      cliEnv({
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        NYMBAL_MATRIX_URL: matrixUrl,
        NO_COLOR: '1',
        ...extra,
      }),
    calls: () =>
      (existsSync(log) ? readFileSync(log, 'utf8') : '').split('\n').filter((line) => line !== ''),
    bytes: () => ({
      manifest: readFileSync(manifestFile),
      lockfile: readFileSync(lockPath),
    }),
    read: () => JSON.parse(readFileSync(manifestFile, 'utf8')) as typeof manifest,
    manifestAtInstall: () => JSON.parse(readFileSync(sawManifest, 'utf8')) as typeof manifest,
  }
}

type Store = ReturnType<typeof store>

/** Runs the command in the store and returns the run with its streams free of colour codes. */
async function upgrade(s: Store, matrixUrl: string, args: string[] = [], extra = {}) {
  const run = await runCli(['upgrade', ...args], {
    cwd: s.dir,
    env: s.env(matrixUrl, extra),
  })
  return { ...run, out: run.out, errors: stripAnsi(run.stderr), printed: stripAnsi(run.stdout) }
}

function expectUntouched(s: Store, before: { manifest: Buffer; lockfile: Buffer }) {
  expect(readFileSync(s.manifestFile).equals(before.manifest)).toBe(true)
  expect(readFileSync(s.lockPath).equals(before.lockfile)).toBe(true)
}

describe('AC-7: a matrix that fails a declared third-party adapter refuses the upgrade', () => {
  it.each([
    { label: 'no flag', args: [] as string[] },
    { label: '--force', args: ['--force'] },
  ])(
    'AC-7: the only newer row fails the adapter: exit 1 naming adapter, version, status and failure line, files byte-identical, nothing spawned ($label)',
    async ({ args }) => {
      const matrix = await matrixServer(BLOCKED)
      const s = store()
      const before = s.bytes()

      const run = await upgrade(s, matrix.url, args)

      expect(run.code, run.out).toBe(1)
      expect(run.errors).toContain('refused')
      expect(run.errors).toContain(CURRENT)
      expect(run.errors).toContain(`${TARGET}: ${THIRD} 2.0.0 failing: ${FAILURE}`)
      expectUntouched(s, before)
      expect(s.calls()).toEqual([])
      expect(matrix.hits()).toBe(1)
    },
  )
})

describe('AC-8: an unreadable matrix refuses and changes nothing', () => {
  it.each([
    { name: 'a server refusing connections', reply: undefined },
    { name: 'a 404', reply: { status: 404, body: 'not found' } },
    { name: 'a 500', reply: { status: 500, body: 'oops' } },
    { name: 'invalid JSON', reply: { status: 200, body: '{not json' } },
    {
      name: 'a matrix parseMatrix rejects (a package value that is a path)',
      reply: {
        status: 200,
        body: JSON.stringify({
          schema: 1,
          generatedAt: '2026-11-09T03:00:00.000Z',
          stacks: { [TARGET]: { packages: { nymbal: 'file:../x' }, adapters: {} } },
        }),
      },
    },
    {
      name: 'a matrix of another schema',
      reply: { status: 200, body: JSON.stringify({ schema: 2, stacks: {} }) },
    },
  ])('AC-8: $name exits 1 naming the matrix and its URL, and writes nothing', async ({ reply }) => {
    const url =
      reply === undefined
        ? `http://127.0.0.1:${await closedPort()}/matrix.json`
        : (await matrixServer(reply)).url
    const s = store()
    const before = s.bytes()

    const run = await upgrade(s, url)

    expect(run.code, run.out).toBe(1)
    expect(run.errors).toContain('cannot read the compatibility matrix')
    expect(run.errors).toContain(url)
    expectUntouched(s, before)
    expect(s.calls()).toEqual([])
  })
})

/** The manifest after a clean upgrade: Nymbal names at the target in all three places, certified adapters moved. */
function upgradedManifest(s: Store) {
  const expected = structuredClone(s.manifest)
  for (const name of NYMBAL_NAMES) {
    expected.dependencies[name as keyof typeof expected.dependencies] = TARGET
  }
  expected.pnpm.overrides = { nymbal: TARGET, '@nymbalhq/platform': TARGET }
  expected.overrides = { nymbal: TARGET, '@nymbalhq/platform': TARGET }
  expected.dependencies[FIRST as keyof typeof expected.dependencies] = '1.2.0'
  expected.dependencies[THIRD as keyof typeof expected.dependencies] = '1.5.0'
  return expected
}

describe('AC-9: a compatible row moves the store to the new versions', () => {
  it('AC-9: every Nymbal name and certified adapter moves in every section, nothing else changes, install follows the write and the local build follows the install', async () => {
    const matrix = await matrixServer(COMPATIBLE)
    const s = store()
    const pageBefore = readFileSync(s.pageFile)

    const run = await upgrade(s, matrix.url)

    expect(run.code, run.out).toBe(0)
    expect(run.printed).toContain(`upgraded to ${TARGET}`)
    const expected = upgradedManifest(s)
    expect(readFileSync(s.manifestFile, 'utf8')).toBe(`${JSON.stringify(expected, null, 2)}\n`)
    expect(s.manifestAtInstall()).toEqual(expected)
    expect(readFileSync(s.pageFile).equals(pageBefore)).toBe(true)
    expect(s.calls()).toEqual([
      'pnpm install --no-frozen-lockfile',
      'nymbal build',
      'nymbal doctor --json',
    ])
  })
})

describe('AC-3: an upgrade that passes over a release says so', () => {
  it('AC-3: the newest row fails an adapter and a lower row is compatible: the store lands on the lower row and stdout names the held row and the adapter with no suite', async () => {
    const matrix = await matrixServer(
      matrixOf({
        '1.10.0': rowAt('1.10.0', {
          [THIRD]: { version: '2.0.0', status: 'failing', line: FAILURE },
        }),
        [TARGET]: rowAt(TARGET, {
          [THIRD]: { version: '1.5.0', status: 'passing', line: '30 cases passed' },
          [OWN]: { version: '0.9.0', status: 'no-suite' },
        }),
      }),
    )
    const s = store()

    const run = await upgrade(s, matrix.url)

    expect(run.code, run.out).toBe(0)
    const lines = run.printed.split('\n')
    expect(lines).toContain(`1.10.0 held back: ${THIRD} failing`)
    expect(lines).toContain(`not certified: ${OWN}`)
    expect(lines).toContain(`upgraded to ${TARGET}`)
    expect(s.read().dependencies.nymbal).toBe(TARGET)
    expect(s.read().dependencies[OWN]).toBe('0.4.0')
  })
})

describe('AC-10: the lockfile picks the package manager', () => {
  it.each([
    { lockfile: 'pnpm-lock.yaml', command: 'pnpm install --no-frozen-lockfile' },
    { lockfile: 'yarn.lock', command: 'yarn install' },
    { lockfile: 'bun.lock', command: 'bun install' },
    { lockfile: 'package-lock.json', command: 'npm install' },
  ])(
    'AC-10: a store with $lockfile runs "$command" even under npm\'s user agent',
    async ({ lockfile, command }) => {
      const matrix = await matrixServer(COMPATIBLE)
      const s = store({ lockfile })

      const run = await upgrade(s, matrix.url, [], {
        npm_config_user_agent: 'npm/11.0.0 node/v26.12.1 darwin arm64',
      })

      expect(run.code, run.out).toBe(0)
      expect(s.calls().filter((call) => !call.startsWith('nymbal '))).toEqual([command])
    },
  )
})

describe("AC-11: build and the migration read go through the store's own CLI", () => {
  it.each([
    { label: 'nothing pending, doctor exit 0', detail: DOCTOR_NONE_PENDING, doctorExit: 0 },
    { label: 'a migration pending, doctor exit 1', detail: DOCTOR_PENDING, doctorExit: 1 },
  ])(
    'AC-11: $label: the local nymbal runs build then doctor, the detail prints verbatim, and migrate is never spawned',
    async ({ detail, doctorExit }) => {
      const matrix = await matrixServer(COMPATIBLE)
      const s = store({ doctorOutput: doctorJson(detail), doctorExit })

      const run = await upgrade(s, matrix.url)

      expect(run.code, run.out).toBe(0)
      expect(run.printed).toContain(`migrations: ${detail}`)
      expect(s.calls().filter((call) => call.startsWith('nymbal '))).toEqual([
        'nymbal build',
        'nymbal doctor --json',
      ])
    },
  )
})

describe('AC-12: a doctor that says nothing readable leaves the upgrade finished', () => {
  it.each([
    { label: 'not JSON', output: 'doctor crashed', doctorExit: 1 },
    { label: 'no output at all', output: '', doctorExit: 1 },
    {
      label: 'JSON with no migrations check',
      output: JSON.stringify({ checks: [{ name: 'config', status: 'ok', detail: 'valid' }] }),
      doctorExit: 0,
    },
  ])('AC-12: $label prints the hint and exits 0', async ({ output, doctorExit }) => {
    const matrix = await matrixServer(COMPATIBLE)
    const s = store({ doctorOutput: output, doctorExit })

    const run = await upgrade(s, matrix.url)

    expect(run.code, run.out).toBe(0)
    expect(run.printed).toContain('run nymbal doctor')
    expect(run.printed).toContain(`upgraded to ${TARGET}`)
  })
})

describe('AC-13: a failed install undoes the upgrade', () => {
  it('AC-13: exit 1, package.json and the lockfile byte-identical to before, and no build spawned', async () => {
    const matrix = await matrixServer(COMPATIBLE)
    const s = store({ install: 'fails' })
    const before = s.bytes()

    const run = await upgrade(s, matrix.url)

    expect(run.code, run.out).toBe(1)
    expect(run.errors).toContain('install failed')
    expect(run.errors).toMatch(/restored/i)
    expectUntouched(s, before)
    expect(s.calls()).toEqual(['pnpm install --no-frozen-lockfile'])
  })
})

describe('AC-14: a failed build leaves the upgrade in place and says how to go back', () => {
  it("AC-14: exit 1 with package.json upgraded, no doctor spawned, and a message naming the previous version, both files, every edited name's previous value and the install that must follow", async () => {
    const matrix = await matrixServer(COMPATIBLE)
    const s = store({ buildExit: 1 })

    const run = await upgrade(s, matrix.url)

    expect(run.code, run.out).toBe(1)
    expect(s.read()).toEqual(upgradedManifest(s))
    expect(s.calls()).toEqual(['pnpm install --no-frozen-lockfile', 'nymbal build'])
    expect(run.errors).toContain('build failed')
    expect(run.errors).toContain(CURRENT)
    expect(run.errors).toContain(`git restore package.json ${s.lockfile}`)
    expect(run.errors).toContain('pnpm install')
    const previous: Record<string, string> = {
      nymbal: CURRENT,
      '@nymbalhq/platform': CURRENT,
      '@nymbalhq/sdk': CURRENT,
      [FIRST]: '1.1.0',
      [THIRD]: '^1.0.0',
    }
    for (const [name, value] of Object.entries(previous)) {
      expect(run.errors).toContain(`${name} ${value}`)
    }
  })
})

describe('AC-15: a directory that is not a store is refused before the matrix is fetched', () => {
  it.each([
    {
      name: 'no marker file',
      sabotage: (s: Store) => rmSync(join(s.dir, 'astro.config.mjs')),
    },
    {
      name: 'no package.json',
      sabotage: (s: Store) => rmSync(s.manifestFile),
    },
    {
      name: 'no node_modules/nymbal',
      sabotage: (s: Store) =>
        renameSync(join(s.dir, 'node_modules', 'nymbal'), join(s.dir, 'nymbal-moved')),
    },
  ])(
    'AC-15: $name exits 1 with no fetch, where the same store whole reaches the matrix',
    async ({ sabotage }) => {
      const matrix = await matrixServer(NOTHING_NEWER)
      const s = store()
      const whole = await upgrade(s, matrix.url)
      const fetchesWhenWhole = matrix.hits()
      expect(whole.code, whole.out).toBe(0)
      expect(fetchesWhenWhole).toBe(1)

      sabotage(s)
      const run = await upgrade(s, matrix.url)

      expect(run.code, run.out).toBe(1)
      expect(matrix.hits()).toBe(fetchesWhenWhole)
      expect(s.calls()).toEqual([])
    },
  )

  it('AC-15: a store whose only marker is next.config.mjs passes the check, reaches the matrix and reports no newer release', async () => {
    const matrix = await matrixServer(NOTHING_NEWER)
    const s = store({ marker: 'next.config.mjs' })
    const before = s.bytes()

    const run = await upgrade(s, matrix.url)

    expect(run.code, run.out).toBe(0)
    expect(matrix.hits()).toBe(1)
    expect(run.printed).toContain('no newer release')
    expect(run.printed).toContain(CURRENT)
    expectUntouched(s, before)
  })
})

describe('AC-22: an install that did not move the store is a failed install', () => {
  it('AC-22: the manager exits 0 but nymbal stays at the old version: exit 1, never reports an upgrade, restores both files, no build spawned', async () => {
    const matrix = await matrixServer(COMPATIBLE)
    const s = store({ install: 'leaves' })
    const before = s.bytes()

    const run = await upgrade(s, matrix.url)

    expect(run.code, run.out).toBe(1)
    expect(run.errors).toContain(`nymbal is at ${CURRENT}, not ${TARGET}`)
    expect(run.errors).toMatch(/restored/i)
    expect(run.out).not.toContain('upgraded to')
    expectUntouched(s, before)
    expect(s.calls()).toEqual(['pnpm install --no-frozen-lockfile'])
  })
})
