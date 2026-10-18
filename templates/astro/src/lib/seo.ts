import type { DenormalisedProduct } from '@nymbalhq/sdk'

export function productJsonLd(product: DenormalisedProduct, baseUrl: string) {
  // The SDK types `media` as unknown: the projection stores either URLs or `{ url }` objects.
  const media: unknown[] = Array.isArray(product.media) ? product.media : []
  const images = media
    .map((m) =>
      typeof m === 'string'
        ? m
        : m && typeof m === 'object' && 'url' in m && typeof m.url === 'string'
          ? m.url
          : null,
    )
    .filter((url): url is string => url !== null)

  const sku = product.variants?.[0]?.sku ?? product.id

  const lowPrice = (product.priceRange?.minMinor ?? product.priceMinor ?? 0) / 100
  const highPrice = (product.priceRange?.maxMinor ?? product.priceMinor ?? 0) / 100

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
