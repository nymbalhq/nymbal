import { randomUUID } from 'node:crypto'
import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sanitizeDescription } from '../../src/index.js'
import { untilDelivered } from '../support/history.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { openRaw, type RawReader } from '../support/raw.js'

// A product description is stored as a sanitised HTML fragment, whatever the service is given on create or update:
// GET /api/products/:slug serves it with no script, style, iframe, svg (or other active element) and none of their
// content, no event-handler attribute and no javascript: or data: link, while every allowed tag and every text run
// is kept and a bare `<` or `&` stays text. The stored value is sanitizeDescription of the input, and sanitizing it
// again changes nothing.

const ALLOWED = ['p', 'strong', 'b', 'em', 'i', 'u', 'h2', 'h3', 'h4', 'blockquote'] as const
const ACTIVE = [
  'script',
  'style',
  'iframe',
  'svg',
  'object',
  'embed',
  'math',
  'template',
  'noscript',
]

interface Fragment {
  html: string
  /** Text that must be served. */
  kept: string[]
  /** Text that must not be served anywhere: forbidden content, handler code, a dropped attribute or link. */
  gone: string[]
  /** Allowed tags the fragment opens, by name, once per opening. */
  tags: string[]
  /** https links whose href is kept. */
  links: string[]
}

let n = 0
const word = (prefix: string) => `${prefix}${(n += 1)}x`

const piece: fc.Arbitrary<Fragment> = fc
  .constantFrom(
    'allowed',
    'br',
    'list',
    'safe-link',
    'mailto',
    'unknown-tag',
    'active',
    'handler',
    'img',
    'bad-link',
    'bare-text',
  )
  .chain((kind) =>
    fc.tuple(fc.constant(kind), fc.constantFrom(...ALLOWED), fc.constantFrom(...ACTIVE)),
  )
  .map(([kind, tag, active]): Fragment => {
    const k = word('kept')
    const g = word('gone')
    switch (kind) {
      case 'allowed':
        return { html: `<${tag}>${k}</${tag}>`, kept: [k], gone: [], tags: [tag], links: [] }
      case 'br':
        return { html: `${k}<br>`, kept: [k], gone: [], tags: ['br'], links: [] }
      case 'list':
        return {
          html: `<ul><li>${k}</li></ul>`,
          kept: [k],
          gone: [],
          tags: ['ul', 'li'],
          links: [],
        }
      case 'safe-link': {
        const href = `https://shop.example/${k}`
        return {
          html: `<a href="${href}">${k}</a>`,
          kept: [k],
          gone: [],
          tags: ['a'],
          links: [href],
        }
      }
      case 'mailto':
        return {
          html: `<a href="mailto:${k}@shop.example">${k}</a>`,
          kept: [k],
          gone: [],
          tags: ['a'],
          links: [],
        }
      case 'unknown-tag':
        return { html: `<span class="${g}">${k}</span>`, kept: [k], gone: [g], tags: [], links: [] }
      case 'active':
        return active === 'embed'
          ? { html: `<embed src="${g}">`, kept: [], gone: [g], tags: [], links: [] }
          : { html: `<${active}>${g}</${active}>`, kept: [], gone: [g], tags: [], links: [] }
      case 'handler':
        return {
          html: `<${tag} onclick="${g}()">${k}</${tag}>`,
          kept: [k],
          gone: [g],
          tags: [tag],
          links: [],
        }
      case 'img':
        return {
          html: `<img src=x onerror="${g}()">${k}`,
          kept: [k],
          gone: [g],
          tags: [],
          links: [],
        }
      case 'bad-link':
        return {
          html: `<a href="${k.length % 2 === 0 ? 'javascript' : ' JaVaScRiPt'}:${g}()">${k}</a><a href="data:text/html,${g}">${k}</a>`,
          kept: [k],
          gone: [g],
          tags: ['a', 'a'],
          links: [],
        }
      default:
        return {
          html: `${k} 1 < 2 & 3`,
          kept: [k, '1 &lt; 2 &amp; 3'],
          gone: [],
          tags: [],
          links: [],
        }
    }
  })

