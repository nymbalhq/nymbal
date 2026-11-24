import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A stack slot per checkout, so that two worktrees on one machine run the gate, the E2E suite and a walk at once
// without sharing containers or ports. The main checkout is slot 0, today's compose project and ports, which CI sees;
// a linked worktree claims the lowest free slot 1..9 and keeps it until the worktree is removed.

export type StackBlock = {
  slot: number
  project: string
  api: number
  astro: number
  nextjs: number
  customApi: number
  astroCustom: number
  nextjsCustom: number
  noSearchApi: number
  astroNoSearch: number
  nextjsNoSearch: number
  overrideApi: number
  astroOverride: number
  nextjsOverride: number
  walkApi: number
  walkAstro: number
  walkNextjs: number
  wordpress: number
  postgres: number
  redis: number
  mailpitSmtp: number
  mailpitUi: number
  minio: number
}

type PortField = Exclude<keyof StackBlock, 'slot' | 'project'>

export const MAX_SLOT = 9

const SLOT0: Record<PortField, number> = {
  api: 3001,
  astro: 4321,
  nextjs: 3000,
  customApi: 3011,
  astroCustom: 4331,
  nextjsCustom: 3010,
  noSearchApi: 3021,
  astroNoSearch: 4341,
  nextjsNoSearch: 3020,
  // The project-elements fixture's store (tests/e2e/fixtures/override-elements), each template on it.
  overrideApi: 3041,
  astroOverride: 4371,
  nextjsOverride: 3040,
  walkApi: 3031,
  walkAstro: 4351,
  walkNextjs: 3030,
  // The WordPress site the migration kit's journeys run on.
  wordpress: 3051,
  postgres: 54329,
  redis: 63799,
  mailpitSmtp: 11025,
  mailpitUi: 18025,
  minio: 59000,
}

/** The step between slots: slot 0's ports span less than 100 within each hundred, so blocks never overlap. */
const SLOT_STRIDE = 100

export function stackBlock(slot: number): StackBlock {
  if (!Number.isInteger(slot) || slot < 0 || slot > MAX_SLOT) {
    throw new RangeError(`a stack slot is an integer 0..${MAX_SLOT}; got ${slot}`)
  }
  const ports = Object.fromEntries(
    Object.entries(SLOT0).map(([field, port]) => [field, port + SLOT_STRIDE * slot]),
  ) as Record<PortField, number>
  return { slot, project: slot === 0 ? 'nymbal' : `nymbal-s${slot}`, ...ports }
}

/** The variables compose.yaml reads its host ports from. */
const COMPOSE_PORTS: Record<string, PortField> = {
  NYMBAL_POSTGRES_PORT: 'postgres',
  NYMBAL_REDIS_PORT: 'redis',
  NYMBAL_MAILPIT_SMTP_PORT: 'mailpitSmtp',
  NYMBAL_MAILPIT_UI_PORT: 'mailpitUi',
  NYMBAL_MINIO_PORT: 'minio',
  NYMBAL_WORDPRESS_PORT: 'wordpress',
}

/** The compose host-port variables of a block, by the names compose.yaml reads. */
export function composePorts(block: StackBlock): Record<string, string> {
  return Object.fromEntries(
    Object.entries(COMPOSE_PORTS).map(([name, field]) => [name, String(block[field])]),
  )
}

export function stackEnv(block: StackBlock): Record<string, string> {
  return {
    NYMBAL_STACK_SLOT: String(block.slot),
    COMPOSE_PROJECT_NAME: block.project,
    ...composePorts(block),
  }
}

/** git in `cwd`, without the GIT_* variables a hook sets: the checkout asked about is the one at `cwd`. */
function git(cwd: string, args: string[]): string | undefined {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name]
  try {
    return execFileSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

const real = (path: string): string => (existsSync(path) ? realpathSync(path) : path)

/** The checkout at `cwd`: its git common dir, its top level, and whether it is the main checkout. */
type Checkout = { commonDir: string; worktree: string; main: boolean }

function checkout(cwd: string): Checkout | undefined {
  const dirs = git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
    '--show-toplevel',
  ])
  if (dirs === undefined) return undefined
  const [gitDir = '', commonDir = '', top = ''] = dirs.split('\n')
  if (commonDir === '' || top === '') return undefined
  return {
    commonDir: real(commonDir),
    worktree: real(top),
    main: real(gitDir) === real(commonDir),
  }
}

const isErrno = (error: unknown, code: string): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === code

function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

const SLEEPER = new Int32Array(new SharedArrayBuffer(4))
/** resolveSlot is synchronous (the Playwright config calls it at import), so its lock waits block. */
const sleepSync = (ms: number): void => {
  Atomics.wait(SLEEPER, 0, 0, ms)
}

