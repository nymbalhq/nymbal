import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { run, VITEST_WORKERS_ENV, vitestWorkers } from '../../scripts/gate'
import { liveHolders } from '../../scripts/stack'

// P2-14 review round 2, Finding F2 (Decision 14): two worktrees' gates running Vitest at once each started a worker
// per core, and Vitest's main process starved. A Vitest step now takes a share of the CPUs by the number of worktrees
// with a live shared hold. Each other holder is a child process in a linked worktree of a throwaway repository.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const STACK_URL = pathToFileURL(join(REPO, 'scripts/stack.ts')).href

const created: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.stdin.end('die\n')
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name]
  delete env.NYMBAL_STACK_SLOT
  delete env[VITEST_WORKERS_ENV]
  return env
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' }).trim()
}

/** A repository with one empty commit and two linked worktrees beside it. */
function twoWorktrees(): { root: string; one: string; two: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-workers-')))
  created.push(root)
  const main = join(root, 'main')
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
  for (const name of ['one', 'two'])
    git(main, 'worktree', 'add', '-q', '-b', name, join(root, name))
  return { root, one: join(root, 'one'), two: join(root, 'two') }
}

// Takes a shared hold in its working directory, says `held`, and keeps it until `die` on stdin kills it, its hold
// left on disk as a crashed gate would leave it. (tsx runs the code in a child of its own, so the test's kill of the
// tsx process would not reach the holder.)
const HOLDER = `;(async () => {
  const m = await import(process.env.NYMBAL_TEST_STACK_URL)
  await m.acquireShared(process.cwd(), 'tests')
  process.stdout.write('held\\n')
  process.stdin.on('data', (chunk) => {
    if (String(chunk).includes('die')) process.kill(process.pid, 'SIGKILL')
  })
})()`

/** A child holding a shared hold in `cwd`, once it holds it. */
async function holder(cwd: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(TSX, ['--eval', HOLDER], {
    cwd,
    env: { ...cleanEnv(), NYMBAL_TEST_STACK_URL: STACK_URL },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) resolve()
    })
    child.on('close', (code) => reject(new Error(`holder exited ${code}: ${stderr}`)))
  })
  return child
}

async function kill(child: ChildProcessWithoutNullStreams): Promise<void> {
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()))
  child.stdin.end('die\n')
  await closed
}

const sharedHolds = (root: string): string[] =>
  readdirSync(join(root, 'main/.git/nymbal-stacks/heavy')).filter((n) => n.startsWith('shared-'))

/** What `NYMBAL_VITEST_MAX_WORKERS` a gate step named `name` saw, run in `cwd` under a shared hold. */
async function workersSeenBy(cwd: string, name: string): Promise<string> {
  const out = join(cwd, `${name}.workers`)
  const result = await run(
    [
      {
        name,
        command: `printf '%s' "\${${VITEST_WORKERS_ENV}-unset}" > '${out}'`,
        hold: 'shared',
      },
    ],
    { cwd, budgetMs: 60_000, env: cleanEnv() },
  )
  expect(result.exitCode).toBe(0)
  return readFileSync(out, 'utf8')
}

describe('P2-14 F2: Vitest steps share the CPUs between worktrees', () => {
  it('liveHolders counts each worktree with a live shared hold', async () => {
    const { one, two } = twoWorktrees()
    expect(liveHolders(one)).toBe(1)
    await holder(one)
    await holder(two)
    expect(liveHolders(one)).toBe(2)
    expect(liveHolders(two)).toBe(2)
  })

  it('liveHolders does not count a dead holder whose hold is still on disk', async () => {
    const { root, one, two } = twoWorktrees()
    await holder(one)
    await kill(await holder(two))
    expect(sharedHolds(root)).toHaveLength(2)
    expect(liveHolders(one)).toBe(1)
  })

  it('a Vitest step gets half the CPUs while another worktree holds, and no setting alone', async () => {
    const { one, two } = twoWorktrees()
    expect(await workersSeenBy(one, 'tests')).toBe('unset')
    await holder(two)
    const half = String(Math.max(1, Math.floor(availableParallelism() / 2)))
    expect(await workersSeenBy(one, 'tests')).toBe(half)
    expect(await workersSeenBy(one, 'sentinels')).toBe(half)
    // A step that runs no Vitest is left alone in the same state.
    expect(await workersSeenBy(one, 'lint')).toBe('unset')
  })

  it('vitestWorkers is the floor of the share, never below one, and unset alone', () => {
    for (const cpus of [1, 2, 3, 8, 10, 16]) {
      expect(vitestWorkers(cpus, 1)).toBeUndefined()
      for (const holders of [2, 3, 4, 9]) {
        const workers = vitestWorkers(cpus, holders) ?? 0
        expect(workers).toBeGreaterThanOrEqual(1)
        expect(workers).toBeLessThanOrEqual(Math.max(1, cpus / holders))
        expect(workers).toBe(Math.max(1, Math.floor(cpus / holders)))
      }
    }
  })
})