const fragment: fc.Arbitrary<Fragment> = fc
  .array(piece, { minLength: 1, maxLength: 8 })
  .map((pieces) => ({
    html: pieces.map((p) => p.html).join('\n'),
    kept: pieces.flatMap((p) => p.kept),
    gone: pieces.flatMap((p) => p.gone),
    tags: pieces.flatMap((p) => p.tags),
    links: pieces.flatMap((p) => p.links),
  }))

const openings = (html: string, tag: string): number =>
  (html.match(new RegExp(`<${tag}(?=[\\s>/])`, 'gi')) ?? []).length

/** Each way a served description fails the fragment it was made from; none when it is sanitised as it should be. */
function violations(served: string, f: Fragment): string[] {
  const found: string[] = []
  for (const tag of ACTIVE) if (openings(served, tag) > 0) found.push(`<${tag}> served`)
  if (/\son[a-z]+\s*=/i.test(served)) found.push('an on* attribute served')
  if (/(?:javascript|data)\s*:/i.test(served)) found.push('a javascript: or data: link served')
  for (const g of f.gone) if (served.includes(g)) found.push(`${g} served`)
  for (const k of f.kept) if (!served.includes(k)) found.push(`${k} dropped`)
  for (const tag of new Set(f.tags)) {
    const want = f.tags.filter((t) => t === tag).length
    const got = openings(served, tag)
    if (got !== want) found.push(`<${tag}> ${got} times, given ${want}`)
  }
  for (const href of f.links) {
    const anchor = served.match(new RegExp(`<a\\b[^>]*href="${href}"[^>]*>`))?.[0] ?? ''
    if (!/\brel="nofollow noopener noreferrer"/.test(anchor)) found.push(`${href} without rel`)
  }
  return found
}

let s: ServedKernel
let raw: RawReader

beforeAll(async () => {
  s = await serveKernel(await createKernel({ dialect: 'sqlite' }))
  raw = openRaw('sqlite', s.kernel.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await s?.stop()
})

async function served(slug: string): Promise<string> {
  await untilDelivered(raw)
  const res = await fetch(`${s.baseUrl}/api/products/${slug}`)
  expect(res.status, slug).toBe(200)
  return ((await res.json()) as { data: { description: string } }).data.description
}

/** The description served after creating a product with `created`, and after updating it to `updated`. */
async function createdThenUpdated(
  created: Fragment,
  updated: Fragment,
): Promise<{ onCreate: string; onUpdate: string }> {
  const tag = randomUUID()
  const product = await s.kernel.services.product.create({
    slug: `desc-${tag}`,
    name: 'Description Tee',
    description: created.html,
    status: 'active',
    variants: [{ sku: `DESC-${tag}`, name: 'Default', priceMinor: 1000, stock: 1, options: [] }],
  })
  const onCreate = await served(product.slug)
  await s.kernel.services.product.update(product.id, { description: updated.html })
  const onUpdate = await served(product.slug)
  return { onCreate, onUpdate }
}

describe('AC-3: a product description is stored sanitised', () => {
  it('AC-3: a description created and then updated through the product service is served by GET /api/products/:slug with no forbidden part, and with every allowed tag and text run kept', async () => {
    await fc.assert(
      fc.asyncProperty(fragment, fragment, async (created, updated) => {
        const { onCreate, onUpdate } = await createdThenUpdated(created, updated)

        expect(
          { created: violations(onCreate, created), updated: violations(onUpdate, updated) },
          JSON.stringify({ created: created.html, updated: updated.html }),
        ).toEqual({ created: [], updated: [] })
      }),
      { numRuns: 20 },
    )
  }, 120_000)

  it('AC-3: the served description is sanitizeDescription of the input, on create and on update, and sanitizing it again changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fragment, fragment, async (created, updated) => {
        const { onCreate, onUpdate } = await createdThenUpdated(created, updated)

        expect(onCreate).toBe(sanitizeDescription(created.html))
        expect(onUpdate).toBe(sanitizeDescription(updated.html))
        expect(sanitizeDescription(onCreate)).toBe(onCreate)
        expect(sanitizeDescription(onUpdate)).toBe(onUpdate)
      }),
      { numRuns: 20 },
    )
  }, 120_000)
})
