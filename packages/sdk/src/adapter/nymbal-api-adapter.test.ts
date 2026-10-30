import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient } from '../index.js'

// AC-6: the order's key goes to the API in `x-nymbal-order-key`, only when the caller passes one, and never in the URL,
// which a proxy's access log keeps.

const BASE = 'https://api.order-key.test'
const ORDER_KEY_HEADER = 'x-nymbal-order-key'

interface Sent {
  url: URL
  headers: Headers
}

/** A fake API that records each request and answers every order read with the order it names. */
function recordingApi(): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    sent.push({ url, headers: new Headers(init.headers) })
    const orderNumber = decodeURIComponent(url.pathname.split('/').pop() ?? '')
    return new Response(JSON.stringify({ data: { orderNumber } }), { status: 200 })
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AC-6: customer.orders.get sends the order key in its header', () => {
  it('AC-6: property: get(n, { key }) sends x-nymbal-order-key: key and get(n) sends no such header, both to /api/orders/<n>, and the key is in no URL', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,8}$/),
        fc.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        async (orderNumber, key) => {
          const sent = recordingApi()
          const client = createNymbalClient({ baseUrl: BASE })
          try {
            const keyed = await client.customer.orders.get(orderNumber, { key })
            const bare = await client.customer.orders.get(orderNumber)

            expect(sent.map((s) => s.headers.get(ORDER_KEY_HEADER))).toEqual([key, null])
            expect(sent.map((s) => s.url.pathname)).toEqual(
              [orderNumber, orderNumber].map((n) => `/api/orders/${encodeURIComponent(n)}`),
            )
            expect(sent.filter((s) => s.url.href.includes(key))).toEqual([])
            expect(keyed).toEqual(bare)
          } finally {
            client.destroy()
          }
        },
      ),
      { numRuns: 50 },
    )
  })
})
