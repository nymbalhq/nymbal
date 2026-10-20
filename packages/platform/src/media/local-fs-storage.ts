import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaStorage } from './storage.js'

export interface LocalFsMediaStorageOptions {
  root: string
  urlPrefix?: string
}

/** What the local filesystem storage offers, whatever its root: the app reports it for the media slot. */
export const LOCAL_FS_MEDIA_CAPABILITIES: readonly string[] = ['put']

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
  }
}
