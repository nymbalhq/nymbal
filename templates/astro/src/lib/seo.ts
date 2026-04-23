import type { DenormalisedProduct } from '@nymbal/sdk'

export function productJsonLd(product: DenormalisedProduct, baseUrl: string) {
  const images = product.media?.length
    ? product.media.map((m) => (typeof m === 'string' ? m : m.url))
    : []

  const sku = product.variants?.[0]?.sku ?? product.id

  const lowPrice = product.priceRange
    ? product.priceRange.min / 100
    : product.priceMinor / 100
  const highPrice = product.priceRange
    ? product.priceRange.max / 100
    : product.priceMinor / 100

  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.name,
    description: product.description,
    image: images,
    sku,
    url: `${baseUrl}/product/${product.slug}`,
    offers: {
      '@type': 'AggregateOffer',
      lowPrice: lowPrice.toFixed(2),
      highPrice: highPrice.toFixed(2),
      priceCurrency: product.currency,
      availability: product.inStock
        ? 'https://schema.org/InStock'
        : 'https://schema.org/OutOfStock',
      offerCount: product.variants?.length ?? 1,
    },
  }
}

export function breadcrumbJsonLd(items: Array<{ name: string; url: string }>) {
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

export function organizationJsonLd(storeName: string, url: string) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: storeName,
    url,
  }
}
