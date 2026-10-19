import type { Metadata } from 'next'
import { fetchProducts, fetchCategories, sortFromSearchParams } from '@/lib/api'
import { Breadcrumb } from '@/components/server/Breadcrumb'
import { ProductGrid } from '@/components/client/ProductGrid'
import styles from '@/styles/pages/plp.module.css'

export const metadata: Metadata = {
  title: 'All Products',
  description: 'Browse our full collection of products.',
}

interface ProductsPageProps {
  searchParams: Promise<{ sort?: string | string[] }>
}

export default async function ProductsPage({ searchParams }: ProductsPageProps) {
  const sort = sortFromSearchParams(await searchParams)
  const [{ items, nextCursor }, categories] = await Promise.all([
    fetchProducts({ limit: 24, sort }),
    fetchCategories(),
  ])

  return (
    <div className={`container ${styles.page}`}>
      <Breadcrumb
        items={[
          { label: 'Home', href: '/' },
          { label: 'Products' },
        ]}
      />
      <h1 className={styles.pageTitle}>All Products</h1>
      <ProductGrid
        initialProducts={items}
        initialCursor={nextCursor}
        initialSort={sort}
        categories={categories}
      />
    </div>
  )
}
