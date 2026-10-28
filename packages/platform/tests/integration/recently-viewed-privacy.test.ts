import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, seedVariant } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'
import {
  bearer,
  bearerOf,
  expectedList,
  freshShop,
  lapsedToken,
  liftedViewLimit,
  list,
  record,
  registeredCustomer,
  setCookieOf,
  viewsInLog,
  VISITOR_COOKIE,
  type ServedList,
} from '../support/recently-viewed.js'

// AC-4 on one served kernel (SQLite): a list is served only to its own viewer. Each run makes two fresh visitors (their
// cookies minted by their first view) and a fresh customer, interleaves their views over a small catalogue, and then
// reads `GET /api/recently-viewed` every way a caller can: each visitor's cookie answers exactly that visitor's fold of
// its logged views, the customer's bearer exactly the customer's (a visitor cookie beside it changes nothing), no
// credential `{ items: [] }` and no cookie, a lapsed bearer 401 whatever cookie is sent, and a query naming another
// viewer changes nothing. Every 200 is `Cache-Control: private, no-store`.

const PRIVATE = /^(?=.*\bprivate\b)(?=.*\bno-store\b)/i

type Who = 'x' | 'y' | 'customer'

describe('AC-4: a recently-viewed list is served only to its viewer (sqlite)', () => {
  let served: ServedKernel
  let raw: RawReader
  let products: string[]

  beforeAll(async () => {
    const kernel = await createKernel({ dialect: 'sqlite', configure: liftedViewLimit })
    served = await serveKernel(kernel)
    raw = openRaw(kernel.dialect, kernel.target)
    products = []
    for (let i = 0; i < 5; i += 1) products.push((await seedVariant(kernel, 3)).productId)
  }, 60_000)

  afterAll(async () => {
    await raw?.close()
    await served?.stop()
  })

  it('AC-4: property: over generated interleavings of views by two visitors and a customer, each credential is served exactly its own viewer’s fold, no credential [] with no cookie, a lapsed bearer 401 with or without a visitor cookie, a query naming a viewer changes nothing, and every 200 is private, no-store', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom<Who>('x', 'y', 'customer'), fc.nat({ max: 4 })), {
          minLength: 1,
          maxLength: 10,
        }),
        async (steps) => {
          const x = await freshShop(served.baseUrl)
          const y = await freshShop(served.baseUrl)
          const c = await freshShop(served.baseUrl)
          const customer = await registeredCustomer(served.kernel)
          const token = await bearerOf(served.baseUrl, c.jar, customer)
          // Both visitors exist before the generated views, so each has a cookie to read with.
          for (const shop of [x, y]) expect((await record(shop, products[0]!)).status).toBe(204)
          for (const [who, pick] of steps) {
            const res =
              who === 'customer'
                ? await record(c, products[pick]!, bearer(token))
                : await record(who === 'x' ? x : y, products[pick]!)
            expect(res.status).toBe(204)
          }
          const xId = x.jar.get(VISITOR_COOKIE)!
          const yId = y.jar.get(VISITOR_COOKIE)!
          expect(xId).not.toBe(yId)

          const logged = await viewsInLog(raw)
          const foldOf = (kind: string, id: string) =>
            expectedList(logged.filter((v) => v.viewer.kind === kind && v.viewer.id === id))

          const nobody = await freshShop(served.baseUrl)
          const lapsed = await lapsedToken(served.kernel, customer, 'expired')
          const asking = `?viewer=visitor:${yId}&visitorId=${yId}&customerId=${customer.id}`
          const reads: Array<[string, ServedList, string[]]> = [
            ['x', await list(x), foldOf('visitor', xId)],
            ['y', await list(y), foldOf('visitor', yId)],
            ['customer', await list(c, bearer(token)), foldOf('customer', customer.id)],
            [
              'customer with x’s cookie',
              await list(x, bearer(token)),
              foldOf('customer', customer.id),
            ],
            ['no credential', await list(nobody), []],
            ['x naming y and the customer', await list(x, {}, asking), foldOf('visitor', xId)],
            ['no credential naming y and the customer', await list(nobody, {}, asking), []],
          ]
          const refusals: Array<[string, ServedList]> = [
            ['a lapsed bearer', await list(nobody, bearer(lapsed))],
            ['a lapsed bearer with x’s cookie', await list(x, bearer(lapsed))],
          ]

          for (const [label, read] of refusals) {
            expect([read.status, read.body.error?.code], label).toEqual([401, 'auth.token_invalid'])
          }
          for (const [label, read, expected] of reads) {
            expect(read.status, label).toBe(200)
            expect(read.ids, label).toEqual(expected)
            expect(read.cacheControl ?? '', `${label}: Cache-Control`).toMatch(PRIVATE)
            expect(
              setCookieOf(read, VISITOR_COOKIE),
              `${label}: a read minted a cookie`,
            ).toBeUndefined()
          }
          // The two visitors' lists are their own folds, so a list that mixes them is caught above; the run is
          // not vacuous only when the views gave someone a list.
          expect(reads.some(([, read]) => (read.ids?.length ?? 0) > 0)).toBe(true)
        },
      ),
      { numRuns: 12, endOnFailure: true },
    )
  }, 180_000)
})
