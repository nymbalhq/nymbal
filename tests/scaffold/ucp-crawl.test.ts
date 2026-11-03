import { describe, expect, it } from 'vitest'
import robotsParser from 'robots-parser'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { validateUcp } from '../fixtures/ucp/validate.js'

// AC-11, run by scripts/scaffold-clean.sh in the `scaffold-clean` project once it has scaffolded `shop` and started
// `nymbal dev`, with no edit for agents. An agent that knows only the API origin reads the UCP profile, finds a product
// through the shopping service it names, opens a checkout and hands it to the buyer's browser; the crawl files answer.
//
//   NYMBAL_SCAFFOLD_DIR  the scaffolded project directory
//   NYMBAL_STORE_URL     the storefront its `nymbal dev` serves
//   NYMBAL_API_URL       the API its `nymbal dev` serves

const SCAFFOLD_DIR = process.env['NYMBAL_SCAFFOLD_DIR']
const STORE_URL_SET = process.env['NYMBAL_STORE_URL']
const API_URL_SET = process.env['NYMBAL_API_URL']
if (!SCAFFOLD_DIR || !STORE_URL_SET || !API_URL_SET) {
  throw new Error(
    'AC-11 needs NYMBAL_SCAFFOLD_DIR, NYMBAL_STORE_URL and NYMBAL_API_URL. ' +
      'Run it through scripts/scaffold-clean.sh <astro|nextjs>, which scaffolds, starts `nymbal dev` and sets them.',
  )
}
const STORE_URL: string = STORE_URL_SET.replace(/\/+$/, '')
const API_URL: string = API_URL_SET.replace(/\/+$/, '')

const AGENT = { name: 'scaffold-ucp-agent', version: '1.0.0' }
/** The crawl's bound: profile to the storefront's checkout page. */
const BUDGET_SECONDS = 120

interface Profile {
  ucp: { services: Record<string, Array<{ transport: string; endpoint?: string }>> }
}

interface ListedProduct {
  slug: string
  name: string
  priceRange: unknown
  variants: Array<{ id: string; stock: number }>
}

type Structured = Record<string, unknown>

async function call(client: Client, name: string, args: Structured): Promise<Structured> {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError === true)
    throw new Error(`${name}: ${JSON.stringify(result.structuredContent)}`)
  return (result.structuredContent ?? {}) as Structured
}

describe('AC-11: a UCP agent crawls a fresh scaffold from its profile to the checkout page', () => {
  it(
    `AC-11: the profile validates; through its MCP endpoint the agent finds the first listed product by name, opens a checkout of one unit, and its continue_url hands the cart to the storefront's /checkout, which answers 200 for it, inside ${BUDGET_SECONDS} s`,
    async () => {
      const started = performance.now()
      const profileRes = await fetch(`${API_URL}/.well-known/ucp`)
      const profile = (await profileRes.json().catch(() => null)) as Profile | null
      expect(profileRes.status).toBe(200)
      expect(validateUcp('profile.json#/$defs/business_schema', profile)).toEqual([])
      const endpoint = profile!.ucp.services['dev.ucp.shopping']?.find(
        (s) => s.transport === 'mcp',
      )?.endpoint
      expect(new URL(endpoint ?? '/missing', API_URL).origin).toBe(new URL(API_URL).origin)

      const listed = (
        (await (await fetch(`${API_URL}/api/products`)).json()) as {
          data: { items: ListedProduct[] }
        }
      ).data.items.filter((p) => p.priceRange !== null)
      const first = listed[0]!
      const variant = first.variants.find((v) => v.stock > 0)!

      const client = new Client(AGENT)
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!)))
      let checkout: Structured
      let found: string[]
      try {
        const search = await call(client, 'search_catalog', { catalog: { query: first.name } })
        found = ((search['products'] ?? []) as Array<{ id: string }>).map((p) => p.id)
        checkout = await call(client, 'create_checkout', {
          checkout: { line_items: [{ item: { id: variant.id }, quantity: 1 }] },
        })
      } finally {
        await client.close()
      }

      const handoff = await fetch(String(checkout['continue_url']), { redirect: 'manual' })
      const cookie = handoff.headers
        .getSetCookie()
        .map((c) => c.split(';')[0]!)
        .find((c) => c.startsWith('nymbal.cart='))
      const cart = (
        (await (
          await fetch(`${API_URL}/api/cart`, { headers: { cookie: cookie ?? '' } })
        ).json()) as { data: { items: Array<{ variantId: string; qty: number }> } }
      ).data
      const page = await fetch(`${STORE_URL}/checkout`, { headers: { cookie: cookie ?? '' } })
      await page.arrayBuffer()
      const seconds = (performance.now() - started) / 1000
      // eslint-disable-next-line no-console
      console.log(`ucp-crawl: ${Math.ceil(seconds)}s`)

      expect(found).toContain(first.slug)
      expect(checkout['status']).toBe('requires_escalation')
      expect([handoff.status, handoff.headers.get('location')]).toEqual([
        303,
        `${STORE_URL}/checkout`,
      ])
      expect(cookie).toBe(`nymbal.cart=${String(checkout['id'])}`)
      expect(cart.items.map((i) => ({ variantId: i.variantId, qty: i.qty }))).toEqual([
        { variantId: variant.id, qty: 1 },
      ])
      expect(page.status).toBe(200)
      expect(seconds).toBeLessThan(BUDGET_SECONDS)
    },
    (BUDGET_SECONDS + 30) * 1000,
  )

  it('AC-11: /robots.txt, /llms.txt and /agents/products.json at the API answer 200 in their shapes: crawlers allowed the catalogue and kept from checkout, the store named and its profile and feed linked, a UCP search response of the listed products', async () => {
    const [robotsRes, llmsRes, feedRes] = await Promise.all(
      ['/robots.txt', '/llms.txt', '/agents/products.json'].map((path) =>
        fetch(`${API_URL}${path}`),
      ),
    )
    const robotsText = await robotsRes!.text()
    const llms = await llmsRes!.text()
    const feed = (await feedRes!.json().catch(() => null)) as {
      products?: Array<{ id: string }>
    } | null
    const robots = robotsParser(`${API_URL}/robots.txt`, robotsText)
    const targets = [...llms.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => new URL(m[1]!, API_URL).href)
    const listed = (
      (await (await fetch(`${API_URL}/api/products?limit=100`)).json()) as {
        data: { items: ListedProduct[] }
      }
    ).data.items.filter((p) => p.priceRange !== null)

    expect([robotsRes!.status, llmsRes!.status, feedRes!.status]).toEqual([200, 200, 200])
    for (const agent of ['GPTBot', 'ClaudeBot', 'ExampleCrawler']) {
      expect(
        [
          robots.isAllowed(`${API_URL}/product/x`, agent),
          robots.isDisallowed(`${API_URL}/checkout`, agent),
        ],
        agent,
      ).toEqual([true, true])
    }
    expect(llms.split('\n')[0]).toMatch(/^# \S/)
    expect(targets).toEqual(
      expect.arrayContaining([`${API_URL}/.well-known/ucp`, `${API_URL}/agents/products.json`]),
    )
    expect(validateUcp('shopping/catalog_search.json#/$defs/search_response', feed)).toEqual([])
    expect((feed?.products ?? []).map((p) => p.id)).toEqual(listed.map((p) => p.slug))
  }, 60_000)
})
