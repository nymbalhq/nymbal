// Reads: stryker.integration.config.mjs, vitest.stryker.integration.config.ts, mutation-ratchet.integration.json
// Reads: stryker.config.mjs, vitest.config.ts, tests/tooling/mutation-ratchet-integration.test.ts
import { execFile, execFileSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { isHarnessPath, selectTests, strykerTargets } from '../../scripts/gate'

// A changed-tests run selects a test only when its import graph reaches a changed file, so a test that reads a file
// from disk is never selected for a change to it. The integration mutation run's config, test set and ratchet are
// imported by their tests; this resolves that through Vitest itself, in a copy of the work tree where one file
// changed and nothing else did, since a changed test file is always selected.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const NEW_FILES = [
  'stryker.integration.config.mjs',
  'vitest.stryker.integration.config.ts',
  'mutation-ratchet.integration.json',
]
/** The tests of the integration config, its test set and its ratchet. */
const GUARDS = ['tests/tooling/mutation-ratchet-integration.test.ts']
const SOURCE = 'packages/platform/src/services/cart-service.ts'

const exec = promisify(execFile)

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=f', '-c', 'user.email=f@x', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
}

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The work tree's files, tracked and untracked alike, committed as the base of a fresh repository. */
function workTreeCopy(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-selection-')))
  created.push(dir)
  const files = git(REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
    .split('\0')
    .filter(Boolean)
  for (const path of files) {
    const from = join(REPO, path)
    const link = isLink(from)
    if (!link && !existsSync(from)) continue
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    // A tracked symlink (./migrations) stays a link, relative as git holds it.
    if (link) symlinkSync(readlinkSync(from), join(dir, path))
    else copyFileSync(from, join(dir, path))
  }
  // Dependencies resolve through this checkout's installs, the root's and each package's.
  for (const pkg of ['.', ...files.filter((p) => basename(p) === 'package.json').map(dirname)]) {
    const modules = join(REPO, pkg, 'node_modules')
    if (pkg === '.' || existsSync(modules)) {
      if (!existsSync(join(dir, pkg, 'node_modules')))
        symlinkSync(modules, join(dir, pkg, 'node_modules'))
    }
  }
  git(dir, 'init', '--quiet')
  appendFileSync(join(dir, '.git/info/exclude'), 'node_modules\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', 'base')
  return dir
}

/** The tooling test files `vitest list` selects in `cwd` with these arguments, relative to it. */
async function toolingFiles(cwd: string, args: string[]): Promise<string[]> {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('VITEST') && !key.startsWith('NYMBAL_')) env[key] = value
  }
  const { stdout } = await exec(
    join(REPO, 'node_modules/.bin/vitest'),
    ['list', '--filesOnly', '--json', '--project', 'tooling', ...args],
    { cwd, env, maxBuffer: 64 * 1024 * 1024 },
  )
  const rows = JSON.parse(stdout.slice(stdout.indexOf('['))) as Array<{ file: string }>
  return rows.map((row) => relative(cwd, row.file)).sort()
}

describe('AC-7: a change to an integration mutation file selects its tests', () => {
  it('AC-7: through Vitest, a change to each new file alone selects the tests of the integration config and ratchet, and not the whole tooling project', async () => {
    expect(
      NEW_FILES.filter((f) => !existsSync(join(REPO, f))),
      'files at the repo root',
    ).toEqual([])
    const dir = workTreeCopy()
    const all = await toolingFiles(dir, [])
    const rows: Array<{ file: string; missing: string[]; selected: number }> = []
    for (const file of NEW_FILES) {
      appendFileSync(join(dir, file), '\n')
      const picked = await toolingFiles(dir, ['--changed', 'HEAD'])
      git(dir, 'checkout', '--', file)
      rows.push({
        file,
        missing: GUARDS.filter((g) => !picked.includes(g)),
        selected: picked.length,
      })
    }
    expect(
      rows.map(
        (r) =>
          `${r.file}: ${r.missing.length === 0 ? 'selected' : `misses ${r.missing.join(', ')}`}`,
      ),
    ).toEqual(NEW_FILES.map((f) => `${f}: selected`))
    for (const r of rows) {
      expect(r.selected, `${r.file} selects part of the tooling project`).toBeLessThan(all.length)
    }
  }, 120_000)

  it('AC-7: the three files are harness paths that select the related tests, not every test, and widen no unit Stryker run', async () => {
    expect(NEW_FILES.filter((f) => !isHarnessPath(f))).toEqual([])
    for (const file of NEW_FILES) {
      expect(selectTests([file]).mode, file).toBe('changed')
      expect(selectTests([SOURCE, file]).mode, file).toBe(selectTests([SOURCE]).mode)
    }
    expect(await strykerTargets(REPO, NEW_FILES)).toEqual([])
    expect(await strykerTargets(REPO, [SOURCE, ...NEW_FILES])).toEqual(
      await strykerTargets(REPO, [SOURCE]),
    )
  })
})
