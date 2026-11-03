import type { NymbalConfig } from '@nymbalhq/config'
import type { AgentSurfaceUrls } from '@nymbalhq/types'
import { ADMIN_BASE_PATH } from '../routes/admin-static.js'
import { UCP_PROFILE_PATH } from './profile.js'

/** The product feed's path; it serves `search_catalog` with no query. */
export const FEED_PATH = '/agents/products.json'

/** What no crawler reads: shopper state, the admin and the API. */
const PRIVATE_PATHS = ['/api/', ADMIN_BASE_PATH, '/account', '/cart', '/checkout', '/order/', '/alerts/']

/**
 * `robots.txt`: the named AI crawlers are allowed the store, then everyone else is allowed or kept out by `others`;
 * both groups keep out the private paths. Null when it is off.
 */
export function robotsTxt(crawl: NymbalConfig['agents']['crawl']): string | null {
  if (!crawl.robots) return null
  const rules = (first: string) => [first, ...PRIVATE_PATHS.map((path) => `Disallow: ${path}`)]
  const groups: string[][] = []
  if (crawl.allow.length > 0) {
    groups.push([...crawl.allow.map((agent) => `User-agent: ${agent}`), ...rules('Allow: /')])
  }
  groups.push(['User-agent: *', ...rules(crawl.others === 'allow' ? 'Allow: /' : 'Disallow: /')])
  return `${groups.map((group) => group.join('\n')).join('\n\n')}\n`
}

export interface LlmsTxtInput {
  storeName: string
  urls: AgentSurfaceUrls
  /** Whether the UCP profile is served, so linked. */
  ucp: boolean
  /** Whether the product feed is served, so linked. */
  feed: boolean
  categories: Array<{ slug: string; name: string }>
  products: Array<{ slug: string; name: string }>
}

/** One line of text: a newline in a name would start another section. */
function line(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Link text with the brackets that would end it escaped. */
function text(value: string): string {
  return line(value).replace(/[[\]\\]/g, (char) => `\\${char}`)
}

/**
 * `llms.txt` (llmstxt.org): the store's name, a one-line summary, where agents reach it, its categories and the first
 * page of its products. The profile and the feed are on the API's origin, the pages on the storefront's.
 */
export function llmsTxt(input: LlmsTxtInput): string {
  const { urls } = input
  const page = (path: string, slug: string) =>
    `${urls.storefront ?? ''}/${path}/${encodeURIComponent(slug)}`
  const agents = [
    ...(input.ucp
      ? [
          `- [UCP business profile](${urls.api}${UCP_PROFILE_PATH}): the Universal Commerce Protocol profile, naming the MCP endpoint that searches the catalogue and opens a checkout`,
        ]
      : []),
    ...(input.feed
      ? [
          `- [Product feed](${urls.api}${FEED_PATH}): every listed product in UCP's catalogue search shape, 100 a page`,
        ]
      : []),
  ]
  const sections: Array<[string, string[]]> = [
    ['Agents', agents],
    ['Categories', input.categories.map((c) => `- [${text(c.name)}](${page('category', c.slug)})`)],
    ['Products', input.products.map((p) => `- [${text(p.name)}](${page('product', p.slug)})`)],
  ]
  const name = line(input.storeName)
  const summary = input.ucp
    ? `> ${name} is an online store. Shopping agents can search its catalogue and open a checkout the buyer completes on the store's own checkout page.`
    : `> ${name} is an online store.`
  return [
    `# ${name}`,
    '',
    summary,
    ...sections.flatMap(([title, lines]) =>
      lines.length === 0 ? [] : ['', `## ${title}`, '', ...lines],
    ),
    '',
  ].join('\n')
}
