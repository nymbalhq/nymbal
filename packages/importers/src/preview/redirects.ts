import type { RedirectRow, Unredirected } from './types.js'

type Rec = Record<string, unknown>

/** WooCommerce's default category base; its REST API exposes neither the setting nor a category's permalink. */
const CATEGORY_BASE = 'product-category'

export interface RedirectInput {
  /** Every category WooCommerce holds: a category's URL holds its ancestors' slugs. */
  sourceCategories: Rec[]
  categories: Array<{ source: Rec; nymbalSlug: string }>
  products: Array<{ source: Rec; nymbalSlug: string; listed: boolean }>
}

export interface Redirects {
  rows: RedirectRow[]
  unredirected: Unredirected[]
  duplicates: Array<{ from: string; wcIds: number[] }>
}

const idOf = (r: Rec) => Number(r['id'])
const byId = <T extends { source: Rec }>(xs: T[]) =>
  [...xs].sort((a, b) => idOf(a.source) - idOf(b.source))

/**
 * Each WooCommerce category's and listed product's URL to its Nymbal URL: categories first, then products, each in
 * WooCommerce id order. A URL two records share keeps the first; the later ids are listed as duplicates. A product
 * with no page of its own on the storefront, or served under a plain permalink (a query a host cannot match on a
 * path), gets no row and is listed with the reason.
 */
export function buildRedirects(input: RedirectInput): Redirects {
  const parents = new Map(input.sourceCategories.map((c) => [idOf(c), c]))
  const categoryPath = (c: Rec): string => {
    const chain = [String(c['slug'])]
    const seen = new Set([idOf(c)])
    let parent = Number(c['parent'] ?? 0)
    while (parent !== 0 && parents.has(parent) && !seen.has(parent)) {
      seen.add(parent)
      const up = parents.get(parent)!
      chain.unshift(String(up['slug']))
      parent = Number(up['parent'] ?? 0)
    }
    return `/${CATEGORY_BASE}/${chain.join('/')}/`
  }

  const rows: RedirectRow[] = []
  const unredirected: Unredirected[] = []
  const taken = new Set<string>()
  const later = new Map<string, number[]>()
  const add = (from: string, to: string, wcId: number) => {
    if (taken.has(from)) {
      later.set(from, [...(later.get(from) ?? []), wcId])
      return
    }
    taken.add(from)
    rows.push({ from, to, status: 301 })
  }

  for (const c of byId(input.categories)) {
    add(categoryPath(c.source), `/category/${c.nymbalSlug}`, idOf(c.source))
  }
  for (const p of byId(input.products)) {
    const wcId = idOf(p.source)
    if (!p.listed) {
      unredirected.push({ kind: 'product', wcId, reason: 'imported as a draft' })
      continue
    }
    // No usable permalink: WooCommerce's default product base.
    let from = `/product/${String(p.source['slug'])}/`
    const permalink = p.source['permalink']
    const url = typeof permalink === 'string' && URL.canParse(permalink) ? new URL(permalink) : null
    if (url !== null && /^https?:$/.test(url.protocol)) {
      if (url.search !== '') {
        unredirected.push({
          kind: 'product',
          wcId,
          reason: `plain permalink: ${String(permalink)}`,
        })
        continue
      }
      from = url.pathname
    }
    add(from, `/product/${p.nymbalSlug}`, wcId)
  }

  return {
    rows,
    unredirected,
    duplicates: [...later].map(([from, wcIds]) => ({ from, wcIds })),
  }
}

const field = (value: string | number): string => {
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** `from,to,status` and a line per row, RFC 4180: a field holding a comma, quote or line break is quoted. */
export function formatRedirectsCsv(rows: RedirectRow[]): string {
  return ['from,to,status', ...rows.map((r) => [r.from, r.to, r.status].map(field).join(','))]
    .map((line) => `${line}\n`)
    .join('')
}
