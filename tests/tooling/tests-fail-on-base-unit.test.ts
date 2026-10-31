// Reads: nothing
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { EXCLUDED_PREFIXES, TEST_FILE } from '../../scripts/test-census'
import {
  addedTestCode,
  failureLine,
  firstErrorLine,
  installBase,
  isDependencyLayoutPath,
} from '../../scripts/tests-fail-on-base'

// AC-25 to AC-27: the pure decisions inside tests-fail-on-base.
// - AC-25 `isDependencyLayoutPath(path)`: whether a changed path moves the dependency graph, so the base worktree
//   must install its own dependencies instead of mirroring HEAD's.
// - AC-26 `installBase(worktree, session, run)`: the offline install, then an online retry only when going online
//   can fix the failure. `run` has `runCommand`'s signature; the fake here stands in for the process boundary only.
// - AC-27 `firstErrorLine(output)`: the line the `base did not build` reason quotes. The outputs are the shapes tsc,
//   tsup, Node and pnpm really print.

describe('AC-25: a dependency-layout change is any package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc or patches/**', () => {
  const LAYOUT = [
    'package.json',
    'packages/sdk/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    'patches/better-sqlite3@11.10.0.patch',
    'patches/vendor/left-pad@1.3.0.patch',
  ]
  const NOT_LAYOUT = [
    'packages/sdk/src/index.ts',
    'README.md',
    'docs/npmrc.md',
    'scripts/patches.ts',
    'packages/sdk/src/package.json.ts',
    'tests/tooling/pnpm-workspace.test.ts',
  ]

  for (const path of LAYOUT) {
    it(`AC-25: ${path} is a dependency-layout change`, () => {
      expect(isDependencyLayoutPath(path)).toBe(true)
    })
  }

  it('AC-25: source, docs and test paths that merely name those files are not', () => {
    expect(NOT_LAYOUT.filter((path) => isDependencyLayoutPath(path))).toEqual([])
  })
  const SEGMENT = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/)

  it('AC-25: a package.json at any workspace depth counts; a source file beside it does not (property)', () => {
    fc.assert(
      fc.property(fc.array(SEGMENT, { minLength: 1, maxLength: 3 }), (dirs) => {
        const dir = dirs.join('/')
        expect(isDependencyLayoutPath(`${dir}/package.json`)).toBe(true)
        expect(isDependencyLayoutPath(`${dir}/index.ts`)).toBe(false)
      }),
    )
  })

  it('AC-25: any file under patches/ counts (property)', () => {
    fc.assert(
      fc.property(fc.array(SEGMENT, { minLength: 1, maxLength: 3 }), (parts) => {
        expect(isDependencyLayoutPath(`patches/${parts.join('/')}.patch`)).toBe(true)
      }),
    )
  })
})

type Run = { status: number | null; signal: NodeJS.Signals | null; output: string }

/** A fake process boundary: the offline install gives `offline`, any other command succeeds; records each command. */
function fakeInstall(offline: Run): {
  commands: string[]
  run: (cwd: string, command: string) => Promise<Run>
} {
  const commands: string[] = []
  return {
    commands,
    run: (_cwd, command) => {
      commands.push(command)
      return Promise.resolve(
        command.includes('--offline')
          ? offline
          : { status: 0, signal: null, output: 'Done in 1.2s\n' },
      )
    },
  }
}

