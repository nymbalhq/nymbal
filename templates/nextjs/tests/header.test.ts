import fc from 'fast-check'
import { DynamicServerError } from 'next/dist/client/components/hooks-server-context'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canSearch, shopperCanSearch } from '@/lib/header'

// The header's search bar hangs on GET /api/capabilities. A shopper's page renders per request, so its header may
// fall back to no search bar when that read fails; the catalog header sits on cacheable pages, where a fallback would
// be cached for every shopper, so its read keeps rejecting.

type Failure = 'network' | number

let answer: () => Response = () => {
  throw new Error('no answer set')
}
let requests = 0

const capabilities = (list: string[]): Response =>
  new Response(JSON.stringify({ data: { search: { capabilities: list } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

const failing = (failure: Failure): (() => Response) =>
  failure === 'network'
    ? () => {
        throw new TypeError('fetch failed')
      }
    : () =>
        new Response(JSON.stringify({ error: { message: 'refused' } }), {
          status: failure,
          headers: { 'content-type': 'application/json' },
        })

/** How a call settled: the value it resolved to, or the error it rejected with. */
async function settle(
  run: Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await run }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Every way the capabilities read fails: no answer, or any error status but a 404 (which is an answer). */
const aFailure: fc.Arbitrary<Failure> = fc.oneof(
  fc.constant<Failure>('network'),
  fc.integer({ min: 400, max: 599 }).filter((status) => status !== 404),
)

beforeEach(() => {
  requests = 0
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (new URL(url).pathname !== '/api/capabilities') throw new Error(`unexpected fetch ${url}`)
    requests += 1
    return answer()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the header’s search bar when GET /api/capabilities fails', () => {
  it('AC-1: for every failed capabilities read (the fetch rejects, or any status 400-599 but 404), the shopper header’s read resolves false while the catalog header’s rejects', async () => {
    await fc.assert(
      fc.asyncProperty(aFailure, async (failure) => {
        answer = failing(failure)
        const before = requests
        const shopper = await settle(shopperCanSearch())
        const catalog = await settle(canSearch())
        expect(requests - before, 'each read asks the API once').toBe(2)
        expect(shopper, `shopperCanSearch on ${failure}`).toEqual({ ok: true, value: false })
        expect(catalog.ok, `canSearch on ${failure} rejects`).toBe(false)
      }),
      { numRuns: 60 },
    )
  })

  it('AC-1: on a 200, over generated capability lists, both reads resolve whether the list holds `search`', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.constantFrom('search', 'facets', 'suggest', 'typo-tolerance', 'synonyms'),
          {
            maxLength: 5,
          },
        ),
        async (list) => {
          answer = () => capabilities(list)
          const searches = list.includes('search')
          const shopper = await settle(shopperCanSearch())
          const catalog = await settle(canSearch())
          expect(shopper, `shopperCanSearch for [${list.join(', ')}]`).toEqual({
            ok: true,
            value: searches,
          })
          expect(catalog, `canSearch for [${list.join(', ')}]`).toEqual(shopper)
        },
      ),
      { numRuns: 40 },
    )
  })

  it('AC-1: the shopper header’s read passes on what Next must see (its dynamic-usage error) rather than falling back', async () => {
    const dynamic = new DynamicServerError('Dynamic server usage: headers')
    answer = () => {
      throw dynamic
    }
    const shopper = await settle(shopperCanSearch())
    expect(shopper).toEqual({ ok: false, error: dynamic })
  })
})
