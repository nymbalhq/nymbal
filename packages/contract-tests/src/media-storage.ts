import { describe, expect, it } from 'vitest'
import type { MediaStorage } from '@nymbalhq/types'

type Make = () => MediaStorage | Promise<MediaStorage>

/**
 * The media storage contract every implementation runs: `put` resolves with a URL, and the bytes read back from that
 * URL (through `fetchUrl`, which knows where the storage serves from) are the bytes that were put.
 */
export function runMediaStorageContract(
  name: string,
  make: Make,
  fetchUrl: (url: string) => Promise<Uint8Array>,
): void {
  describe(`MediaStorage contract: ${name}`, () => {
    it('reports put among its capabilities', async () => {
      const storage = await make()
      expect(storage.capabilities()).toContain('put')
    })

    it('put then a read of the returned url gives back the same bytes, for nested keys too', async () => {
      const storage = await make()
      const bodies = new Map<string, Uint8Array>([
        ['image.png', Uint8Array.from([137, 80, 78, 71, 0, 255, 1])],
        ['products/42/large.jpg', new TextEncoder().encode('jpeg bytes ✓')],
        ['empty.txt', new Uint8Array(0)],
      ])
      const urls = new Set<string>()
      for (const [key, body] of bodies) {
        const { url } = await storage.put(key, body, 'application/octet-stream')
        urls.add(url)
        expect([...(await fetchUrl(url))]).toEqual([...body])
      }
      expect(urls.size).toBe(bodies.size)
    })

    it('a second put under a key replaces what the url serves', async () => {
      const storage = await make()
      await storage.put('replaced.bin', Uint8Array.from([1, 2, 3]), 'application/octet-stream')
      const { url } = await storage.put(
        'replaced.bin',
        Uint8Array.from([9]),
        'application/octet-stream',
      )
      expect([...(await fetchUrl(url))]).toEqual([9])
    })
  })
}
