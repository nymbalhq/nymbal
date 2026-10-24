import Link from 'next/link'
import { notFound } from 'next/navigation'
import { preload } from 'react-dom'
import { fetchProducts, fetchCategories } from '@/lib/api'
import { cardImageOf, cardProductOf, renderNymbal } from '@/lib/render'
import { organizationJsonLd } from '@/lib/seo'
import { HeroSection } from '@/components/server/HeroSection'
import { CategoryNav, ProductGrid } from '@/components/client/elements'
import { NewsletterSignup } from '@/components/client/NewsletterSignup'
import styles from '@/styles/pages/home.module.css'

// `/` is rewritten here (next.config.mjs): a dynamic segment with no params prerenders nothing at build, when the API
// may be down, and Next caches its first render and regenerates it in the background every 300 s.
export const revalidate = 300

export function generateStaticParams(): Array<{ key: string }> {
  return []
}

interface HomePageProps {
  params: Promise<{ key: string }>
}

export default async function HomePage({ params }: HomePageProps) {
  if ((await params).key !== 'index') notFound()
  const [{ items }, categories] = await Promise.all([
    fetchProducts({ limit: 8 }),
    fetchCategories(),
  ])
  const products = items.map(cardProductOf)
  // The first card's image is the page's likely LCP, and the preload scanner never reaches it inside the grid's shadow
  // root: a preload in the head starts it. React's preload(), not a <link> element: a cached render writes an element
  // and its preload both.
  if (products[0] !== undefined) {
    preload(cardImageOf(products[0]).url, { as: 'image', fetchPriority: 'high' })
  }

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
