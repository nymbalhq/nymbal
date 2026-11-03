import type { AgentSurfaceUrls, Cart } from '@nymbalhq/types'
import { UCP_CAPABILITY, UCP_VERSION, type UcpCapability } from './profile.js'

/** A product as the catalogue routes answer it (the `products` read model). */
export interface ListedProduct {
  id: string
  slug: string
  name: string
  description: string
  shortDescription: string
  media: unknown
  priceRange: { minMinor: number; maxMinor: number } | null
  currency: string | null
  variants: Array<{ id: string; sku: string; name: string; priceMinor: number; stock: number }>
}

export interface UcpLink {
  type: string
  url: string
  title?: string | undefined
}

export interface UcpVariant {
  id: string
  sku: string
  title: string
  description: { plain: string }
  price: { amount: number; currency: string }
  availability: { available: boolean }
  inputs?: Array<{ id: string; match: 'exact' | 'featured' }>
}

export interface UcpProduct {
  id: string
  handle: string
  title: string
  description: { html: string } | { plain: string }
  url?: string
  price_range: {
    min: { amount: number; currency: string }
    max: { amount: number; currency: string }
  }
  media?: Array<{ type: 'image'; url: string; alt_text?: string }>
  variants: UcpVariant[]
}

export interface UcpMessage {
  type: 'error' | 'info'
  code: string
  content: string
  severity?: 'recoverable' | 'requires_buyer_input' | 'requires_buyer_review' | 'unrecoverable'
  path?: string
}

/** The `ucp` block of a catalogue answer: the version and the capability the tool serves. */
export function catalogUcp(capability: UcpCapability): Record<string, unknown> {
  return { version: UCP_VERSION, capabilities: { [capability]: [{ version: UCP_VERSION }] } }
}

/** A UCP error answer: no payload, only why. */
export function ucpError(
  capability: UcpCapability | undefined,
  messages: UcpMessage[],
): Record<string, unknown> {
  return {
    ucp: {
      version: UCP_VERSION,
      status: 'error',
      ...(capability !== undefined && {
        capabilities: { [capability]: [{ version: UCP_VERSION }] },
      }),
    },
    messages,
  }
}

/** A media URL the store holds as a path is made absolute on the API, which serves it. */
function absolute(url: string, base: string): string | undefined {
  if (URL.canParse(url)) return url
  return base !== '' && URL.canParse(url, base) ? new URL(url, base).href : undefined
}

function mediaOf(media: unknown, base: string): NonNullable<UcpProduct['media']> {
  if (!Array.isArray(media)) return []
  return media.flatMap((entry: unknown) => {
    const { url, altText } = (entry ?? {}) as { url?: unknown; altText?: unknown }
    const resolved = typeof url === 'string' ? absolute(url, base) : undefined
    if (resolved === undefined) return []
    return [
      {
        type: 'image' as const,
        url: resolved,
        ...(typeof altText === 'string' && altText !== '' && { alt_text: altText }),
      },
    ]
  })
}

/**
 * A listed product in UCP's catalogue shape, or null when it has no price (no sellable variant), which no UCP answer
 * carries. Money stays in the read model's minor units.
 */
export function ucpProduct(product: ListedProduct, urls: AgentSurfaceUrls): UcpProduct | null {
  const { priceRange, currency } = product
  if (priceRange === null || currency === null || product.variants.length === 0) return null
  const description =
    product.description !== ''
      ? { html: product.description }
      : { plain: product.shortDescription || product.name }
  return {
    id: product.slug,
    handle: product.slug,
    title: product.name,
    description,
    ...(urls.storefront !== undefined && {
      url: `${urls.storefront}/product/${encodeURIComponent(product.slug)}`,
    }),
    price_range: {
      min: { amount: priceRange.minMinor, currency },
      max: { amount: priceRange.maxMinor, currency },
    },
    media: mediaOf(product.media, urls.api),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      title: variant.name,
      description: { plain: variant.name },
      price: { amount: variant.priceMinor, currency },
      availability: { available: variant.stock > 0 },
    })),
  }
}

const HANDOFF_MESSAGE: UcpMessage = {
  type: 'error',
  code: 'buyer_handoff',
  severity: 'requires_buyer_input',
  content: "Shipping, tax and payment are taken on the store's checkout page.",
}

/** The path the buyer opens to take a cart to the storefront's checkout. */
export function handoffPath(token: string): string {
  return `/api/agents/checkout/${encodeURIComponent(token)}`
}

/**
 * A cart as a UCP checkout that the buyer completes on the store's page: its totals are the cart's, and it always
 * requires escalation to `continue_url`.
 */
export function ucpCheckout(
  cart: Cart,
  urls: AgentSurfaceUrls,
  links: readonly UcpLink[],
): Record<string, unknown> {
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: { [UCP_CAPABILITY.checkout]: [{ version: UCP_VERSION }] },
      payment_handlers: {},
    },
    id: cart.token,
    line_items: cart.items.map((line) => {
      const amount = line.priceMinor * line.qty
      return {
        id: line.variantId,
        item: {
          id: line.variantId,
          title:
            line.variantName === ''
              ? line.productName
              : `${line.productName} – ${line.variantName}`,
          price: line.priceMinor,
        },
        quantity: line.qty,
        totals: [
          { type: 'subtotal', amount },
          { type: 'total', amount },
        ],
      }
    }),
    status: 'requires_escalation',
    currency: cart.currency,
    totals: [
      { type: 'subtotal', amount: cart.subtotalMinor },
      { type: 'total', amount: cart.subtotalMinor },
    ],
    messages: [HANDOFF_MESSAGE],
    links: links.map((link) => ({ ...link })),
    expires_at: cart.expiresAt,
    continue_url: `${urls.api}${handoffPath(cart.token)}`,
  }
}
