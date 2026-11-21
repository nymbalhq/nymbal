import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient } from '../index.js'

// The API adapter sends the marker on the wire only when it is given it.

const BASE = 'https://api.search-origin.test'

function recordingApi(): URL[] {
  const urls: URL[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    urls.push(new URL(String(input instanceof Request ? input.url : input)))
    return new Response(JSON.stringify({ data: { items: [], nextCursor: null, total: 0 } }), {
      status: 200,
    })
  })
  return urls
}

const withoutOrigin = (url: URL): string => {
  const stripped = new URL(url)
  stripped.searchParams.delete('origin')
  return stripped.search
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-31: search requests carry origin only when asked', () => {
  it('AC-31: with origin page the request sends origin=page beside q; without it the request has no origin parameter', async () => {
    const urls = recordingApi()
    const client = createNymbalClient({ baseUrl: BASE })

    await client.adapter.products.search('wool', { origin: 'page' })
    await client.adapter.products.search('wool')

    expect(urls.map((u) => [u.pathname, u.searchParams.get('q'), u.searchParams.get('origin')])).toEqual([
      ['/api/products/search', 'wool', 'page'],
      ['/api/products/search', 'wool', null],
    ])
    expect(urls[1]!.search).toBe(withoutOrigin(urls[0]!))
  })
})
