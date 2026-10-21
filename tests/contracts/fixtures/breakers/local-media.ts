import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'
import { createLocalFsMediaStorage } from '@nymbalhq/platform'
import type { HealthReport, MediaStorage } from '@nymbalhq/types'

// Local-fs media for the breakers (P2-13 AC-5): the real storage on a fresh root, the same on a root it cannot write
// (its dependency, the filesystem, is gone: health `down` and put rejects), and the defective shapes the suite must
// refuse. Every root is removed when the file's run ends.

const URL_PREFIX = '/p2-13-media'
const roots: string[] = []
let root = ''

afterAll(() => {
  for (const r of roots.splice(0)) {
    chmodSync(r, 0o755)
    rmSync(r, { recursive: true, force: true })
  }
})

function freshRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'p2-13-breaker-media-'))
  roots.push(r)
  return r
}

export function localMedia(): MediaStorage {
  root = freshRoot()
  return createLocalFsMediaStorage({ root, urlPrefix: URL_PREFIX })
}

/** The bytes the url names under the root of the storage `localMedia` made last. */
export async function fetchUrl(url: string): Promise<Uint8Array> {
  if (!url.startsWith(`${URL_PREFIX}/`)) throw new Error(`${url} is not under ${URL_PREFIX}/`)
  return new Uint8Array(readFileSync(join(root, url.slice(URL_PREFIX.length + 1))))
}

/** Local-fs on a root it may not write: what a dead dependency is for this storage. */
export function deadMedia(): MediaStorage {
  const r = freshRoot()
  chmodSync(r, 0o555)
  return createLocalFsMediaStorage({ root: r, urlPrefix: URL_PREFIX })
}

/** The storage without healthCheck, which the type allows and certification does not. */
export function withoutHealth(storage: MediaStorage): MediaStorage {
  return {
    capabilities: () => storage.capabilities(),
    put: (key, body, contentType) => storage.put(key, body, contentType),
  }
}

/** A dependency that is "gone" yet answers: health only `degraded`, and put still stores. */
export function stillAnswering(): MediaStorage {
  const live = createLocalFsMediaStorage({ root: freshRoot(), urlPrefix: URL_PREFIX })
  return {
    capabilities: () => live.capabilities(),
    put: (key, body, contentType) => live.put(key, body, contentType),
    healthCheck: async (): Promise<HealthReport> => ({ status: 'degraded', detail: 'answering' }),
  }
}

/** A dependency that never answers: health and put stay pending. */
export function neverAnswering(): MediaStorage {
  return {
    capabilities: () => ['put'],
    put: () => new Promise<{ url: string }>(() => undefined),
    healthCheck: () => new Promise<HealthReport>(() => undefined),
  }
}
