import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSentinel, run } from '../../scripts/sentinels'

// Acceptance tests for P0-01 (sentinel runner): AC-12 to AC-19.
// AC-13 to AC-18 build a throwaway git repo per test: a tiny module, a `node --test` suite that appends to a log
// outside the repo every time it runs, and sentinel files committed under `sentinels/`.
type Report = Awaited<ReturnType<typeof run>>
type Sentinel = ReturnType<typeof parseSentinel>
type SentinelResult = Report['sentinels'][number]

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SUITE = 'node --test'

const MATH_JS = `export function add(a, b) {
  return a + b
}

export function untested(x) {
  return x * 2
}
`

interface TempRepo {
  /** The git work tree. */
  root: string
  /** Absolute sentinel directory inside the work tree. */
  dir: string
  /** Log outside the work tree; the suite appends `run` each time it executes. */
  log: string
}

const created: string[] = []

afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
}

function makeRepo(opts: { green: boolean }): TempRepo {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-sentinels-')))
  created.push(base)
  const root = join(base, 'repo')
  const log = join(base, 'suite-runs.log')
  const dir = join(root, 'sentinels')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'test'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'sentinel-fixture', private: true, type: 'module' }, null, 2)}\n`,
  )
  writeFileSync(join(root, 'src/math.js'), MATH_JS)
  writeFileSync(
    join(root, 'test/math.test.js'),
    [
      "import { appendFileSync } from 'node:fs'",
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { add } from '../src/math.js'",
      '',
      `appendFileSync(${JSON.stringify(log)}, 'run\\n')`,
      '',
      "test('add', () => {",
      `  assert.equal(add(2, 3), ${opts.green ? 5 : 6})`,
      '})',
      '',
    ].join('\n'),
  )
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'sentinel@example.test')
  git(root, 'config', 'user.name', 'Sentinel Test')
  commitAll(root, 'base')
  return { root, dir, log }
}

function commitAll(root: string, message: string): void {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--allow-empty', '-m', message)
}

/** A unified diff for `file` after `transform`, produced by git; the file is restored byte for byte. */
function patchFor(repo: TempRepo, file: string, transform: (s: string) => string): string {
  const abs = join(repo.root, file)
  const original = readFileSync(abs, 'utf8')
  const changed = transform(original)
  expect(changed, `transform must change ${file}`).not.toBe(original)
  writeFileSync(abs, changed)
  const diff = git(repo.root, 'diff', '--', file)
  writeFileSync(abs, original)
  return diff
}

/** Breaks behaviour the suite tests: caught. */
function breakAdd(repo: TempRepo): string {
  return patchFor(repo, 'src/math.js', (s) => s.replace('return a + b', 'return a - b'))
}

/** Changes code no test reads: missed. */
function changeUntested(repo: TempRepo): string {
  return patchFor(repo, 'src/math.js', (s) => s.replace('return x * 2', 'return x * 3'))
}

/** Makes the suite write `patched` to the log when it runs with this patch applied. */
function markSuite(repo: TempRepo): string {
  return patchFor(repo, 'test/math.test.js', (s) =>
    s.replace(
      "'run\\n')",
      "'run\\n')\nappendFileSync(" + JSON.stringify(repo.log) + ", 'patched\\n')",
    ),
  )
}

/** Creates a new untested file: missed, and a leak if left behind. */
const CREATE_EXTRA = `diff --git a/src/extra.js b/src/extra.js
new file mode 100644
--- /dev/null
+++ b/src/extra.js
@@ -0,0 +1 @@
+export const extra = 1
`

/** Modifies a file that does not exist: does not apply. */
const DOES_NOT_APPLY = `diff --git a/src/missing.js b/src/missing.js
--- a/src/missing.js
+++ b/src/missing.js
@@ -1 +1 @@
-export const missing = 1
+export const missing = 2
`

function writeSentinel(
  repo: TempRepo,
  s: { id: string; kind: 'present' | 'injected'; patch?: string },
): void {
  const header = [
    `# id: ${s.id}`,
    `# kind: ${s.kind}`,
    `# defect: defect of ${s.id}`,
    '# where: src/math.js:1',
    '# killed-by: test/math.test.js',
    '',
  ].join('\n')
  writeFileSync(join(repo.dir, `${s.id}-fixture.patch`), header + (s.patch ?? ''))
}

