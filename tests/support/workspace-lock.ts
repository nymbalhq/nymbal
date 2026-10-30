import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The scaffold store tests each make a workspace member in the checkout and run `pnpm install`, which rewrites the
// workspace lockfile and re-links its node_modules, then put both back. Two of them at once would install over each
// other and restore a lockfile that lacks the other's member, so each holds this lock from before its scaffold until
// after its restore. The lock is a directory (mkdir is atomic) named after the checkout, holding its owner's pid; a lock
// whose owner is gone is taken over.

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const LOCK = join(
  tmpdir(),
  `nymbal-workspace-${createHash('sha1').update(REPO).digest('hex').slice(0, 12)}.lock`,
)
const POLL_MS = 500

function ownerAlive(): boolean {
  let pid: number
  try {
    pid = Number(readFileSync(join(LOCK, 'pid'), 'utf8'))
  } catch {
    // Just made, its pid not yet written: alive.
    return true
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM'
  }
}

/** Waits up to `withinMs` for the checkout's workspace lock; resolves to its release. */
export async function holdWorkspace(withinMs: number): Promise<() => void> {
  const deadline = Date.now() + withinMs
  while (true) {
    try {
      mkdirSync(LOCK)
      writeFileSync(join(LOCK, 'pid'), String(process.pid))
      return () => rmSync(LOCK, { recursive: true, force: true })
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'EEXIST') throw error
    }
    if (!ownerAlive()) {
      rmSync(LOCK, { recursive: true, force: true })
      continue
    }
    if (Date.now() > deadline) {
      throw new Error(`another scaffold test held ${LOCK} for ${withinMs} ms`)
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
