'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { SearchBar } from '@nymbal/react'

interface SearchProduct {
  slug: string
}

export function SearchBarWrapper() {
  const router = useRouter()

  const handleSelect = useCallback(
    (event: CustomEvent<{ product: unknown }>) => {
      const product = event.detail.product as SearchProduct
      if (product?.slug) {
        router.push(`/products/${product.slug}`)
      }
    },
    [router],
  )

  return (
    <SearchBar
      placeholder="Search products..."
      debounceMs={300}
      onSearchSelect={handleSelect}
    />
  )
}
