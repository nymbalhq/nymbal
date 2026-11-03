import { constants } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { ValidationError, type HealthReport, type MediaStorage } from '@nymbalhq/types'

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

/** The file a key names under `root`, or a refusal when it would land anywhere else. */
function destinationOf(root: string, key: string): string {
  const base = resolve(root) + sep
  const dest = resolve(base, key)
  if (key.includes('\\') || key.includes('\0') || isAbsolute(key) || !dest.startsWith(base)) {
    throw new ValidationError('the media key resolves outside the media root', {
      code: 'media.key_outside_root',
      context: { key },
    })
  }
  return dest
}

export function createLocalFsMediaStorage(options: LocalFsMediaStorageOptions): MediaStorage {
  const { root } = options
  const urlPrefix = options.urlPrefix ?? '/imported-media'

  return {
    capabilities: () => LOCAL_FS_MEDIA_CAPABILITIES,
    async put(key, body, _contentType) {
      const dest = destinationOf(root, key)
      await mkdir(dirname(dest), { recursive: true })
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
