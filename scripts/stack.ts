import { execFileSync } from 'node:child_process'
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
  walkApi: number
  walkAstro: number
  walkNextjs: number
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
  walkApi: 3031,
  walkAstro: 4351,
  walkNextjs: 3030,
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

/** A claim opened but not yet written is empty for an instant; only an old empty one is left over from a crash. */
const EMPTY_CLAIM_GRACE_MS = 60_000

type Claim = { slot: number; path: string; holder: string }

function readClaims(dir: string): Claim[] {
  return readdirSync(dir)
    .filter((name) => /^[1-9]$/.test(name) && Number(name) <= MAX_SLOT)
    .flatMap((name) => {
      const path = join(dir, name)
      try {
        return [{ slot: Number(name), path, holder: readFileSync(path, 'utf8').trim() }]
      } catch {
        // Removed as stale by another process between the listing and the read.
        return []
      }
    })
}

function isStale(claim: Claim, live: Set<string>): boolean {
  if (claim.holder === '') {
    try {
      return Date.now() - statSync(claim.path).mtimeMs > EMPTY_CLAIM_GRACE_MS
    } catch {
      return false
    }
  }
  return !live.has(claim.holder) || !existsSync(claim.holder)
}

function removeClaim(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
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
  const dirs = git(cwd, [
    'rev-parse',
    '--path-format=absolute',
    '--git-dir',
    '--git-common-dir',
    '--show-toplevel',
  ])
  if (dirs === undefined) return 0
  const [gitDir = '', commonDir = '', top = ''] = dirs.split('\n')
  if (real(gitDir) === real(commonDir) || top === '') return 0
  const worktree = real(top)

  const dir = join(real(commonDir), 'nymbal-stacks')
  mkdirSync(dir, { recursive: true })
  const own = (): Claim | undefined =>
    readClaims(dir)
      .filter((claim) => claim.holder === worktree)
      .sort((a, b) => a.slot - b.slot)[0]
  const held = own()
  if (held !== undefined) return held.slot

  const live = new Set(
    (git(cwd, ['worktree', 'list', '--porcelain']) ?? '')
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => real(line.slice('worktree '.length))),
  )
  for (const claim of readClaims(dir)) if (isStale(claim, live)) removeClaim(claim.path)

  for (let slot = 1; slot <= MAX_SLOT; slot++) {
    const path = join(dir, String(slot))
    try {
      writeFileSync(path, `${worktree}\n`, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    // Two processes in this worktree racing each claim a slot; both keep the lower one.
    const first = own()
    if (first !== undefined && first.slot < slot) {
      removeClaim(path)
      return first.slot
    }
    return slot
  }
  const holders = readClaims(dir)
    .sort((a, b) => a.slot - b.slot)
    .map((claim) => `${claim.slot}: ${claim.holder}`)
  throw new Error(
    `every stack slot 1..${MAX_SLOT} is held (${holders.join(', ')}); remove a worktree or set NYMBAL_STACK_SLOT`,
  )
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