describe('AC-26: an offline install failure that going online cannot fix is not retried online', () => {
  const UNFIXABLE = [
    [
      'ERR_PNPM_OUTDATED_LOCKFILE',
      '[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/packages/app/package.json',
    ],
    [
      'ERR_PNPM_LOCKFILE_BREAKING_CHANGE',
      ' ERR_PNPM_LOCKFILE_BREAKING_CHANGE  Lockfile /tmp/base/pnpm-lock.yaml not compatible with current pnpm',
    ],
    [
      'ERR_PNPM_LOCKFILE_CONFIG_MISMATCH',
      ' ERR_PNPM_LOCKFILE_CONFIG_MISMATCH  Cannot proceed with the frozen installation. The current "overrides" configuration doesn\'t match the value found in the lockfile',
    ],
  ] as const

  for (const [code, line] of UNFIXABLE) {
    it(`AC-26: ${code} runs the offline install only and returns its failure`, async () => {
      const offline: Run = {
        status: 1,
        signal: null,
        output: `✓ Lockfile passes supply-chain policies (verified 8s ago)\n${line}\n\nNote that in CI environments this setting is true by default.\n`,
      }
      const { commands, run } = fakeInstall(offline)

      const result = await installBase('/tmp/base', {}, run)

      expect(commands).toHaveLength(1)
      expect(commands[0]).toContain('--offline')
      expect(result.status).not.toBe(0)
      expect(result.output).toContain(code)
    })
  }

  it('AC-26: a failure the store can cause (ERR_PNPM_NO_OFFLINE_META) is retried online, and the online result is returned', async () => {
    const offline: Run = {
      status: 1,
      signal: null,
      output:
        '[ERR_PNPM_NO_OFFLINE_META] Failed to resolve left-pad@1.3.0 in package mirror /Users/dev/Library/Caches/pnpm/v11/metadata/https%3A+registry.npmjs.org/left-pad.jsonl\n',
    }
    const { commands, run } = fakeInstall(offline)

    const result = await installBase('/tmp/base', {}, run)

    expect(commands).toHaveLength(2)
    expect(commands[0]).toContain('--offline')
    expect(commands[1]).not.toContain('--offline')
    expect(result.status).toBe(0)
  })
})

describe('AC-27: the first error line is the first line of a real error shape, else the last non-empty line', () => {
  const CASES: Array<{ name: string; output: string[]; expected: string }> = [
    {
      name: 'a tsc error after a tsup line naming dist/error.js',
      output: [
        'packages/sdk build$ tsup',
        'packages/sdk build: ESM dist/error.js 1.20 KB',
        "packages/sdk build: src/index.ts(1,23): error TS2307: Cannot find module '@nymbalhq/types' or its corresponding type declarations.",
        'packages/sdk build: Failed',
        ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @nymbalhq/sdk@0.0.0 build: `tsup`',
      ],
      expected:
        "packages/sdk build: src/index.ts(1,23): error TS2307: Cannot find module '@nymbalhq/types' or its corresponding type declarations.",
    },
    {
      name: 'a coloured tsc error after a harmless line with "error" in it',
      output: [
        '> fixture@ build /tmp/base',
        '> tsc -p tsconfig.json --noErrorTruncation && node copy-error-pages.mjs',
        "src/a.ts:1:23 - \x1b[91merror\x1b[0m\x1b[90m TS2307: \x1b[0mCannot find module '@nymbalhq/types'.",
      ],
      expected: "src/a.ts:1:23 - error TS2307: Cannot find module '@nymbalhq/types'.",
    },
    {
      name: "Node's `Error:` line after a command echo with --on-error",
      output: [
        '> fixture@ build /tmp/base',
        '> node build.mjs --on-error=exit',
        '',
        "Error: Cannot find module '/tmp/base/build.mjs'",
        '    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)',
      ],
      expected: "Error: Cannot find module '/tmp/base/build.mjs'",
    },
    {
      name: "Node's ESM `Cannot find package`, not the stack frame source line above it",
      output: [
        'node:internal/modules/esm/resolve:873',
        '  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);',
        '        ^',
        '',
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsup' imported from /tmp/base/packages/app/build.mjs",
      ],
      expected:
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsup' imported from /tmp/base/packages/app/build.mjs",
    },
    {
      name: 'a pnpm 9 error code after a WARN line naming an is-error dependency',
      output: [
        'Scope: all 3 workspace projects',
        ' WARN  3 deprecated subdependencies found: glob@7.2.3, inflight@1.0.6, is-error@2.2.2',
        ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/packages/app/package.json',
      ],
      expected:
        'ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/packages/app/package.json',
    },
    {
      name: 'a bracketed pnpm error code (current pnpm) after a WARN line naming an error-ex dependency',
      output: [
        '\u2713 Lockfile passes supply-chain policies (verified 8s ago)',
        ' WARN  1 deprecated subdependencies found: error-ex@1.3.2',
        '[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/packages/app/package.json',
        '',
        'Note that in CI environments this setting is true by default. If you still need to run install in such cases, use "pnpm install --no-frozen-lockfile"',
      ],
      expected:
        '[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/packages/app/package.json',
    },
    {
      name: 'no error shape: the last non-empty line, not a harmless earlier one',
      output: [
        'packages/app build$ tsup',
        'packages/app build: ESM dist/error.js 1.20 KB',
        'packages/app build: Killed',
        '',
        '',
      ],
      expected: 'packages/app build: Killed',
    },
  ]

  for (const { name, output, expected } of CASES) {
    it(`AC-27: ${name}`, () => {
      expect(firstErrorLine(output.join('\n'))).toBe(expected)
    })
  }

  /** Real output lines that are no error shape, some with "error" or `ERR_` in them. */
  const HARMLESS = [
    'packages/sdk build$ tsup',
    'packages/sdk build: ESM dist/error.js 1.20 KB',
    '> tsc -p tsconfig.json && node copy-error-pages.mjs',
    ' WARN  1 deprecated subdependencies found: error-ex@1.3.2',
    'Progress: resolved 412, reused 412, downloaded 0, added 0, done',
    'Found 1 error in src/index.ts:1',
    '  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);',
    'packages/app build: Failed',
    '\u2713 Lockfile passes supply-chain policies (verified 8s ago)',
  ]
  /** Real error lines, one of each shape. */
  const ERRORS = [
    "src/index.ts(1,23): error TS2307: Cannot find module '@nymbalhq/types'.",
    '[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/package.json',
    ' ERR_PNPM_LOCKFILE_BREAKING_CHANGE  Lockfile /tmp/base/pnpm-lock.yaml not compatible with current pnpm',
    "Error: Cannot find module '/tmp/base/build.mjs'",
    "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsup' imported from /tmp/base/build.mjs",
  ]

  it('AC-27: harmless lines, then a real error, then anything: the real error is the line (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...HARMLESS), { maxLength: 6 }),
        fc.constantFrom(...ERRORS),
        fc.array(fc.constantFrom(...HARMLESS, ...ERRORS, ''), { maxLength: 4 }),
        (before, error, after) => {
          expect(firstErrorLine([...before, error, ...after].join('\n'))).toBe(error.trim())
        },
      ),
    )
  })

  it('AC-27: no error shape at all: the last non-empty line (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...HARMLESS), { minLength: 1, maxLength: 6 }),
        fc.nat({ max: 2 }),
        (lines, blanks) => {
          const output = [...lines, ...Array<string>(blanks).fill('')].join('\n')
          expect(firstErrorLine(output)).toBe(lines[lines.length - 1]?.trim())
        },
      ),
    )
  })
})

