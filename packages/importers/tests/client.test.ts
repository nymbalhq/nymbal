import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WooCommerceClient, WooCommerceApiError } from '../src/woocommerce/client.js'

function makeCreds() {
  return { url: 'https://mystore.example.com', consumerKey: 'ck_abc', consumerSecret: 'cs_xyz' }
}

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

describe('WooCommerceClient', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    vi.stubGlobal('fetch', originalFetch)
  })

  it('sends correct Basic auth header', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? ''))
      return jsonResponse({})
    })

    const client = new WooCommerceClient(makeCreds())
    await client.healthCheck()

    const expected = `Basic ${Buffer.from('ck_abc:cs_xyz').toString('base64')}`
    expect(calls[0]).toBe(expected)
  })

  it('throws WooCommerceApiError on 401', async () => {
    vi.stubGlobal('fetch', async () => new Response('Unauthorized', { status: 401 }))
    const client = new WooCommerceClient(makeCreds())
    await expect(client.healthCheck()).rejects.toThrow(WooCommerceApiError)
  })

  it('paginates through all pages', async () => {
    let callCount = 0
    vi.stubGlobal('fetch', async (url: string) => {
      const page = new URL(url).searchParams.get('page')
      callCount++
      if (page === '1') {
        return jsonResponse([{ id: 1 }, { id: 2 }], 200, {
          'X-WP-Total': '3',
          'X-WP-TotalPages': '2',
        })
      }
      return jsonResponse([{ id: 3 }], 200, {
        'X-WP-Total': '3',
        'X-WP-TotalPages': '2',
      })
    })

    const client = new WooCommerceClient(makeCreds())
    const results: unknown[] = []
    for await (const page of client.paginate('/products')) {
      results.push(...page.items)
    }

    expect(results).toHaveLength(3)
    expect(callCount).toBe(2)
  })

  it('includes per_page=100 and orderby=id in requests', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return jsonResponse([], 200, { 'X-WP-Total': '0', 'X-WP-TotalPages': '1' })
    })

    const client = new WooCommerceClient(makeCreds())
    for await (const _ of client.paginate('/products')) { /* consume */ }

    const url = new URL(urls[0]!)
    expect(url.searchParams.get('per_page')).toBe('100')
    expect(url.searchParams.get('orderby')).toBe('id')
    expect(url.searchParams.get('order')).toBe('asc')
  })

  it('retries on 429 with Retry-After', async () => {
    let attempts = 0
    vi.stubGlobal('fetch', async () => {
      attempts++
      if (attempts < 2) {
        return new Response('Too Many Requests', {
          status: 429,
          headers: { 'Retry-After': '0' },
        })
      }
      return jsonResponse({})
    })

    const client = new WooCommerceClient(makeCreds())
    await client.healthCheck()
    expect(attempts).toBe(2)
  })

  it('getTotal reads X-WP-Total header', async () => {
    vi.stubGlobal('fetch', async () =>
      jsonResponse([], 200, { 'X-WP-Total': '42', 'X-WP-TotalPages': '1' }),
    )

    const client = new WooCommerceClient(makeCreds())
    const total = await client.getTotal('/products')
    expect(total).toBe(42)
  })
})
