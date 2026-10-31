// Reads: scripts/tests-fail-on-base.ts
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

// A new test is judged on the base by what it asserts, not by an import the base cannot find: every test-code file the
// change adds (a shared suite, a helper, a fixture) is in the base worktree for the run; product files the change adds,
// and files it modifies, stay at the base. Every `fails on base` line says why, in parentheses. Each test builds a
// throwaway git repo with `node --test` as the suite and runs
// `scripts/tests-fail-on-base.ts <base> --root <repo> --suite 'node --test'`.

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

/** The message every behavioural assertion here carries, so a note quoting it is the assertion's own line. */
const QUANTITY = 'total counts each line by its quantity'

/** The base prices a cart by its lines' prices alone; the head multiplies each by its quantity. */
const BASE_CART =
  'export function total(lines) {\n  return lines.reduce((sum, line) => sum + line.price, 0)\n}\n'
const HEAD_CART =
  'export function total(lines) {\n  return lines.reduce((sum, line) => sum + line.price * (line.qty ?? 1), 0)\n}\n'

/** A shared suite: `node:test` cases over whatever cart module the runner hands it. */
function sharedSuite(assertion: string): string {
  return [
    "import { test } from 'node:test'",
    "import assert from 'node:assert/strict'",
    '',
    'export function cartSuite(cart) {',
    "  test('cart total', () => {",
    `    ${assertion}`,
    '  })',
    '}',
    '',
  ].join('\n')
}

/** Holds on the base and the head alike. */
const HOLDS_ON_BASE = `assert.equal(cart.total([{ price: 2 }, { price: 3 }]), 5, '${QUANTITY}')`
/** Holds only with the head's quantities. */
const NEEDS_HEAD = `assert.equal(cart.total([{ price: 2, qty: 3 }]), 6, '${QUANTITY}')`

/** A runner of the shared suite at `suitePath` (relative to test/), against the real cart. */
function runner(suitePath: string): string {
  return [
    "import * as cart from '../src/cart.js'",
    `import { cartSuite } from '${suitePath}'`,
    '',
    'cartSuite(cart)',
    '',
  ].join('\n')
}

/** A repo whose base prices by price alone and has one passing test; returns the root and the base sha. */
function makeRepo(): { root: string; base: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-tfob-imports-')))
  created.push(dir)
  const root = join(dir, 'repo')
  mkdirSync(root)
  write(
    root,
    'package.json',
    `${JSON.stringify({ name: 'tfob-imports-fixture', private: true, type: 'module' }, null, 2)}\n`,
  )
  write(root, 'src/cart.js', BASE_CART)
  write(
    root,
    'test/cart.test.js',
    [
      "import { test } from 'node:test'",
      "import assert from 'node:assert/strict'",
      "import { total } from '../src/cart.js'",
      '',
      "test('total', () => {",
      '  assert.equal(total([{ price: 4 }]), 4)',
      '})',
      '',
    ].join('\n'),
  )
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'tfob@example.test')
  git(root, 'config', 'user.name', 'TFOB Test')
  const base = commitAll(root, 'base')
  return { root, base }
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
    head: git(root, 'rev-parse', 'HEAD').trim(),
    status: git(root, 'status', '--porcelain=v1', '--untracked-files=all'),
    worktrees: git(root, 'worktree', 'list', '--porcelain'),
  }
}

const execFileAsync = promisify(execFile)

