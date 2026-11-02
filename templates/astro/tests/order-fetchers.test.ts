import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openExpiredOrder, requestOrderLink } from '../src/lib/api'

// The order page's server-side fetchers, used when the page's script does not run, with `fetch` stubbed. The email a
// shopper types reaches the API only in a header or a JSON body, never in a URL, however it is spelt. The read sends
// the expired key beside the email; the link request carries the CSRF pair `GET /api/csrf` answered, as a cookie and
// a header. A busy rate limit is an answer the page shows ('limited'), never a thrown error the page turns into a 500.

interface Sent {
  url: string
  method: string
  headers: Headers
  body: string | null
}

const sent: Sent[] = []
let answer: (call: Sent) => Response | Promise<Response>

beforeEach(() => {
  sent.length = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const call: Sent = {
      url: request?.url ?? String(input),
      method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers ?? request?.headers),
      body:
        typeof init?.body === 'string'
          ? init.body
          : request !== null
            ? await request.clone().text()
            : null,
    }
    sent.push(call)
    return answer(call)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const refusal = (status: number): Response =>
  json({ error: { code: 'refused', message: 'refused' } }, status)

/** Emails with the characters a URL would carry differently: `+`, `%`, `&`, `?`, `#`, a space. */
const anEmail = fc
  .tuple(
    fc.array(fc.constantFrom('a', 'z', '7', '.', '+', '%', '&', '?', '#', ' ', '='), {
      minLength: 1,
      maxLength: 12,
    }),
    fc.constantFrom('example.test', 'shop.example', 'e2e.test'),
  )
  .map(([local, domain]) => `s${local.join('')}x@${domain}`)

const anOrderNumber = fc.stringMatching(/^[A-Z]{2,4}-[0-9]{1,6}$/)
const aKey = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)
const aToken = fc.stringMatching(/^[0-9a-f]{64}$/)

/** The URLs among `sent` that carry `email` as typed, percent-encoded, form-encoded or once decoded. */
function urlsCarrying(email: string): string[] {
  const forms = [
    email,
    encodeURIComponent(email),
    encodeURI(email),
    new URLSearchParams({ e: email }).toString().slice(2),
  ].map((f) => f.toLowerCase())
  return sent
    .map((c) => c.url)
    .filter((url) => {
      let decoded = url
      try {
        decoded = decodeURIComponent(url)
      } catch {
        // A URL that does not decode is checked as it is.
      }
      return [url, decoded].some((u) => forms.some((f) => u.toLowerCase().includes(f)))
    })
}

async function settle<T>(
  run: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await run }
  } catch (error) {
    return { ok: false, error }
  }
}

/** What each answer to the read becomes: the order, a word the page shows, or a rejection. */
type ReadAnswer = 200 | 404 | 429 | 'network' | number

const readAnswer: fc.Arbitrary<ReadAnswer> = fc.oneof(
  fc.constantFrom<ReadAnswer>(200, 404, 429, 'network'),
  fc.integer({ min: 400, max: 599 }).filter((s) => s !== 404 && s !== 429),
)

