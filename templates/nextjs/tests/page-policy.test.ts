import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { pagePolicy } from '@/lib/page-policy.mjs'
import { pagePolicy as astroPagePolicy } from '../../astro/src/lib/page-policy'

// AC-2: the Next storefront's page policy. In production it forbids framing, plugins, foreign base URLs and form
// targets, loads scripts only from the store and Stripe, and connects only to the store, its API's origin and Stripe;
// it carries no dev allowance ('unsafe-eval', a websocket, a wildcard). The dev policy only adds to it. Both templates
// ship one production policy.

const STRIPE_JS = 'https://js.stripe.com'
const STRIPE_API = 'https://api.stripe.com'

/** A CSP as directive name to its sources. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name.toLowerCase(), sources)
  }
  return out
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

const apiUrls = fc.oneof(
  fc.constantFrom('', 'http://localhost:3001', 'https://api.shop.example/v1/'),
  fc.webUrl({
    validSchemes: ['http', 'https'],
    authoritySettings: { withPort: true },
    withQueryParameters: false,
    withFragments: false,
  }),
)

describe('AC-2: the Next page policy', () => {
  // Kills: a production policy that lets the page be framed, loads plugins or scripts from anywhere, sends forms or
  // a <base> elsewhere, connects to more than the API's origin, or carries a dev allowance.
  it('AC-2: property: for any API URL the production policy forbids framing, plugins, foreign base and form targets, allows Stripe’s script and frames, connects to self, the API’s origin and Stripe only, and has no unsafe-eval, websocket or wildcard', () => {
    fc.assert(
      fc.property(apiUrls, (apiUrl) => {
        const policy = directives(pagePolicy({ apiUrl, dev: false }))
        const sources = [...policy.values()].flat()

        expect(policy.get('frame-ancestors'), apiUrl).toEqual(["'none'"])
        expect(policy.get('object-src'), apiUrl).toEqual(["'none'"])
        expect(policy.get('base-uri'), apiUrl).toEqual(["'self'"])
        expect(policy.get('form-action'), apiUrl).toEqual(["'self'"])
        expect(policy.get('script-src') ?? [], apiUrl).toContain(STRIPE_JS)
        expect(policy.get('frame-src') ?? [], apiUrl).toContain(STRIPE_JS)
        expect(sorted(policy.get('connect-src') ?? []), apiUrl).toEqual(
          sorted(["'self'", STRIPE_API, ...(apiUrl === '' ? [] : [new URL(apiUrl).origin])]),
        )
        expect(
          sources.filter((s) => s === "'unsafe-eval'" || /^wss?:/i.test(s) || s.includes('*')),
          apiUrl,
        ).toEqual([])
      }),
      { numRuns: 200 },
    )
  })

  // Kills: the API URL leaking into any directive but connect-src (a script source naming the API host).
  it('AC-2: property: two API URLs give production policies that differ only in connect-src', () => {
    fc.assert(
      fc.property(apiUrls, apiUrls, (a, b) => {
        const without = (apiUrl: string) => {
          const policy = directives(pagePolicy({ apiUrl, dev: false }))
          policy.delete('connect-src')
          return policy
        }

        expect(without(a), `${a} | ${b}`).toEqual(without(b))
      }),
      { numRuns: 100 },
    )
  })

  // Kills: a dev policy that drops or narrows a production directive, or loosens framing or plugins.
  it('AC-2: property: the dev policy keeps every production directive and source, adding only, and still forbids framing and plugins', () => {
    fc.assert(
      fc.property(apiUrls, (apiUrl) => {
        const prod = directives(pagePolicy({ apiUrl, dev: false }))
        const dev = directives(pagePolicy({ apiUrl, dev: true }))

        for (const [name, sources] of prod) {
          const kept = dev.get(name) ?? []
          expect(
            sources.filter((s) => !kept.includes(s)),
            `${name} lost in dev for ${apiUrl}`,
          ).toEqual([])
        }
        expect(dev.get('frame-ancestors'), apiUrl).toEqual(prod.get('frame-ancestors'))
        expect(dev.get('object-src'), apiUrl).toEqual(prod.get('object-src'))
      }),
      { numRuns: 100 },
    )
  })

  // Kills: the two templates drifting apart, so a store's policy depends on which template it scaffolded.
  it('AC-2: property: the Next and Astro production policies grant the same sources for any API URL', () => {
    fc.assert(
      fc.property(apiUrls, (apiUrl) => {
        const next = directives(pagePolicy({ apiUrl, dev: false }))
        const astro = directives(astroPagePolicy({ apiUrl, dev: false }))
        const asSets = (policy: Map<string, string[]>) =>
          new Map([...policy].map(([name, sources]) => [name, sorted(sources)]))

        expect(asSets(next), apiUrl).toEqual(asSets(astro))
      }),
      { numRuns: 100 },
    )
  })
})