// Asynchronous runs only: a synchronous one blocks the Vitest worker's event loop past its RPC timeout under load.
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
    if (typeof error.code === 'string') throw error
    return { status: error.code ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function runScript(root: string, base: string) {
  const result = await run(TSX, [SCRIPT, base, '--root', root, '--suite', SUITE], {
    cwd: REPO,
    timeout: 50_000,
  })
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` }
}

/** Guards the fixture: every head test is green at head, so failing on base is the base's doing. */
async function expectGreenAtHead(root: string): Promise<void> {
  const result = await run('node', ['--test'], { cwd: root })
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

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

/** The note in parentheses on `<verdict>: <file> (<note>)`, or undefined when the line has none. */
function noteOf(out: string, file: string): string | undefined {
  const line = out.split('\n').find((l) => l.includes(`: ${file}`))
  return line === undefined ? undefined : /^[^:]+: \S+ \((.*)\)$/.exec(line)?.[1]
}

/** The test files git lists as added between base and HEAD: the files the script must give a verdict on. */
function addedTests(root: string, base: string): string[] {
  return git(root, 'diff', '--name-only', '--no-renames', '--diff-filter=A', base, 'HEAD')
    .split('\n')
    .filter((path) => /\.test\.js$/.test(path))
    .sort()
}

/** The test files the script gave a verdict on. */
function judged(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => l.includes('fails on base') || l.includes('PASSES ON BASE'))
    .map((l) => /test\/[\w/-]+\.test\.js/.exec(l)?.[0] ?? l)
    .sort()
}

describe('AC-1: a new runner of a new shared suite is judged by the suite’s assertion', () => {
  it('AC-1: a suite that holds on the base source makes its runner PASSES ON BASE and the step exit 1', async () => {
    const { root, base } = makeRepo()
    write(root, 'test/support/suite.js', sharedSuite(HOLDS_ON_BASE))
    write(root, 'test/runner.test.js', runner('./support/suite.js'))
    commitAll(root, 'head: a shared cart suite and its runner')
    await expectGreenAtHead(root)
    const before = state(root)

    const { status, out } = await runScript(root, base)

    expect(verdictsOf(out, 'test/runner.test.js'), out).toEqual(['PASSES ON BASE'])
    expect(status, out).toBe(1)
    expect(judged(out), out).toEqual(addedTests(root, base))
    expect(state(root)).toEqual(before)
  })

  it('AC-1: a suite that needs the head’s source makes its runner fail on base with the assertion’s line as the note', async () => {
    const { root, base } = makeRepo()
    write(root, 'src/cart.js', HEAD_CART)
    write(root, 'test/support/suite.js', sharedSuite(NEEDS_HEAD))
    write(root, 'test/runner.test.js', runner('./support/suite.js'))
    commitAll(root, 'head: quantities, a shared cart suite and its runner')
    await expectGreenAtHead(root)

    const { status, out } = await runScript(root, base)

    expect(verdictsOf(out, 'test/runner.test.js'), out).toEqual(['fails on base'])
    expect(noteOf(out, 'test/runner.test.js'), out).toBe(
      `AssertionError [ERR_ASSERTION]: ${QUANTITY}`,
    )
    expect(out).not.toContain('Cannot find module')
    expect(status, out).toBe(0)
  })
})

describe('AC-2: a support file the change renames is on the base at its new path', () => {
  it('AC-2: a suite moved to a new path in the range is present on base, so its runner is judged by its assertion', async () => {
    const { root } = makeRepo()
    write(root, 'test/helpers/cart-suite.js', sharedSuite(HOLDS_ON_BASE))
    const base = commitAll(root, 'base: a shared suite under helpers')
    mkdirSync(join(root, 'test/support'))
    git(root, 'mv', 'test/helpers/cart-suite.js', 'test/support/suite.js')
    write(root, 'test/runner.test.js', runner('./support/suite.js'))
    commitAll(root, 'head: the suite moves to support and gains a runner')
    await expectGreenAtHead(root)
    // The fixture is a rename as git sees it by default, not an add and a delete.
    expect(git(root, 'diff', '--name-status', base, 'HEAD')).toMatch(
      /^R\d+\ttest\/helpers\/cart-suite\.js\ttest\/support\/suite\.js$/m,
    )

    const { status, out } = await runScript(root, base)

    expect(verdictsOf(out, 'test/runner.test.js'), out).toEqual(['PASSES ON BASE'])
    expect(status, out).toBe(1)
  })
})

describe('AC-3: a fixture the change adds and a test reads by URL is on the base', () => {
  it('AC-3: a test reading test/fixtures/data.json via import.meta.url fails on base with its assertion, not ENOENT', async () => {
    const { root, base } = makeRepo()
    write(root, 'src/cart.js', HEAD_CART)
    write(root, 'test/fixtures/data.json', `${JSON.stringify([{ price: 2, qty: 3 }])}\n`)
    write(
      root,
      'test/quantity.test.js',
      [
        "import { readFileSync } from 'node:fs'",
        "import { test } from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { total } from '../src/cart.js'",
        '',
        "const lines = JSON.parse(readFileSync(new URL('./fixtures/data.json', import.meta.url), 'utf8'))",
        '',
        "test('quantities', () => {",
        `  assert.equal(total(lines), 6, '${QUANTITY}')`,
        '})',
        '',
      ].join('\n'),
    )
    commitAll(root, 'head: quantities, read from a fixture')
    await expectGreenAtHead(root)

    const { status, out } = await runScript(root, base)

    expect(verdictsOf(out, 'test/quantity.test.js'), out).toEqual(['fails on base'])
    expect(noteOf(out, 'test/quantity.test.js'), out).toBe(
      `AssertionError [ERR_ASSERTION]: ${QUANTITY}`,
    )
    expect(out).not.toContain('ENOENT')
    expect(status, out).toBe(0)
  })
})

describe('AC-4: a product module the change adds stays off the base', () => {
  it('AC-4: a test of a new src/divide.js fails on base, exit 0, its note naming the module the base worktree lacks', async () => {
    const { root, base } = makeRepo()
    write(root, 'src/divide.js', 'export function divide(a, b) {\n  return a / b\n}\n')
    write(
      root,
      'test/divide.test.js',
      [
        "import { test } from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { divide } from '../src/divide.js'",
        '',
        "test('divide', () => {",
        '  assert.equal(divide(6, 3), 2)',
        '})',
        '',
      ].join('\n'),
    )
    commitAll(root, 'head: divide')
    await expectGreenAtHead(root)
    const before = state(root)

    const { status, out } = await runScript(root, base)

    expect(verdictsOf(out, 'test/divide.test.js'), out).toEqual(['fails on base'])
    const note = noteOf(out, 'test/divide.test.js') ?? ''
    expect(note, out).toMatch(/Cannot find module '[^']*\/src\/divide\.js'/)
    // The module was looked for in the base worktree, never in the checkout being judged.
    const missing = /Cannot find module '([^']*)'/.exec(note)?.[1] ?? ''
    expect(missing.startsWith(`${root}/`), out).toBe(false)
    expect(status, out).toBe(0)
    expect(state(root)).toEqual(before)
  })
})

describe('AC-5: a support file the change modifies stays at the base’s version', () => {
  const VALUE = 'the support value is the head’s 2'

  it('AC-5: a new suite asserting the head’s value() makes its runner fail on base with the assertion’s line', async () => {
    const { root } = makeRepo()
    write(root, 'test/support/value.js', 'export function value() {\n  return 1\n}\n')
    const base = commitAll(root, 'base: a support value')
    write(root, 'test/support/value.js', 'export function value() {\n  return 2\n}\n')
    write(
      root,
      'test/support/suite.js',
      [
        "import { test } from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { value } from './value.js'",
        '',
        'export function valueSuite() {',
        "  test('value', () => {",
        `    assert.equal(value(), 2, '${VALUE}')`,
        '  })',
        '}',
        '',
      ].join('\n'),
    )
    write(
      root,
      'test/value.test.js',
      "import { valueSuite } from './support/suite.js'\n\nvalueSuite()\n",
    )
    commitAll(root, 'head: value is 2, with a suite and its runner')
    await expectGreenAtHead(root)

    const { status, out } = await runScript(root, base)

    expect(verdictsOf(out, 'test/value.test.js'), out).toEqual(['fails on base'])
    expect(noteOf(out, 'test/value.test.js'), out).toBe(`AssertionError [ERR_ASSERTION]: ${VALUE}`)
    expect(status, out).toBe(0)
  })
})
