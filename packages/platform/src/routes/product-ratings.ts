import type { Logger, ProductRating, ReviewsAdapter } from '@nymbalhq/types'

/**
 * The rating a product is served with: the reviews adapter's figures, the average to one decimal, or null when the
 * adapter reports no aggregate, the product has no approved review, the figures are outside 1 to 5, or the call fails.
 * A failing provider costs the rating, never the catalogue.
 */
async function ratingOf(
  reviews: ReviewsAdapter,
  productId: string,
  logger: Logger,
): Promise<ProductRating | null> {
  try {
    const agg = await reviews.getAggregateRating(productId)
    if (!(agg.count > 0) || !(agg.average >= 1 && agg.average <= 5)) return null
    return { average: Math.round(agg.average * 10) / 10, count: agg.count }
  } catch (err) {
    logger.warn({ err, productId, provider: reviews.providerName }, 'product rating unavailable')
    return null
  }
}

/** Each product with its served `rating`; the stored documents are not changed. */
export async function withRatings(
  reviews: ReviewsAdapter | undefined,
  products: readonly unknown[],
  logger: Logger,
): Promise<Array<Record<string, unknown> & { rating: ProductRating | null }>> {
  const source = reviews?.capabilities().includes('aggregate') === true ? reviews : undefined
  return Promise.all(
    products.map(async (doc) => {
      const p = doc as Record<string, unknown>
      const id = p.id
      const rating =
        source !== undefined && typeof id === 'string' ? await ratingOf(source, id, logger) : null
      return { ...p, rating }
    }),
  )
}
