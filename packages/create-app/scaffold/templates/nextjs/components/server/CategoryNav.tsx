import Link from 'next/link'
import type { Category } from '@nymbal/types'
import styles from '@/styles/pages/home.module.css'

interface CategoryNavProps {
  categories: Category[]
}

export function CategoryNav({ categories }: CategoryNavProps) {
  if (categories.length === 0) return null

  return (
    <section className={`container ${styles.categoriesSection}`}>
      <h2 className="section-title">Shop by Category</h2>
      <div className={styles.categoriesGrid}>
        {categories.map((category) => (
          <Link
            key={category.id}
            href={`/category/${category.slug}`}
            className={styles.categoryCard}
            data-testid={`category-${category.slug}`}
          >
            {category.name}
          </Link>
        ))}
      </div>
    </section>
  )
}
