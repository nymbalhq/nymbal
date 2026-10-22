import Link from 'next/link'
import { fetchProducts, fetchCategories } from '@/lib/api'
import { cardImageOf, cardProductOf, renderNymbal } from '@/lib/render'
import { organizationJsonLd } from '@/lib/seo'
import { HeroSection } from '@/components/server/HeroSection'
import { CategoryNav, ProductGrid } from '@/components/client/elements'
import { NewsletterSignup } from '@/components/client/NewsletterSignup'
import styles from '@/styles/pages/home.module.css'

export default async function HomePage() {
  const [{ items }, categories] = await Promise.all([
    fetchProducts({ limit: 8 }),
    fetchCategories(),
  ])
  const products = items.map(cardProductOf)
  // The first card's image is the page's likely LCP, and the preload scanner never reaches it inside the grid's shadow
  // root: a preload link, which React hoists into the head, starts it.
  const firstImage = products[0] === undefined ? null : cardImageOf(products[0]).url

  const jsonLd = organizationJsonLd(
    'Nymbal Store',
    process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
  )

  return (
    <>
      {firstImage !== null && (
        <link rel="preload" as="image" href={firstImage} fetchPriority="high" />
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <HeroSection />

      <section className={`container ${styles.categoriesSection}`}>
        <h2 className="section-title">Shop by Category</h2>
        <CategoryNav
          categories={categories}
          serverHtml={
            renderNymbal('nymbal-category-nav', { categories: JSON.stringify(categories) }).__html
          }
        />
      </section>

      <section className={`container ${styles.featuredSection}`}>
        <div className={styles.featuredHeader}>
          <h2 className={styles.featuredTitle}>Featured Products</h2>
          <Link href="/products" className={styles.featuredViewAll}>
            View All
          </Link>
        </div>
        <ProductGrid
          products={products}
          serverHtml={
            renderNymbal('nymbal-product-grid', { products: JSON.stringify(products) }).__html
          }
        />
      </section>

      <NewsletterSignup />
    </>
  )
}
