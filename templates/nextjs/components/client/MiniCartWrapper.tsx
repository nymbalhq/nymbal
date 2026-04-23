'use client'

import { useCallback } from 'react'
import { MiniCart } from '@nymbal/react'

export function MiniCartWrapper() {
  const handleClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent('nymbal:cart:open'))
  }, [])

  return <MiniCart onClick={handleClick} />
}
