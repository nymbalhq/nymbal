// Reads: scripts/sentinels.ts, tests/sentinels/**
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process'
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
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseSentinel, run, touchedPaths } from '../../scripts/sentinels'

// The sentinel runner: AC-6, AC-8, AC-12 to AC-19, AC-22 to AC-24 and AC-27.
// AC-19 is anchored by content (no line numbers asserted), and tests check against a fixture.
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
  s: { id: string; kind: 'present' | 'injected'; patch?: string; suite?: string },
): void {
  const header = [
    `# id: ${s.id}`,
    `# kind: ${s.kind}`,
    `# defect: defect of ${s.id}`,
    '# where: src/math.js:1',
    '# killed-by: test/math.test.js',
    ...(s.suite !== undefined ? [`# suite: ${s.suite}`] : []),
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
      '# killed-by: the transaction tests',
      '',
    ].join('\n')
    const parsed = parseSentinel(text, 'sentinels/S042-b.patch')
    expect(parsed).toMatchObject({
      id: 'S042',
      kind: 'present',
      defect: 'b is live',
      where: 'src/b.js:3-9',
      killedBy: 'the transaction tests',
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
  const PATCHES = readdirSync(SENTINEL_DIR)
    .filter((f) => f.endsWith('.patch'))
    .sort()

  // The set is whatever tests/sentinels holds: a new sentinel edits no test. Each is anchored by its own `where`.
  it.each(PATCHES)(
    'AC-19: %s is named after its id and names a kind; its where names a file at HEAD, which an injected patch changes and applies to, and a present one is header only',
    (name) => {
      const file = join('tests/sentinels', name)
      const sentinel = parseSentinel(readFileSync(join(REPO, file), 'utf8'), file)
      const where = (sentinel.where.split(/\s/)[0] ?? '').replace(/:\d+(?:-\d+)?$/, '')
      expect(name.startsWith(`${sentinel.id}-`), name).toBe(true)
      expect(['injected', 'present']).toContain(sentinel.kind)
      expect(anchorProblems(REPO, sentinel, { path: where, marks: /(?:)/ })).toEqual([])
      expect(
        sentinel.kind !== 'present' || sentinel.patch.trim() === '',
        `a present sentinel is header only: ${sentinel.where}`,
      ).toBe(true)
    },
  )
})

type Anchor = { path: string; marks: RegExp }

/**
 * Why a sentinel is not anchored at `root`'s HEAD; empty when it is. Anchored by content: `where` names the file (a
 * line range after it is informational), the file holds the marks somewhere, and an injected patch applies.
 */
function anchorProblems(root: string, sentinel: Sentinel, anchor: Anchor): string[] {
  const problems: string[] = []
  const file = (sentinel.where.split(/\s/)[0] ?? '').replace(/:\d+(?:-\d+)?$/, '')
  if (file !== anchor.path) problems.push(`where names ${file}, not ${anchor.path}`)
  let content = ''
  try {
    // HEAD, not the working tree: the runner applies sentinels to the tree while this suite may run.
    content = git(root, 'show', `HEAD:${anchor.path}`)
  } catch {
    problems.push(`${anchor.path} is not in HEAD`)
  }
  if (!anchor.marks.test(content)) problems.push(`${anchor.path} no longer holds ${anchor.marks}`)
  if (sentinel.kind === 'injected') {
    if (!sentinel.patch.includes(`+++ b/${anchor.path}`))
      problems.push(`the patch does not change ${anchor.path}`)
    // --cached checks against the index (HEAD), so an applied sentinel in the tree does not fail this.
    const check = spawnSync('git', ['apply', '--check', '--cached', '-'], {
      cwd: root,
      input: sentinel.patch,
      encoding: 'utf8',
    })
    if (check.status !== 0)
      problems.push(`the patch does not apply at HEAD: ${check.stderr.trim()}`)
  }
  return problems
}

describe('AC-8: sentinels are anchored by content, not by line', () => {
  const TARGET = 'src/price.js'
  // The target is mid-file: git apply pins a hunk that starts at line 1 to the top of the file, wherever it moved.
  const BODY = [
    '// Prices in minor units.',
    "export const CURRENCY = 'GBP'",
    '',
    'export function price(qty, unit) {',
    '  return qty * unit',
    '}',
    '',
    'export function free() {',
    '  return 0',
    '}',
    '',
  ].join('\n')
  /** The 0-based index of the target line in BODY. */
  const TARGET_LINE = 4
  const ANCHOR: Anchor = { path: TARGET, marks: /return qty \* unit/ }

  /** A repo whose HEAD has the target code at line 5, and an injected sentinel whose where names that line. */
  function anchoredRepo(): { repo: TempRepo; sentinel: Sentinel } {
    const repo = makeRepo({ green: true })
    commitFile(repo, TARGET, BODY)
    const patch = patchFor(repo, TARGET, (s) => s.replace('qty * unit', 'qty + unit'))
    const text = [
      '# id: I900',
      '# kind: injected',
      '# defect: price adds instead of multiplying',
      `# where: ${TARGET}:${TARGET_LINE + 1}`,
      '# killed-by: test/price.test.js',
      '',
      patch,
    ].join('\n')
    return { repo, sentinel: parseSentinel(text, 'sentinels/I900-fixture.patch') }
  }

  it('AC-8: property: moving the target code down N lines keeps the check green, and the patch still lands on it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 80 }), (n) => {
        const { repo, sentinel } = anchoredRepo()
        const above = Array.from({ length: n }, (_, i) => `// line ${i + 1} above the target`)
        commitFile(repo, TARGET, `${above.join('\n')}\n${BODY}`)

        expect(anchorProblems(repo.root, sentinel, ANCHOR)).toEqual([])
        execFileSync('git', ['apply', '-'], { cwd: repo.root, input: sentinel.patch })
        const moved = readFileSync(join(repo.root, TARGET), 'utf8').split('\n')
        expect(moved[n + TARGET_LINE]).toBe('  return qty + unit')
        expect(moved.slice(0, n)).toEqual(above)
      }),
      { numRuns: 8, examples: [[1], [40]] },
    )
  })

  it('AC-8: deleting the target code turns the check red, naming the missing marks and the patch that no longer applies', () => {
    const { repo, sentinel } = anchoredRepo()
    const before = anchorProblems(repo.root, sentinel, ANCHOR)
    commitFile(repo, TARGET, 'export function price(qty) {\n  return qty\n}\n')

    const after = anchorProblems(repo.root, sentinel, ANCHOR)
    expect(after.length).toBeGreaterThan(before.length)
    expect(after.join('\n')).toMatch(/no longer holds/)
    expect(after.join('\n')).toMatch(/does not apply/)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-22 to AC-24 and AC-27
// ---------------------------------------------------------------------------------------------------------------

/** Commits `name` in the repo with `body`; the file is part of HEAD so the tree stays clean. */
function commitFile(repo: TempRepo, name: string, body: string): void {
  writeFileSync(join(repo.root, name), body)
  commitAll(repo.root, `add ${name}`)
}

describe('AC-22: the default suite and the Report suite', () => {
  /**
   * A repo whose `pnpm test` runs two Vitest projects: `main` (green, reads src/math.js) and `tooling` (always red).
   * Only a default suite that excludes `tooling` has a green control here.
   */
  function vitestRepo(): TempRepo {
    const repo = makeRepo({ green: true })
    rmSync(join(repo.root, 'test'), { recursive: true, force: true })
    symlinkSync(join(REPO, 'node_modules'), join(repo.root, 'node_modules'))
    writeFileSync(join(repo.root, '.gitignore'), 'node_modules\n')
    writeFileSync(
      join(repo.root, 'package.json'),
      `${JSON.stringify(
        {
          name: 'sentinel-fixture',
          private: true,
          type: 'module',
          scripts: { test: 'vitest run' },
        },
        null,
        2,
      )}\n`,
    )
    writeFileSync(
      join(repo.root, 'vitest.config.mjs'),
      [
        'export default {',
        '  test: {',
        '    projects: [',
        "      { test: { name: 'main', include: ['main/**/*.test.mjs'] } },",
        "      { test: { name: 'tooling', include: ['tooling/**/*.test.mjs'] } },",
        '    ],',
        '  },',
        '}',
        '',
      ].join('\n'),
    )
    mkdirSync(join(repo.root, 'main'))
    mkdirSync(join(repo.root, 'tooling'))
    writeFileSync(
      join(repo.root, 'main/math.test.mjs'),
      "import { expect, test } from 'vitest'\nimport { add } from '../src/math.js'\n\ntest('add', () => {\n  expect(add(2, 3)).toBe(5)\n})\n",
    )
    writeFileSync(
      join(repo.root, 'tooling/red.test.mjs'),
      "import { expect, test } from 'vitest'\n\ntest('tooling is red here', () => {\n  expect(1).toBe(2)\n})\n",
    )
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
    commitAll(repo.root, 'vitest projects')
    return repo
  }

  it('AC-22: the CLI with no --suite excludes the tooling project, so the control is green and the Report names that command', () => {
    const repo = vitestRepo()
    const res = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/sentinels.ts', '--root', repo.root, '--dir', repo.dir, '--json'],
      { cwd: REPO, encoding: 'utf8' },
    )
    expect(res.status, `the default suite must leave the tooling project out\n${res.stderr}`).toBe(
      0,
    )
    const report = JSON.parse(res.stdout) as Report & { suite: string }

    expect(report.suite).toMatch(/^pnpm vitest run --project[ =]!tooling$/)
    expect(statuses(report)).toEqual({ I001: 'caught' })
  })

  it('AC-22: run reports the suite command it ran', async () => {
    const repo = makeRepo({ green: true })
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
    commitAll(repo.root, 'sentinels')

    const report = (await run({ root: repo.root, dir: repo.dir, suite: SUITE })) as Report & {
      suite?: string
    }

    expect(report.suite).toBe(SUITE)
  })
})

describe('AC-23: a signal while a patch is applied', () => {
  const pids: number[] = []

  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'AC-23: %s mid-run restores the tree and exits 130',
    async (signal) => {
      const repo = makeRepo({ green: true })
      // Fast and green unpatched (the control); with the patch applied it records its pid and sleeps.
      commitFile(
        repo,
        'slow-suite.mjs',
        [
          "import { appendFileSync, readFileSync } from 'node:fs'",
          "const src = readFileSync(new URL('./src/math.js', import.meta.url), 'utf8')",
          "if (src.includes('a - b')) {",
          `  appendFileSync(${JSON.stringify(repo.log)}, \`applied \${process.pid}\\n\`)`,
          '  setTimeout(() => process.exit(1), 20000)',
          '} else {',
          '  process.exit(0)',
          '}',
          '',
        ].join('\n'),
      )
      writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
      commitAll(repo.root, 'sentinels')
      const before = snapshot(repo.root)

      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/sentinels.ts',
          '--root',
          repo.root,
          '--dir',
          repo.dir,
          '--suite',
          'node slow-suite.mjs',
          '--json',
        ],
        { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.on('exit', (code, sig) => resolve({ code, signal: sig })),
      )
      if (child.pid !== undefined) pids.push(child.pid)

      // Wait until the patch is applied and the suite is running on it.
      await vi.waitFor(
        () => {
          const match = /applied (\d+)/.exec(readLog(repo))
          if (!match?.[1]) throw new Error('the patched suite has not started yet')
          pids.push(Number(match[1]))
        },
        { timeout: 20000, interval: 50 },
      )
      expect(readFileSync(join(repo.root, 'src/math.js'), 'utf8')).toContain('a - b')

      child.kill(signal)
      const { code, signal: killedBy } = await exited

      expect(snapshot(repo.root), 'the tree is restored after the signal').toEqual(before)
      expect({ code, signal: killedBy }).toEqual({ code: 130, signal: null })
    },
  )
})

