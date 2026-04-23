import Link from 'next/link'
import { fetchProducts, fetchCategories } from '@/lib/api'
import { organizationJsonLd } from '@/lib/seo'
import { HeroSection } from '@/components/server/HeroSection'
import { CategoryNav } from '@/components/server/CategoryNav'
import { ProductCard } from '@/components/server/ProductCard'
import { NewsletterSignup } from '@/components/client/NewsletterSignup'
import styles from '@/styles/pages/home.module.css'

export default async function HomePage() {
  const [{ items: products }, categories] = await Promise.all([
    fetchProducts({ limit: 8 }),
    fetchCategories(),
  ])

  const jsonLd = organizationJsonLd(
    'Nymbal Store',
    process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
  )

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <HeroSection />

      <CategoryNav categories={categories} />

      <section className={`container ${styles.featuredSection}`}>
        <div className={styles.featuredHeader}>
          <h2 className={styles.featuredTitle}>Featured Products</h2>
          <Link href="/products" className={styles.featuredViewAll}>
            View All
          </Link>
        </div>
        {products.length > 0 ? (
          <div className="product-grid">
            {products.map((product) => (
              <ProductCard
                key={product.id}
                product={{
                  slug: product.slug,
                  name: product.name,
                  priceMinor: product.priceMinor ?? null,
                  currency: product.currency ?? null,
                  media: product.media,
                }}
              />
            ))}
          </div>
        ) : (
          <p className="text-muted text-center">
            No products available yet. Check back soon.
          </p>
        )}
      </section>

      <NewsletterSignup />
    </>
  )
}
