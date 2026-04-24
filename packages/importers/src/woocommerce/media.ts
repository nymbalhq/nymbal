import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { MediaStorage } from '@nymbal/platform'

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

export async function downloadImage(
  src: string,
  altText: string,
  storage: MediaStorage,
  subdir: string,
): Promise<DownloadedMedia | null> {
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
    const contentType = (rawContentType.split(';')[0] ?? 'image/jpeg').trim()
    const ext = SUPPORTED_TYPES[contentType] ?? 'jpg'
    const hash = createHash('sha256').update(src).digest('hex').slice(0, 16)
    const key = join(subdir, `${hash}.${ext}`)

    const buffer = await res.arrayBuffer()
    const { url } = await storage.put(key, new Uint8Array(buffer), contentType)
    return { url, altText: altText || '' }
  } catch {
    return null
  }
}

export async function downloadProductImages(
  images: Array<{ src: string; alt: string }>,
  productSlug: string,
  storage: MediaStorage,
): Promise<DownloadedMedia[]> {
  const results: DownloadedMedia[] = []
  for (const img of images) {
    if (!img.src) continue
    const downloaded = await downloadImage(img.src, img.alt, storage, `products/${productSlug}`)
    if (downloaded) {
      results.push(downloaded)
    }
  }
  return results
}