describe('AC-24: a sentinel with its own suite', () => {
  it('AC-24: a red per-sentinel suite is a red control: run rejects with "control red" and never applies the patch', async () => {
    const repo = makeRepo({ green: true })
    commitFile(
      repo,
      'red-suite.mjs',
      [
        "import { appendFileSync, readFileSync } from 'node:fs'",
        "const src = readFileSync(new URL('./src/math.js', import.meta.url), 'utf8')",
        `if (src.includes('a - b')) appendFileSync(${JSON.stringify(repo.log)}, 'patched\\n')`,
        'process.exit(1)',
        '',
      ].join('\n'),
    )
    writeSentinel(repo, {
      id: 'I001',
      kind: 'injected',
      patch: breakAdd(repo),
      suite: 'node red-suite.mjs',
    })
    commitAll(repo.root, 'sentinels')
    const before = snapshot(repo.root)

    await expect(run({ root: repo.root, dir: repo.dir, suite: SUITE })).rejects.toThrow(
      /control red/,
    )

    expect(readLog(repo), 'the sentinel must not run on a red suite').not.toContain('patched')
    expect(snapshot(repo.root)).toEqual(before)
  })

  it('AC-24: each distinct per-sentinel suite gets exactly one control run', async () => {
    const repo = makeRepo({ green: true })
    commitFile(
      repo,
      'counted-suite.mjs',
      [
        "import { appendFileSync } from 'node:fs'",
        "import { add } from './src/math.js'",
        `appendFileSync(${JSON.stringify(repo.log)}, 'counted\\n')`,
        'process.exit(add(2, 3) === 5 ? 0 : 1)',
        '',
      ].join('\n'),
    )
    const own = 'node counted-suite.mjs'
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo), suite: own })
    writeSentinel(repo, { id: 'I002', kind: 'injected', patch: changeUntested(repo), suite: own })
    commitAll(repo.root, 'sentinels')

    const report = await run({ root: repo.root, dir: repo.dir, suite: SUITE })

    expect(statuses(report)).toEqual({ I001: 'caught', I002: 'missed' })
    const ownRuns = readLog(repo)
      .split('\n')
      .filter((l) => l === 'counted').length
    // One control for the shared suite plus one run per sentinel that uses it.
    expect(ownRuns).toBe(1 + report.sentinels.length)
  })
})

