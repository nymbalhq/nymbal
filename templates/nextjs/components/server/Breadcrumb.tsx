import Link from 'next/link'
import styles from '@/styles/pages/pdp.module.css'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
}

export function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" data-testid="breadcrumb">
      <ol className={styles.breadcrumb}>
        {items.map((item, index) => (
          <li key={index} style={{ display: 'inline-flex', alignItems: 'center', gap: 'inherit' }}>
            {index > 0 && (
              <span className={styles.breadcrumbSeparator} aria-hidden="true">
                /
              </span>
            )}
            {item.href ? (
              <Link href={item.href} className={styles.breadcrumbLink}>
                {item.label}
              </Link>
            ) : (
              <span aria-current="page">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}
