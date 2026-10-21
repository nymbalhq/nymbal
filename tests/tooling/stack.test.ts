import { execFile, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { COMPOSE_PORT_VARS, expectedBlock, PORT_FIELDS } from './stack-table'

// Acceptance tests for P2-14 AC-1, AC-2 and AC-6: scripts/stack.ts gives each checkout a stack slot (the main checkout
// 0, a linked worktree the lowest free 1..9, kept until the worktree is removed) and each slot a block of ports.
// AC-2 and AC-6 run in a throwaway git repository with linked worktrees, made in the system temp directory.

const exec = promisify(execFile)

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const STACK_PATH = join(REPO, 'scripts/stack.ts')
const STACK_URL = pathToFileURL(STACK_PATH).href

// Loaded in each test, so that each names its own failure while the module is missing.
const loadStack = () => import('../../scripts/stack')

const created: string[] = []
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  created.push(dir)
  return dir
}

/** The environment without git's own variables (a hook sets GIT_DIR) or a slot from the shell that runs the tests. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name]
  delete env.NYMBAL_STACK_SLOT
  return env
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' }).trim()
}

/** A repository with one empty commit, in `<tmp>/main`; its worktrees go beside it. */
function tempRepo(): string {
  const main = join(scratch('nymbal-stack-'), 'main')
  mkdirSync(main)
  git(main, 'init', '-q', '-b', 'main')
  git(
    main,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'init',
  )
  return main
}

function addWorktree(main: string, name: string): string {
  const path = join(main, '..', name)
  git(main, 'worktree', 'add', '-q', '-b', name, path)
  return realpathSync(path)
}

// A child that loads scripts/stack.ts, then (with a barrier) says `ready` and waits for a line on stdin before it
// resolves, so that several children resolve at the same moment rather than as each happens to finish loading.
const RESOLVE = `import(process.env.NYMBAL_TEST_STACK_URL)
  .then((m) =>
    new Promise((go) => {
      if (!process.env.NYMBAL_TEST_BARRIER) return go()
      process.stdin.once('data', () => { process.stdin.destroy(); go() })
      process.stdout.write('ready\\n')
    }).then(() => m.resolveSlot(process.cwd(), {})),
  )
  .then(
    (slot) => process.stdout.write('\\n' + JSON.stringify({ slot }) + '\\n'),
    (e) => process.stdout.write('\\n' + JSON.stringify({ error: String(e && e.message !== undefined ? e.message : e) }) + '\\n'),
  )`

type Resolved = { slot?: number; error?: string }

function lastJson(stdout: string): Resolved {
  return JSON.parse(stdout.trimEnd().split('\n').pop() ?? '{}') as Resolved
}

