// Reads: scripts/registry/**, package.json, .node-version, tests/fixtures/third-party-search/**, tests/fixtures/third-party-search-*/**
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { validateManifest } from '../../scripts/registry/manifest'
import { badgePath } from '../../scripts/registry/site'
import type { EntryHistory } from '../../scripts/registry/status'

// The nightly registry run end to end, through `pnpm registry`, the real sandbox (Docker) and the workspace CLI
// (`pnpm build` first), on third-party entries copied out of tests/fixtures: one well-behaved, one broken, one whose
// directory is gone, and, in a run of its own with a short bound, one that hangs. The 7-day clock is carried by the
// seeded history and `--now`.

const REPO = fileURLToPath(new URL('../..', import.meta.url))
const FIXTURES = join(REPO, 'tests', 'fixtures')
const NODE_VERSION = readFileSync(join(REPO, '.node-version'), 'utf8').trim()
const DAY = 24 * 3600 * 1000
const NOW = '2026-10-31T03:00:00.000Z'
const ago = (days: number) => new Date(Date.parse(NOW) - days * DAY).toISOString()
/** The bound a full search suite certifies within (the certify test's own, test-contracts-package.test.ts). */
const CERTIFY_TIMEOUT_S = 150
/** A short bound for the hanging entry, so proving the bound costs seconds, not the certify bound. */
const HANG_TIMEOUT_S = 20

const GOOD = '@acme/nymbal-search'
const BROKEN = '@acme/nymbal-search-broken'
const MISSING = '@acme/nymbal-search-missing'
const HANGING = '@acme/nymbal-search-hanging'
const GONE = '@acme/nymbal-search-gone'
const PACKAGES = [GOOD, BROKEN, MISSING]
/** The files the broken twin's install, prepare and prepack scripts would leave. */
const MARKER = /^script-ran-/

const scratch: string[] = []
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const f of readdirSync(REPO)) if (MARKER.test(f)) rmSync(join(REPO, f), { force: true })
})

function testDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
  for (const key of Object.keys(env)) if (key.startsWith('VITEST')) delete env[key]
  delete env['NODE_OPTIONS']
  delete env['NODE_ENV']
  return env
}

function registry(args: string[], timeout: number) {
  const res = spawnSync('pnpm', ['--silent', 'registry', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: cleanEnv(),
    timeout,
  })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  return { status: res.status, out, lines: out.split('\n').filter((l) => l.trim() !== '') }
}

const entry = (pkg: string, provider: string, dir: string) => ({
  package: pkg,
  slot: 'search',
  provider,
  tier: 'community',
  maintainer: 'https://github.com/acme',
  source: { dir },
})

const pick = (h: Partial<EntryHistory> | undefined) =>
  h === undefined
    ? undefined
    : { status: h.status, failingSince: h.failingSince, lastRun: h.lastRun, line: h.line }

/** An entry's history in status.json, whichever way the run lays it out: nested under `history` or beside the entry. */
function statusIn(doc: unknown, pkg: string) {
  const list = (Array.isArray(doc) ? doc : (doc as { adapters?: unknown[] }).adapters) ?? []
  const found = (list as Array<Record<string, unknown>>).find((e) => e['package'] === pkg)
  if (found === undefined) return undefined
  return pick((found['history'] ?? found) as Partial<EntryHistory>)
}

/** Every file under `root` (not following links) whose name matches. */
function filesNamed(root: string, name: RegExp): string[] {
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((rel) =>
    name.test(rel.split(/[\\/]/).pop() ?? ''),
  )
}

/** A night's run over `adapters`, seeded with `seeded`: its result, the history it carried and status.json. */
function night(
  adapters: unknown[],
  seeded: Record<string, EntryHistory>,
  entryTimeoutS: number,
  timeout: number,
) {
  const dir = testDir('registry-night-')
  const work = join(dir, 'work')
  mkdirSync(work)
  const out = join(dir, 'site')
  const manifest = join(dir, 'adapters.json')
  writeFileSync(manifest, JSON.stringify({ adapters }))
  const history = join(dir, 'history.json')
  writeFileSync(history, `${JSON.stringify(seeded, null, 2)}\n`)
  const run = registry(
    [
      '--manifest',
      manifest,
      '--history',
      history,
      '--out',
      out,
      '--now',
      NOW,
      '--entry-timeout',
      String(entryTimeoutS),
      '--work',
      work,
    ],
    timeout,
  )
  const read = (file: string): unknown =>
    existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined
  return {
    run,
    work,
    out,
    carried: (read(history) ?? {}) as Record<string, EntryHistory>,
    page: read(join(out, 'status.json')),
  }
}

