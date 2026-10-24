import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { MediaStorage } from '@nymbalhq/types'

const TIMEOUT_MS = 15_000
const SUPPORTED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface DownloadedMedia {
  url: string
  altText: string
}

/**
 * The image at `src`, stored. A source that cannot be fetched or answers non-2xx is skipped (null); a `put` that rejects
 * is the store's failure, so it is thrown for the caller to report.
 */
export async function downloadImage(
  src: string,
  altText: string,
  storage: MediaStorage,
  subdir: string,
): Promise<DownloadedMedia | null> {
  let body: Uint8Array
  let contentType: string
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(src, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) return null

    const rawContentType = res.headers.get('content-type') ?? 'image/jpeg'
    contentType = (rawContentType.split(';')[0] ?? 'image/jpeg').trim()
    body = new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
  const ext = SUPPORTED_TYPES[contentType] ?? 'jpg'
  const hash = createHash('sha256').update(src).digest('hex').slice(0, 16)
  const key = join(subdir, `${hash}.${ext}`)

  const { url } = await storage.put(key, body, contentType)
  return { url, altText: altText || '' }
}

/** Each image stored, in order; one whose `put` rejects is left out and passed to `onStoreError`. */
export async function downloadProductImages(
  images: Array<{ src: string; alt: string }>,
  productSlug: string,
  storage: MediaStorage,
  onStoreError: (error: unknown) => void,
): Promise<DownloadedMedia[]> {
  const results: DownloadedMedia[] = []
  for (const img of images) {
    if (!img.src) continue
    let downloaded: DownloadedMedia | null
    try {
      downloaded = await downloadImage(img.src, img.alt, storage, `products/${productSlug}`)
    } catch (error) {
      onStoreError(error)
      continue
    }
    if (downloaded) {
      results.push(downloaded)
    }
  }
  return results
}
