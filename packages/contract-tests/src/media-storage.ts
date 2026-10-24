import { describe, expect, it } from 'vitest'
import type { MediaStorage } from '@nymbalhq/types'
import { CASE_MS, healthAndDowntime, type Build, type ContractOptions } from './common.js'

export interface MediaStorageContractOptions extends ContractOptions<MediaStorage> {
  /** Reads back the bytes a URL `put` returned serves: the storage's public URL, or the file a local URL names. */
  fetchUrl: (url: string) => Promise<Uint8Array>
}

/**
 * The media storage contract every implementation runs: `put` resolves with a URL, and the bytes read back from that
 * URL (through `fetchUrl`, which knows where the storage serves from) are the bytes that were put; then health (and,
 * given `unreachable`, downtime).
 */
export function runMediaStorageContract(
  name: string,
  make: Build<MediaStorage>,
  options: MediaStorageContractOptions,
): void {
  const { fetchUrl } = options
  describe(`MediaStorage contract: ${name}`, () => {
    it('reports put among its capabilities', async () => {
      const storage = await make()
      expect(storage.capabilities()).toContain('put')
    }, CASE_MS)

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
    }, CASE_MS)

    it('a second put under a key replaces what the url serves', async () => {
      const storage = await make()
      await storage.put('replaced.bin', Uint8Array.from([1, 2, 3]), 'application/octet-stream')
      const { url } = await storage.put(
        'replaced.bin',
        Uint8Array.from([9]),
        'application/octet-stream',
      )
      expect([...(await fetchUrl(url))]).toEqual([9])
    }, CASE_MS)

    healthAndDowntime(make, options.unreachable, 'put()', (storage) =>
      storage.put('contract-down.bin', Uint8Array.from([1]), 'application/octet-stream'),
    )
  })
}
