import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { preload } from 'react-dom'
import { fetchProduct, fetchProducts, fetchReviews } from '@/lib/api'
import { cardProductOf, renderNymbal } from '@/lib/render'
import { productJsonLd } from '@/lib/seo'
import {
  Breadcrumb,
  ImageGallery,
  ProductGrid,
  ReviewForm,
  ReviewList,
} from '@/components/client/elements'
import { ProductInteractive } from '@/components/client/ProductInteractive'
import styles from '@/styles/pages/pdp.module.css'

// Next caches each product page on its first request and regenerates it in the background every 60 s; the build
// prerenders none, since the API may be down then.
export const revalidate = 60

export function generateStaticParams(): Array<{ slug: string }> {
  return []
}

interface ProductPageProps {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params
  const product = await fetchProduct(slug, revalidate)

  if (!product) {
    return { title: 'Product Not Found' }
  }

  return {
    title: product.name,
    description: product.shortDescription ?? product.description ?? `Buy ${product.name}.`,
  }
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params
  const product = await fetchProduct(slug, revalidate)

  if (!product) notFound()

  const [{ items: reviews }, { items: relatedProducts }] = await Promise.all([
    fetchReviews(product.id),
    fetchProducts({ limit: 4 }),
  ])

  const related = relatedProducts
    .filter((p) => p.id !== product.id)
    .slice(0, 4)
    .map(cardProductOf)

  // The product's elements as the server renders them for its first variant, which ProductInteractive shows first.
  const variant = product.variants?.[0]
  const serverHtml = {
    price: renderNymbal('nymbal-product-price', {
      'product-id': product.id,
      'price-minor': String(variant?.priceMinor ?? product.priceMinor ?? 0),
      currency: product.currency ?? 'GBP',
    }).__html,
    stock: renderNymbal('nymbal-stock-badge', {
      'product-id': product.id,
      stock: String(variant?.stock ?? 0),
    }).__html,
    variantSelector: renderNymbal('nymbal-variant-selector', { product: JSON.stringify(product) })
      .__html,
    quantity: renderNymbal('nymbal-quantity-selector', { value: '1', min: '1', max: '99' }).__html,
    addToCart: renderNymbal('nymbal-add-to-cart', {
      'variant-id': variant?.id ?? product.id,
      qty: '1',
      ...((variant?.stock ?? 0) <= 0 && { disabled: '' }),
    }).__html,
  }

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const jsonLd = productJsonLd(product, baseUrl)

  const mediaArray = Array.isArray(product.media) ? product.media : []
  const images =
    mediaArray.length > 0
      ? mediaArray.map((m: Record<string, string>) => ({
          url: m.url,
          alt: m.alt ?? product.name,
        }))
      : [{ url: `https://picsum.photos/seed/${product.slug}/600/600`, alt: product.name }]
  const crumbs = [
    { label: 'Home', href: '/' },
    { label: 'Products', href: '/products' },
    { label: product.name },
  ]

  // The gallery's main image is the page's LCP: a preload in the head starts it before the browser parses the body.
  // React's preload(), not a <link> element: a cached render writes an element and its preload both.
  preload(images[0]!.url, { as: 'image', fetchPriority: 'high' })

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className={`container ${styles.page}`}>
        <Breadcrumb
          items={crumbs}
          serverHtml={renderNymbal('nymbal-breadcrumb', { items: JSON.stringify(crumbs) }).__html}
        />

        <div className={styles.productLayout}>
          <ImageGallery
            className={styles.gallery}
            images={images}
            serverHtml={
              renderNymbal('nymbal-image-gallery', { images: JSON.stringify(images) }).__html
            }
          />

          <div className={styles.info}>
            <ProductInteractive product={product} serverHtml={serverHtml} />

            {product.description && (
              <div className={styles.description}>
                <p>{product.description}</p>
              </div>
            )}

            <div className={styles.detailsSection}>
              <details className={styles.detailsItem}>
                <summary className={styles.detailsSummary}>Details</summary>
                <div className={styles.detailsContent}>
                  {product.description ?? 'No additional details available.'}
                </div>
              </details>
              <details className={styles.detailsItem}>
                <summary className={styles.detailsSummary}>Shipping & Returns</summary>
                <div className={styles.detailsContent}>
                  Free standard shipping on orders over $50. Returns accepted within 30 days of
                  purchase.
                </div>
              </details>
            </div>
          </div>
        </div>

        <section className={styles.reviewsSection}>
          <h2 className={styles.reviewsTitle}>Customer Reviews</h2>
          <ReviewList
            reviews={reviews}
            serverHtml={
              renderNymbal('nymbal-review-list', { reviews: JSON.stringify(reviews) }).__html
            }
          />
          <ReviewForm
            className={styles.reviewForm}
            productId={product.id}
            serverHtml={renderNymbal('nymbal-review-form', { 'product-id': product.id }).__html}
          />
        </section>

        {related.length > 0 && (
          <section className="section">
            <h2 className="section-title">You may also like</h2>
            <ProductGrid
              products={related}
              lazy
              serverHtml={
                renderNymbal('nymbal-product-grid', { products: JSON.stringify(related), lazy: '' })
                  .__html
              }
            />
          </section>
        )}
      </div>
    </>
  )
}
