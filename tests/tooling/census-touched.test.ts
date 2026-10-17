import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { assertionTouched } from '../../scripts/gate'

// Acceptance tests for AC-21: the census trend judges a touched test file only when it is new or the change adds or
// edits an assertion line in it. A diff that touches only imports, comments or names is not judged, so a mechanical
// codemod over old weak files does not have to fix their debt first.
//
// `assertionTouched(diff, path)` reads a unified `git diff` (several files) and says whether `path` is judged. The
// diffs here are real `git diff -M <base>` output from throwaway repositories, so hunk headers, context lines and
// rename headers are what git writes. The last block runs the `census-trend` step itself on such a repository.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const GATE = join(REPO, 'scripts/gate.ts')

const created: string[] = []
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  )
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

/** A repository with no remote whose base commit holds `files`. */
function makeRepo(files: Record<string, string>): { root: string; base: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-census-touched-')))
  created.push(dir)
  const root = join(dir, 'repo')
  mkdirSync(root)
  for (const [file, text] of Object.entries(files)) write(root, file, text)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'census@example.test')
  git(root, 'config', 'user.name', 'Census Test')
  return { root, base: commitAll(root, 'base') }
}

/** Base holds `base`, the change writes `head` (and renames per `moves`); returns git's diff of the change. */
function diffOf(
  baseFiles: Record<string, string>,
  head: Record<string, string>,
  moves: Array<[string, string]> = [],
): string {
  const { root, base } = makeRepo(baseFiles)
  for (const [from, to] of moves) {
    mkdirSync(join(root, to, '..'), { recursive: true })
    git(root, 'mv', from, to)
  }
  for (const [file, text] of Object.entries(head)) write(root, file, text)
  commitAll(root, 'head')
  return git(root, 'diff', '-M', '--no-color', '--no-ext-diff', base)
}

type WeakOptions = { from?: string; title?: string; comment?: string; body?: string[] }

/** A weak Vitest file (C4 assertions only) as old debt looks: an import, a comment, a named test, assertions. */
function weakTest(opts: WeakOptions = {}): string {
  const {
    from = '@nymbalhq/types',
    title = 'adds two numbers',
    comment = '// the sum of two small numbers',
    body = ['  expect(add(1, 2)).toBe(3)', '  expect(add(2, 2)).toBe(4)'],
  } = opts
  // No blank line after the imports: git's three context lines below an import edit reach the first assertion.
  return [
    "import { expect, it } from 'vitest'",
    `import { add } from '${from}'`,
    `it('${title}', () => {`,
    `  ${comment}`,
    ...body,
    '})',
    '',
  ].join('\n')
}

const WEAK = 'packages/sdk/src/weak.test.ts'

