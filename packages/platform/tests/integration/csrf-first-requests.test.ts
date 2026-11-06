import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant, type Kernel, type Seeded } from '../support/kernel.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../support/security.js'

// A guest's first requests, sent at once with no cookie, as a browser opening the store sends them: only
// `GET /api/csrf` sets the `nymbal.csrf` cookie, so the cookie the browser keeps is the token the client was handed,
// and its first unsafe call is accepted. A refusal sets no cookie either.

const OTHER_SAFE_PATHS = ['/api/cart', '/api/products', '/health'] as const

interface Answer {
  path: string
  status: number
  body: { data?: { token?: string }; error?: { code: string } }
  setCookies: string[]
}

/** The `name=value` pairs a response's `Set-Cookie` headers set, in header order. */
function cookiePairs(setCookies: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';')
    const at = pair!.indexOf('=')
    if (at > 0) pairs.push([pair!.slice(0, at).trim(), pair!.slice(at + 1).trim()])
  }
  return pairs
}

const csrfValues = (setCookies: string[]): string[] =>
  cookiePairs(setCookies)
    .filter(([name]) => name === CSRF_COOKIE)
    .map(([, value]) => value)

/** One request with no cookie at all, as a browser's first visit sends it. */
async function cookieless(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const res = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      accept: 'application/json',
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return {
    path,
    status: res.status,
    body: text === '' ? {} : (JSON.parse(text) as Answer['body']),
    setCookies: res.headers.getSetCookie(),
  }
}

describe('CSRF cookie on a guest’s first requests', () => {
  let k: Kernel
  let served: ServedKernel
  let seeded: Seeded

  beforeAll(async () => {
    k = await createKernel({ dialect: 'sqlite' })
    served = await serveKernel(k)
    seeded = await seedVariant(k, 10_000)
  }, 60_000)

  afterAll(async () => {
    await served?.stop()
  })

  it('AC-1: property: k cookieless first requests at once (GET /api/csrf and k-1 other safe reads) set exactly one nymbal.csrf, equal to the token /api/csrf returns, and the first cart write with it is accepted', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...OTHER_SAFE_PATHS), { minLength: 1, maxLength: 7 }),
        fc.nat(),
        async (others, at) => {
          const paths: string[] = [...others]
          // /api/csrf at any position among the k requests.
          paths.splice(at % (others.length + 1), 0, '/api/csrf')
          const answers: Answer[] = []
          await Promise.all(
            paths.map(async (path) => {
              answers.push(await cookieless(served.baseUrl, 'GET', path))
            }),
          )
          const issued = answers.find((a) => a.path === '/api/csrf')!
          const token = issued.body.data?.token
          const set = answers.flatMap((a) =>
            csrfValues(a.setCookies).map((value) => ({ path: a.path, value })),
          )
          expect(set.length, `k=${paths.length}: nymbal.csrf set by ${JSON.stringify(set)}`).toBe(1)
          expect(set[0]!.value).toBe(token)

          // The browser's jar after every answer, in the order they arrived (a later Set-Cookie replaces an earlier).
          const jar = new Map<string, string>()
          for (const answer of answers) {
            for (const [name, value] of cookiePairs(answer.setCookies)) jar.set(name, value)
          }
          const res = await fetch(new URL('/api/cart/items', served.baseUrl), {
            method: 'POST',
            headers: {
              accept: 'application/json',
              'content-type': 'application/json',
              cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
              [CSRF_HEADER]: token!,
            },
            body: JSON.stringify({ variantId: seeded.variantId, qty: 1 }),
          })
          const text = await res.text()
          expect(res.status, `POST /api/cart/items: ${text}`).toBeGreaterThanOrEqual(200)
          expect(res.status, `POST /api/cart/items: ${text}`).toBeLessThan(300)
        },
      ),
      { numRuns: 20 },
    )
  })

  it('AC-2: a cookieless GET /api/cart sets no nymbal.csrf; a cookieless POST /api/cart/items is refused 403 csrf.invalid and sets none', async () => {
    const read = await cookieless(served.baseUrl, 'GET', '/api/cart')
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(csrfValues(read.setCookies)).toEqual([])

    const write = await cookieless(served.baseUrl, 'POST', '/api/cart/items', {
      variantId: seeded.variantId,
      qty: 1,
    })
    expect(write.status, JSON.stringify(write.body)).toBe(403)
    expect(write.body.error?.code).toBe('csrf.invalid')
    expect(csrfValues(write.setCookies)).toEqual([])
  })
})