describe('the controls are the suites the selected sentinels run', () => {
  /** A repo whose own suite logs `counted` and whose default suite (`node --test`) logs `run`. */
  function suitedRepo(): { repo: TempRepo; own: string; runs: (line: string) => number } {
    const repo = makeRepo({ green: true })
    commitFile(
      repo,
      'counted-suite.mjs',
      [
        "import { appendFileSync } from 'node:fs'",
        "import { add } from './src/math.js'",
        `appendFileSync(${JSON.stringify(repo.log)}, 'counted\\n')`,
        'process.exit(add(2, 3) === 5 ? 0 : 1)',
        '',
      ].join('\n'),
    )
    const runs = (line: string) =>
      readLog(repo)
        .split('\n')
        .filter((l) => l === line).length
    return { repo, own: 'node counted-suite.mjs', runs }
  }

  it('runs no default control when every selected sentinel names its own suite', async () => {
    const { repo, own, runs } = suitedRepo()
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo), suite: own })
    writeSentinel(repo, { id: 'I002', kind: 'injected', patch: changeUntested(repo), suite: own })
    commitAll(repo.root, 'sentinels')

    const report = await run({ root: repo.root, dir: repo.dir, suite: SUITE })

    expect(statuses(report)).toEqual({ I001: 'caught', I002: 'missed' })
    expect(runs('run'), 'the default suite never ran').toBe(0)
    expect(runs('counted')).toBe(1 + report.sentinels.length)
  })

  it('runs the default control when a selected sentinel has no suite of its own', async () => {
    const { repo, own, runs } = suitedRepo()
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo), suite: own })
    writeSentinel(repo, { id: 'I002', kind: 'injected', patch: changeUntested(repo) })
    commitAll(repo.root, 'sentinels')

    const report = await run({ root: repo.root, dir: repo.dir, suite: SUITE })

    expect(statuses(report)).toEqual({ I001: 'caught', I002: 'missed' })
    // The default suite: its control, then I002's run. The own suite: its control, then I001's run.
    expect(runs('run')).toBe(2)
    expect(runs('counted')).toBe(2)
  })

  it('runs no default control when the only selected sentinel is suited, though another is not', async () => {
    const { repo, own, runs } = suitedRepo()
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo), suite: own })
    writeSentinel(repo, { id: 'I002', kind: 'injected', patch: changeUntested(repo) })
    commitAll(repo.root, 'sentinels')

    const report = await run({ root: repo.root, dir: repo.dir, suite: SUITE, only: 'I001' })

    expect(statuses(report)).toEqual({ I001: 'caught' })
    expect(runs('run'), 'the default suite never ran').toBe(0)
    expect(runs('counted')).toBe(2)
  })
})

