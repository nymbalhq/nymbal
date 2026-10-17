import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  firstErrorLine,
  installBase,
  isDependencyLayoutPath,
} from '../../scripts/tests-fail-on-base'

// Acceptance tests for P0-02 follow-up round 1, AC-25 to AC-27: the pure decisions inside tests-fail-on-base.
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
