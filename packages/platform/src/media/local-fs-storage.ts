import { constants } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { HealthReport, MediaStorage } from '@nymbalhq/types'

export interface LocalFsMediaStorageOptions {
  root: string
  urlPrefix?: string
}

/** What the local filesystem storage offers, whatever its root: the app reports it for the media slot. */
export const LOCAL_FS_MEDIA_CAPABILITIES: readonly string[] = ['put']

/**
 * The directory whose write permission decides whether `put` can store under `root`: the root itself, or, when it
 * does not exist yet, its nearest existing ancestor, since `put` creates the missing directories.
 */
async function nearestExisting(root: string): Promise<string> {
  let dir = resolve(root)
  for (;;) {
    try {
      await access(dir, constants.F_OK)
      return dir
    } catch {
      const parent = dirname(dir)
      if (parent === dir) return dir
      dir = parent
    }
  }
}

export function createLocalFsMediaStorage(options: LocalFsMediaStorageOptions): MediaStorage {
  const { root } = options
  const urlPrefix = options.urlPrefix ?? '/imported-media'

  return {
    capabilities: () => LOCAL_FS_MEDIA_CAPABILITIES,
    async put(key, body, _contentType) {
      const dest = join(root, key)
      const dir = dest.substring(0, dest.lastIndexOf('/'))
      await mkdir(dir, { recursive: true })
      await writeFile(dest, body)
      return { url: `${urlPrefix}/${key}` }
    },
    // Permission is read with access(2), never probed by writing a file.
    async healthCheck(): Promise<HealthReport> {
      const dir = await nearestExisting(root)
      try {
        await access(dir, constants.W_OK)
        return { status: 'healthy', detail: root }
      } catch {
        return { status: 'down', detail: `${dir} is not writable` }
      }
    },
  }
}