// The added test-code set and the reason a `fails on base` line gives.
// - `addedTestCode(nameStatus, untracked)`: the added files that are test code (a `test`, `tests`, `__tests__` or
//   `fixtures` segment) but no test file themselves, so a new test's suites, helpers and fixtures are in the base
//   worktree; product files and modified files never are. `nameStatus` is `git diff --name-status --no-renames
//   --diff-filter=A <base>`.
// - `failureLine(output)`: the note on a `fails on base` line. The outputs are what `node --test` (Node 26.12.1) and
//   Vitest 3.2.4 really print, with the temporary directory shortened to /tmp/base.

const MARKERS = ['test', 'tests', '__tests__', 'fixtures'] as const
const WORD = fc
  .stringMatching(/^[a-z][a-z0-9-]{0,6}$/)
  .filter((word) => !(MARKERS as readonly string[]).includes(word))
const DIRS = fc.array(WORD, { maxLength: 2 })
const NAME = fc
  .tuple(WORD, fc.constantFrom('ts', 'js', 'mjs', 'json', 'sql', 'txt'))
  .map(([name, ext]) => `${name}.${ext}`)

type Kind = 'test code' | 'product' | 'test file' | 'excluded'
type Entry = { path: string; kind: Kind }

const ENTRY: fc.Arbitrary<Entry> = fc.oneof(
  fc
    .tuple(DIRS, fc.constantFrom(...MARKERS), DIRS, NAME)
    .map(([above, marker, below, name]) => [...above, marker, ...below, name].join('/'))
    .filter((path) => !EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix)))
    .map((path): Entry => ({ path, kind: 'test code' })),
  fc
    .tuple(DIRS, NAME)
    .map(([dirs, name]): Entry => ({ path: [...dirs, name].join('/'), kind: 'product' })),
  fc
    .tuple(
      DIRS,
      fc.option(fc.constantFrom(...MARKERS)),
      WORD,
      fc.constantFrom('test.ts', 'spec.tsx', 'test.mjs', 'spec.js'),
    )
    .map(
      ([dirs, marker, name, ext]): Entry => ({
        path: [...dirs, ...(marker === null ? [] : [marker]), `${name}.${ext}`].join('/'),
        kind: 'test file',
      }),
    ),
  fc.tuple(fc.constantFrom(...EXCLUDED_PREFIXES), DIRS, NAME).map(
    ([prefix, dirs, name]): Entry => ({
      path: `${prefix}${[...dirs, name].join('/')}`,
      kind: 'excluded',
    }),
  ),
)

