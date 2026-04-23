import Link from 'next/link'
import styles from '@/styles/pages/home.module.css'

export function HeroSection() {
  return (
    <section className={styles.hero} data-testid="hero-section">
      <div className={styles.heroContent}>
        <h1 className={styles.heroTitle}>Curated for quality. Built to last.</h1>
        <p className={styles.heroSubtitle}>
          Discover thoughtfully designed products that stand the test of time.
        </p>
        <Link href="/products" className={styles.heroCta}>
          Shop Now
        </Link>
      </div>
    </section>
  )
}