/** Every tracked path with its content hash, the porcelain status (untracked included) and HEAD. */
function snapshot(root: string): { files: Record<string, string>; status: string; head: string } {
  const files: Record<string, string> = {}
  for (const p of git(root, 'ls-files').split('\n').filter(Boolean)) {
    files[p] = createHash('sha256')
      .update(readFileSync(join(root, p)))
      .digest('hex')
  }
  return {
    files,
    status: git(root, 'status', '--porcelain', '--untracked-files=all'),
    head: git(root, 'rev-parse', 'HEAD').trim(),
  }
}

function readLog(repo: TempRepo): string {
  return existsSync(repo.log) ? readFileSync(repo.log, 'utf8') : ''
}

function statuses(report: Report): Record<string, string> {
  return Object.fromEntries(report.sentinels.map((s: SentinelResult) => [s.id, s.status]))
}

describe('AC-12: parseSentinel', () => {
  const DIFF = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1 +1 @@',
    '-export const a = 1',
    '+export const a = 2',
    '',
  ].join('\n')

  it('AC-12: reads every header field and the diff of an injected sentinel', () => {
    const text = [
      '# id: I042',
      '# kind: injected',
      '# defect: a is one too high',
      '# where: src/a.js:1',
      '# killed-by: test/a.test.js',
      '# suite: node --test',
      DIFF,
    ].join('\n')
    const parsed: Sentinel = parseSentinel(text, 'sentinels/I042-a.patch')
    expect(parsed).toMatchObject({
      id: 'I042',
      kind: 'injected',
      defect: 'a is one too high',
      where: 'src/a.js:1',
      killedBy: 'test/a.test.js',
      suite: 'node --test',
    })
    expect(parsed.patch.trim()).toBe(DIFF.trim())
  })

  it('AC-12: a header-only present sentinel has an empty patch and no suite', () => {
    const text = [
      '# id: S042',
      '# kind: present',
      '# defect: b is live',
      '# where: src/b.js:3-9',
      '# killed-by: P1-02 acceptance tests',
      '',
    ].join('\n')
    const parsed = parseSentinel(text, 'sentinels/S042-b.patch')
    expect(parsed).toMatchObject({
      id: 'S042',
      kind: 'present',
      defect: 'b is live',
      where: 'src/b.js:3-9',
      killedBy: 'P1-02 acceptance tests',
    })
    expect(parsed.suite).toBeUndefined()
    expect(parsed.patch.trim()).toBe('')
  })

  it.each([
    ['id', 'sentinels/no-id.patch'],
    ['kind', 'sentinels/no-kind.patch'],
  ])('AC-12: a sentinel missing %s throws an error naming the file', (field, file) => {
    const lines = [
      '# id: I043',
      '# kind: injected',
      '# defect: c',
      '# where: src/c.js:1',
      '# killed-by: test/c.test.js',
    ].filter((l) => !l.startsWith(`# ${field}:`))
    expect(() => parseSentinel([...lines, DIFF].join('\n'), file)).toThrow(file)
  })
})

describe('AC-13: a red control', () => {
  it('AC-13: run rejects with "control red" and runs no sentinel', async () => {
    const repo = makeRepo({ green: false })
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: markSuite(repo) })
    commitAll(repo.root, 'sentinels')
    const before = snapshot(repo.root)

    await expect(run({ root: repo.root, dir: repo.dir, suite: SUITE })).rejects.toThrow(
      /control red/,
    )

    const log = readLog(repo)
    expect(log, 'the control ran the suite').toContain('run')
    expect(log, 'no sentinel ran').not.toContain('patched')
    expect(snapshot(repo.root)).toEqual(before)
  })
})

describe('AC-14: a dirty tracked tree', () => {
  it('AC-14: run refuses before running anything and leaves the uncommitted edit in place', async () => {
    const repo = makeRepo({ green: true })
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
    commitAll(repo.root, 'sentinels')
    appendFileSync(join(repo.root, 'src/math.js'), '// uncommitted local edit\n')
    const dirty = readFileSync(join(repo.root, 'src/math.js'), 'utf8')
    const before = snapshot(repo.root)

    await expect(run({ root: repo.root, dir: repo.dir, suite: SUITE })).rejects.toThrow()

    expect(existsSync(repo.log), 'the suite must not run, not even the control').toBe(false)
    expect(readFileSync(join(repo.root, 'src/math.js'), 'utf8')).toBe(dirty)
    expect(snapshot(repo.root)).toEqual(before)
  })
})

