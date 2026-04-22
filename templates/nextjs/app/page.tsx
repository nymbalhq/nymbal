interface Product {
  id: string
  slug: string
  title: string
  description: string
  priceMinor: number
  currency: string
  imageUrl: string
}

async function loadProducts(): Promise<{ products: Product[]; error: string | null }> {
  const apiUrl = process.env.NYMBAL_API_URL ?? 'http://localhost:3001'
  try {
    const res = await fetch(`${apiUrl}/api/products?limit=50`, { cache: 'no-store' })
    if (!res.ok) return { products: [], error: `API returned ${res.status}` }
    const data = (await res.json()) as { items: Product[] }
    return { products: data.items, error: null }
  } catch (err) {
    return { products: [], error: err instanceof Error ? err.message : String(err) }
  }
}

function formatPrice(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`
  }
}

export default async function Page() {
  const { products, error } = await loadProducts()
  return (
    <main style={{ padding: '2rem', maxWidth: '72rem', marginInline: 'auto' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.25rem' }}>Nymbal — Next.js Storefront</h1>
      <p style={{ color: '#666', marginTop: 0 }}>
        Minimal starter — fetches <code>/api/products</code>. Prompt 4 builds out the full UI.
      </p>
      {error && (
        <p style={{ color: '#b00', background: '#fee', padding: '0.75rem 1rem', borderRadius: 6 }}>
          Failed to load products: {error}
        </p>
      )}
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          display: 'grid',
          gap: '1.25rem',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
        }}
      >
        {products.map((p) => (
          <li
            key={p.id}
            style={{
              border: '1px solid rgba(0,0,0,0.1)',
              borderRadius: 8,
              overflow: 'hidden',
              background: 'rgba(255,255,255,0.4)',
            }}
          >
            <img
              src={p.imageUrl}
              alt={p.title}
              loading="lazy"
              style={{ width: '100%', height: 160, objectFit: 'cover', display: 'block', background: '#eee' }}
            />
            <div style={{ padding: '0.75rem 1rem 1rem' }}>
              <p style={{ fontWeight: 600, fontSize: '0.95rem', margin: '0 0 0.25rem' }}>{p.title}</p>
              <p style={{ fontWeight: 500, color: '#333' }}>
                {formatPrice(p.priceMinor, p.currency)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}
