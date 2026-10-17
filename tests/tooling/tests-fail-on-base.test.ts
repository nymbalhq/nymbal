import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Acceptance tests for P0-02 AC-6: `scripts/tests-fail-on-base.ts <base> --root <repo> --suite <command>`.
// Each test builds a throwaway git repo: a tiny module, `node --test` tests, a base commit and a head commit that
// adds tests. The script runs `<suite> <test file>` for every added test file against the base commit's source in
// a temporary worktree, and must leave the checkout exactly as it found it.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SCRIPT = join(REPO, 'scripts/tests-fail-on-base.ts')
const SUITE = 'node --test'

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
}

function write(root: string, file: string, text: string): void {
  mkdirSync(join(root, file, '..'), { recursive: true })
  writeFileSync(join(root, file), text)
}

function commitAll(root: string, message: string): string {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', message)
  return git(root, 'rev-parse', 'HEAD').trim()
}

function testFile(importName: string, assertion: string): string {
  return [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    `import { ${importName} } from '../src/math.js'`,
    '',
    `test('${importName}', () => {`,
    `  ${assertion}`,
    '})',
    '',
  ].join('\n')
}

const BASE_MATH = 'export function add(a, b) {\n  return a + b\n}\n'
const HEAD_MATH = `${BASE_MATH}\nexport function multiply(a, b) {\n  return a * b\n}\n`

/** A repo whose base has `add` and its test; returns the root and the base sha. */
function makeRepo(): { root: string; base: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-tfob-')))
  created.push(dir)
  const root = join(dir, 'repo')
  mkdirSync(root)
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'tfob-fixture', private: true, type: 'module' }, null, 2)}\n`,
  )
  write(root, 'src/math.js', BASE_MATH)
  write(root, 'test/add.test.js', testFile('add', 'assert.equal(add(2, 3), 5)'))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'tfob@example.test')
  git(root, 'config', 'user.name', 'TFOB Test')
  const base = commitAll(root, 'base')
  return { root, base }
}

/** Head adds `multiply` with a test that needs it (fails on base) and edits the existing add test (passes on base). */
function addGoodHead(root: string): void {
  write(root, 'src/math.js', HEAD_MATH)
  write(root, 'test/multiply.test.js', testFile('multiply', 'assert.equal(multiply(2, 3), 6)'))
  write(root, 'test/add.test.js', testFile('add', 'assert.equal(add(2, 2), 4)'))
}

/** Every file under the work tree except .git, hashed: the checkout's bytes. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.name === '.git') continue
      if (entry.isDirectory()) walk(abs)
      else out[relative(root, abs)] = createHash('sha256').update(readFileSync(abs)).digest('hex')
    }
  }
  walk(root)
  return out
}

function state(root: string) {
  return {
    files: snapshot(root),
    head: git(root, 'rev-parse', 'HEAD').trim(),
    branch: git(root, 'symbolic-ref', '-q', 'HEAD').trim(),
    status: git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
    worktrees: git(root, 'worktree', 'list', '--porcelain'),
    branches: git(root, 'branch', '--list', '--all'),
    stash: git(root, 'stash', 'list'),
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

/** The test files the script gave a verdict on. */
function judged(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.includes('fails on base') || l.includes('PASSES ON BASE'))
    .map((l) => /test\/[\w-]+\.test\.js/.exec(l)?.[0] ?? l)
    .sort()
}

/** The test files git lists as added between base and HEAD. */
function addedTests(root: string, base: string): string[] {
  return git(root, 'diff', '--name-only', '--diff-filter=A', base, 'HEAD', '--', 'test/')
    .split('\n')
    .filter(Boolean)
    .sort()
}

function lineFor(out: string, file: string): string | undefined {
  return out.split('\n').find((l) => l.includes(file))
}

/** Guards the fixture: every head test is green at head, so failing on base is the base's doing. */
function expectGreenAtHead(root: string): void {
  const result = spawnSync('node', ['--test'], { cwd: root, encoding: 'utf8' })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

describe('AC-6: tests-fail-on-base', () => {
  it('AC-6: a new test that fails on the base source is fine: exit 0, reported as "fails on base"', () => {
    const { root, base } = makeRepo()
    addGoodHead(root)
    commitAll(root, 'head: multiply')
    expectGreenAtHead(root)
    write(root, 'notes/untracked.txt', 'left alone\n')
    const before = state(root)

    const { status, out } = runScript(root, base)

    expect(status, out).toBe(0)
    expect(lineFor(out, 'test/multiply.test.js'), out).toContain('fails on base')
    expect(out).not.toContain('PASSES ON BASE')
    expect(judged(out), out).toEqual(addedTests(root, base))
    expect(before).toEqual(state(root))
  })

  it('AC-6: a new test that passes on the base source is a violation: exit 1, reported as "PASSES ON BASE"', () => {
    const { root, base } = makeRepo()
    addGoodHead(root)
    write(root, 'test/add-zero.test.js', testFile('add', 'assert.equal(add(0, 7), 7)'))
    commitAll(root, 'head: multiply and a test that cannot fail on base')
    expectGreenAtHead(root)
    write(root, 'notes/untracked.txt', 'left alone\n')
    const before = state(root)

    const { status, out } = runScript(root, base)

    expect(status, out).toBe(1)
    expect(lineFor(out, 'test/add-zero.test.js'), out).toContain('PASSES ON BASE')
    expect(lineFor(out, 'test/multiply.test.js'), out).toContain('fails on base')
    expect(judged(out), out).toEqual(addedTests(root, base))
    expect(before).toEqual(state(root))
  })
})