/** Resolves the slot of each directory in a child process of its own; with `together`, all at the same moment. */
async function resolveInChildren(dirs: string[], together: boolean): Promise<Resolved[]> {
  const runs = dirs.map((cwd) => {
    const child = spawn(TSX, ['--eval', RESOLVE], {
      cwd,
      env: {
        ...cleanEnv(),
        NYMBAL_TEST_STACK_URL: STACK_URL,
        ...(together ? { NYMBAL_TEST_BARRIER: '1' } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.on('error', () => {})
    let stdout = ''
    let markReady = (): void => {}
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.includes('ready\n')) markReady()
    })
    const done = new Promise<string>((resolve) => {
      child.on('close', () => {
        markReady()
        resolve(stdout)
      })
    })
    return { child, ready, done }
  })
  if (together) {
    await Promise.all(runs.map((r) => r.ready))
    for (const r of runs) r.child.stdin.write('go\n')
  } else {
    for (const r of runs) r.child.stdin.end()
  }
  return (await Promise.all(runs.map((r) => r.done))).map(lastJson)
}

describe('AC-1: stackBlock gives each slot a disjoint block of ports', () => {
  it("AC-1: stackBlock(0) is the spec table's slot 0 row exactly, and MAX_SLOT is 9", async () => {
    const { stackBlock, MAX_SLOT } = await loadStack()
    expect(stackBlock(0)).toEqual(expectedBlock(0))
    expect(MAX_SLOT).toBe(9)
  })

  it('AC-1: every slot k in 0..9 adds 100k to every port and names project nymbal (k = 0) or nymbal-s<k>', async () => {
    const { stackBlock, MAX_SLOT } = await loadStack()
    for (let slot = 0; slot <= MAX_SLOT; slot++) {
      expect(stackBlock(slot)).toEqual(expectedBlock(slot))
      expect(PORT_FIELDS.map((f) => stackBlock(slot)[f] - stackBlock(0)[f])).toEqual(
        PORT_FIELDS.map(() => 100 * slot),
      )
    }
  })

  it('AC-1: property: two distinct slots share no port; within a block all 17 ports are distinct and in 1024..65535', async () => {
    const { stackBlock, MAX_SLOT } = await loadStack()
    const ports = (slot: number): number[] => PORT_FIELDS.map((f) => stackBlock(slot)[f])
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: MAX_SLOT }),
        fc.integer({ min: 0, max: MAX_SLOT }),
        (a, b) => {
          fc.pre(a !== b)
          const theirs = new Set(ports(b))
          expect(ports(a).filter((port) => theirs.has(port))).toEqual([])
        },
      ),
      { numRuns: 200 },
    )
    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_SLOT }), (slot) => {
        const own = ports(slot)
        expect(new Set(own).size).toBe(PORT_FIELDS.length)
        expect(PORT_FIELDS.length).toBe(17)
        expect(Math.min(...own)).toBeGreaterThanOrEqual(1024)
        expect(Math.max(...own)).toBeLessThanOrEqual(65535)
      }),
    )
  })

  it.each([10, -1, 1.5])('AC-1: stackBlock(%s) throws a RangeError', async (slot) => {
    const { stackBlock } = await loadStack()
    expect(() => stackBlock(slot)).toThrow(RangeError)
  })
})

describe('AC-2: resolveSlot gives each worktree a slot of its own, kept until the worktree is removed', () => {
  it('AC-2 (a): the main checkout is slot 0', async () => {
    const { resolveSlot } = await loadStack()
    const main = tempRepo()
    expect(resolveSlot(main, {})).toBe(0)
  })

  it('AC-2 (b): two linked worktrees get 1 and 2, and each keeps its slot on a second call and in another process', async () => {
    const { resolveSlot } = await loadStack()
    const main = tempRepo()
    const one = addWorktree(main, 'wt1')
    const two = addWorktree(main, 'wt2')
    const first = [resolveSlot(one, {}), resolveSlot(two, {})]
    expect(first).toEqual([1, 2])
    expect([resolveSlot(one, {}), resolveSlot(two, {})]).toEqual(first)
    // A fresh process has nothing in memory: it can only find the slot in the claim.
    const again = await resolveInChildren([one, two], false)
    expect(again.map((r) => r.slot ?? r.error)).toEqual(first)
  })

  it('AC-2 (c): after `git worktree remove` of the first, a new third worktree gets its slot, 1', async () => {
    const { resolveSlot } = await loadStack()
    const main = tempRepo()
    const one = addWorktree(main, 'wt1')
    const two = addWorktree(main, 'wt2')
    expect([resolveSlot(one, {}), resolveSlot(two, {})]).toEqual([1, 2])
    git(main, 'worktree', 'remove', one)
    const three = addWorktree(main, 'wt3')
    expect(resolveSlot(three, {})).toBe(1)
    expect(resolveSlot(two, {})).toBe(2)
  })

  it('AC-2 (d): NYMBAL_STACK_SLOT=7 gives 7 anywhere; 12 and x throw naming the variable; empty is unset', async () => {
    const { resolveSlot } = await loadStack()
    const main = tempRepo()
    const worktree = addWorktree(main, 'wt1')
    const outside = scratch('nymbal-stack-outside-')
    expect(
      [main, worktree, outside].map((dir) => resolveSlot(dir, { NYMBAL_STACK_SLOT: '7' })),
    ).toEqual([7, 7, 7])
    for (const bad of ['12', 'x']) {
      expect(() => resolveSlot(main, { NYMBAL_STACK_SLOT: bad })).toThrow(/NYMBAL_STACK_SLOT/)
    }
    expect(resolveSlot(main, { NYMBAL_STACK_SLOT: '' })).toBe(0)
  })

  it('AC-2 (e): a directory outside any git repository is slot 0', async () => {
    const { resolveSlot } = await loadStack()
    expect(resolveSlot(scratch('nymbal-stack-outside-'), {})).toBe(0)
  })

  it('AC-2: property: four new worktrees resolving at the same moment, each in its own process, get four distinct free slots', async () => {
    const { resolveSlot, MAX_SLOT } = await loadStack()
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 5 }), async (held) => {
        const main = tempRepo()
        const before = Array.from({ length: held }, (_, i) =>
          resolveSlot(addWorktree(main, `held${i}`), {}),
        )
        const racing = Array.from({ length: 4 }, (_, i) => addWorktree(main, `race${i}`))
        const results = await resolveInChildren(racing, true)
        expect(results.map((r) => r.error)).toEqual([undefined, undefined, undefined, undefined])
        const slots = results.map((r) => r.slot ?? -1)
        expect(new Set(slots).size).toBe(racing.length)
        expect(slots.filter((slot) => before.includes(slot))).toEqual([])
        expect(Math.min(...slots)).toBeGreaterThanOrEqual(1)
        expect(Math.max(...slots)).toBeLessThanOrEqual(MAX_SLOT)
      }),
      { numRuns: 3 },
    )
  })
})

