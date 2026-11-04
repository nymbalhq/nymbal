import type { WooCommerceCredentials } from '../types.js'

export class WooCommerceApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'WooCommerceApiError'
  }
}

export interface WcPage<T> {
  items: T[]
  total: number
  totalPages: number
}

export interface WcProduct {
  id: number
  name: string
  slug: string
  type: 'simple' | 'variable' | 'grouped' | 'external'
  status: string
  description: string
  short_description: string
  sku: string
  regular_price: string
  sale_price: string
  categories: Array<{ id: number; name: string; slug: string }>
  images: Array<{ id: number; src: string; name: string; alt: string }>
  attributes: Array<{ id: number; name: string; options: string[] }>
  variations: number[]
  meta_data: Array<{ key: string; value: unknown }>
  downloadable: boolean
  virtual: boolean
  weight: string
  dimensions: { length: string; width: string; height: string }
  yoast_head_json?: { title?: string; description?: string }
}

export interface WcVariation {
  id: number
  sku: string
  regular_price: string
  sale_price: string
  stock_quantity: number | null
  status: string
  attributes: Array<{ id: number; name: string; option: string }>
  weight: string
  dimensions: { length: string; width: string; height: string }
}

export interface WcCategory {
  id: number
  name: string
  slug: string
  parent: number
  description: string
  count: number
}

export interface WcCustomer {
  id: number
  email: string
  first_name: string
  last_name: string
  username: string
  billing: WcAddress
  shipping: WcAddress
  meta_data: Array<{ key: string; value: unknown }>
  date_created: string
}

export interface WcAddress {
  first_name: string
  last_name: string
  company: string
  address_1: string
  address_2: string
  city: string
  state: string
  postcode: string
  country: string
  phone: string
  email?: string
}

export interface WcOrder {
  id: number
  number: string
  status: string
  currency: string
  date_created: string
  customer_id: number
  billing: WcAddress
  shipping: WcAddress
  line_items: Array<{
    id: number
    product_id: number
    variation_id: number
    name: string
    quantity: number
    price: number
    subtotal: string
    subtotal_tax?: string
    total: string
    total_tax?: string
    sku: string
  }>
  shipping_lines: Array<{ method_title: string; total: string; total_tax?: string }>
  fee_lines?: Array<{ id: number; name: string; total: string; total_tax: string }>
  tax_lines: Array<{ label: string; tax_total: string }>
  /** Each refund's `total` is negative: `"-9.00"`. */
  refunds?: Array<{ id: number; reason?: string; total: string }>
  discount_total: string
  shipping_total: string
  total_tax: string
  total: string
  customer_note: string
  /** Typed so that nothing maps them: they are personal. */
  customer_ip_address?: string
  customer_user_agent?: string
  meta_data: Array<{ key: string; value: unknown }>
  payment_method: string
}

export interface WcReview {
  id: number
  product_id: number
  reviewer: string
  reviewer_email: string
  review: string
  rating: number
  verified: boolean
  date_created: string
}

export interface WooCommerceClientOptions {
  /** The clock each request is timed on (`requestStats`). */
  now?: () => number
}

/** Records per page of every list the import reads. */
export const PAGE_SIZE = 100

export class WooCommerceClient {
  private readonly base: string
  private readonly auth: string
  private readonly now: () => number
  /** Every request sent so far, retries included, and their summed wall time. */
  readonly requestStats = { count: 0, ms: 0 }

  constructor(creds: WooCommerceCredentials, opts: WooCommerceClientOptions = {}) {
    this.base = creds.url.replace(/\/$/, '') + '/wp-json/wc/v3'
    this.auth = `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')}`
    this.now = opts.now ?? (() => performance.now())
  }

  async healthCheck(): Promise<void> {
    const res = await this.fetchWithRetry(this.base + '/system_status')
    if (!res.ok) {
      throw new WooCommerceApiError(res.status, `Connection failed: ${res.status} ${res.statusText}`)
    }
  }

  /** A list's total from a one-item page; null when the endpoint refuses, fails, or answers with no list. */
  async getTotal(resource: string, params: Record<string, string> = {}): Promise<number | null> {
    const url = this.buildUrl(resource, { ...params, per_page: '1', page: '1' })
    const answer = await this.getList(url)
    if (answer === null) return null
    const total = parseInt(answer.res.headers.get('X-WP-Total') ?? '', 10)
    return Number.isNaN(total) ? answer.items.length : total
  }

  /** The length of an unpaginated list; null when the endpoint refuses, fails, or answers with no list. */
  async getListLength(resource: string): Promise<number | null> {
    const answer = await this.getList(this.base + resource)
    return answer === null ? null : answer.items.length
  }

  private async getList(url: string): Promise<{ res: Response; items: unknown[] } | null> {
    try {
      const res = await this.fetchWithRetry(url)
      if (!res.ok) return null
      const items: unknown = await res.json()
      return Array.isArray(items) ? { res, items } : null
    } catch {
      return null
    }
  }

  async *paginate<T>(
    resource: string,
    params: Record<string, string> = {},
    startPage = 1,
  ): AsyncGenerator<WcPage<T>> {
    let page = startPage
    while (true) {
      const url = this.buildUrl(resource, {
        ...params,
        per_page: String(PAGE_SIZE),
        page: String(page),
        orderby: 'id',
        order: 'asc',
      })
      const res = await this.fetchWithRetry(url)
      if (!res.ok) {
        throw new WooCommerceApiError(res.status, `${resource} page ${page}: ${res.statusText}`)
      }
      const items = (await res.json()) as T[]
      const total = parseInt(res.headers.get('X-WP-Total') ?? '0', 10)
      const totalPages = parseInt(res.headers.get('X-WP-TotalPages') ?? '1', 10)
      yield { items, total, totalPages }
      if (page >= totalPages) break
      page++
    }
  }

  async getProductVariations(productId: number): Promise<WcVariation[]> {
    const results: WcVariation[] = []
    for await (const page of this.paginate<WcVariation>(`/products/${productId}/variations`)) {
      results.push(...page.items)
    }
    return results
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(this.base + path)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
    return url.toString()
  }

  private async request(path: string): Promise<Response> {
    return fetch(this.base + path, { headers: { Authorization: this.auth } })
  }

  private async fetchWithRetry(url: string, attempt = 0): Promise<Response> {
    const started = this.now()
    let res: Response
    try {
      res = await fetch(url, { headers: { Authorization: this.auth } })
    } finally {
      this.requestStats.count++
      this.requestStats.ms += this.now() - started
    }
    if (res.status === 429 && attempt < 3) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '5', 10)
      await sleep(retryAfter * 1000)
      return this.fetchWithRetry(url, attempt + 1)
    }
    if (res.status >= 500 && attempt < 2) {
      await sleep(1000 * (attempt + 1))
      return this.fetchWithRetry(url, attempt + 1)
    }
    return res
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