describe('AC-15 and AC-16: caught, missed and error', () => {
  function scenario(): TempRepo {
    const repo = makeRepo({ green: true })
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
    writeSentinel(repo, { id: 'I002', kind: 'injected', patch: changeUntested(repo) })
    writeSentinel(repo, { id: 'I003', kind: 'injected', patch: DOES_NOT_APPLY })
    writeSentinel(repo, { id: 'I004', kind: 'injected', patch: CREATE_EXTRA })
    commitAll(repo.root, 'sentinels')
    return repo
  }

  it('AC-15: a tested break is caught, an untested change is missed, a non-applying patch is error and in neither total', async () => {
    const repo = scenario()
    const report = await run({ root: repo.root, dir: repo.dir, suite: SUITE })

    expect(report.control).toBe('green')
    expect(statuses(report)).toEqual({
      I001: 'caught',
      I002: 'missed',
      I003: 'error',
      I004: 'missed',
    })
    expect(report.summary.injected).toEqual({ caught: 1, total: 3 })
    const counted = report.sentinels.filter(
      (s: SentinelResult) => s.kind === 'injected' && s.status !== 'error',
    )
    expect(report.summary.injected.total).toBe(counted.length)
    expect(report.summary.injected.caught).toBe(
      counted.filter((s: SentinelResult) => s.status === 'caught').length,
    )
  })

  it('AC-16: after caught, missed and error sentinels every tracked file is byte-identical and nothing is left behind', async () => {
    const repo = scenario()
    const before = snapshot(repo.root)

    await run({ root: repo.root, dir: repo.dir, suite: SUITE })

    expect(snapshot(repo.root)).toEqual(before)
    expect(existsSync(join(repo.root, 'src/extra.js'))).toBe(false)
  })
})

describe('AC-17: present sentinels', () => {
  it('AC-17: a present sentinel applies nothing, is missed while the control is green, and is summarised apart from injected', async () => {
    const repo = makeRepo({ green: true })
    writeSentinel(repo, { id: 'S001', kind: 'present' })
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
    commitAll(repo.root, 'sentinels')
    const before = snapshot(repo.root)

    const report = await run({ root: repo.root, dir: repo.dir, suite: SUITE })

    expect(report.control).toBe('green')
    expect(statuses(report)).toEqual({ S001: 'missed', I001: 'caught' })
    expect(report.summary.present).toEqual({ caught: 0, total: 1 })
    expect(report.summary.injected).toEqual({ caught: 1, total: 1 })
    expect(snapshot(repo.root)).toEqual(before)
  })
})

describe('AC-18: --only and --json', () => {
  function twoSentinels(): TempRepo {
    const repo = makeRepo({ green: true })
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
    writeSentinel(repo, { id: 'I002', kind: 'injected', patch: changeUntested(repo) })
    commitAll(repo.root, 'sentinels')
    return repo
  }

  it('AC-18: run with only runs that one sentinel', async () => {
    const repo = twoSentinels()
    const report = await run({ root: repo.root, dir: repo.dir, suite: SUITE, only: 'I002' })

    expect(statuses(report)).toEqual({ I002: 'missed' })
    expect(report.summary.injected).toEqual({ caught: 0, total: 1 })
  })

  it('AC-18: the CLI with --only <id> --json prints the Report for that one sentinel', () => {
    const repo = twoSentinels()
    const res = spawnSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/sentinels.ts',
        '--root',
        repo.root,
        '--dir',
        repo.dir,
        '--suite',
        SUITE,
        '--only',
        'I001',
        '--json',
      ],
      { cwd: REPO, encoding: 'utf8' },
    )
    expect(res.stdout, res.stderr).not.toBe('')
    const report = JSON.parse(res.stdout) as Report

    expect(report.control).toBe('green')
    expect(statuses(report)).toEqual({ I001: 'caught' })
    expect(report.summary.injected).toEqual({ caught: 1, total: 1 })
  })
})