/** A lock older than this was left by a crash: holding one takes milliseconds. */
const LOCK_STALE_MS = 30_000

/**
 * Runs `fn` holding `<dir>/.lock`, taken by an exclusive create with backoff. Whatever removes a file another process
 * may have just made does it under this lock, so it never removes the new one.
 */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, '.lock')
  const token = `${process.pid} ${randomUUID()}\n`
  let delay = 5
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: 'wx' })
      break
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
    }
    breakStaleLock(lock)
    sleepSync(delay + Math.random() * delay)
    delay = Math.min(delay * 2, 100)
  }
  try {
    return fn()
  } finally {
    // Ours unless it was broken as stale meanwhile; then it is another process's, and stays.
    if (readOrUndefined(lock) === token) removeFile(lock)
  }
}

function breakStaleLock(lock: string): void {
  let seen
  try {
    seen = statSync(lock)
  } catch {
    return
  }
  if (Date.now() - seen.mtimeMs <= LOCK_STALE_MS) return
  try {
    // Only the lock judged stale: one made since by another breaker has another inode.
    const now = statSync(lock)
    if (now.ino === seen.ino && now.mtimeMs === seen.mtimeMs) removeFile(lock)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

type Claim = { slot: number; path: string; holder: string }

function readClaims(dir: string): Claim[] {
  return readdirSync(dir)
    .filter((name) => /^[1-9]$/.test(name) && Number(name) <= MAX_SLOT)
    .flatMap((name) => {
      const path = join(dir, name)
      const holder = readOrUndefined(path)
      return holder === undefined ? [] : [{ slot: Number(name), path, holder: holder.trim() }]
    })
}

export function resolveSlot(cwd: string, env: NodeJS.ProcessEnv = process.env): number {
  const forced = env.NYMBAL_STACK_SLOT
  if (forced !== undefined && forced !== '') {
    const slot = /^\d+$/.test(forced) ? Number(forced) : Number.NaN
    if (!(slot >= 0 && slot <= MAX_SLOT)) {
      throw new Error(`NYMBAL_STACK_SLOT must be an integer 0..${MAX_SLOT}; got "${forced}"`)
    }
    return slot
  }
  const here = checkout(cwd)
  if (here === undefined || here.main) return 0
  const { worktree } = here

  const dir = join(here.commonDir, 'nymbal-stacks')
  mkdirSync(dir, { recursive: true })
  // A claim is written whole under the lock, so a holder read outside it is either complete or not this worktree's.
  const own = (): number | undefined =>
    readClaims(dir)
      .filter((claim) => claim.holder === worktree)
      .sort((a, b) => a.slot - b.slot)[0]?.slot
  const held = own()
  if (held !== undefined) return held

  // Listing the worktrees, sweeping stale claims and claiming, all under one lock: a sweep that read a claim as stale
  // cannot then delete the fresh claim another process made in its place.
  return withLock(dir, () => {
    // Another process in this worktree may have claimed while this one waited for the lock.
    const claimed = own()
    if (claimed !== undefined) return claimed
    const live = new Set(
      (git(cwd, ['worktree', 'list', '--porcelain']) ?? '')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => real(line.slice('worktree '.length))),
    )
    const claims = readClaims(dir)
    // Under the lock an empty claim can only be one a crash left half written.
    for (const claim of claims) {
      if (claim.holder === '' || !live.has(claim.holder) || !existsSync(claim.holder)) {
        removeFile(claim.path)
      }
    }
    for (let slot = 1; slot <= MAX_SLOT; slot++) {
      try {
        writeFileSync(join(dir, String(slot)), `${worktree}\n`, { flag: 'wx' })
        return slot
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
      }
    }
    const holders = readClaims(dir)
      .sort((a, b) => a.slot - b.slot)
      .map((claim) => `${claim.slot}: ${claim.holder}`)
    throw new Error(
      `every stack slot 1..${MAX_SLOT} is held (${holders.join(', ')}); remove a worktree or set NYMBAL_STACK_SLOT`,
    )
  })
}

export function stack(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): StackBlock {
  return stackBlock(resolveSlot(cwd, env))
}

function main(argv: string[]): number {
  const [format = 'json'] = argv
  const block = stack()
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(block)}\n`)
    return 0
  }
  if (format === 'env') {
    const lines = Object.entries(stackEnv(block)).map(([name, value]) => `export ${name}=${value}`)
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  }
  process.stderr.write(`usage: stack.ts [json|env]; got "${format}"\n`)
  return 1
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    process.exit(main(process.argv.slice(2)))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