/** How a path reaches the script: an `A` or `M` line of the name-status listing, or the untracked list. */
const ITEM = fc.record({ entry: ENTRY, how: fc.constantFrom('A', 'M', 'untracked') })

describe('AC-2: the added test-code set is every added suite, helper and fixture, and nothing else', () => {
  it('AC-2: added and untracked test code is returned once, sorted; product, test files, modified and excluded paths never are (property)', () => {
    fc.assert(
      fc.property(
        fc
          .array(ITEM, { maxLength: 12 })
          .chain((items) => fc.subarray(items).map((again) => [...items, ...again])),
        (items) => {
          const nameStatus = items
            .filter((item) => item.how !== 'untracked')
            .map((item) => `${item.how}\t${item.entry.path}\n`)
            .join('')
          const untracked = items
            .filter((item) => item.how === 'untracked')
            .map((item) => item.entry.path)
          const added = new Set(
            items
              .filter((item) => item.entry.kind === 'test code' && item.how !== 'M')
              .map((item) => item.entry.path),
          )

          expect(addedTestCode(nameStatus, untracked)).toEqual([...added].sort())
        },
      ),
    )
  })

  it('AC-2: a new shared suite and fixture come in; its runner, the product module and a modified helper do not', () => {
    const nameStatus = [
      'A\tpackages/platform/tests/support/suites/order-sequence.ts',
      'A\tpackages/platform/tests/integration/order-sequence.test.ts',
      'A\tpackages/platform/src/db/order-sequence.ts',
      'M\tpackages/platform/tests/support/db.ts',
      'A\tpackages/sdk/src/__tests__/helpers/cart.ts',
      'A\ttests/tooling/fixtures/census/strong.ts',
      'A\ttests/sentinels/order-sequence.patch',
      'A\tsrc/testing/clock.ts',
      '',
    ].join('\n')
    const untracked = ['test/fixtures/data.json', 'src/divide.js', 'test/divide.test.js']

    const added: string[] = addedTestCode(nameStatus, untracked)

    expect(added).toEqual([
      'packages/platform/tests/support/suites/order-sequence.ts',
      'packages/sdk/src/__tests__/helpers/cart.ts',
      'test/fixtures/data.json',
    ])
    expect(added.filter((path) => TEST_FILE.test(path))).toEqual([])
  })
})

const NODE_ASSERTION = [
  '✖ total counts each line by its quantity (1.016167ms)',
  'ℹ tests 1',
  'ℹ suites 0',
  'ℹ pass 0',
  'ℹ fail 1',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 59.721459',
  '',
  '✖ failing tests:',
  '',
  'test at test/runner.test.js:4:1',
  '✖ total counts each line by its quantity (1.016167ms)',
  '  AssertionError [ERR_ASSERTION]: total counts each line by its quantity',
  '  ',
  '  2 !== 6',
  '  ',
  '      at TestContext.<anonymous> (file:///tmp/base/test/support/suite.js:6:12)',
  '      at Test.runInAsyncScope (node:async_hooks:226:14)',
  '      at Test.run (node:internal/test_runner/test:1402:25)',
  '      at Test.start (node:internal/test_runner/test:1262:17)',
  '      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {',
  '    generatedMessage: false,',
  "    code: 'ERR_ASSERTION',",
  '    actual: 2,',
  '    expected: 6,',
  "    operator: 'strictEqual',",
  "    diff: 'simple'",
  '  }',
].join('\n')