describe('AC-21: assertionTouched judges a file only when it is new or the change writes an assertion line', () => {
  it('AC-21: a diff that changes only an import path is not judged, though its hunk shows assertion lines as context', () => {
    const diff = diffOf({ [WEAK]: weakTest() }, { [WEAK]: weakTest({ from: '@nymbalhq/types' }) })
    // Guard: git's context lines around the import carry `expect(`, so only changed lines may decide.
    expect(diff.split('\n').some((l) => l.startsWith(' ') && l.includes('expect('))).toBe(true)

    expect(assertionTouched(diff, WEAK)).toBe(false)
  })

  it('AC-21: a diff that changes only a comment is not judged', () => {
    const diff = diffOf(
      { [WEAK]: weakTest() },
      { [WEAK]: weakTest({ comment: '// the sum of two small integers' }) },
    )

    expect(assertionTouched(diff, WEAK)).toBe(false)
  })

  it('AC-21: a diff that changes only a test name is not judged', () => {
    const diff = diffOf({ [WEAK]: weakTest() }, { [WEAK]: weakTest({ title: 'sums two numbers' }) })

    expect(assertionTouched(diff, WEAK)).toBe(false)
  })

  it('AC-21: a renamed file whose only edit is its import path is not judged (a move is not new)', () => {
    const moved = 'packages/types/src/weak.test.ts'
    const diff = diffOf(
      { [WEAK]: weakTest() },
      { [moved]: weakTest({ from: '@nymbalhq/types' }) },
      [[WEAK, moved]],
    )
    // Guard: git recorded a rename, not a delete and an add.
    expect(diff).toContain(`rename to ${moved}`)

    expect(assertionTouched(diff, moved)).toBe(false)
  })

  it('AC-21: a diff that edits an existing assertion line is judged', () => {
    const diff = diffOf(
      { [WEAK]: weakTest() },
      {
        [WEAK]: weakTest({ body: ['  expect(add(1, 2)).toBe(3)', '  expect(add(2, 3)).toBe(5)'] }),
      },
    )

    expect(assertionTouched(diff, WEAK)).toBe(true)
  })

  const ADDED_ASSERTIONS = [
    '  expect(add(3, 4)).toBe(7)',
    '  assert.equal(add(3, 4), 7)',
    '  fc.assert(fc.property(fc.integer(), (n) => add(n, 0) === n))',
  ]

  for (const line of ADDED_ASSERTIONS) {
    it(`AC-21: a diff that adds an assertion line is judged: ${line.trim()}`, () => {
      const before = weakTest()
      const after = weakTest({
        body: ['  expect(add(1, 2)).toBe(3)', '  expect(add(2, 2)).toBe(4)', line],
      })
      const diff = diffOf({ [WEAK]: before }, { [WEAK]: after })

      expect(assertionTouched(diff, WEAK)).toBe(true)
    })
  }

  it('AC-21: a new file is judged', () => {
    const added = 'packages/sdk/src/new.test.ts'
    const diff = diffOf({ [WEAK]: weakTest() }, { [added]: weakTest() })
    // Guard: git recorded the file as new.
    expect(diff).toContain('new file mode')

    expect(assertionTouched(diff, added)).toBe(true)
  })

  it('AC-21: in a diff of several files each is judged on its own hunks only', () => {
    // The import-only file sorts first, so a reader that runs past its own hunks reaches the assertion one.
    const importOnly = 'packages/sdk/src/a-import.test.ts'
    const asserting = 'packages/sdk/src/b-assert.test.ts'
    const diff = diffOf(
      { [importOnly]: weakTest(), [asserting]: weakTest() },
      {
        [importOnly]: weakTest({ from: '@nymbalhq/types' }),
        [asserting]: weakTest({
          body: [
            '  expect(add(1, 2)).toBe(3)',
            '  expect(add(2, 2)).toBe(4)',
            '  expect(add(0, 0)).toBe(0)',
          ],
        }),
      },
    )
    expect(diff.indexOf(`b/${importOnly}`)).toBeLessThan(diff.indexOf(`b/${asserting}`))

    expect(assertionTouched(diff, importOnly)).toBe(false)
    expect(assertionTouched(diff, asserting)).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// The census-trend step on a repository: which touched files it reports as violations
// ---------------------------------------------------------------------------------------------------------------

const DELEGATING = [
  "import { describe } from 'vitest'",
  "import { storeContract } from './store-contract'",
  '',
  "describe('memory store', () => storeContract(() => new Map()))",
  '',
].join('\n')

function censusTrendStep(root: string, base: string): { status: number | null; out: string } {
  const result = spawnSync(TSX, [GATE, 'census-trend', base], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  })
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

/** The paths named on `violation:` lines. */
function violated(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.startsWith('violation:'))
    .map((l) => /([\w./-]+\.test\.ts)/.exec(l)?.[1] ?? l)
    .sort()
}

describe('AC-21: the census-trend step judges only new files and files whose assertions the change writes', () => {
  const OLD = {
    'package.json': '{ "name": "fixture", "private": true }\n',
    'test/weak-import.test.ts': weakTest(),
    'test/weak-comment.test.ts': weakTest(),
    'test/weak-title.test.ts': weakTest(),
    'test/weak-renamed.test.ts': weakTest(),
    'test/weak-assert.test.ts': weakTest(),
  }

  /** The codemod: import paths, a comment and a test name in old weak files, and one file moved. */
  function codemod(root: string): void {
    write(root, 'test/weak-import.test.ts', weakTest({ from: '@nymbalhq/types' }))
    write(root, 'test/weak-title.test.ts', weakTest({ title: 'sums two numbers' }))
    mkdirSync(join(root, 'test/moved'), { recursive: true })
    git(root, 'mv', 'test/weak-renamed.test.ts', 'test/moved/weak-renamed.test.ts')
    write(root, 'test/moved/weak-renamed.test.ts', weakTest({ from: '@nymbalhq/types' }))
    commitAll(root, 'head: rename the types package')
    // Left uncommitted: the step judges the working tree.
    write(root, 'test/weak-comment.test.ts', weakTest({ comment: '// the sum of two integers' }))
  }

  it('AC-21: a change that only renames imports, comments, names and paths in old weak files exits 0 with no violation', () => {
    const { root, base } = makeRepo(OLD)
    codemod(root)

    const { status, out } = censusTrendStep(root, base)

    expect(violated(out), out).toEqual([])
    expect(status, out).toBe(0)
  })

  it('AC-21: violations are exactly the new weak files (committed or untracked) and the old weak file gaining an assertion; never a delegating file', () => {
    const { root, base } = makeRepo(OLD)
    codemod(root)
    write(
      root,
      'test/weak-assert.test.ts',
      weakTest({
        body: [
          '  expect(add(1, 2)).toBe(3)',
          '  expect(add(2, 2)).toBe(4)',
          '  expect(add(5, 5)).toBe(10)',
        ],
      }),
    )
    write(root, 'test/weak-new.test.ts', weakTest())
    write(root, 'test/delegating.test.ts', DELEGATING)
    commitAll(root, 'head: a new weak test, a delegating test, an assertion in old debt')
    // Untracked: new to the change all the same.
    write(root, 'test/weak-untracked.test.ts', weakTest())

    const { status, out } = censusTrendStep(root, base)

    expect(violated(out), out).toEqual([
      'test/weak-assert.test.ts',
      'test/weak-new.test.ts',
      'test/weak-untracked.test.ts',
    ])
    expect(status, out).toBe(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-24: removed lines and every assertion shape count, so deleting or weakening an assertion is judged
// ---------------------------------------------------------------------------------------------------------------

/** A Vitest file from its own lines: the imports, then one test whose body is `body`. */
function testOf(
  body: string[],
  imports: string[] = ["import { add } from '@nymbalhq/types'"],
): string {
  return [
    "import { expect, it } from 'vitest'",
    ...imports,
    "it('adds two numbers', () => {",
    ...body,
    '})',
    '',
  ].join('\n')
}

const RELATIONAL = '  expect(add(2, 2)).toBeGreaterThan(add(1, 2))'

describe('AC-24: assertionTouched counts removed lines and every assertion or matcher shape', () => {
  it('AC-24: a removed assertion line is judged; a removed comment or import line is not', () => {
    const base = testOf(
      ['  // two is more than one', '  expect(add(1, 2)).toBe(3)', RELATIONAL],
      ["import { add } from '@nymbalhq/types'", "import { fc } from '@fast-check/vitest'"],
    )
    const removedAssertion = diffOf(
      { [WEAK]: base },
      {
        [WEAK]: testOf(
          ['  // two is more than one', '  expect(add(1, 2)).toBe(3)'],
          ["import { add } from '@nymbalhq/types'", "import { fc } from '@fast-check/vitest'"],
        ),
      },
    )
    const removedComment = diffOf(
      { [WEAK]: base },
      {
        [WEAK]: testOf(
          ['  expect(add(1, 2)).toBe(3)', RELATIONAL],
          ["import { add } from '@nymbalhq/types'", "import { fc } from '@fast-check/vitest'"],
        ),
      },
    )
    const removedImport = diffOf(
      { [WEAK]: base },
      { [WEAK]: testOf(['  // two is more than one', '  expect(add(1, 2)).toBe(3)', RELATIONAL]) },
    )
    // Guard: the deletion diff has no added line at all, so only a `-` line can decide.
    expect(removedAssertion.split('\n').filter((l) => /^\+(?!\+\+)/.test(l))).toEqual([])
    expect(removedAssertion).toContain(`-${RELATIONAL}`)

    expect({
      removedAssertion: assertionTouched(removedAssertion, WEAK),
      removedComment: assertionTouched(removedComment, WEAK),
      removedImport: assertionTouched(removedImport, WEAK),
    }).toEqual({ removedAssertion: true, removedComment: false, removedImport: false })
  })

  it('AC-24: an edited matcher-only line of a multi-line expect is judged (`).toBeGreaterThan(` weakened to `).toBe(`); the same kind of line as mere context next to an import edit is not', () => {
    const edited = diffOf(
      { [WEAK]: testOf(['  expect(', '    add(2, 2),', '  ).toBeGreaterThan(add(1, 2))']) },
      { [WEAK]: testOf(['  expect(', '    add(2, 2),', '  ).toBe(4)']) },
    )
    // Guard: no changed line carries `expect(`; only the matcher lines changed.
    const changed = edited.split('\n').filter((l) => /^[+-](?![+-]{2})/.test(l))
    expect(changed.some((l) => l.includes('expect('))).toBe(false)

    const before = [
      "import { expect, it } from 'vitest'",
      "import { add } from '@nymbalhq/types'",
      "it('adds two numbers', () => expect(add(1, 2))",
      '  .toBeGreaterThan(add(0, 2)))',
      '',
    ].join('\n')
    const context = diffOf({ [WEAK]: before }, { [WEAK]: before.replace('@nymbalhq/', '@nymbalhq/') })
    // Guard: the matcher line is in the hunk, as context.
    expect(context.split('\n')).toContain('   .toBeGreaterThan(add(0, 2)))')

    expect({
      edited: assertionTouched(edited, WEAK),
      context: assertionTouched(context, WEAK),
    }).toEqual({ edited: true, context: false })
  })

  it('AC-24: an edited `.not.to<X>(` matcher line is judged', () => {
    const diff = diffOf(
      { [WEAK]: testOf(['  expect(add(2, 2))', '    .not.toBeLessThan(4)']) },
      { [WEAK]: testOf(['  expect(add(2, 2))', '    .not.toBeNaN()']) },
    )

    expect(assertionTouched(diff, WEAK)).toBe(true)
  })

  // Each edit changes only the line holding the call; the matcher on the next line stays as context.
  const CALL_EDITS: Array<[string, string, string]> = [
    ['expect.soft(', '  expect.soft(add(1, 2))', '  expect.soft(add(2, 1))'],
    [
      'expect.poll(',
      '  await expect.poll(() => add(1, 2))',
      '  await expect.poll(() => add(2, 1))',
    ],
  ]

  for (const [shape, from, to] of CALL_EDITS) {
    it(`AC-24: an edited \`${shape}\` line is judged though its matcher is unchanged`, () => {
      const diff = diffOf(
        { [WEAK]: testOf([from, '    .toBe(3)']) },
        { [WEAK]: testOf([to, '    .toBe(3)']) },
      )

      expect(assertionTouched(diff, WEAK)).toBe(true)
    })
  }

  it('AC-24: an added bare `assert(` line is judged', () => {
    const diff = diffOf(
      { [WEAK]: testOf(['  expect(add(1, 2)).toBe(3)']) },
      { [WEAK]: testOf(['  expect(add(1, 2)).toBe(3)', '  assert(add(3, 4) === 7)']) },
    )

    expect(assertionTouched(diff, WEAK)).toBe(true)
  })

  it('AC-24: a removed `fc.assert(` property line is judged', () => {
    const property = '  fc.assert(fc.property(fc.integer(), (n) => add(n, 0) === n))'
    const diff = diffOf(
      { [WEAK]: testOf(['  expect(add(1, 2)).toBe(3)', property]) },
      { [WEAK]: testOf(['  expect(add(1, 2)).toBe(3)']) },
    )

    expect(assertionTouched(diff, WEAK)).toBe(true)
  })
})
