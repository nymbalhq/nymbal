import type { DenormalisedProduct } from '@nymbalhq/sdk'
import { descriptionText } from '@nymbalhq/web-components/ssr'

export { descriptionText, serializeJsonLd } from '@nymbalhq/web-components/ssr'

export interface BreadcrumbItem {
  name: string
  url: string
}

export function productJsonLd(
  product: DenormalisedProduct,
  baseUrl: string,
): Record<string, unknown> {
  const url = `${baseUrl}/product/${product.slug}`
  const priceCurrency = product.currency ?? 'GBP'
  const availability = `https://schema.org/${product.inStock ? 'InStock' : 'OutOfStock'}`

  const offers: Record<string, unknown> =
    product.variants.length > 1 && product.priceRange
      ? {
          '@type': 'AggregateOffer',
          lowPrice: (product.priceRange.minMinor / 100).toFixed(2),
          highPrice: (product.priceRange.maxMinor / 100).toFixed(2),
          priceCurrency,
          offerCount: product.variants.length,
          availability,
        }
      : {
          '@type': 'Offer',
          price: ((product.priceMinor ?? 0) / 100).toFixed(2),
          priceCurrency,
          availability,
          url,
        }

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: descriptionText(product.description),
    url,
    sku: product.variants[0]?.sku ?? product.id,
    offers,
    ...(product.rating?.count && {
      aggregateRating: {
        '@type': 'AggregateRating',
        ratingValue: product.rating.average,
        reviewCount: product.rating.count,
        bestRating: 5,
        worstRating: 1,
      },
    }),
  }
}

export function breadcrumbJsonLd(items: BreadcrumbItem[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  }
}

export function organizationJsonLd(storeName: string, url: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: storeName,
    url,
  }
}