const NODE_MODULE_NOT_FOUND = [
  'node:internal/modules/esm/resolve:241',
  '    throw new ERR_MODULE_NOT_FOUND(',
  '          ^',
  '',
  "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/base/src/divide.js' imported from /tmp/base/test/divide.test.js",
  '    at finalizeResolution (node:internal/modules/esm/resolve:241:11)',
  '    at moduleResolve (node:internal/modules/esm/resolve:846:10)',
  '    at defaultResolve (node:internal/modules/esm/resolve:973:11)',
  '    at ModuleJob.link (node:internal/modules/esm/module_job:389:17) {',
  "  code: 'ERR_MODULE_NOT_FOUND',",
  "  url: 'file:///tmp/base/src/divide.js'",
  '}',
  '',
  'Node.js v26.12.1',
  '✖ test/divide.test.js (49.268041ms)',
  'ℹ tests 1',
  'ℹ fail 1',
  'ℹ duration_ms 54.860042',
  '',
  '✖ failing tests:',
  '',
  'test at test/divide.test.js:1:1',
  '✖ test/divide.test.js (49.268041ms)',
  "  'test failed'",
].join('\n')

const NODE_MISSING_EXPORT = [
  'file:///tmp/base/test/noexport.test.js:2',
  "import { divide } from '../src/math.js'",
  '         ^^^^^^',
  "SyntaxError: The requested module '../src/math.js' does not provide an export named 'divide'",
  '    at #asyncInstantiate (node:internal/modules/esm/module_job:463:21)',
  '    at async ModuleJob.run (node:internal/modules/esm/module_job:561:5)',
  '',
  'Node.js v26.12.1',
  '✖ test/noexport.test.js (46.652875ms)',
  'ℹ tests 1',
  'ℹ fail 1',
  '',
  '✖ failing tests:',
  '',
  'test at test/noexport.test.js:1:1',
  '✖ test/noexport.test.js (46.652875ms)',
  "  'test failed'",
].join('\n')

const VITEST_ASSERTION = [
  '',
  ' RUN  v3.2.4 /tmp/base',
  '',
  ' ❯ test/assert.test.js (1 test | 1 failed) 5ms',
  '   × value is two 4ms',
  '     → expected 1 to be 2 // Object.is equality',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  test/assert.test.js > value is two',
  'AssertionError: expected 1 to be 2 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- 2',
  '+ 1',
  '',
  ' ❯ test/assert.test.js:3:46',
  "      1| import { test, expect } from 'vitest'",
  "      2| import { value } from '../src/v.js'",
  "      3| test('value is two', () => { expect(value()).toBe(2) })",
  '       |                                              ^',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed (1)',
  '   Start at  19:07:04',
  '   Duration  273ms (transform 15ms, setup 0ms, collect 8ms, tests 5ms, environment 0ms, prepare 54ms)',
  '',
].join('\n')

/** A thrown string: Vitest prints `Unknown Error:`, which is no error shape, so only the `→ ` line says why. */
const VITEST_THROWN_STRING = [
  '',
  ' RUN  v3.2.4 /tmp/base',
  '',
  ' ❯ test/str.test.js (1 test | 1 failed) 1ms',
  '   × throws a string 1ms',
  '     → stock went negative',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  test/str.test.js > throws a string',
  'Unknown Error: stock went negative',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed (1)',
  '   Start at  19:09:15',
  '   Duration  617ms (transform 22ms, setup 0ms, collect 19ms, tests 1ms, environment 0ms, prepare 107ms)',
  '',
].join('\n')

