import type { Metadata } from 'next'
import { fetchProducts, fetchCategories } from '@/lib/api'
import { Breadcrumb } from '@/components/server/Breadcrumb'
import { ProductGrid } from '@/components/client/ProductGrid'
import styles from '@/styles/pages/plp.module.css'

export const metadata: Metadata = {
  title: 'All Products',
  description: 'Browse our full collection of products.',
}

export default async function ProductsPage() {
  const [{ items, nextCursor }, categories] = await Promise.all([
    fetchProducts({ limit: 24 }),
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
        categories={categories}
      />
    </div>
  )
}
