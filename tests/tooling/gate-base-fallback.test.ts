import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupScratch,
  gateCli,
  GATE_PACKAGE_JSON,
  git,
  type Scratch,
  scratchRepo,
  write,
} from './scratch-gate'

// `--base` that names no commit in the clone: CI passes the branch's previous tip, which a force-push leaves nowhere
// and a branch's first push gives as forty zeros. The gate falls back to HEAD's first parent; on a root commit it
// narrows nothing by a diff. Either way it says which fallback it took, on one line.

afterEach(cleanupScratch)

const GONE = '7781b5ffcf9e08d2e9a8f1fd6c0b8c1d3b0c6a00'
const ZEROS = '0'.repeat(40)

const FILES = {
  'package.json': GATE_PACKAGE_JSON,
  'stryker.config.mjs': "export default { mutate: ['src/**/*.ts'] }\n",
  'packages/platform/package.json': JSON.stringify({ name: '@nymbalhq/platform' }),
  'src/a.ts': 'export const a = 1\n',
  'src/b.ts': 'export const b = 1\n',
  // A test file with no relational or property assertion: the census trend fails it whenever it is judged.
  'tests/weak.test.ts':
    "import { expect, it } from 'vitest'\n\nit('is one', () => {\n  expect(1).toBe(1)\n})\n",
}

/** A scratch repo whose HEAD is a child of the base commit, changing one source file. */
function childRepo(): Scratch {
  const repo = scratchRepo(FILES)
  write(repo.root, 'src/a.ts', 'export const a = 2\n')
  git(repo.root, 'commit', '-q', '-am', 'head')
  return repo
}

const fallbackLines = (output: string): string[] =>
  output.split('\n').filter((line) => line.startsWith('base: '))

/** The ref the tests step handed `vitest --changed`, or null when it ran every test. */
const changedRef = (repo: Scratch): string | null | undefined => {
  const call = repo.calls().find((c) => /\brun test\b/.test(c))
  if (call === undefined) return undefined
  return /--changed (\S+)/.exec(call)?.[1] ?? null
}

describe('gate: a --base that names no commit falls back to HEAD’s parent', () => {
  it.each([
    { label: 'a commit a force-push removed', base: GONE },
    { label: 'forty zeros (a branch’s first push)', base: ZEROS },
  ])('on $label, every check diffs against HEAD^ and one line says so', async ({ base }) => {
    const repo = childRepo()
    const parent = git(repo.root, 'rev-parse', 'HEAD^')

    const run = await gateCli(repo, ['--base', base, '--json'])

    expect(run.code, run.output).toBe(0)
    expect(changedRef(repo), run.output).toBe(git(repo.root, 'rev-parse', 'HEAD^'))
    // Judged against everything, the untouched weak test would turn the census trend red.
    expect(run.steps.find((s) => s.name === 'census trend')?.status, run.output).toBe('ok')
    const lines = fallbackLines(run.output)
    expect(lines, run.output).toHaveLength(1)
    expect(lines[0]).toContain(`HEAD's parent ${parent.slice(0, 9)}`)
  })
})

describe('gate: a --base that is not CI’s shape and names no commit is refused', () => {
  it.each(['mian', 'origin/dve', GONE.slice(0, 7)])(
    '--base %s exits non-zero, names it, and runs no step',
    async (base) => {
      const repo = childRepo()

      const run = await gateCli(repo, ['--base', base, '--json'])

      expect(run.code, run.output).not.toBe(0)
      expect(run.output).toContain(`--base ${base}`)
      expect(fallbackLines(run.output), run.output).toEqual([])
      expect(repo.calls(), run.output).toEqual([])
    },
  )
})

describe('gate: a --base that names no commit on a root commit narrows nothing', () => {
  it('runs every test and judges no test file as changed in the census trend', async () => {
    const repo = scratchRepo(FILES)
    expect(git(repo.root, 'rev-list', '--count', 'HEAD')).toBe('1')

    const run = await gateCli(repo, ['--base', GONE, '--json'])

    expect(run.code, run.output).toBe(0)
    expect(changedRef(repo), run.output).toBeNull()
    expect(run.steps.find((s) => s.name === 'census trend')?.status, run.output).toBe('ok')
    const lines = fallbackLines(run.output)
    expect(lines, run.output).toHaveLength(1)
    expect(lines[0]).toContain('root commit')
  })

  it('runs every sentinel and a forced Stryker run over the whole mutate set', async () => {
    const repo = scratchRepo(FILES)
    const args = ['--full', '--only', 'stryker,sentinels', '--no-build', '--base', ZEROS, '--json']

    const run = await gateCli(repo, [...args, '--sentinels', 'impacted'])

    expect(run.code, run.output).toBe(0)
    expect(run.output).toContain('sentinels: all')
    const stryker = repo.calls().filter((c) => /\bstryker run\b/.test(c))
    expect(stryker, run.output).toHaveLength(1)
    expect(stryker[0]).toContain('--force')
    const mutated = /--mutate[= ]+'?([^' ]*)/
      .exec(stryker[0] ?? '')?.[1]
      ?.split(',')
      .sort()
    expect(mutated).toEqual(
      Object.keys(FILES)
        .filter((path) => path.startsWith('src/'))
        .sort(),
    )
    expect(fallbackLines(run.output), run.output).toHaveLength(1)
  })
})

describe('gate: --base HEAD~1 (the nightly’s) on a root commit narrows nothing', () => {
  it('runs every test, judges no test file as changed, and one line says so', async () => {
    const repo = scratchRepo(FILES)
    expect(git(repo.root, 'rev-list', '--count', 'HEAD')).toBe('1')

    const run = await gateCli(repo, ['--base', 'HEAD~1', '--json'])

    expect(run.code, run.output).toBe(0)
    expect(changedRef(repo), run.output).toBeNull()
    expect(run.steps.find((s) => s.name === 'census trend')?.status, run.output).toBe('ok')
    const lines = fallbackLines(run.output)
    expect(lines, run.output).toHaveLength(1)
    expect(lines[0]).toContain('--base HEAD~1')
    expect(lines[0]).toContain('root commit')
  })

  it('in a shallow clone, where HEAD only looks like a root, it is refused and runs no step', async () => {
    const repo = childRepo()
    const clone = `${repo.root}-shallow`
    git(repo.root, 'clone', '-q', '--depth', '1', `file://${repo.root}`, clone)
    expect(git(clone, 'rev-parse', '--is-shallow-repository')).toBe('true')
    const shallow: Scratch = { ...repo, root: clone }

    try {
      const run = await gateCli(shallow, ['--base', 'HEAD~1', '--json'])

      expect(run.code, run.output).not.toBe(0)
      expect(run.output).toContain('--base HEAD~1')
      expect(run.output).toContain('shallow')
      expect(fallbackLines(run.output), run.output).toEqual([])
      expect(repo.calls(), run.output).toEqual([])
    } finally {
      rmSync(clone, { recursive: true, force: true })
    }
  })
})