describe('AC-6: the stack CLI prints the block of the worktree it runs in', () => {
  /** A repo whose fourth linked worktree is slot 4: the first three claim 1..3 first. */
  async function slotFourWorktree(): Promise<string> {
    const { resolveSlot } = await loadStack()
    const main = tempRepo()
    for (const name of ['wt1', 'wt2', 'wt3']) resolveSlot(addWorktree(main, name), {})
    return addWorktree(main, 'wt4')
  }

  it('AC-6: `stack.ts env` in a slot 4 worktree prints export lines that, evaluated, set the slot, project and five ports at slot 4', async () => {
    const worktree = await slotFourWorktree()
    const { stdout } = await exec(TSX, [STACK_PATH, 'env'], { cwd: worktree, env: cleanEnv() })
    const lines = stdout.split('\n').filter((line) => line.trim() !== '')
    expect(lines.filter((line) => !line.startsWith('export '))).toEqual([])
    const { stdout: evaluated } = await exec(
      '/bin/sh',
      ['-c', 'eval "$NYMBAL_TEST_EXPORTS" && env'],
      {
        env: { PATH: '/usr/bin:/bin', NYMBAL_TEST_EXPORTS: stdout },
      },
    )
    const vars = Object.fromEntries(
      evaluated
        .split('\n')
        .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => [m[1]!, m[2]!]),
    )
    const block = expectedBlock(4)
    const names = ['NYMBAL_STACK_SLOT', 'COMPOSE_PROJECT_NAME', ...Object.keys(COMPOSE_PORT_VARS)]
    expect(Object.fromEntries(names.map((name) => [name, vars[name]]))).toEqual({
      NYMBAL_STACK_SLOT: String(block.slot),
      COMPOSE_PROJECT_NAME: block.project,
      ...Object.fromEntries(
        Object.entries(COMPOSE_PORT_VARS).map(([name, field]) => [name, String(block[field])]),
      ),
    })
  })

  it('AC-6: `stack.ts json` (and no argument) in a slot 4 worktree prints one JSON object equal to stackBlock(4)', async () => {
    const { stackBlock } = await loadStack()
    const worktree = await slotFourWorktree()
    const { stdout } = await exec(TSX, [STACK_PATH, 'json'], { cwd: worktree, env: cleanEnv() })
    expect(JSON.parse(stdout)).toEqual(stackBlock(4))
    expect(JSON.parse(stdout)).toEqual(expectedBlock(4))
    const { stdout: byDefault } = await exec(TSX, [STACK_PATH], { cwd: worktree, env: cleanEnv() })
    expect(JSON.parse(byDefault)).toEqual(JSON.parse(stdout))
  })
})
