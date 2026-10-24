import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// AC-7: the quiet lock. A timing step holds the exclusive hold, and every CPU-heavy gate step a shared one, across the
// worktrees of one repository. Each holder here is a child process in a linked worktree of a throwaway repository, so
// that the holds are what two gates would take.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const TSX = join(REPO, 'node_modules/.bin/tsx')
const STACK_URL = pathToFileURL(join(REPO, 'scripts/stack.ts')).href

const created: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL')
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name]
  delete env.NYMBAL_STACK_SLOT
  return env
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8' }).trim()
}

/** A repository with one empty commit and two linked worktrees beside it. */
function twoWorktrees(): { one: string; two: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nymbal-locks-')))
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
  return { one: join(root, 'one'), two: join(root, 'two') }
}

// A holder: takes a shared or an exclusive hold in its working directory and reports each event as a JSON line,
// written synchronously so the time is the event's. On `release` it releases and exits; on `die` it is killed with
// its hold still on disk, as a crashed gate would leave it.
const HOLDER = `const fs = require('node:fs')
const say = (o) => fs.writeSync(1, JSON.stringify({ ...o, at: Date.now() }) + '\\n')
;(async () => {
  const m = await import(process.env.NYMBAL_TEST_STACK_URL)
  const mode = process.env.NYMBAL_TEST_HOLD
  const label = process.env.NYMBAL_TEST_LABEL
  say({ event: 'calling' })
  const release = mode === 'exclusive'
    ? await m.acquireExclusive(process.cwd(), label, { maxWaitMs: Number(process.env.NYMBAL_TEST_MAX_WAIT) })
    : await m.acquireShared(process.cwd(), label)
  say({ event: 'held', waitedMs: release.waitedMs, quiet: release.quiet })
  let input = ''
  process.stdin.on('data', async (chunk) => {
    input += chunk
    if (input.includes('die')) process.kill(process.pid, 'SIGKILL')
    if (input.includes('release')) {
      say({ event: 'releasing' })
      await release()
      say({ event: 'released' })
      process.exit(0)
    }
  })
})().catch((e) => { say({ event: 'error', message: String(e && e.message !== undefined ? e.message : e) }); process.exit(1) })`

type HolderEvent = {
  event: 'calling' | 'held' | 'releasing' | 'released' | 'error'
  at: number
  waitedMs?: number
  quiet?: boolean
  message?: string
}

type Holder = {
  /** The event, once it has happened; rejects when the child ends first or `withinMs` passes. */
  next: (event: HolderEvent['event'], withinMs?: number) => Promise<HolderEvent>
  /** Whether the event has happened yet. */
  seen: (event: HolderEvent['event']) => HolderEvent | undefined
  release: () => Promise<HolderEvent>
  die: () => Promise<void>
}