describe('the suite runs with scaled test timeouts', () => {
  /** A suite that logs the timeout scale it was given and is green while `add` is. */
  function scaleRepo(): { repo: TempRepo; suite: string; scales: () => string[] } {
    const repo = makeRepo({ green: true })
    commitFile(
      repo,
      'scale-suite.mjs',
      [
        "import { appendFileSync } from 'node:fs'",
        "import { add } from './src/math.js'",
        `appendFileSync(${JSON.stringify(repo.log)}, \`scale=\${process.env.NYMBAL_TEST_TIMEOUT_SCALE}\\n\`)`,
        'process.exit(add(2, 3) === 5 ? 0 : 1)',
        '',
      ].join('\n'),
    )
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
    commitAll(repo.root, 'sentinels')
    const scales = () =>
      readLog(repo)
        .split('\n')
        .filter((l) => l.startsWith('scale='))
        .map((l) => l.slice('scale='.length))
    return { repo, suite: 'node scale-suite.mjs', scales }
  }

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('the control and every sentinel run get the same scale above 1, so a loaded runner does not turn the control red or a sentinel falsely caught', async () => {
    vi.stubEnv('NYMBAL_TEST_TIMEOUT_SCALE', undefined)
    const { repo, suite, scales } = scaleRepo()

    const report = await run({ root: repo.root, dir: repo.dir, suite })

    expect(statuses(report)).toEqual({ I001: 'caught' })
    const seen = scales()
    expect(seen.length, 'one control run and one sentinel run').toBe(2)
    expect(new Set(seen).size, `every run gets one scale: ${seen.join(', ')}`).toBe(1)
    expect(Number(seen[0])).toBeGreaterThan(1)
  })

  it('a scale already set by the caller is passed through unchanged', async () => {
    vi.stubEnv('NYMBAL_TEST_TIMEOUT_SCALE', '7')
    const { repo, suite, scales } = scaleRepo()

    await run({ root: repo.root, dir: repo.dir, suite })

    expect(scales()).toEqual(['7', '7'])
  })
})

