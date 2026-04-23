import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchProducts, fetchCategories } from '@/lib/api'
import { Breadcrumb } from '@/components/server/Breadcrumb'
import { ProductGrid } from '@/components/client/ProductGrid'
import styles from '@/styles/pages/plp.module.css'

interface CategoryPageProps {
  params: Promise<{ slug: string }>
}

export async function generateMetadata({
  params,
}: CategoryPageProps): Promise<Metadata> {
  const { slug } = await params
  const categories = await fetchCategories()
  const category = categories.find((c) => c.slug === slug)

  return {
    title: category?.name ?? slug,
    description: category?.description ?? `Browse products in ${slug}.`,
  }
}

export default async function CategoryPage({ params }: CategoryPageProps) {
  const { slug } = await params
  const [{ items, nextCursor }, categories] = await Promise.all([
    fetchProducts({ limit: 24, category: slug }),
    fetchCategories(),
  ])

  const category = categories.find((c) => c.slug === slug)
  if (!category) notFound()

  return (
    <div className={`container ${styles.page}`}>
      <Breadcrumb
        items={[
          { label: 'Home', href: '/' },
          { label: category.name },
        ]}
      />
      <h1 className={styles.pageTitle}>{category.name}</h1>
      {category.description && (
        <p className="text-muted mb-lg">{category.description}</p>
      )}
      <ProductGrid
        initialProducts={items}
        initialCursor={nextCursor}
        categorySlug={slug}
        categories={categories}
      />
    </div>
  )
}