function hold(
  cwd: string,
  mode: 'shared' | 'exclusive',
  label: string,
  maxWaitMs = 10_000,
): Holder {
  const child = spawn(TSX, ['--eval', HOLDER], {
    cwd,
    env: {
      ...cleanEnv(),
      NYMBAL_TEST_STACK_URL: STACK_URL,
      NYMBAL_TEST_HOLD: mode,
      NYMBAL_TEST_LABEL: label,
      NYMBAL_TEST_MAX_WAIT: String(maxWaitMs),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdin.on('error', () => {})
  const events: HolderEvent[] = []
  let stdout = ''
  let stderr = ''
  const waiters: Array<() => void> = []
  const wake = (): void => {
    for (const w of waiters.splice(0)) w()
  }
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    const lines = stdout.split('\n')
    stdout = lines.pop() ?? ''
    for (const line of lines) if (line.startsWith('{')) events.push(JSON.parse(line) as HolderEvent)
    wake()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<void>((resolve) => child.on('close', () => resolve()))
  let closed = false
  void exited.then(() => {
    closed = true
    wake()
  })
  const seen = (event: HolderEvent['event']): HolderEvent | undefined =>
    events.find((e) => e.event === event)
  const next = (event: HolderEvent['event'], withinMs = 20_000): Promise<HolderEvent> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${mode} holder in ${cwd}: no "${event}" within ${withinMs} ms`)),
        withinMs,
      )
      const check = (): void => {
        const found = seen(event)
        const failed = seen('error')
        if (found) {
          clearTimeout(timer)
          resolve(found)
        } else if (failed || closed) {
          clearTimeout(timer)
          reject(
            new Error(
              `${mode} holder in ${cwd} ended before "${event}": ${failed?.message ?? stderr.trim()}`,
            ),
          )
        } else waiters.push(check)
      }
      check()
    })
  return {
    next,
    seen,
    release: async () => {
      child.stdin.write('release\n')
      return next('released')
    },
    die: async () => {
      child.stdin.write('die\n')
      await exited
    },
  }
}

/** How long a holder keeps its hold while another waits on it: what a wait has to cover. */
const HELD_MS = 400

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('AC-7: the quiet lock across worktrees', () => {
  it('AC-7 (a): two shared holds from different worktrees are held at once', async () => {
    const { one, two } = twoWorktrees()
    const first = hold(one, 'shared', 'tests')
    const held = await first.next('held')
    const second = hold(two, 'shared', 'integration-stores')
    const alsoHeld = await second.next('held')
    // The second was granted while the first was still held.
    expect(first.seen('releasing')).toBeUndefined()
    const released = await first.release()
    expect(alsoHeld.at).toBeLessThan(released.at)
    expect(alsoHeld.at).toBeGreaterThanOrEqual(held.at)
    await second.release()
  })

  it("AC-7 (b): an exclusive hold waits until the other worktree's shared hold is released, and its waitedMs covers the wait", async () => {
    const { one, two } = twoWorktrees()
    const shared = hold(one, 'shared', 'tests')
    await shared.next('held')
    const exclusive = hold(two, 'exclusive', 'perf', 10_000)
    const calling = await exclusive.next('calling')
    await pause(HELD_MS)
    expect(exclusive.seen('held')).toBeUndefined()
    const releasing = await shared.release()
    const held = await exclusive.next('held')
    expect(held.at).toBeGreaterThanOrEqual(releasing.at)
    expect(held.quiet).toBe(true)
    expect(held.waitedMs).toBeGreaterThanOrEqual(releasing.at - calling.at - 50)
    expect(held.waitedMs).toBeLessThanOrEqual(held.at - calling.at)
    await exclusive.release()
  })

  it('AC-7 (c): while the exclusive hold is held, a shared hold from the other worktree waits until it is released', async () => {
    const { one, two } = twoWorktrees()
    const exclusive = hold(one, 'exclusive', 'perf', 10_000)
    const quiet = await exclusive.next('held')
    expect(quiet.quiet).toBe(true)
    const shared = hold(two, 'shared', 'tests')
    await shared.next('calling')
    await pause(HELD_MS)
    expect(shared.seen('held')).toBeUndefined()
    const releasing = await exclusive.release()
    const held = await shared.next('held')
    expect(held.at).toBeGreaterThanOrEqual(releasing.at)
    await shared.release()
  })

  it('AC-7 (d): a shared hold or a quiet whose holder died blocks nothing', async () => {
    const { one, two } = twoWorktrees()
    // A shared hold left by a killed gate does not hold the exclusive one back.
    const deadShared = hold(one, 'shared', 'tests')
    await deadShared.next('held')
    await deadShared.die()
    const exclusive = hold(two, 'exclusive', 'perf', 10_000)
    const calling = await exclusive.next('calling')
    const quiet = await exclusive.next('held')
    expect(quiet.quiet).toBe(true)
    expect(quiet.waitedMs).toBeLessThan(10_000)
    expect(quiet.at - calling.at).toBeLessThan(10_000)
    // Its `quiet`, left by a kill, does not hold a shared one back.
    await exclusive.die()
    const shared = hold(one, 'shared', 'tests')
    const held = await shared.next('held', 10_000)
    expect(held.at).toBeGreaterThanOrEqual(quiet.at)
    // And a new exclusive hold is quiet again, though both earlier holders left their files.
    await shared.release()
    const again = hold(two, 'exclusive', 'perf', 10_000)
    const quietAgain = await again.next('held')
    expect(quietAgain.quiet).toBe(true)
    await again.release()
  })

  it('AC-7 (e): with maxWaitMs 200 and a live shared hold that never releases, the exclusive hold returns after about 200 ms, not quiet', async () => {
    const { one, two } = twoWorktrees()
    const shared = hold(one, 'shared', 'tests')
    await shared.next('held')
    const exclusive = hold(two, 'exclusive', 'perf', 200)
    const calling = await exclusive.next('calling')
    const held = await exclusive.next('held', 10_000)
    expect(held.quiet).toBe(false)
    expect(held.waitedMs).toBeGreaterThanOrEqual(200)
    expect(held.at - calling.at).toBeGreaterThanOrEqual(200)
    // About 200 ms: well short of the 10 min bound, with room for a loaded machine.
    expect(held.at - calling.at).toBeLessThan(200 + 3_000)
    // The shared hold was never released while the exclusive one waited.
    expect(shared.seen('releasing')).toBeUndefined()
    await exclusive.release()
    await shared.release()
  })
})