describe('AC-27: paths a patch touches', () => {
  /** A tracked SQL file whose first line, once removed, reads `--- notes.txt` inside the hunk. */
  const SQL = '-- notes.txt\nselect 1;\n'

  it('AC-27: touchedPaths reads diff --git headers only, never ---/+++ text inside hunks', () => {
    const patch = [
      'diff --git a/db/schema.sql b/db/schema.sql',
      '--- a/db/schema.sql',
      '+++ b/db/schema.sql',
      '@@ -1,2 +1,2 @@',
      '--- notes.txt',
      '+++ b/evil.txt',
      ' select 1;',
      'diff --git a/src/old.js b/src/new.js',
      'similarity index 100%',
      'rename from src/old.js',
      'rename to src/new.js',
      'diff --git a/src/created.js b/src/created.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/created.js',
      '@@ -0,0 +1 @@',
      '+export const created = 1',
      '',
    ].join('\n')

    expect([...touchedPaths(patch)].sort()).toEqual([
      'db/schema.sql',
      'src/created.js',
      'src/new.js',
      'src/old.js',
    ])
  })

  it('AC-27: a removed "-- notes.txt" line does not delete an untracked file named notes.txt', async () => {
    const repo = makeRepo({ green: true })
    mkdirSync(join(repo.root, 'db'))
    writeFileSync(join(repo.root, 'db/schema.sql'), SQL)
    commitAll(repo.root, 'schema')
    const patch = patchFor(repo, 'db/schema.sql', (s) => s.replace('-- notes.txt\n', ''))
    expect(patch, 'the hunk carries a line that reads like a --- header').toContain(
      '\n--- notes.txt\n',
    )
    writeSentinel(repo, { id: 'I001', kind: 'injected', patch })
    commitAll(repo.root, 'sentinels')
    writeFileSync(join(repo.root, 'notes.txt'), 'untracked work\n')

    await run({ root: repo.root, dir: repo.dir, suite: SUITE })

    expect(existsSync(join(repo.root, 'notes.txt')), 'untracked notes.txt survives').toBe(true)
    expect(readFileSync(join(repo.root, 'db/schema.sql'), 'utf8')).toBe(SQL)
  })
})

// The CLI's exit status (AC-6) and its --only list (AC-15), on the same throwaway repo the cases above build: I001
// breaks `add`, which the suite tests (caught); I002 changes `untested`, which no test reads (missed).