describe('AC-19: the real sentinel set', () => {
  const SENTINEL_DIR = join(REPO, 'tests/sentinels')

  /** Each sentinel's kind, the location its `where` must name, and what that location must contain. */
  const EXPECTED: Record<
    string,
    { kind: 'present' | 'injected'; path: string; lines: [number, number]; marks: RegExp }
  > = {
    S001: {
      kind: 'present',
      path: 'packages/platform/src/db/command-store.ts',
      lines: [44, 50],
      marks: /return fn\(db\)/,
    },
    S002: {
      kind: 'present',
      path: 'packages/platform/src/services/inventory-service.ts',
      lines: [104, 116],
      marks: /variant\.stock - qty/,
    },
    S003: {
      kind: 'present',
      path: 'packages/platform/src/repositories/variant.ts',
      lines: [70, 70],
      marks: /store\.db/,
    },
    S004: {
      kind: 'present',
      path: 'packages/platform/src/services/checkout-service.ts',
      lines: [182, 183],
      marks: /limit: 1000/,
    },
    S005: {
      kind: 'present',
      path: 'packages/platform/src/services/inventory-service.ts',
      lines: [125, 125],
      marks: /publisher\.publish/,
    },
    S006: {
      kind: 'present',
      path: 'packages/platform/src/services/cart-service.ts',
      lines: [62, 62],
      marks: /documentStore\.put/,
    },
    S007: {
      kind: 'present',
      path: 'packages/platform/src/services/checkout-service.ts',
      lines: [179, 199],
      marks: /finalize\(paymentIntentId, paidAmountMinor\)/,
    },
    S008: {
      kind: 'present',
      path: 'packages/config/src/schema.ts',
      lines: [73, 73],
      marks: /jwtSecret: .*\.default\('/,
    },
    I101: {
      kind: 'injected',
      path: 'packages/platform/src/services/inventory-service.ts',
      lines: [107, 111],
      marks: /inventory\.insufficient/,
    },
    I102: {
      kind: 'injected',
      path: 'packages/platform/src/services/checkout-service.ts',
      lines: [192, 194],
      marks: /commitReservation/,
    },
    I103: {
      kind: 'injected',
      path: 'packages/platform/src/services/checkout-service.ts',
      lines: [130, 130],
      marks: /lineTotalMinor: item\.priceMinor \* item\.qty,/,
    },
    I104: {
      kind: 'injected',
      path: 'packages/platform/src/handlers/idempotency.ts',
      lines: [15, 21],
      marks: /repo\.seen\(/,
    },
    I105: {
      kind: 'injected',
      path: 'packages/platform/src/services/auth-service.ts',
      lines: [208, 208],
      marks: /revokedAt/,
    },
  }

  function loadAll(): Array<{ file: string; sentinel: Sentinel }> {
    return readdirSync(SENTINEL_DIR)
      .filter((f) => f.endsWith('.patch'))
      .sort()
      .map((f) => {
        const file = join('tests/sentinels', f)
        return { file, sentinel: parseSentinel(readFileSync(join(REPO, file), 'utf8'), file) }
      })
  }

  it('AC-19: tests/sentinels holds exactly S001-S008 and I101-I105, each file named after its id', () => {
    const all = loadAll()
    expect(all.map((s) => s.sentinel.id).sort()).toEqual(Object.keys(EXPECTED).sort())
    for (const { file, sentinel } of all) {
      expect(file.startsWith(`tests/sentinels/${sentinel.id}-`), file).toBe(true)
    }
  })

  it.each(Object.keys(EXPECTED))(
    'AC-19: %s has the expected kind and its where names the defect line',
    (id) => {
      const want = EXPECTED[id]
      const got = loadAll().find((s) => s.sentinel.id === id)?.sentinel
      if (!want || !got) throw new Error(`sentinel ${id} missing from tests/sentinels`)
      expect(got.kind).toBe(want.kind)
      const [from, to] = want.lines
      const location = from === to ? `${want.path}:${from}` : `${want.path}:${from}-${to}`
      expect(got.where).toContain(location)
      const named = readFileSync(join(REPO, want.path), 'utf8')
        .split('\n')
        .slice(from - 1, to)
        .join('\n')
      expect(named, `${location} must still be the defect`).toMatch(want.marks)
      if (want.kind === 'present') {
        expect(got.patch.trim(), 'a present sentinel is header only').toBe('')
      }
    },
  )

  it.each(Object.keys(EXPECTED).filter((id) => id.startsWith('I')))(
    'AC-19: injected %s changes the file its where names and git apply --check is clean',
    (id) => {
      const want = EXPECTED[id]
      const got = loadAll().find((s) => s.sentinel.id === id)?.sentinel
      if (!want || !got) throw new Error(`sentinel ${id} missing from tests/sentinels`)
      expect(got.patch).toContain(`+++ b/${want.path}`)
      const check = spawnSync('git', ['apply', '--check', '-'], {
        cwd: REPO,
        input: got.patch,
        encoding: 'utf8',
      })
      expect(check.status, check.stderr).toBe(0)
    },
  )
})
