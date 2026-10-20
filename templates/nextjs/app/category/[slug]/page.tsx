import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { fetchProducts, fetchCategories, fetchCapabilities, sortFromSearchParams } from '@/lib/api'
import { Breadcrumb } from '@/components/server/Breadcrumb'
import { ProductGrid } from '@/components/client/ProductGrid'
import styles from '@/styles/pages/plp.module.css'

interface CategoryPageProps {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ sort?: string | string[] }>
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
        initialSort={sort}
        initialFacets={facets ?? []}
        sortKeys={capabilities?.catalog.sortKeys ?? []}
        defaultSort={capabilities?.catalog.defaultSort}
        categorySlug={slug}
      />
    </div>
  )
}
