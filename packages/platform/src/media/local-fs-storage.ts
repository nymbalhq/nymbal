import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MediaStorage } from './storage.js'

export interface LocalFsMediaStorageOptions {
  root: string
  urlPrefix?: string
}

export function createLocalFsMediaStorage(options: LocalFsMediaStorageOptions): MediaStorage {
  const { root } = options
  const urlPrefix = options.urlPrefix ?? '/imported-media'

  return {
    async put(key, body, _contentType) {
      const dest = join(root, key)
      const dir = dest.substring(0, dest.lastIndexOf('/'))
      await mkdir(dir, { recursive: true })
      await writeFile(dest, body)
      return { url: `${urlPrefix}/${key}` }
    },
  }
}
