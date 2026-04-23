import type { DenormalisedProduct } from '@nymbal/sdk'

export interface BreadcrumbItem {
  name: string
  url: string
}

export function productJsonLd(
  product: DenormalisedProduct,
  baseUrl: string,
): Record<string, unknown> {
  const url = `${baseUrl}/products/${product.slug}`
  const priceCurrency = product.currency ?? 'GBP'

  const offers: Record<string, unknown> =
    product.variants.length > 1 && product.priceRange
      ? {
          '@type': 'AggregateOffer',
          lowPrice: (product.priceRange.minMinor / 100).toFixed(2),
          highPrice: (product.priceRange.maxMinor / 100).toFixed(2),
          priceCurrency,
          offerCount: product.variants.length,
          availability: product.inStock
            ? 'https://schema.org/InStock'
            : 'https://schema.org/OutOfStock',
        }
      : {
          '@type': 'Offer',
          price: ((product.priceMinor ?? 0) / 100).toFixed(2),
          priceCurrency,
          availability: product.inStock
            ? 'https://schema.org/InStock'
            : 'https://schema.org/OutOfStock',
          url,
        }

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    url,
    sku: product.variants[0]?.sku ?? product.id,
    offers,
  }
}

export function breadcrumbJsonLd(
  items: BreadcrumbItem[],
): Record<string, unknown> {
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

export function organizationJsonLd(
  storeName: string,
  url: string,
): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: storeName,
    url,
  }
}
