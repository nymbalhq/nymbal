import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchProducts, fetchCategories, fetchCapabilities, sortFromSearchParams } from '@/lib/api'
import { cardImageOf, cardProductOf, renderNymbal } from '@/lib/render'
import { Breadcrumb, ProductGrid } from '@/components/client/elements'
import { ListingControls } from '@/components/client/ListingControls'
import styles from '@/styles/pages/plp.module.css'

interface CategoryPageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ sort?: string | string[] }>
}

export async function generateMetadata({ params }: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params
  const categories = await fetchCategories()
  const category = categories.find((c) => c.slug === slug)

  return {
    title: category?.name ?? slug,
    description: category?.description ?? `Browse products in ${slug}.`,
  }
}

export default async function CategoryPage({ params, searchParams }: CategoryPageProps) {
  const { slug } = await params
  const capabilities = await fetchCapabilities()
  const sort = sortFromSearchParams(await searchParams, capabilities?.catalog)
  const [{ items, nextCursor, facets }, categories] = await Promise.all([
    fetchProducts({ limit: 24, category: slug, sort }),
    fetchCategories(),
  ])

  const category = categories.find((c) => c.slug === slug)
  if (!category) notFound()
  const crumbs = [{ label: 'Home', href: '/' }, { label: category.name }]
  const cards = items.map(cardProductOf)
  // The first card's image is the page's LCP, and the preload scanner never reaches it inside the grid's shadow root:
  // a preload link, which React hoists into the head, starts it.
  const firstImage = cards[0] === undefined ? null : cardImageOf(cards[0]).url
  const grid = {
    products: JSON.stringify(cards),
    source: 'product-list',
    ...(nextCursor !== null && { 'has-more': '' }),
  }

  return (
    <div className={`container ${styles.page}`}>
      {firstImage !== null && (
        <link rel="preload" as="image" href={firstImage} fetchPriority="high" />
      )}
      <Breadcrumb
        items={crumbs}
        serverHtml={renderNymbal('nymbal-breadcrumb', { items: JSON.stringify(crumbs) }).__html}
      />
      <h1 className={styles.pageTitle}>{category.name}</h1>
      {category.description && <p className="text-muted mb-lg">{category.description}</p>}
      <ListingControls
        sort={sort}
        category={slug}
        facets={facets ?? []}
        sortKeys={capabilities?.catalog.sortKeys ?? []}
        defaultSort={capabilities?.catalog.defaultSort}
      >
        <ProductGrid
          products={cards}
          source="product-list"
          hasMore={nextCursor !== null}
          serverHtml={renderNymbal('nymbal-product-grid', grid).__html}
        />
      </ListingControls>
    </div>
  )
}
