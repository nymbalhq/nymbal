import type { Metadata } from 'next'
import { fetchProducts, fetchCapabilities, sortFromSearchParams } from '@/lib/api'
import { cardProductOf, renderNymbal } from '@/lib/render'
import { Breadcrumb, ProductGrid } from '@/components/client/elements'
import { ListingControls } from '@/components/client/ListingControls'
import styles from '@/styles/pages/plp.module.css'

export const metadata: Metadata = {
  title: 'All Products',
  description: 'Browse our full collection of products.',
}

interface ProductsPageProps {
  searchParams: Promise<{ sort?: string | string[] }>
}

const CRUMBS = [{ label: 'Home', href: '/' }, { label: 'Products' }]

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const capabilities = await fetchCapabilities()
  const sort = sortFromSearchParams(await searchParams, capabilities?.catalog)
  const { items, nextCursor, facets } = await fetchProducts({ limit: 24, sort })
  const cards = items.map(cardProductOf)
  const grid = {
    products: JSON.stringify(cards),
    source: 'product-list',
    ...(nextCursor !== null && { 'has-more': '' }),
  }

  return (
    <div className={`container ${styles.page}`}>
      <Breadcrumb
        items={CRUMBS}
        serverHtml={renderNymbal('nymbal-breadcrumb', { items: JSON.stringify(CRUMBS) }).__html}
      />
      <h1 className={styles.pageTitle}>All Products</h1>
      <ListingControls
        sort={sort}
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
