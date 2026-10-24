import { type ExecFileException, execFile, execFileSync } from 'node:child_process'
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
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

// AC-6 and AC-13 to AC-15: `scripts/tests-fail-on-base.ts <base> --root <repo> --suite <command>`. Each test builds a
// throwaway git repo: a tiny module, tests, a base commit and a change that adds tests. The script runs
// `<suite> <test file>` for every added test file against the base commit's source in a temporary worktree, and must
// leave the checkout exactly as it found it.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const SCRIPT = join(REPO, 'scripts/tests-fail-on-base.ts')
const VITEST = join(REPO, 'node_modules/.bin/vitest')
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
      // A link is recorded as its target and never followed: pnpm's node_modules links are part of the checkout.
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
    head: git(root, 'rev-parse', 'HEAD').trim(),
    branch: git(root, 'symbolic-ref', '-q', 'HEAD').trim(),
    status: git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
    worktrees: git(root, 'worktree', 'list', '--porcelain'),
    branches: git(root, 'branch', '--list', '--all'),
    stash: git(root, 'stash', 'list'),
  }
}

const execFileAsync = promisify(execFile)

// Every run of a real program here is asynchronous: a synchronous one blocks the Vitest worker's event loop, and a
// file of them (over 60 s under load) leaves the worker's pending RPCs unanswered past their 60 s timeout.
async function run(
  command: string,
  args: string[],
  options: { cwd: string; timeout?: number },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { ...options, encoding: 'utf8' })
    return { status: 0, stdout, stderr }
  } catch (e) {
    const error = e as ExecFileException & { stdout?: string; stderr?: string }
    // A string code is a failure to start (ENOENT, a full buffer), not an exit status.
    if (typeof error.code === 'string') throw error
    return { status: error.code ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function runScript(root: string, base: string, suite = SUITE) {
  const result = await run(TSX, [SCRIPT, base, '--root', root, '--suite', suite], {
    cwd: REPO,
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
async function expectGreenAtHead(root: string): Promise<void> {
  const result = await run('node', ['--test'], { cwd: root })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

describe('AC-6: tests-fail-on-base', () => {
  it('AC-6: a new test that fails on the base source is fine: exit 0, reported as "fails on base"', async () => {
    const { root, base } = makeRepo()
    addGoodHead(root)
    commitAll(root, 'head: multiply')
    await expectGreenAtHead(root)
    write(root, 'notes/untracked.txt', 'left alone\n')
    const before = state(root)

    const { status, out } = await runScript(root, base)

    expect(status, out).toBe(0)
    expect(lineFor(out, 'test/multiply.test.js'), out).toContain('fails on base')
    expect(out).not.toContain('PASSES ON BASE')
    expect(judged(out), out).toEqual(addedTests(root, base))
    expect(before).toEqual(state(root))
  })

  it('AC-6: a new test that passes on the base source is a violation: exit 1, reported as "PASSES ON BASE"', async () => {
    const { root, base } = makeRepo()
    addGoodHead(root)
    write(root, 'test/add-zero.test.js', testFile('add', 'assert.equal(add(0, 7), 7)'))
    commitAll(root, 'head: multiply and a test that cannot fail on base')
    await expectGreenAtHead(root)
    write(root, 'notes/untracked.txt', 'left alone\n')
    const before = state(root)

    const { status, out } = await runScript(root, base)

    expect(status, out).toBe(1)
    expect(lineFor(out, 'test/add-zero.test.js'), out).toContain('PASSES ON BASE')
    expect(lineFor(out, 'test/multiply.test.js'), out).toContain('fails on base')
    expect(judged(out), out).toEqual(addedTests(root, base))
    expect(before).toEqual(state(root))
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-13 to AC-15
// ---------------------------------------------------------------------------------------------------------------

const VERDICTS = ['not judged', 'fails on base', 'PASSES ON BASE'] as const

/** Every verdict phrase on the lines naming `file`; a file judged once has exactly one. */
function verdictsOf(out: string, file: string): string[] {
  const found = new Set<string>()
  for (const line of out.split('\n')) {
    if (!line.includes(file)) continue
    for (const verdict of VERDICTS) if (line.includes(verdict)) found.add(verdict)
  }
  return [...found]
}

function emptyRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-tfob-')))
  created.push(dir)
  const root = join(dir, 'repo')
  mkdirSync(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'tfob@example.test')
  git(root, 'config', 'user.name', 'TFOB Test')
  return root
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function expectExit0(cwd: string, command: string, args: string[]): Promise<void> {
  const result = await run(command, args, { cwd })
  expect(result.status, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toBe(0)
}

describe('AC-13: tests-fail-on-base resolves workspace packages from the base commit', () => {
  function workspaceTest(name: string, assertion: string): string {
    return [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      `import { ${name} } from '@tfob/lib'`,
      '',
      `test('${name}', () => {`,
      `  ${assertion}`,
      '})',
      '',
    ].join('\n')
  }

  /** A pnpm workspace: `@tfob/app`'s tests import `@tfob/lib` through the link `pnpm install` makes. */
  async function makeWorkspace(): Promise<{ root: string; base: string }> {
    const root = emptyRepo()
    write(root, '.gitignore', 'node_modules/\n')
    write(root, 'package.json', json({ name: 'tfob-workspace', private: true, type: 'module' }))
    write(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n")
    write(
      root,
      'packages/lib/package.json',
      json({ name: '@tfob/lib', version: '1.0.0', type: 'module', exports: './src/index.js' }),
    )
    write(root, 'packages/lib/src/index.js', BASE_MATH)
    write(
      root,
      'packages/app/package.json',
      json({
        name: '@tfob/app',
        version: '1.0.0',
        type: 'module',
        dependencies: { '@tfob/lib': 'workspace:*' },
      }),
    )
    write(root, 'packages/app/test/add.test.js', workspaceTest('add', 'assert.equal(add(2, 3), 5)'))
    await expectExit0(root, 'pnpm', ['install', '--offline', '--no-frozen-lockfile'])
    const base = commitAll(root, 'base')
    return { root, base }
  }

  it('AC-13: a new test needing behaviour the change adds to another workspace package fails on base; one that does not, passes', async () => {
    const { root, base } = await makeWorkspace()
    write(root, 'packages/lib/src/index.js', HEAD_MATH)
    write(
      root,
      'packages/app/test/multiply.test.js',
      workspaceTest('multiply', 'assert.equal(multiply(2, 3), 6)'),
    )
    write(
      root,
      'packages/app/test/add-zero.test.js',
      workspaceTest('add', 'assert.equal(add(0, 7), 7)'),
    )
    commitAll(root, 'head: lib gains multiply')
    await expectGreenAtHead(root)
    const before = state(root)

    const { status, out } = await runScript(root, base)

    expect(verdictsOf(out, 'packages/app/test/multiply.test.js'), out).toEqual(['fails on base'])
    expect(verdictsOf(out, 'packages/app/test/add-zero.test.js'), out).toEqual(['PASSES ON BASE'])
    expect(status, out).toBe(1)
    expect(state(root)).toEqual(before)
  })
})

describe('AC-14: a base run that executes no test is "not judged"', () => {
  function vitestTest(name: string, assertion: string): string {
    return [
      "import { expect, test } from 'vitest'",
      `import { ${name} } from '../src/math.js'`,
      '',
      `test('${name}', () => {`,
      `  ${assertion}`,
      '})',
      '',
    ].join('\n')
  }

  function vitestConfig(projects: Array<{ name: string; include: string }>): string {
    const rows = projects.map(
      (p) => `    { test: { name: '${p.name}', include: ['${p.include}'] } },`,
    )
    return [
      'export default {',
      '  test: {',
      '    projects: [',
      ...rows,
      '    ],',
      '  },',
      '}',
      '',
    ].join('\n')
  }

  /** A repo tested by Vitest with one project, `unit`, over test/. */
  function makeVitestRepo(): { root: string; base: string } {
    const root = emptyRepo()
    write(root, '.gitignore', 'node_modules/\n')
    write(root, 'package.json', json({ name: 'tfob-vitest', private: true, type: 'module' }))
    write(root, 'vitest.config.mjs', vitestConfig([{ name: 'unit', include: 'test/**/*.test.js' }]))
    write(root, 'src/math.js', BASE_MATH)
    write(root, 'test/add.test.js', vitestTest('add', 'expect(add(2, 3)).toBe(5)'))
    const base = commitAll(root, 'base')
    return { root, base }
  }

  function headWithSpecsProject(root: string): void {
    write(root, 'src/math.js', HEAD_MATH)
    write(
      root,
      'vitest.config.mjs',
      vitestConfig([
        { name: 'unit', include: 'test/**/*.test.js' },
        { name: 'specs', include: 'spec/**/*.test.js' },
      ]),
    )
    write(
      root,
      'spec/multiply-spec.test.js',
      vitestTest('multiply', 'expect(multiply(2, 3)).toBe(6)'),
    )
  }

  it('AC-14: a file the base configuration does not collect ("No test files found") is not judged and listed apart from the judged ones', async () => {
    const { root, base } = makeVitestRepo()
    headWithSpecsProject(root)
    write(root, 'test/multiply.test.js', vitestTest('multiply', 'expect(multiply(2, 3)).toBe(6)'))
    commitAll(root, 'head: a specs project and two tests')
    await expectExit0(root, VITEST, ['run'])

    const { out } = await runScript(root, base, `${VITEST} run`)

    expect(verdictsOf(out, 'spec/multiply-spec.test.js'), out).toEqual(['not judged'])
    expect(verdictsOf(out, 'test/multiply.test.js'), out).toEqual(['fails on base'])
  })

  it('AC-14: a suite naming a project that does not exist at base is not judged', async () => {
    const { root, base } = makeVitestRepo()
    headWithSpecsProject(root)
    commitAll(root, 'head: a specs project')
    await expectExit0(root, VITEST, ['run', '--project', 'specs', 'spec/multiply-spec.test.js'])

    const { out } = await runScript(root, base, `${VITEST} run --project specs`)

    expect(verdictsOf(out, 'spec/multiply-spec.test.js'), out).toEqual(['not judged'])
  })

  it('AC-14: a base run that ends by a signal is not judged', async () => {
    const { root, base } = makeRepo()
    write(root, 'src/math.js', HEAD_MATH)
    // At base `multiply` is missing and the run is killed before any test executes.
    write(
      root,
      'test/killed.test.js',
      [
        "import { test } from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import * as math from '../src/math.js'",
        '',
        "if (typeof math.multiply !== 'function') process.kill(process.pid, 'SIGKILL')",
        '',
        "test('multiply', () => {",
        '  assert.equal(math.multiply(2, 3), 6)',
        '})',
        '',
      ].join('\n'),
    )
    write(root, 'test/multiply.test.js', testFile('multiply', 'assert.equal(multiply(2, 3), 6)'))
    commitAll(root, 'head: multiply')
    await expectExit0(root, 'node', ['test/killed.test.js'])
    await expectExit0(root, 'node', ['test/multiply.test.js'])

    const { out } = await runScript(root, base, 'node')

    expect(verdictsOf(out, 'test/killed.test.js'), out).toEqual(['not judged'])
    expect(verdictsOf(out, 'test/multiply.test.js'), out).toEqual(['fails on base'])
  })
})

describe('AC-15: added test files include uncommitted and untracked ones', () => {
  it('AC-15: a staged new test and an untracked new test are both judged, on their working-tree contents', async () => {
    const { root, base } = makeRepo()
    // Nothing is committed after base: the source change is unstaged, one test staged, one untracked.
    write(root, 'src/math.js', HEAD_MATH)
    write(root, 'test/multiply.test.js', testFile('multiply', 'assert.equal(multiply(2, 3), 6)'))
    git(root, 'add', 'test/multiply.test.js')
    write(root, 'test/add-zero.test.js', testFile('add', 'assert.equal(add(0, 7), 7)'))
    await expectGreenAtHead(root)
    expect(git(root, 'rev-parse', 'HEAD').trim()).toBe(base)
    const before = state(root)

    const { status, out } = await runScript(root, base)

    expect(verdictsOf(out, 'test/multiply.test.js'), out).toEqual(['fails on base'])
    expect(verdictsOf(out, 'test/add-zero.test.js'), out).toEqual(['PASSES ON BASE'])
    expect(status, out).toBe(1)
    expect(state(root)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------------------------------------------
// AC-22 and AC-23: a dependency change between base and HEAD, and a base that cannot install or build
// ---------------------------------------------------------------------------------------------------------------

async function runWith(root: string, base: string, extra: string[]) {
  const result = await run(TSX, [SCRIPT, base, '--root', root, '--suite', SUITE, ...extra], {
    cwd: REPO,
    timeout: 50_000,
  })
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

/** A node:test file in packages/app/test that imports the app's own source, which re-exports the lib. */
function appTest(name: string, assertion: string): string {
  return [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    `import { ${name} } from '../src/index.js'`,
    '',
    `test('${name}', () => {`,
    `  ${assertion}`,
    '})',
    '',
  ].join('\n')
}

/** Writes a two-package workspace: `<scope>/app` depends on and re-exports `<scope>/lib`, and builds against it. */
function writeWorkspace(root: string, scope: string, lib: string): void {
  write(root, '.gitignore', 'node_modules/\n')
  write(root, 'package.json', json({ name: 'tfob-workspace', private: true, type: 'module' }))
  write(root, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n")
  write(
    root,
    'packages/lib/package.json',
    json({ name: `${scope}/lib`, version: '1.0.0', type: 'module', exports: './src/index.js' }),
  )
  write(root, 'packages/lib/src/index.js', lib)
  write(
    root,
    'packages/app/package.json',
    json({
      name: `${scope}/app`,
      version: '1.0.0',
      type: 'module',
      dependencies: { [`${scope}/lib`]: 'workspace:*' },
    }),
  )
  write(root, 'packages/app/src/index.js', `export * from '${scope}/lib'\n`)
  // The build resolves the lib by the name this commit's manifests give it.
  write(
    root,
    'packages/app/build.mjs',
    `import { add } from '${scope}/lib'\nif (add(1, 1) !== 2) process.exit(1)\n`,
  )
  write(root, 'packages/app/test/add.test.js', appTest('add', 'assert.equal(add(2, 3), 5)'))
}

const APP_BUILD = 'node packages/app/build.mjs'

/** The lines naming `file`: one per added file, each with its verdict and note. */
function linesFor(out: string, file: string): string[] {
  return out.split('\n').filter((l) => l.includes(file))
}

describe('AC-22: a dependency change installs the base dependencies in the base worktree', () => {
  it('AC-22: HEAD renames a workspace dependency; the base builds by its own names and a new test fails on base for its own reason', async () => {
    const root = emptyRepo()
    writeWorkspace(root, '@scope-a', BASE_MATH)
    await expectExit0(root, 'pnpm', ['install', '--offline', '--no-frozen-lockfile'])
    const base = commitAll(root, 'base: @scope-a')

    // HEAD renames the scope and adds multiply; HEAD's node_modules know only @scope-b.
    writeWorkspace(root, '@scope-b', HEAD_MATH)
    write(
      root,
      'packages/app/test/multiply.test.js',
      appTest('multiply', 'assert.equal(multiply(2, 3), 6)'),
    )
    write(root, 'packages/app/test/add-zero.test.js', appTest('add', 'assert.equal(add(0, 7), 7)'))
    await expectExit0(root, 'pnpm', ['install', '--offline', '--no-frozen-lockfile'])
    commitAll(root, 'head: @scope-b, lib gains multiply')
    await expectGreenAtHead(root)
    await expectExit0(root, 'node', ['packages/app/build.mjs'])
    // Guards: the dependency change is real, and mirroring HEAD's modules cannot resolve the base's name.
    expect(git(root, 'diff', '--name-only', base, 'HEAD')).toContain('pnpm-lock.yaml')
    expect(readdirSync(join(root, 'packages/app/node_modules'))).not.toContain('@scope-a')
    const before = state(root)

    const { status, out } = await runWith(root, base, ['--build', APP_BUILD])

    expect(verdictsOf(out, 'packages/app/test/multiply.test.js'), out).toEqual(['fails on base'])
    // Passing on base proves the base run resolved @scope-a/lib: the failure above is the missing multiply.
    expect(verdictsOf(out, 'packages/app/test/add-zero.test.js'), out).toEqual(['PASSES ON BASE'])
    expect(status, out).toBe(1)
    expect(state(root)).toEqual(before)
  })
})

describe('AC-23 (revised): a base that cannot install or build fails the step closed and says why', () => {
  const TSC_ERROR =
    "src/index.ts(1,23): error TS2307: Cannot find module '@nymbalhq/types' or its corresponding type declarations."
  // The build's last line: it is no error shape, so it can reach the output only as part of the tail.
  const LAST_LINE = 'Found 1 error in src/index.ts:1 (tail line)'

  it('AC-23 (revised): a failing base build exits non-zero with "base did not build: <first error line>" and the output tail; every added file is not judged with that reason', async () => {
    const { root } = makeRepo()
    write(
      root,
      'build.mjs',
      [
        "console.log('CLI Building entry: src/index.ts')",
        `console.error(${JSON.stringify(TSC_ERROR)})`,
        `console.error(${JSON.stringify(LAST_LINE)})`,
        'process.exit(2)',
        '',
      ].join('\n'),
    )
    const base = commitAll(root, 'base: a build that fails')
    write(root, 'build.mjs', 'process.exit(0)\n')
    // One added test would fail on base and one would pass: neither may be judged.
    addGoodHead(root)
    write(root, 'test/add-zero.test.js', testFile('add', 'assert.equal(add(0, 7), 7)'))
    commitAll(root, 'head: the build is fixed, multiply and two new tests')
    await expectGreenAtHead(root)
    const added = addedTests(root, base)
    expect(added.length).toBeGreaterThanOrEqual(2)
    const before = state(root)

    const { status, out } = await runWith(root, base, ['--build', 'node build.mjs'])

    for (const file of added) {
      expect(verdictsOf(out, file), out).toEqual(['not judged'])
      expect(linesFor(out, file).join('\n'), out).toContain(`base did not build: ${TSC_ERROR}`)
    }
    expect(out, out).toContain(LAST_LINE)
    expect(status, out).not.toBe(0)
    expect(state(root)).toEqual(before)
  })

  it('AC-23 (revised): a base whose dependencies cannot install (lockfile out of date) exits non-zero naming the pnpm error; every added file is not judged', async () => {
    const root = emptyRepo()
    writeWorkspace(root, '@scope-a', BASE_MATH)
    await expectExit0(root, 'pnpm', ['install', '--offline', '--no-frozen-lockfile'])
    // The base commits a manifest change without the lockfile it needs: a frozen install of it fails.
    write(
      root,
      'packages/app/package.json',
      json({
        name: '@scope-a/app',
        version: '1.0.0',
        type: 'module',
        dependencies: { '@scope-a/lib': 'workspace:*', '@scope-a/util': 'workspace:*' },
      }),
    )
    write(
      root,
      'packages/util/package.json',
      json({ name: '@scope-a/util', version: '1.0.0', type: 'module' }),
    )
    const base = commitAll(root, 'base: a dependency without its lockfile entry')
    write(root, 'packages/lib/src/index.js', HEAD_MATH)
    write(
      root,
      'packages/app/test/multiply.test.js',
      appTest('multiply', 'assert.equal(multiply(2, 3), 6)'),
    )
    write(root, 'packages/app/test/add-zero.test.js', appTest('add', 'assert.equal(add(0, 7), 7)'))
    await expectExit0(root, 'pnpm', ['install', '--offline', '--no-frozen-lockfile'])
    commitAll(root, 'head: the lockfile is brought up to date')
    await expectGreenAtHead(root)
    expect(git(root, 'diff', '--name-only', base, 'HEAD')).toContain('pnpm-lock.yaml')
    const before = state(root)

    const { status, out } = await runWith(root, base, ['--build', ''])

    for (const file of [
      'packages/app/test/multiply.test.js',
      'packages/app/test/add-zero.test.js',
    ]) {
      expect(verdictsOf(out, file), out).toEqual(['not judged'])
      // The first error line, not pnpm's progress lines before it.
      // pnpm 9 prints ` ERR_PNPM_X  msg`, 10 and 11 `[ERR_PNPM_X] msg`, 12 `Error: ERR_PNPM_X`.
      expect(linesFor(out, file).join('\n'), out).toMatch(
        /base did not build: (?:\[|Error: )?ERR_PNPM_OUTDATED_LOCKFILE\b/,
      )
    }
    expect(status, out).not.toBe(0)
    expect(state(root)).toEqual(before)
  })
})
