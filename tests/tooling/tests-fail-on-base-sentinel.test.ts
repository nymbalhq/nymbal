import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// AC-13: rule 8 counts a sentinel. A new test file that passes on the base and is named in the `# suite:` of an
// injected sentinel under `tests/sentinels/` is run once more, alone, with that sentinel's patch applied to the head
// source in the temporary worktree. Failing there is the verdict `fails under sentinel <id>` and no violation;
// passing there, or being named by no sentinel, stays PASSES ON BASE.
// Each test builds a throwaway git repo, as tests-fail-on-base.test.ts does.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SCRIPT = join(REPO, 'scripts/tests-fail-on-base.ts')
const SUITE = 'node --test'

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: env === undefined ? process.env : { ...process.env, ...env },
  })
}

function write(root: string, file: string, text: string): void {
  mkdirSync(join(root, file, '..'), { recursive: true })
  writeFileSync(join(root, file), text)
}

function commitAll(root: string, message: string): string {
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', message])
  return git(root, ['rev-parse', 'HEAD']).trim()
}

/** Imports only what it uses: importing `multiply` from the base's math.js would fail the file on base by itself. */
function testFile(name: string, assertion: string, importName = 'add'): string {
  return [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    `import { ${importName} } from '../src/math.js'`,
    '',
    `test('${name}', () => {`,
    `  ${assertion}`,
    '})',
    '',
  ].join('\n')
}

const BASE_MATH = 'export function add(a, b) {\n  return a + b\n}\n'
const HEAD_MATH = `${BASE_MATH}\nexport function multiply(a, b) {\n  return a * b\n}\n`

/** Fails on base: base has no `multiply`. */
const MULTIPLY_TEST = 'test/multiply.test.js'
/** Case 1: passes on base, named by I901 whose patch (add off by one) makes it fail. */
const CAUGHT = 'test/add-zero.test.js'
/** Case 2: passes on base, named by I902 whose patch (multiply off by one) it does not catch. */
const NOT_CAUGHT = 'test/add-one.test.js'
/** Case 3: passes on base, named by no sentinel (I901's patch would catch it, but I901 does not name it). */
const UNNAMED = 'test/add-two.test.js'

const CAUGHT_BY = 'I901'
const MISSED_BY = 'I902'

function sentinel(opts: { id: string; defect: string; suite: string; patch: string }): string {
  return [
    `# id: ${opts.id}`,
    '# kind: injected',
    `# defect: ${opts.defect}`,
    '# where: src/math.js',
    '# killed-by: the sentinel fixture',
    `# suite: ${opts.suite}`,
    opts.patch,
  ].join('\n')
}

/** The patch that turns head's src/math.js into `patched`, taken from git so it applies to head exactly. */
function patchOf(root: string, patched: string): string {
  write(root, 'src/math.js', patched)
  const patch = git(root, ['diff', '--', 'src/math.js'])
  git(root, ['checkout', '--', 'src/math.js'])
  return patch
}

/**
 * A repo whose base has `add`; head adds `multiply`, its test, the given new add tests and two injected sentinels:
 * I901 (add off by one) naming CAUGHT, I902 (multiply off by one) naming NOT_CAUGHT. Returns root, base and patches.
 */
