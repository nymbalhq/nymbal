'use client'

import { useCallback } from 'react'
import { MiniCart } from '@nymbalhq/react'

export function MiniCartWrapper() {
  const handleClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent('nymbal:cart:open'))
  }, [])

  return <MiniCart onClick={handleClick} />
}