describe('AC-6: the Astro order page’s server fetchers', () => {
  it('AC-6: over generated emails, openExpiredOrder sends GET /api/orders/:n with the key and the email in their headers and no URL carrying the email; 200 is the order, 404 not-found, 429 limited, any other failure or a network error rejects', async () => {
    await fc.assert(
      fc.asyncProperty(
        anOrderNumber,
        aKey,
        anEmail,
        readAnswer,
        async (orderNumber, key, email, status) => {
          sent.length = 0
          const order = { orderNumber, totalMinor: 1999, currency: 'GBP', lineItems: [] }
          answer = () => {
            if (status === 'network') throw new TypeError('fetch failed')
            return status === 200 ? json({ data: order }, 200) : refusal(status)
          }
          const outcome = await settle(openExpiredOrder(orderNumber, key, email))

          const reads = sent.filter(
            (c) => new URL(c.url).pathname === `/api/orders/${encodeURIComponent(orderNumber)}`,
          )
          expect(reads.map((c) => c.method)).toEqual(['GET'])
          expect(reads[0]!.headers.get('x-nymbal-order-key')).toBe(key)
          expect(reads[0]!.headers.get('x-nymbal-order-email')?.toLowerCase()).toBe(
            email.toLowerCase(),
          )
          expect(urlsCarrying(email)).toEqual([])

          const expected =
            status === 200
              ? { ok: true, value: order }
              : status === 404
                ? { ok: true, value: 'not-found' }
                : status === 429
                  ? { ok: true, value: 'limited' }
                  : { ok: false }
          expect(outcome.ok ? { ok: true, value: outcome.value } : { ok: false }).toEqual(expected)
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-6: over generated emails and tokens, requestOrderLink gets GET /api/csrf, then POSTs /api/orders/link with that answer’s nymbal.csrf cookie equal to its x-csrf-token header, the number and email in a JSON body and no URL carrying the email; 202 is sent, 429 limited, any other answer, a failed csrf read or a network error rejects', async () => {
    type LinkAnswer = 202 | 429 | 'network' | 'csrf-fails' | number
    const linkAnswer: fc.Arbitrary<LinkAnswer> = fc.oneof(
      fc.constantFrom<LinkAnswer>(202, 429, 'network', 'csrf-fails'),
      fc.integer({ min: 400, max: 599 }).filter((s) => s !== 429),
    )
    await fc.assert(
      fc.asyncProperty(
        anOrderNumber,
        anEmail,
        aToken,
        linkAnswer,
        async (orderNumber, email, token, status) => {
          sent.length = 0
          answer = (call) => {
            const path = new URL(call.url).pathname
            if (path === '/api/csrf') {
              if (status === 'csrf-fails') return refusal(500)
              return json({ data: { token } }, 200, {
                'set-cookie': `nymbal.csrf=${token}; Path=/; SameSite=Lax`,
              })
            }
            if (path === '/api/orders/link') {
              if (status === 'network') throw new TypeError('fetch failed')
              return status === 202
                ? json({ data: { sent: 'if-matched' } }, 202)
                : refusal(status as number)
            }
            throw new Error(`unexpected fetch ${call.method} ${call.url}`)
          }
          const outcome = await settle(requestOrderLink(orderNumber, email))
          expect(urlsCarrying(email)).toEqual([])

          const post = sent.find(
            (c) => c.method === 'POST' && new URL(c.url).pathname === '/api/orders/link',
          )
          const cookies = Object.fromEntries(
            (post?.headers.get('cookie') ?? '')
              .split(';')
              .map((pair) => pair.trim().split('='))
              .filter((pair) => pair.length === 2),
          )
          const seen = {
            requests: sent.map((c) => `${c.method} ${new URL(c.url).pathname}`),
            cookie: cookies['nymbal.csrf'] ?? null,
            header: post?.headers.get('x-csrf-token') ?? null,
            json: /^application\/json/.test(post?.headers.get('content-type') ?? ''),
            body: post?.body ? (JSON.parse(post.body) as unknown) : null,
            outcome: outcome.ok ? { ok: true, value: outcome.value } : { ok: false },
          }
          // The pair is the csrf answer's own: its cookie and its token, so the API's double-submit check passes.
          expect(seen).toEqual(
            status === 'csrf-fails'
              ? {
                  requests: ['GET /api/csrf'],
                  cookie: null,
                  header: null,
                  json: false,
                  body: null,
                  outcome: { ok: false },
                }
              : {
                  requests: ['GET /api/csrf', 'POST /api/orders/link'],
                  cookie: token,
                  header: token,
                  json: true,
                  body: { orderNumber, email },
                  outcome:
                    status === 202
                      ? { ok: true, value: 'sent' }
                      : status === 429
                        ? { ok: true, value: 'limited' }
                        : { ok: false },
                },
          )
        },
      ),
      { numRuns: 60 },
    )
  })
})