function makeRepo(addTests: string[]): {
  root: string
  base: string
  patches: Record<string, string>
} {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-tfob-sentinel-')))
  created.push(dir)
  const root = join(dir, 'repo')
  mkdirSync(root)
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'tfob-sentinel-fixture', private: true, type: 'module' }, null, 2)}\n`,
  )
  write(root, 'src/math.js', BASE_MATH)
  write(root, 'test/add.test.js', testFile('add', 'assert.equal(add(2, 3), 5)'))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.email', 'tfob@example.test'])
  git(root, ['config', 'user.name', 'TFOB Test'])
  const base = commitAll(root, 'base')

  write(root, 'src/math.js', HEAD_MATH)
  commitAll(root, 'head: multiply')
  const patches = {
    [CAUGHT_BY]: patchOf(root, HEAD_MATH.replace('return a + b', 'return a + b + 1')),
    [MISSED_BY]: patchOf(root, HEAD_MATH.replace('return a * b', 'return a * b + 1')),
  }
  write(
    root,
    `tests/sentinels/${CAUGHT_BY}-add-off-by-one.patch`,
    sentinel({
      id: CAUGHT_BY,
      defect: 'add returns one too many',
      suite: `${SUITE} ${CAUGHT}`,
      patch: patches[CAUGHT_BY],
    }),
  )
  write(
    root,
    `tests/sentinels/${MISSED_BY}-multiply-off-by-one.patch`,
    sentinel({
      id: MISSED_BY,
      defect: 'multiply returns one too many',
      suite: `${SUITE} ${NOT_CAUGHT}`,
      patch: patches[MISSED_BY],
    }),
  )
  write(root, MULTIPLY_TEST, testFile('multiply', 'assert.equal(multiply(2, 3), 6)', 'multiply'))
  const bodies: Record<string, string> = {
    [CAUGHT]: 'assert.equal(add(0, 7), 7)',
    [NOT_CAUGHT]: 'assert.equal(add(1, 1), 2)',
    [UNNAMED]: 'assert.equal(add(2, 5), 7)',
  }
  for (const file of addTests) write(root, file, testFile(file, bodies[file] ?? ''))
  commitAll(root, 'head: sentinels and new tests')
  return { root, base, patches }
}

/** Every file under the work tree except .git, hashed: the checkout's bytes. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.name === '.git') continue
      if (entry.isSymbolicLink()) out[relative(root, abs)] = `link:${readlinkSync(abs)}`
      else if (entry.isDirectory()) walk(abs)
      else out[relative(root, abs)] = createHash('sha256').update(readFileSync(abs)).digest('hex')
    }
  }
  walk(root)
  return out
}

function state(root: string) {
  return {
    files: snapshot(root),
    head: git(root, ['rev-parse', 'HEAD']).trim(),
    status: git(root, ['status', '--porcelain=v1', '--untracked-files=all']),
    worktrees: git(root, ['worktree', 'list', '--porcelain']),
  }
}

function runScript(root: string, base: string) {
  const result = spawnSync(TSX, [SCRIPT, base, '--root', root, '--suite', SUITE], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 50_000,
  })
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

function passes(root: string, files: string[]): boolean {
  return spawnSync('node', ['--test', ...files], { cwd: root, encoding: 'utf8' }).status === 0
}

/**
 * Guards the fixture: every head test is green at head; I901's patch fails CAUGHT, and would fail NOT_CAUGHT and
 * UNNAMED too, so only the sentinel that names a file may judge it; I902's patch leaves NOT_CAUGHT green; and I901's
 * patch does not apply to the base's src/math.js, so only a run on the head source can be caught by it.
 */
function expectFixture(
  root: string,
  base: string,
  patches: Record<string, string>,
  added: string[],
): void {
  expect(passes(root, []), 'head is green').toBe(true)
  const under = (id: string, files: string[]): boolean => {
    const file = join(root, '..', `${id}.diff`)
    writeFileSync(file, patches[id] ?? '')
    git(root, ['apply', file])
    try {
      return passes(root, files)
    } finally {
      git(root, ['apply', '-R', file])
      rmSync(file)
    }
  }
  expect(under(CAUGHT_BY, [CAUGHT]), `${CAUGHT} catches ${CAUGHT_BY}`).toBe(false)
  if (added.includes(UNNAMED)) {
    expect(under(CAUGHT_BY, [UNNAMED]), `${UNNAMED} would catch ${CAUGHT_BY}`).toBe(false)
  }
  if (added.includes(NOT_CAUGHT)) {
    expect(under(CAUGHT_BY, [NOT_CAUGHT]), `${NOT_CAUGHT} would catch ${CAUGHT_BY}`).toBe(false)
    expect(under(MISSED_BY, [NOT_CAUGHT]), `${NOT_CAUGHT} misses ${MISSED_BY}`).toBe(true)
  }
  const index = join(root, '..', 'base.index')
  const env = { GIT_INDEX_FILE: index }
  git(root, ['read-tree', base], env)
  const patchFile = join(root, '..', 'base-check.diff')
  writeFileSync(patchFile, patches[CAUGHT_BY] ?? '')
  const onBase = spawnSync('git', ['apply', '--cached', '--check', patchFile], {
    cwd: root,
    env: { ...process.env, ...env },
  })
  rmSync(index)
  rmSync(patchFile)
  expect(onBase.status, `${CAUGHT_BY} must not apply to the base source`).not.toBe(0)
}

const SENTINEL_VERDICT = /fails under sentinel (\S+)/

/** Every verdict on the lines naming `file`, a sentinel verdict with its id; a file judged once has exactly one. */
function verdictsOf(out: string, file: string): string[] {
  const found = new Set<string>()
  for (const line of out.split('\n')) {
    if (!line.includes(file)) continue
    for (const verdict of ['not judged', 'fails on base', 'PASSES ON BASE']) {
      if (line.includes(verdict)) found.add(verdict)
    }
    const sentinelVerdict = SENTINEL_VERDICT.exec(line)
    if (sentinelVerdict !== null)
      found.add(`fails under sentinel ${sentinelVerdict[1]?.replace(/:$/, '')}`)
  }
  return [...found]
}

/** The added test files whose line carries PASSES ON BASE: the violations. */
function violations(out: string, files: string[]): string[] {
  return files.filter((file) => verdictsOf(out, file).includes('PASSES ON BASE')).sort()
}

describe('AC-13: rule 8 counts a sentinel', () => {
  it('AC-13: a new test that passes on base but fails under the injected sentinel naming it is "fails under sentinel <id>", and the step exits 0', () => {
    const { root, base, patches } = makeRepo([CAUGHT])
    expectFixture(root, base, patches, [CAUGHT])
    const before = state(root)

    const { status, out } = runScript(root, base)

    expect(verdictsOf(out, CAUGHT), out).toEqual([`fails under sentinel ${CAUGHT_BY}`])
    expect(verdictsOf(out, MULTIPLY_TEST), out).toEqual(['fails on base'])
    expect(violations(out, [CAUGHT, MULTIPLY_TEST]), out).toEqual([])
    expect(status, out).toBe(0)
    // The patch goes to the temporary worktree only: the checkout is left exactly as it was.
    expect(state(root)).toEqual(before)
  })

  it('AC-13: of three files passing on base, only the one its naming sentinel catches is spared; the one its sentinel misses and the one no sentinel names are PASSES ON BASE, exit 1', () => {
    const added = [CAUGHT, NOT_CAUGHT, UNNAMED]
    const { root, base, patches } = makeRepo(added)
    expectFixture(root, base, patches, added)
    const before = state(root)

    const { status, out } = runScript(root, base)

    expect(verdictsOf(out, CAUGHT), out).toEqual([`fails under sentinel ${CAUGHT_BY}`])
    // The violations are exactly the file whose sentinel misses it and the file no sentinel names.
    expect(violations(out, [...added, MULTIPLY_TEST]), out).toEqual([NOT_CAUGHT, UNNAMED].sort())
    for (const file of [NOT_CAUGHT, UNNAMED]) {
      expect(verdictsOf(out, file), out).toEqual(['PASSES ON BASE'])
    }
    expect(verdictsOf(out, MULTIPLY_TEST), out).toEqual(['fails on base'])
    expect(status, out).toBe(1)
    expect(state(root)).toEqual(before)
  })
})
