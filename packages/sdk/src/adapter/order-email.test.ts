import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNymbalClient } from '../index.js'
import { NymbalApiError } from './fetch-client.js'

// Once an order's key has expired the shopper gives the order's email: the SDK sends it to the API in
// `x-nymbal-order-email` beside the key's own header, and in the body of "send me my order link", never in a URL,
// which proxy and CDN access logs keep. The API's `orders.key_expired` refusal reaches the caller as its code.

const BASE = 'https://api.order-email.test'
const ORDER_KEY_HEADER = 'x-nymbal-order-key'
const ORDER_EMAIL_HEADER = 'x-nymbal-order-email'

interface Sent {
  method: string
  url: URL
  headers: Headers
  body: string
}

/**
 * A fake API that records each request: an order read answers the order it names, or the `orders.key_expired` 404 when
 * the key is `expired` and no email came with it; the link request answers 202; the CSRF read answers a token.
 */
function recordingApi(expired?: string): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    const headers = new Headers(init.headers)
    sent.push({ method: init.method ?? 'GET', url, headers, body: String(init.body ?? '') })
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
    if (url.pathname === '/api/csrf') return json(200, { data: { token: 'csrf-token' } })
    if (url.pathname === '/api/orders/link') return json(202, { data: { sent: 'if-matched' } })
    const orderNumber = decodeURIComponent(url.pathname.split('/').pop() ?? '')
    if (headers.get(ORDER_KEY_HEADER) === expired && !headers.has(ORDER_EMAIL_HEADER)) {
      return json(404, {
        error: { code: 'orders.key_expired', message: 'This order link has expired' },
      })
    }
    return json(200, { data: { orderNumber } })
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const orderNumber = fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,8}$/)
const orderKey = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)
const email = fc.emailAddress()

/** Whether `value`, as typed or URL-encoded, is anywhere in the URL. */
const inUrl = (url: URL, value: string) =>
  [value, encodeURIComponent(value)].some(
    (v) => decodeURIComponent(url.href).includes(v) || url.href.includes(v),
  )

describe('the SDK sends the order’s email in a header, never a URL', () => {
  // Kills: the email put in the query string (`?email=`), where every access log keeps it; the email header dropped,
  // so an expired key can never open the order; the key or the email sent where the other belongs.
  it('AC-2: property: orders.get(n, { key, email }) sends x-nymbal-order-key: key and x-nymbal-order-email: email to /api/orders/<n>, orders.get(n, { key }) sends no email header, and neither the key nor the email is in any URL; the expired key alone rejects with code orders.key_expired and status 404, and with the email resolves to the order', async () => {
    await fc.assert(
      fc.asyncProperty(orderNumber, orderKey, email, async (n, key, address) => {
        const sent = recordingApi(key)
        const client = createNymbalClient({ baseUrl: BASE })
        try {
          const refused = await client.orders.get(n, { key }).then(
            () => null,
            (err: unknown) => err,
          )
          const opened = await client.orders.get(n, { key, email: address })

          expect(refused, 'the expired key alone').toBeInstanceOf(NymbalApiError)
          expect([(refused as NymbalApiError).code, (refused as NymbalApiError).status]).toEqual([
            'orders.key_expired',
            404,
          ])
          expect(opened, 'the expired key with the email').toEqual({ orderNumber: n })
          const reads = sent.filter((s) => s.url.pathname !== '/api/csrf')
          expect(reads.map((s) => s.url.pathname)).toEqual(
            [n, n].map((x) => `/api/orders/${encodeURIComponent(x)}`),
          )
          expect(
            reads.map((s) => [s.headers.get(ORDER_KEY_HEADER), s.headers.get(ORDER_EMAIL_HEADER)]),
          ).toEqual([
            [key, null],
            [key, address],
          ])
          expect(
            sent.filter((s) => inUrl(s.url, key) || inUrl(s.url, address)).map((s) => s.url.href),
          ).toEqual([])
        } finally {
          client.destroy()
        }
      }),
      { numRuns: 50 },
    )
  })

  // Kills: a link request that puts the email in the URL, or sends the number and email anywhere but the body.
  it('AC-3: property: orders.requestLink({ orderNumber, email }) POSTs { orderNumber, email } as JSON to /api/orders/link, the email in no URL, and resolves without error on the 202', async () => {
    await fc.assert(
      fc.asyncProperty(orderNumber, email, async (n, address) => {
        const sent = recordingApi()
        const client = createNymbalClient({ baseUrl: BASE })
        try {
          await client.orders.requestLink({ orderNumber: n, email: address })
          const posts = sent.filter((s) => s.method === 'POST')
          expect(posts.map((s) => s.url.pathname)).toEqual(['/api/orders/link'])
          expect(JSON.parse(posts[0]!.body)).toEqual({ orderNumber: n, email: address })
          expect(sent.filter((s) => inUrl(s.url, address)).map((s) => s.url.href)).toEqual([])
        } finally {
          client.destroy()
        }
      }),
      { numRuns: 30 },
    )
  })
})