// The sandbox mounts the workspace, whose native modules are built for the host: Docker Desktop on macOS cannot load
// them in a Linux container, so this runs on Linux (dev CI's tooling-slow) only.
describe.runIf(process.platform === 'linux')('AC-5: the nightly registry run end to end', () => {
  beforeAll(() => {
    const image = `node:${NODE_VERSION}-bookworm-slim`
    const pull = spawnSync('docker', ['pull', image], { encoding: 'utf8', timeout: 300_000 })
    if (pull.status !== 0) throw new Error(`docker pull ${image}: ${pull.stderr}`)
  }, 310_000)

  it('AC-5: the run exits 0 with red adapters, carries the history (passing, failing, suspended), writes the page and a badge per entry, and runs no package script', () => {
    const copies = testDir('registry-fixtures-')
    cpSync(join(FIXTURES, 'third-party-search'), join(copies, 'search'), { recursive: true })
    cpSync(join(FIXTURES, 'third-party-search-broken'), join(copies, 'broken'), { recursive: true })
    const seeded: Record<string, EntryHistory> = {
      [GOOD]: {
        status: 'failing',
        failingSince: ago(3),
        lastRun: ago(1),
        line: `not certified ${GOOD} (search): 2 of 30 cases failed`,
      },
      [MISSING]: {
        status: 'failing',
        failingSince: ago(7),
        lastRun: ago(1),
        line: `not certified ${MISSING} (search): 2 of 30 cases failed`,
      },
    }
    const atRoot = () => readdirSync(REPO).filter((f) => MARKER.test(f))
    const rootBefore = atRoot()

    const { run, work, out, carried, page } = night(
      [
        entry(GOOD, 'acme', join(copies, 'search')),
        entry(BROKEN, 'acme-broken', join(copies, 'broken')),
        entry(MISSING, 'acme-missing', join(copies, 'missing')),
      ],
      seeded,
      CERTIFY_TIMEOUT_S,
      1_100_000,
    )

    expect(run.status, run.out.slice(-4000)).toBe(0)
    // The page and the carried history agree on every entry.
    expect(PACKAGES.map((p) => statusIn(page, p))).toEqual(PACKAGES.map((p) => pick(carried[p])))
    expect(PACKAGES.map((p) => carried[p]?.lastRun)).toEqual(PACKAGES.map(() => NOW))

    const good = carried[GOOD]!
    const broken = carried[BROKEN]!
    const missing = carried[MISSING]!
    expect({ status: good.status, failingSince: good.failingSince }, good.line).toEqual({
      status: 'passing',
      failingSince: null,
    })

    const notCertified = new RegExp(
      `^not certified ${BROKEN.replace('/', '\\/')} \\(search\\): (\\d+) of (\\d+) cases failed$`,
    ).exec(broken.line)
    expect({ status: broken.status, failingSince: broken.failingSince }, broken.line).toEqual({
      status: 'failing',
      failingSince: NOW,
    })
    expect(notCertified, broken.line).not.toBeNull()
    expect(Number(notCertified![1])).toBeGreaterThan(0)
    expect(Number(notCertified![1])).toBeLessThan(Number(notCertified![2]))

    expect({ status: missing.status, failingSince: missing.failingSince }, missing.line).toEqual({
      status: 'suspended',
      failingSince: seeded[MISSING]!.failingSince,
    })

    const html = readFileSync(join(out, 'index.html'), 'utf8')
    expect(
      filesNamed(join(out, 'badges'), /\.svg$/)
        .map((f) => `badges/${f}`)
        .sort(),
    ).toEqual(PACKAGES.map((p) => badgePath(p)).sort())
    expect(PACKAGES.filter((p) => !html.includes(badgePath(p)))).toEqual([])

    expect({
      copies: filesNamed(copies, MARKER),
      work: filesNamed(work, MARKER),
      root: atRoot(),
    }).toEqual({ copies: [], work: [], root: rootBefore })
  }, 1_200_000)

  it('AC-5: a hanging adapter is killed at the entry timeout, fails its night with the timed-out line, and the entry after it still runs', () => {
    const copies = testDir('registry-hanging-')
    cpSync(join(FIXTURES, 'third-party-search-hanging'), join(copies, 'hanging'), {
      recursive: true,
    })

    const { run, carried, page } = night(
      [
        entry(HANGING, 'acme-hanging', join(copies, 'hanging')),
        entry(GONE, 'acme-gone', join(copies, 'gone')),
      ],
      {},
      HANG_TIMEOUT_S,
      150_000,
    )

    expect(run.status, run.out.slice(-4000)).toBe(0)
    expect([HANGING, GONE].map((p) => statusIn(page, p))).toEqual(
      [HANGING, GONE].map((p) => pick(carried[p])),
    )
    expect(pick(carried[HANGING])).toEqual({
      status: 'failing',
      failingSince: NOW,
      lastRun: NOW,
      line: `timed out after ${HANG_TIMEOUT_S} s (certify)`,
    })
    expect({ status: carried[GONE]?.status, lastRun: carried[GONE]?.lastRun }).toEqual({
      status: 'failing',
      lastRun: NOW,
    })
  }, 180_000)
})

describe('AC-5: a bad manifest stops the run before it writes anything', () => {
  it('AC-5: an invalid manifest exits 1 with its validation line, writes no page and leaves the history byte-identical', () => {
    const dir = testDir('registry-invalid-')
    const bad = {
      adapters: [
        {
          package: '@nymbalhq/search-acme',
          slot: 'search',
          provider: 'acme',
          tier: 'community',
          maintainer: 'https://github.com/acme',
          source: { npm: '^1.0.0' },
        },
      ],
    }
    const manifest = join(dir, 'adapters.json')
    writeFileSync(manifest, JSON.stringify(bad))
    const history = join(dir, 'history.json')
    const seeded = `{"@acme/nymbal-search":{"status":"failing","failingSince":"${ago(2)}","lastRun":"${ago(1)}","line":"x"}}`
    writeFileSync(history, seeded)
    const before = readFileSync(history)
    const out = join(dir, 'site')
    mkdirSync(join(dir, 'work'))

    const run = registry(
      [
        '--manifest',
        manifest,
        '--history',
        history,
        '--out',
        out,
        '--now',
        NOW,
        '--work',
        join(dir, 'work'),
      ],
      60_000,
    )
    const expected: string[] = validateManifest(bad, REPO)

    expect(expected).toHaveLength(1)
    expect(run.status, run.out).toBe(1)
    expect(run.lines, run.out).toEqual(expected)
    expect(readFileSync(history).equals(before)).toBe(true)
    expect(existsSync(out)).toBe(false)
  }, 90_000)
})