const VITEST_MODULE_NOT_FOUND = [
  '',
  ' RUN  v3.2.4 /tmp/base',
  '',
  '',
  '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  test/missing.test.js [ test/missing.test.js ]',
  "Error: Cannot find module '../src/divide.js' imported from '/tmp/base/test/missing.test.js'",
  ' ❯ test/missing.test.js:2:31',
  "      1| import { test, expect } from 'vitest'",
  "      2| import { divide } from '../src/divide.js'",
  '       |                               ^',
  '',
  'Caused by: Error: Failed to load url ../src/divide.js (resolved id: ../src/divide.js) in /tmp/base/test/missing.test.js. Does the file exist?',
  ' ❯ loadAndTransform node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17',
  '',
  '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯',
  '',
  '',
  ' Test Files  1 failed (1)',
  '      Tests  no tests',
  '   Start at  19:07:04',
  '   Duration  283ms (transform 12ms, setup 0ms, collect 0ms, tests 0ms, environment 0ms, prepare 54ms)',
  '',
].join('\n')

describe('AC-6: the failure line is the error that failed the run, not a stack frame, a summary or `no output`', () => {
  it("AC-6: node --test's assertion: its AssertionError line, not the closing brace firstErrorLine falls back to", () => {
    expect(failureLine(NODE_ASSERTION)).toBe(
      'AssertionError [ERR_ASSERTION]: total counts each line by its quantity',
    )
    expect(failureLine(NODE_ASSERTION)).not.toBe(firstErrorLine(NODE_ASSERTION))
  })

  it('AC-6: Node ESM missing module: the ERR_MODULE_NOT_FOUND line, not the `throw new` source line above it', () => {
    expect(failureLine(NODE_MODULE_NOT_FOUND)).toBe(
      "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/tmp/base/src/divide.js' imported from /tmp/base/test/divide.test.js",
    )
  })

  it('AC-6: Node ESM missing named export: the SyntaxError line, not the source line or `test failed`', () => {
    expect(failureLine(NODE_MISSING_EXPORT)).toBe(
      "SyntaxError: The requested module '../src/math.js' does not provide an export named 'divide'",
    )
  })

  it("AC-6: a Vitest assertion: its expectation, from the AssertionError or the `→ ` line, not the run's Duration", () => {
    expect(failureLine(VITEST_ASSERTION)).toMatch(
      /^(?:→ |AssertionError: )expected 1 to be 2 \/\/ Object\.is equality$/,
    )
  })

  it('AC-6: Vitest with no error shape: the first `→ ` line, where firstErrorLine gives the Duration line', () => {
    expect(failureLine(VITEST_THROWN_STRING)).toMatch(/^(?:→ )?stock went negative$/)
    expect(firstErrorLine(VITEST_THROWN_STRING)).toMatch(/^Duration/)
  })

  it("AC-6: Vitest's missing module: its `Error: Cannot find module` line, not the `Caused by` below it", () => {
    expect(failureLine(VITEST_MODULE_NOT_FOUND)).toBe(
      "Error: Cannot find module '../src/divide.js' imported from '/tmp/base/test/missing.test.js'",
    )
  })

  /** Real output lines that are no error shape, some with "error", `ERR_` or `Error` in them. */
  const NOT_ERRORS = [
    'packages/sdk build: ESM dist/error.js 1.20 KB',
    ' WARN  1 deprecated subdependencies found: error-ex@1.3.2',
    'Found 1 error in src/index.ts:1',
    '  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);',
    'Unknown Error: stock went negative',
    '   Duration  617ms (transform 22ms, setup 0ms, collect 19ms, tests 1ms, environment 0ms, prepare 107ms)',
    "  'test failed'",
  ]
  /** Real error lines that are neither `<Name>Error:` nor a `→ ` line: firstErrorLine's own shapes. */
  const OTHER_ERRORS = [
    "src/index.ts(1,23): error TS2307: Cannot find module '@nymbalhq/types'.",
    '[ERR_PNPM_OUTDATED_LOCKFILE] Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/package.json',
    ' ERR_PNPM_LOCKFILE_BREAKING_CHANGE  Lockfile /tmp/base/pnpm-lock.yaml not compatible with current pnpm',
  ]

  it('AC-6: with no error line and no `→ ` line, it is firstErrorLine (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...NOT_ERRORS, ...OTHER_ERRORS, ''), { maxLength: 8 }),
        (lines) => {
          const output = lines.join('\n')
          expect(failureLine(output)).toBe(firstErrorLine(output))
        },
      ),
    )
  })
})