async function cli(
  repo: TempRepo,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      join(REPO, 'node_modules/.bin/tsx'),
      ['scripts/sentinels.ts', '--root', repo.root, '--dir', repo.dir, '--suite', SUITE, ...args],
      { cwd: REPO, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1
        resolve({ code, stdout, stderr })
      },
    )
  })
}

/** I001 (caught), and I002 (missed) when asked; the control is red when the suite expects the wrong sum. */
function exitRepo(opts: { missed: boolean; controlRed?: boolean }): TempRepo {
  const repo = makeRepo({ green: opts.controlRed !== true })
  writeSentinel(repo, { id: 'I001', kind: 'injected', patch: breakAdd(repo) })
  if (opts.missed)
    writeSentinel(repo, { id: 'I002', kind: 'injected', patch: changeUntested(repo) })
  commitAll(repo.root, 'sentinels')
  return repo
}

const suiteRuns = (repo: TempRepo): number => readLog(repo).split('\n').filter(Boolean).length

describe('AC-6: a missed sentinel fails the run', () => {
  it('AC-6: a missed injected sentinel exits 1 after printing the report, as text and as --json', async () => {
    const [text, json] = await Promise.all([
      cli(exitRepo({ missed: true }), []),
      cli(exitRepo({ missed: true }), ['--json']),
    ])

    expect(text.stdout, text.stderr).toMatch(/\| I002 \| injected \| missed \|/)
    expect(text.stdout).toContain('Injected: 1/2 caught')
    expect(text.code, `${text.stdout}\n${text.stderr}`).toBe(1)

    const report = JSON.parse(json.stdout) as Report
    const missed = report.sentinels.filter((s) => s.status === 'missed').map((s) => s.id)
    expect(missed).toEqual(['I002'])
    expect(report.summary.injected.caught).toBeLessThan(report.summary.injected.total)
    expect(json.code, json.stdout).toBe(1)
  })

  it('AC-6: the exit status is 0 iff the control is green and every injected sentinel is caught', async () => {
    const CASES = [
      { name: 'every injected sentinel caught', missed: false },
      { name: 'one injected sentinel missed', missed: true },
      { name: 'the control red', missed: false, controlRed: true },
    ]
    const results = await Promise.all(CASES.map((c) => cli(exitRepo(c), [])))
    const detail = results
      .map((r, i) => `${CASES[i]!.name}: exit ${r.code}\n${r.stdout}${r.stderr}`)
      .join('\n')

    expect(results[0]!.stdout, 'the all-caught run prints its report').toContain(
      'Injected: 1/1 caught',
    )
    expect(
      results.map((r) => r.code === 0),
      detail,
    ).toEqual(CASES.map((c) => c.controlRed !== true && !c.missed))
    for (const [i, r] of results.entries()) {
      expect([0, 1], `${CASES[i]!.name} exits 0 or 1, never a crash code`).toContain(r.code)
    }
  })
})

describe('AC-15: sentinels.ts --only takes a list', () => {
  /** Three sentinels that each break `add`, so each would run the suite once if selected. */
  function threeRepo(): TempRepo {
    const repo = makeRepo({ green: true })
    for (const id of ['I101', 'S001', 'I102']) {
      writeSentinel(repo, { id, kind: 'injected', patch: breakAdd(repo) })
    }
    commitAll(repo.root, 'sentinels')
    return repo
  }

  it('AC-15: --only I101,S001 runs exactly those two; --only I101,NOPE exits 1 naming NOPE and runs nothing', async () => {
    const listed = threeRepo()
    const ran = await cli(listed, ['--only', 'I101,S001', '--json'])
    expect(ran.code, ran.stderr).toBe(0)
    const report = JSON.parse(ran.stdout) as Report
    expect(report.sentinels.map((s) => s.id).sort()).toEqual(['I101', 'S001'])
    // The control plus one suite run per selected sentinel: I102's patch was never applied.
    expect(suiteRuns(listed)).toBe(report.sentinels.length + 1)

    const typo = threeRepo()
    const bad = await cli(typo, ['--only', 'I101,NOPE', '--json'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toMatch(/\bNOPE\b/)
    expect(suiteRuns(typo)).toBe(0)
  })
})
