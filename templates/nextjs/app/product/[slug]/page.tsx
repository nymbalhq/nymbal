import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchProduct, fetchProducts, fetchReviews } from '@/lib/api'
import { productJsonLd } from '@/lib/seo'
import { Breadcrumb } from '@/components/server/Breadcrumb'
import { ReviewList } from '@/components/server/ReviewList'
import { RelatedProducts } from '@/components/server/RelatedProducts'
import { ImageGallery } from '@/components/client/ImageGallery'
import { ProductInteractive } from '@/components/client/ProductInteractive'
import { ReviewForm } from '@/components/client/ReviewForm'
import styles from '@/styles/pages/pdp.module.css'

interface ProductPageProps {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({
  params,
}: ProductPageProps): Promise<Metadata> {
  const { slug } = await params
  const product = await fetchProduct(slug)

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
  const product = await fetchProduct(slug)

  if (!product) notFound()

  const [{ items: reviews }, { items: relatedProducts }] = await Promise.all([
    fetchReviews(product.id),
    fetchProducts({ limit: 4 }),
  ])

  const related = relatedProducts.filter((p) => p.id !== product.id).slice(0, 4)

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const jsonLd = productJsonLd(product, baseUrl)

  const mediaArray = Array.isArray(product.media) ? product.media : []
  const images = mediaArray.length > 0
    ? mediaArray.map((m: Record<string, string>) => ({
        url: m.url,
        alt: m.alt ?? product.name,
      }))
    : [{ url: `https://picsum.photos/seed/${product.slug}/600/600`, alt: product.name }]

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <div className={`container ${styles.page}`}>
        <Breadcrumb
          items={[
            { label: 'Home', href: '/' },
            { label: 'Products', href: '/products' },
            { label: product.name },
          ]}
        />

        <div className={styles.productLayout}>
          <ImageGallery images={images} />

          <div className={styles.info}>
            <ProductInteractive product={product} />

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
                <summary className={styles.detailsSummary}>
                  Shipping & Returns
                </summary>
                <div className={styles.detailsContent}>
                  Free standard shipping on orders over $50. Returns accepted within
                  30 days of purchase.
                </div>
              </details>
            </div>
          </div>
        </div>

        <ReviewList reviews={reviews} />
        <ReviewForm productId={product.id} />
        <RelatedProducts products={related} />
      </div>
    </>
  )
}
