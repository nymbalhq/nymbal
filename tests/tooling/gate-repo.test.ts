import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { changedFiles, selectTests } from '../../scripts/gate'

// Acceptance tests for P0-02 AC-16 and AC-17, on throwaway git repos with no remote.
// AC-16: the changed-file collection (`changedFiles(root, base)`) lists deleted paths, committed or not, so that
// `selectTests` sees a deletion as a change. AC-17: the `census-trend` and `test-quality` steps of `gate.ts` take
// the base from their positional argument and work in a clone that has no `origin/*` refs.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const GATE = join(REPO, 'scripts/gate.ts')

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

/** A repo with no remote whose base commit holds `files`; returns the root and the base sha. */
function makeRepo(files: Record<string, string>): { root: string; base: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-gate-repo-')))
  created.push(dir)
  const root = join(dir, 'repo')
  mkdirSync(root)
  for (const [file, text] of Object.entries(files)) write(root, file, text)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'gate@example.test')
  git(root, 'config', 'user.name', 'Gate Test')
  return { root, base: commitAll(root, 'base') }
}

// ---------------------------------------------------------------------------------------------------------------
// AC-16: deletions are changes
// ---------------------------------------------------------------------------------------------------------------

describe('AC-16: the changed-file collection and selectTests see deleted paths', () => {
  const BASE_FILES = {
    'package.json': '{ "name": "fixture", "private": true }\n',
    'vitest.stryker.config.ts': 'export default {}\n',
    'packages/sdk/package.json': '{ "name": "@fixture/sdk" }\n',
    'packages/sdk/src/client.ts': 'export const client = 1\n',
    'packages/sdk/src/store.ts': 'export const store = 1\n',
    'README.md': '# fixture\n',
  }

  it('AC-16: a committed deletion of a configuration path is listed and selects all', () => {
    const { root, base } = makeRepo(BASE_FILES)
    git(root, 'rm', '-q', 'vitest.stryker.config.ts')
    commitAll(root, 'head: drop the stryker vitest config')

    const changed = changedFiles(root, base)

    expect(changed).toContain('vitest.stryker.config.ts')
    expect(selectTests(changed).mode).toBe('all')
  })

  it('AC-16: a staged, uncommitted deletion of a package manifest is listed and selects all', () => {
    const { root, base } = makeRepo(BASE_FILES)
    git(root, 'rm', '-q', 'packages/sdk/package.json')

    const changed = changedFiles(root, base)

    expect(changed).toContain('packages/sdk/package.json')
    expect(selectTests(changed).mode).toBe('all')
  })

  it('AC-16: a deletion-only change of a source file (not staged) is a change, never "none"', () => {
    const { root, base } = makeRepo(BASE_FILES)
    rmSync(join(root, 'packages/sdk/src/store.ts'))

    const changed = changedFiles(root, base)

    expect(changed).toEqual(['packages/sdk/src/store.ts'])
    expect(selectTests(changed).mode).toBe('changed')
  })

  it('AC-16: deleted, modified and untracked paths are all listed, each once', () => {
    const { root, base } = makeRepo(BASE_FILES)
    git(root, 'rm', '-q', 'packages/sdk/src/store.ts')
    commitAll(root, 'head: drop the store')
    write(root, 'packages/sdk/src/client.ts', 'export const client = 2\n')
    write(root, 'packages/sdk/src/cache.ts', 'export const cache = 1\n')
    rmSync(join(root, 'README.md'))

    const changed = changedFiles(root, base)

    expect([...changed].sort()).toEqual(
      [
        'README.md',
        'packages/sdk/src/cache.ts',
        'packages/sdk/src/client.ts',
        'packages/sdk/src/store.ts',
      ].sort(),
    )
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-17: census-trend and test-quality need no origin/*
// ---------------------------------------------------------------------------------------------------------------

const STRONG_TEST = [
  "import { expect, it } from 'vitest'",
  "it('grows', () => {",
  '  expect(2).toBeGreaterThan(1)',
  '})',
  '',
].join('\n')

const WEAK_TEST = [
  "import { expect, it } from 'vitest'",
  "it('is one', () => {",
  '  expect(1).toBe(1)',
  '})',
  '',
].join('\n')

function gateStep(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const result = spawnSync(TSX, [GATE, ...args], { cwd, encoding: 'utf8', timeout: 30_000 })
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

describe('AC-17: census-trend and test-quality take the base from their positional argument only', () => {
  const BASE_FILES = {
    'package.json': '{ "name": "fixture", "private": true }\n',
    'src/value.ts': 'export const value = 1\n',
  }

  it('AC-17: census-trend <sha> in a clone without origin/* reports the touched files and exits 0', () => {
    const { root, base } = makeRepo(BASE_FILES)
    write(root, 'test/strong.test.ts', STRONG_TEST)
    commitAll(root, 'head: a strong test')
    expect(git(root, 'for-each-ref', 'refs/remotes')).toBe('')

    const { status, out } = gateStep(root, 'census-trend', base)

    expect(status, out).toBe(0)
    expect(out).toContain('1 test file(s) touched')
  })

  it('AC-17: census-trend main judges against main, with or without an origin/dev elsewhere', () => {
    const { root } = makeRepo(BASE_FILES)
    git(root, 'switch', '-q', '-c', 'feature')
    write(root, 'test/weak.test.ts', WEAK_TEST)
    const head = commitAll(root, 'head: a weak test')

    const withoutOrigin = gateStep(root, 'census-trend', 'main')
    expect(withoutOrigin.status, withoutOrigin.out).toBe(1)
    expect(withoutOrigin.out).toContain('violation: test/weak.test.ts')

    // An origin/dev at HEAD would see no touched file: the positional base must win.
    git(root, 'update-ref', 'refs/remotes/origin/dev', head)
    const withOrigin = gateStep(root, 'census-trend', 'main')
    expect(withOrigin.status, withOrigin.out).toBe(1)
    expect(withOrigin.out).toContain('violation: test/weak.test.ts')
  })

  it('AC-17: test-quality <sha> in a clone without origin/* writes the report for the touched test files', () => {
    const { root, base } = makeRepo(BASE_FILES)
    write(root, 'test/strong.test.ts', STRONG_TEST)
    commitAll(root, 'head: a strong test')

    const { status, out } = gateStep(root, 'test-quality', base, '--started', '0')

    expect(status, out).toBe(0)
    const report = join(root, 'reports/test-quality.md')
    expect(existsSync(report), out).toBe(true)
    expect(readFileSync(report, 'utf8')).toContain('## test/strong.test.ts')
  })
})
