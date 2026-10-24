import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient } from '../src/index.js'

// AC-1's client side: `client.capabilities.get()` answers the store's GET /api/capabilities report as it is, read
// once per client and cached for the process.

const API = 'http://api.test'

const REPORT = {
  payments: { capabilities: ['intent', 'capture'], client: { driver: 'test-mode', options: {} } },
  search: { capabilities: ['index', 'search'] },
  catalog: { sortKeys: ['price-asc', 'newest'], defaultSort: 'newest' },
}

function fakeApi() {
  const asked: string[] = []
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    asked.push(url.pathname)
    if (url.pathname === '/api/capabilities') {
      return new Response(JSON.stringify({ data: REPORT }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: url.pathname } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }
  return { asked, fetchImpl }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client.capabilities', () => {
  it('AC-1: get() resolves the report GET /api/capabilities answers, and a second get() on the same client asks the API no more', async () => {
    const api = fakeApi()
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const client = createNymbalClient({ baseUrl: API, tokenStorage: 'memory' })

    const first = await client.capabilities.get()
    const second = await client.capabilities.get()

    expect(first).toEqual(REPORT)
    expect(second).toEqual(first)
    expect(api.asked.filter((p) => p === '/api/capabilities')).toHaveLength(1)
    client.destroy()
  })

  it('AC-1: the cache is per client: two clients each read the report once', async () => {
    const api = fakeApi()
    vi.stubGlobal('fetch', vi.fn(api.fetchImpl))
    const clients = [
      createNymbalClient({ baseUrl: API, tokenStorage: 'memory' }),
      createNymbalClient({ baseUrl: API, tokenStorage: 'memory' }),
    ]

    const reads = () => api.asked.filter((p) => p === '/api/capabilities').length
    const perClient: number[] = []
    for (const client of clients) {
      const before = reads()
      await client.capabilities.get()
      await client.capabilities.get()
      perClient.push(reads() - before)
    }

    expect(perClient).toEqual(clients.map(() => 1))
    for (const client of clients) client.destroy()
  })
})
